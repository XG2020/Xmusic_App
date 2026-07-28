import React, {useCallback, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Modal,
  ToastAndroid,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {useFocusEffect} from '@react-navigation/native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {startDownload} from '../services/downloadManager';
import {deleteLocalSongWithCompanions} from '../services/download';
import {
  getLocalPlaylist,
  removeSongFromPlaylist,
  getFavSongs,
  getLocalPlaylists,
  addSongsToPlaylist,
  addFavSongs,
  toggleFav,
  songKey,
  markSongsUnplayable,
  LocalPlaylist,
} from '../services/store';
import {resolveSongUrls} from '../services/api';
import {playSongsProgressive} from '../services/player';
import {autoOpenPlayerEnabled} from '../services/settings';
import SongActionSheet from '../components/SongActionSheet';
import Icon from '../components/Icon';
import {useTheme, Theme} from '../theme';
import type {Song} from '../types/music';

/** 我喜欢虚拟歌单 ID */
export const FAV_PLAYLIST_ID = '__fav__';

type SortKey = 'default' | 'title' | 'singer';

const singerText = (s: Song) =>
  s.singer?.map(x => x.name).join(' / ') ?? '未知歌手';

/** 歌曲行（memo 化：大歌单滚动与无关状态更新时不整列表重渲染） */
type RowProps = {
  item: Song;
  index: number;
  multiMode: boolean;
  checked: boolean;
  styles: ReturnType<typeof createStyles>;
  onPress: (item: Song, index: number) => void;
  onLongPress: (item: Song) => void;
  onMore: (item: Song) => void;
};

const SongRow = React.memo(
  ({item, index, multiMode, checked, styles, onPress, onLongPress, onMore}: RowProps) => (
    <TouchableOpacity
      style={styles.item}
      onPress={() => onPress(item, index)}
      onLongPress={multiMode ? undefined : () => onLongPress(item)}
      delayLongPress={400}>
      {multiMode && (
        <View style={[styles.checkbox, checked && styles.checkboxOn]}>
          {checked && <Text style={styles.checkboxTick}>✓</Text>}
        </View>
      )}
      <View style={styles.itemInfo}>
        <Text
          style={[styles.title, item.unplayable && styles.titleOff]}
          numberOfLines={1}>
          {item.title}
        </Text>
        <View style={styles.subRow}>
          {!!item.localPath && (
            <View style={styles.tag}>
              <Text style={styles.tagText}>本地</Text>
            </View>
          )}
          {!!item.unplayable && (
            <View style={styles.tagOff}>
              <Text style={styles.tagOffText}>不可播放</Text>
            </View>
          )}
          <Text
            style={[styles.sub, item.unplayable && styles.titleOff]}
            numberOfLines={1}>
            {singerText(item)}
            {item.album?.name ? ` · ${item.album.name}` : ''}
          </Text>
        </View>
      </View>
      {!multiMode && (
        <TouchableOpacity
          style={styles.moreBtn}
          onPress={() => onMore(item)}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="more" size={16} style={styles.moreIcon} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  ),
);

/**
 * 歌单详情（参考 QQ 音乐歌单列表排版）：
 * - 顶部绿色圆形播放按钮 + 全部播放(N)，右侧排序 / 下载全部 / 多选
 * - 行内两行式排版，右侧「⋮」打开歌曲操作菜单
 * - 长按弹出 删除 / 批量操作；多选模式支持批量添加到歌单、下载、删除
 */
export default function PlaylistDetailScreen({navigation, route}: any) {
  const plId: string = route.params?.id;
  const isFavPl = plId === FAV_PLAYLIST_ID;
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [pl, setPl] = useState<LocalPlaylist | null>(null);
  const [starting, setStarting] = useState(false);
  const [actionSong, setActionSong] = useState<Song | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('default');
  const [sortAsc, setSortAsc] = useState(true);
  // 多选批量模式
  const [multiMode, setMultiMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 批量「添加到歌单」选择弹层
  const [plPicker, setPlPicker] = useState(false);
  const [playlists, setPlaylists] = useState<LocalPlaylist[]>([]);

  const load = useCallback(async () => {
    if (isFavPl) {
      const songs = await getFavSongs();
      setPl({id: FAV_PLAYLIST_ID, name: '我喜欢', songs, createdAt: 0});
    } else {
      const p = await getLocalPlaylist(plId);
      setPl(p ?? null);
    }
  }, [plId, isFavPl]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  /** 展示顺序（排序仅影响显示与播放顺序，不写回歌单） */
  const songs = useMemo(() => {
    const list = [...(pl?.songs ?? [])];
    if (sortKey === 'title') {
      list.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    } else if (sortKey === 'singer') {
      list.sort((a, b) => singerText(a).localeCompare(singerText(b), 'zh'));
    }
    // 倒序：对当前排序结果整体反转（默认排序则为添加顺序的倒序）
    if (!sortAsc) {
      list.reverse();
    }
    return list;
  }, [pl, sortKey, sortAsc]);

  /** 解析器包装：播放中发现的下架歌自动补标（兼容导入时未检测的旧歌单） */
  const resolverWithMark = useCallback(
    async (batch: Song[]) => {
      const resolved = await resolveSongUrls(batch);
      const okKeys = new Set(resolved.map(songKey));
      const bad = batch.filter(s => !s.localPath && !okKeys.has(songKey(s)));
      if (bad.length) {
        const badKeys = new Set(bad.map(songKey));
        markSongsUnplayable(plId, [...badKeys]).catch(() => {});
        // 当前列表立即灰显，无需等下次进入页面
        setPl(prev =>
          prev
            ? {
                ...prev,
                songs: prev.songs.map(s =>
                  badKeys.has(songKey(s)) ? {...s, unplayable: true} : s,
                ),
              }
            : prev,
        );
      }
      return resolved;
    },
    [plId],
  );

  const playAt = async (index: number) => {
    if (!songs.length || starting) {
      return;
    }
    // 过滤掉不可播放的歌（VIP/下架），队列只入可播歌曲
    const playable = songs.filter(s => !s.unplayable);
    if (!playable.length) {
      ToastAndroid.show('歌单中没有可播放的歌曲', ToastAndroid.SHORT);
      return;
    }
    const target = songs[index];
    const startIdx = Math.max(
      playable.findIndex(s => songKey(s) === songKey(target)),
      0,
    );
    setStarting(true);
    try {
      // 渐进式：首批 12 首解析后立即开播，剩余全量占位入队后台替换
      const ok = await playSongsProgressive(playable, startIdx, resolverWithMark);
      if (!ok) {
        AppAlert.alert('播放失败', '无法获取歌曲播放地址');
        return;
      }
      if (autoOpenPlayerEnabled()) {
        navigation.navigate('Player');
      }
    } catch (e) {
      AppAlert.alert('播放失败', '请检查网络后重试');
    } finally {
      setStarting(false);
    }
  };

  /** 移出歌单（我喜欢 = 取消喜欢），本地文件可选一并删除 */
  const onRemove = (song: Song) => {
    const doRemove = async (alsoDeleteFile: boolean) => {
      if (isFavPl) {
        await toggleFav(song);
      } else {
        await removeSongFromPlaylist(plId, song);
      }
      if (alsoDeleteFile && song.localPath) {
        try {
          // 连同歌词/封面/元数据附件一起删除
          await deleteLocalSongWithCompanions(song.localPath);
        } catch (e) {
          AppAlert.alert('文件删除失败', '已移出歌单，但文件可能已被移除或无权限');
        }
      }
      await load();
    };
    const buttons: any[] = [
      {text: '取消', style: 'cancel'},
      {
        text: isFavPl ? '取消喜欢' : '仅移出歌单',
        onPress: () => doRemove(false),
      },
    ];
    if (song.localPath) {
      buttons.push({
        text: '移出并删除本地文件',
        style: 'destructive',
        onPress: () => doRemove(true),
      });
    }
    AppAlert.alert(isFavPl ? '取消喜欢' : '移出歌单', `「${song.title}」`, buttons);
  };

  /** 长按：删除 / 批量操作 */
  const onLongPressSong = (song: Song) => {
    AppAlert.alert(
      `「${song.title}」`,
      undefined,
      [
        {text: '取消', style: 'cancel'},
        {
          text: '批量操作',
          onPress: () => enterMulti(song),
        },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => onRemove(song),
        },
      ],
      {cancelable: true},
    );
  };

  // ===== 排序 / 下载全部 =====

  const onPickSort = () => {
    AppAlert.alert(
      '排序方式',
      `当前：${
        sortKey === 'default' ? '默认排序' : sortKey === 'title' ? '按歌名' : '按歌手'
      } · ${sortAsc ? '正序' : '倒序'}`,
      [
        {text: '默认排序', onPress: () => setSortKey('default')},
        {text: '按歌名', onPress: () => setSortKey('title')},
        {text: '按歌手', onPress: () => setSortKey('singer')},
        {
          text: sortAsc ? '切换为倒序' : '切换为正序',
          onPress: () => setSortAsc(v => !v),
        },
      ],
      {cancelable: true},
    );
  };

  /** 逐首交给下载管理器（跳过本地歌曲） */
  const downloadSongs = async (list: Song[]) => {
    const targets = list.filter(s => !s.localPath);
    if (!targets.length) {
      AppAlert.alert('无需下载', '所选歌曲均已在本地');
      return;
    }
    let ok = 0;
    for (const s of targets) {
      if (await startDownload(s)) {
        ok += 1;
      }
    }
    AppAlert.alert(
      '已加入下载队列',
      `共 ${ok} 首，进度可在「下载管理」中查看`,
    );
  };

  const onDownloadAll = () => {
    if (!songs.length) {
      return;
    }
    AppAlert.alert('下载全部', `将下载 ${songs.length} 首歌曲`, [
      {text: '取消', style: 'cancel'},
      {text: '下载', onPress: () => downloadSongs(songs)},
    ]);
  };

  // ===== 多选批量模式 =====

  const enterMulti = (preselect?: Song) => {
    setSelected(preselect ? new Set([songKey(preselect)]) : new Set());
    setMultiMode(true);
  };

  const exitMulti = () => {
    setMultiMode(false);
    setSelected(new Set());
  };

  const toggleSelect = (song: Song) => {
    const key = songKey(song);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const allSelected = songs.length > 0 && selected.size === songs.length;
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(songs.map(songKey)));
  };

  const selectedSongs = songs.filter(s => selected.has(songKey(s)));

  // 行回调经 ref 中转保持引用稳定，配合 memo 行组件避免大列表整体重渲染
  const rowHandlersRef = useRef({
    onPress: (_item: Song, _index: number) => {},
    onLongPress: (_item: Song) => {},
    onMore: (_item: Song) => {},
  });
  rowHandlersRef.current = {
    onPress: (item, index) => {
      if (multiMode) {
        toggleSelect(item);
        return;
      }
      if (item.unplayable) {
        ToastAndroid.show(
          '该歌曲无法播放（需要VIP或已下架）',
          ToastAndroid.SHORT,
        );
        return;
      }
      playAt(index);
    },
    onLongPress: onLongPressSong,
    onMore: item => setActionSong(item),
  };
  const onRowPress = useCallback(
    (item: Song, index: number) => rowHandlersRef.current.onPress(item, index),
    [],
  );
  const onRowLongPress = useCallback(
    (item: Song) => rowHandlersRef.current.onLongPress(item),
    [],
  );
  const onRowMore = useCallback(
    (item: Song) => rowHandlersRef.current.onMore(item),
    [],
  );

  const openBatchAdd = async () => {
    if (!selectedSongs.length) {
      return;
    }
    setPlaylists(await getLocalPlaylists());
    setPlPicker(true);
  };

  const onBatchAddTo = async (target: 'fav' | LocalPlaylist) => {
    setPlPicker(false);
    if (target === 'fav') {
      const added = await addFavSongs(selectedSongs);
      AppAlert.alert('已添加到"我喜欢"', `新增 ${added} 首`);
    } else {
      const added = await addSongsToPlaylist(target.id, selectedSongs);
      AppAlert.alert(`已添加到《${target.name}》`, `新增 ${added} 首`);
    }
    exitMulti();
  };

  const onBatchDownload = async () => {
    if (!selectedSongs.length) {
      return;
    }
    exitMulti();
    await downloadSongs(selectedSongs);
  };

  const onBatchDelete = () => {
    if (!selectedSongs.length) {
      return;
    }
    AppAlert.alert(
      isFavPl ? '取消喜欢' : '移出歌单',
      `已选定 ${selectedSongs.length} 首`,
      [
        {text: '取消', style: 'cancel'},
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            for (const s of selectedSongs) {
              if (isFavPl) {
                await toggleFav(s);
              } else {
                await removeSongFromPlaylist(plId, s);
              }
            }
            exitMulti();
            await load();
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {multiMode ? (
        // 多选模式顶栏：全选 | 已选定N首 | 完成
        <View style={styles.header}>
          <TouchableOpacity style={styles.selectAll} onPress={toggleSelectAll}>
            <View style={[styles.checkbox, allSelected && styles.checkboxOn]}>
              {allSelected && <Text style={styles.checkboxTick}>✓</Text>}
            </View>
            <Text style={styles.selectAllText}>全选</Text>
          </TouchableOpacity>
          <Text style={styles.multiTitle}>
            {selected.size ? `已选定${selected.size}首` : '请选择歌曲'}
          </Text>
          <TouchableOpacity onPress={exitMulti}>
            <Text style={styles.multiDone}>完成</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.pageTitle} numberOfLines={1}>
            {pl?.name ?? '歌单'}
          </Text>
        </View>
      )}

      {!multiMode && !!songs.length && (
        // 全部播放行：绿色圆形播放 + 数量，右侧 排序 / 下载 / 多选
        <View style={styles.playAllRow}>
          <TouchableOpacity style={styles.playAll} onPress={() => playAt(0)}>
            <View style={styles.playAllBtn}>
              <Icon name="play" size={13} color="#fff" />
            </View>
            <Text style={styles.playAllText}>
              全部播放<Text style={styles.playAllCount}>({songs.length})</Text>
            </Text>
          </TouchableOpacity>
          <View style={styles.toolBtns}>
            <TouchableOpacity
              style={styles.toolBtn}
              onPress={onPickSort}
              hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}>
              <Icon name="sort" size={20} color={t.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.toolBtn}
              onPress={onDownloadAll}
              hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}>
              <Icon name="downloadFilled" size={20} color={t.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.toolBtn}
              onPress={() => enterMulti()}
              hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}>
              <Text style={styles.toolBtnText}>☰</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <FlatList
        data={songs}
        keyExtractor={(item, i) => `${songKey(item)}-${i}`}
        // 大歌单渲染优化：分批渲染 + 收窄渲染窗口 + 裁剪离屏行
        initialNumToRender={12}
        maxToRenderPerBatch={16}
        windowSize={9}
        updateCellsBatchingPeriod={40}
        removeClippedSubviews
        ListEmptyComponent={
          <Text style={styles.empty}>
            歌单是空的{'\n'}可通过其他列表歌曲右侧「⋮」添加到此歌单
          </Text>
        }
        renderItem={({item, index}) => (
          <SongRow
            item={item}
            index={index}
            multiMode={multiMode}
            checked={selected.has(songKey(item))}
            styles={styles}
            onPress={onRowPress}
            onLongPress={onRowLongPress}
            onMore={onRowMore}
          />
        )}
      />

      {/* 多选模式底部操作栏：添加到 / 下载 / 删除 */}
      {multiMode && (
        <View style={styles.batchBar}>
          <TouchableOpacity
            style={styles.batchBtn}
            disabled={!selected.size}
            onPress={openBatchAdd}>
            <Text
              style={[styles.batchIcon, !selected.size && styles.batchOff]}>
              ＋
            </Text>
            <Text
              style={[styles.batchLabel, !selected.size && styles.batchOff]}>
              添加到
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.batchBtn}
            disabled={!selected.size}
            onPress={onBatchDownload}>
            <Icon
              name="downloadFilled"
              size={20}
              style={styles.batchIconImg}
              color={selected.size ? t.text : t.sub}
            />
            <Text
              style={[styles.batchLabel, !selected.size && styles.batchOff]}>
              下载
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.batchBtn}
            disabled={!selected.size}
            onPress={onBatchDelete}>
            <Icon
              name="garbage"
              size={20}
              style={styles.batchIconImg}
              color={selected.size ? t.text : t.sub}
            />
            <Text
              style={[styles.batchLabel, !selected.size && styles.batchOff]}>
              删除
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 批量「添加到歌单」选择弹层 */}
      <Modal
        visible={plPicker}
        transparent
        statusBarTranslucent
        animationType="slide"
        onRequestClose={() => setPlPicker(false)}>
        <TouchableOpacity
          style={styles.sheetMask}
          activeOpacity={1}
          onPress={() => setPlPicker(false)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.sheetTitle}>
              添加 {selectedSongs.length} 首到…
            </Text>
            {!isFavPl && (
              <TouchableOpacity
                style={styles.sheetItem}
                onPress={() => onBatchAddTo('fav')}>
                <Icon name="heart" size={18} />
                <Text style={styles.sheetItemLabel}>我喜欢</Text>
              </TouchableOpacity>
            )}
            <FlatList
              data={playlists.filter(p => p.id !== plId)}
              keyExtractor={p => p.id}
              style={styles.sheetList}
              ListEmptyComponent={
                <Text style={styles.sheetEmpty}>暂无其他歌单</Text>
              }
              renderItem={({item}) => (
                <TouchableOpacity
                  style={styles.sheetItem}
                  onPress={() => onBatchAddTo(item)}>
                  <Text style={styles.sheetItemIcon}>📃</Text>
                  <Text style={styles.sheetItemLabel} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.sheetItemCount}>
                    {item.songs.length} 首
                  </Text>
                </TouchableOpacity>
              )}
            />
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={() => setPlPicker(false)}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <SongActionSheet
        song={actionSong}
        onClose={() => setActionSong(null)}
        onChanged={load}
        extraActions={
          actionSong
            ? [
                {
                  label: isFavPl ? '取消喜欢' : '从本歌单移除',
                  destructive: true,
                  onPress: () => onRemove(actionSong),
                },
              ]
            : undefined
        }
      />

      {starting && (
        <View style={styles.mask}>
          <ActivityIndicator color={t.primary} size="large" />
          <Text style={styles.maskText}>正在加载…</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: t.bg},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    backText: {fontSize: 30, color: t.text, lineHeight: 32, paddingHorizontal: 4},
    pageTitle: {flex: 1, fontSize: 18, fontWeight: '700', color: t.text},
    // 多选顶栏
    selectAll: {flexDirection: 'row', alignItems: 'center', gap: 8},
    selectAllText: {fontSize: 14, color: t.text},
    multiTitle: {
      flex: 1,
      textAlign: 'center',
      fontSize: 16,
      fontWeight: '700',
      color: t.text,
    },
    multiDone: {fontSize: 14, fontWeight: '700', color: t.primary},
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 1.5,
      borderColor: t.sub,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 4,
    },
    checkboxOn: {backgroundColor: t.primary, borderColor: t.primary},
    checkboxTick: {color: '#fff', fontSize: 12, fontWeight: '700'},
    // 全部播放行
    playAllRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    playAll: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    playAllBtn: {
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: t.primary,
      alignItems: 'center',
      justifyContent: 'center',
      paddingLeft: 2,
    },
    playAllText: {fontSize: 15, fontWeight: '700', color: t.text},
    playAllCount: {fontSize: 13, fontWeight: '400', color: t.sub},
    toolBtns: {flexDirection: 'row', alignItems: 'center', gap: 18},
    toolBtn: {alignItems: 'center', justifyContent: 'center'},
    toolBtnText: {fontSize: 19, color: t.text},
    empty: {
      textAlign: 'center',
      color: t.sub,
      marginTop: 40,
      fontSize: 13,
      lineHeight: 22,
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 11,
      paddingLeft: 16,
      paddingRight: 6,
    },
    itemInfo: {flex: 1},
    title: {fontSize: 16, color: t.text},
    subRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 4,
    },
    tag: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.primary,
      borderRadius: 3,
      paddingHorizontal: 3,
      paddingVertical: 0.5,
    },
    tagText: {fontSize: 9, color: t.primary},
    sub: {flex: 1, fontSize: 12, color: t.sub},
    titleOff: {color: t.sub, opacity: 0.45},
    tagOff: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.sub,
      borderRadius: 3,
      paddingHorizontal: 3,
      paddingVertical: 0.5,
      opacity: 0.6,
    },
    tagOffText: {fontSize: 9, color: t.sub},
    moreBtn: {paddingHorizontal: 12, paddingVertical: 6},
    moreIcon: {tintColor: t.sub},
    // 批量底栏
    batchBar: {
      flexDirection: 'row',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
      backgroundColor: t.card,
      paddingVertical: 8,
      paddingBottom: 14,
    },
    batchBtn: {flex: 1, alignItems: 'center', gap: 3},
    batchIcon: {fontSize: 20, color: t.text, lineHeight: 22},
    // 图标区与「＋」文字行高(22)等高，保证三列图标垂直居中对齐
    batchIconImg: {height: 22},
    batchLabel: {fontSize: 11, color: t.text},
    batchOff: {color: t.sub, opacity: 0.6},
    // 歌单选择弹层
    sheetMask: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: t.card,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingTop: 16,
      paddingBottom: 24,
      paddingHorizontal: 20,
      maxHeight: '65%',
    },
    sheetTitle: {
      color: t.text,
      fontSize: 15,
      fontWeight: '700',
      textAlign: 'center',
      marginBottom: 8,
    },
    sheetList: {flexGrow: 0},
    sheetEmpty: {
      textAlign: 'center',
      color: t.sub,
      fontSize: 12,
      paddingVertical: 20,
    },
    sheetItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 13,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    sheetItemIcon: {fontSize: 16, width: 24, textAlign: 'center'},
    sheetItemLabel: {flex: 1, color: t.text, fontSize: 15},
    sheetItemCount: {color: t.sub, fontSize: 12},
    sheetCancel: {
      marginTop: 12,
      backgroundColor: t.sheetBtn,
      borderRadius: 22,
      paddingVertical: 11,
      alignItems: 'center',
    },
    sheetCancelText: {color: t.text, fontSize: 15},
    mask: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: t.mask,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
    },
    maskText: {color: t.text, fontSize: 13},
  });
