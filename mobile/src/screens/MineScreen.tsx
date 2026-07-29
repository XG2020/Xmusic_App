import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Modal,
  Image,
  ActivityIndicator,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {useFocusEffect} from '@react-navigation/native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  getFavSongs,
  getLocalPlaylists,
  removeLocalPlaylist,
  createLocalPlaylist,
  renameLocalPlaylist,
  addFavSongs,
  addSongsToPlaylist,
  clearRecentSongs,
  useRecentSongs,
  songKey,
  LocalPlaylist,
  getFavPlaylists,
  subscribeFavPlaylists,
  toggleFavPlaylist,
  updateFavPlaylistMeta,
  replaceLocalPlaylistSongs,
  FavPlaylist,
} from '../services/store';
import {
  getPlaylist,
  getPlaylistFresh,
  resolvePlaylistId,
  resolveSongUrls,
} from '../services/api';
import {playSongs, playSongsProgressive} from '../services/player';
import {autoOpenPlayerEnabled} from '../services/settings';
import SongActionSheet from '../components/SongActionSheet';
import Icon from '../components/Icon';
import {useSkin} from '../services/skin';
import {useTheme, Theme} from '../theme';
import type {Song} from '../types/music';

type TabKey = 'pls' | 'recent';

/** 输入弹窗类型：新建歌单 / 重命名 / 导入链接 */
type InputKind = 'create' | 'rename' | 'import' | null;

export default function MineScreen({navigation, route}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  // 皮肤：三个板块图标可自定义，有全局背景图时容器透明露出背景
  const skin = useSkin();
  const [tab, setTab] = useState<TabKey>('pls');
  const [favs, setFavs] = useState<Song[]>([]);
  // 最近播放实时订阅（切歌/清空自动刷新）
  const recents = useRecentSongs();
  const [playlists, setPlaylists] = useState<LocalPlaylist[]>([]);
  // 收藏的在线歌单（收藏/取消实时同步）
  const [favPls, setFavPls] = useState<FavPlaylist[]>([]);
  const [actionSong, setActionSong] = useState<Song | null>(null);
  // 输入弹窗
  const [inputKind, setInputKind] = useState<InputKind>(null);
  const [inputValue, setInputValue] = useState('');
  const [renameTarget, setRenameTarget] = useState<LocalPlaylist | null>(null);
  const [importing, setImporting] = useState(false);

  const reload = useCallback(() => {
    getFavSongs().then(setFavs);
    getLocalPlaylists().then(setPlaylists);
    getFavPlaylists().then(setFavPls);
  }, []);

  useFocusEffect(reload);

  // 主页 pager 内 useFocusEffect 不一定触发，订阅收藏变更保证实时刷新
  useEffect(() => subscribeFavPlaylists(reload), [reload]);

  // 推荐页「更多」跳转：携带 tab 参数切到最近播放
  useEffect(() => {
    if (route?.params?.tab === 'recent') {
      setTab('recent');
    }
  }, [route?.params?.tab, route?.params?.ts]);

  // ===== 歌单操作 =====

  const openInput = (kind: InputKind, target?: LocalPlaylist) => {
    setRenameTarget(target ?? null);
    setInputValue(kind === 'rename' && target ? target.name : '');
    setInputKind(kind);
  };

  /** 长按自定义歌单：同步更新（导入的） / 重命名 / 删除 */
  const onLongPressPlaylist = (pl: LocalPlaylist) => {
    AppAlert.alert(`《${pl.name}》`, undefined, [
      // 导入的歌单记录了来源 ID，可跟随原歌单同步更新
      ...(pl.sourceId
        ? [{text: '同步更新（跟随原歌单）', onPress: () => syncLocalPl(pl)}]
        : []),
      {text: '重命名', onPress: () => openInput('rename', pl)},
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          AppAlert.alert('删除歌单', `确定删除《${pl.name}》？`, [
            {text: '取消', style: 'cancel'},
            {
              text: '删除',
              style: 'destructive',
              onPress: async () => {
                setPlaylists(await removeLocalPlaylist(pl.id));
              },
            },
          ]);
        },
      },
      {text: '取消', style: 'cancel'},
    ]);
  };

  /** 导入结果二级弹窗：选择合并到哪个已有歌单（我喜欢 + 自定义歌单） */
  const pickMergeTarget = (songs: Song[]) => {
    AppAlert.alert('合并到已有歌单', '选择要合并到的歌单：', [
      {
        text: `我喜欢（${favs.length}首）`,
        onPress: async () => {
          const added = await addFavSongs(songs);
          reload();
          AppAlert.alert(
            '已合并到《我喜欢》',
            added ? `新增 ${added} 首（已自动去重）` : '歌曲均已存在，无新增',
          );
        },
      },
      ...playlists.map(pl => ({
        text: `${pl.name}（${pl.songs.length}首）`,
        onPress: async () => {
          const added = await addSongsToPlaylist(pl.id, songs);
          reload();
          AppAlert.alert(
            `已合并到《${pl.name}》`,
            added ? `新增 ${added} 首（已自动去重）` : '歌曲均已存在，无新增',
          );
        },
      })),
      {text: '取消', style: 'cancel' as const},
    ]);
  };

  /** 导入 QQ 音乐歌单（原设置页逻辑迁移至此） */
  const doImport = async (input: string) => {
    // 分享短链需请求跟随重定向才能拿到歌单 ID，解析全程显示加载遮罩
    setImporting(true);
    try {
      const id = await resolvePlaylistId(input);
      if (!id) {
        AppAlert.alert('无法识别', '请粘贴 QQ 音乐歌单分享链接或输入歌单 ID');
        return;
      }
      const data = await getPlaylist(id);
      const rawSongs = data?.songs ?? [];
      if (!rawSongs.length) {
        AppAlert.alert('导入失败', '歌单为空或不存在');
        return;
      }
      // 导入时一次性检测无播放地址的歌（VIP/下架），打标后列表灰显禁播
      let songs = rawSongs;
      let blocked = 0;
      try {
        const resolved = await resolveSongUrls(rawSongs);
        const playable = new Set(resolved.map(songKey));
        songs = rawSongs.map(s =>
          playable.has(songKey(s)) ? s : {...s, unplayable: true},
        );
        blocked = songs.length - playable.size;
      } catch (e) {
        // 检测失败不阻断导入，后续播放时会自动补标
      }
      const name = data?.name || `歌单 ${id}`;
      AppAlert.alert(
        `《${name}》`,
        `共 ${songs.length} 首歌曲${
          blocked > 0 ? `，其中 ${blocked} 首无法播放（需要VIP或已下架）将标灰` : ''
        }，选择导入方式：`,
        [
        {
          text: '新建本地歌单',
          onPress: async () => {
            // 记录来源歌单 ID，供后续「同步更新」跟随原歌单
            await createLocalPlaylist(name, songs, data?.coverUrl, id);
            reload();
          },
        },
        {
          text: '合并到已有歌单',
          onPress: () => pickMergeTarget(songs),
        },
        {text: '取消', style: 'cancel'},
      ]);
    } catch (e) {
      AppAlert.alert('导入失败', '请检查网络或确认歌单是否公开');
    } finally {
      setImporting(false);
    }
  };

  /** 同步导入的本地歌单：拉取原歌单最新内容整体替换（保留用户改的名字） */
  const syncLocalPl = async (pl: LocalPlaylist) => {
    setImporting(true);
    try {
      const data = await getPlaylistFresh(Number(pl.sourceId));
      const rawSongs = data?.songs ?? [];
      if (!rawSongs.length) {
        AppAlert.alert('同步失败', '原歌单为空或已被删除');
        return;
      }
      // 与导入时一致：重新检测无播放地址的歌，打标灰显
      let songs = rawSongs;
      try {
        const resolved = await resolveSongUrls(rawSongs);
        const playable = new Set(resolved.map(songKey));
        songs = rawSongs.map(s =>
          playable.has(songKey(s)) ? s : {...s, unplayable: true},
        );
      } catch (e) {
        // 检测失败不阻断同步，播放时会自动补标
      }
      const diff = songs.length - pl.songs.length;
      await replaceLocalPlaylistSongs(pl.id, songs, data?.coverUrl);
      reload();
      AppAlert.alert(
        '同步完成',
        `《${pl.name}》现有 ${songs.length} 首${
          diff > 0
            ? `，新增 ${diff} 首`
            : diff < 0
            ? `，减少 ${-diff} 首`
            : '，无变化'
        }`,
      );
    } catch (e) {
      AppAlert.alert('同步失败', '请检查网络或确认原歌单是否公开');
    } finally {
      setImporting(false);
    }
  };

  /** 同步收藏的在线歌单：刷新摘要并丢缓存，下次进入即为最新内容 */
  const syncFavPl = async (pl: FavPlaylist) => {
    setImporting(true);
    try {
      const data = await getPlaylistFresh(Number(pl.id));
      await updateFavPlaylistMeta(pl.id, {
        name: data?.name || pl.name,
        coverUrl: data?.coverUrl ?? pl.coverUrl,
        songCount: data?.songs?.length ?? 0,
      });
      AppAlert.alert(
        '同步完成',
        `《${data?.name || pl.name}》最新共 ${data?.songs?.length ?? 0} 首`,
      );
    } catch (e) {
      AppAlert.alert('同步失败', '请检查网络或确认歌单是否公开');
    } finally {
      setImporting(false);
    }
  };

  /** 输入弹窗确定 */
  const onInputConfirm = async () => {
    const value = inputValue.trim();
    if (!value) {
      return;
    }
    const kind = inputKind;
    setInputKind(null);
    if (kind === 'create') {
      await createLocalPlaylist(value, []);
      reload();
    } else if (kind === 'rename' && renameTarget) {
      setPlaylists(await renameLocalPlaylist(renameTarget.id, value));
    } else if (kind === 'import') {
      await doImport(value);
    }
  };

  /** 长按收藏歌单：同步更新 / 取消收藏（订阅回调自动刷新列表） */
  const onLongPressFavPl = (pl: FavPlaylist) => {
    AppAlert.alert(`《${pl.name}》`, undefined, [
      {text: '同步更新', onPress: () => syncFavPl(pl)},
      {
        text: '取消收藏',
        style: 'destructive',
        onPress: () => {
          toggleFavPlaylist(pl);
        },
      },
      {text: '取消', style: 'cancel'},
    ]);
  };

  /** 歌单 tab 行：我喜欢置顶 + 本地歌单 + 收藏的在线歌单 */
  type PlRow = {key: string; local?: LocalPlaylist; fav?: FavPlaylist};
  const plData: PlRow[] = [
    {
      key: '__fav__',
      local: {id: '__fav__', name: '我喜欢', songs: favs, createdAt: 0},
    },
    ...playlists.map(p => ({key: p.id, local: p})),
    ...favPls.map(p => ({key: `favpl_${p.id}`, fav: p})),
  ];

  /** 全部播放：我喜欢 + 全部本地歌单歌曲（按 songKey 去重，跳过不可播放的歌） */
  const allSongs = useMemo(() => {
    const seen = new Set<string>();
    const out: Song[] = [];
    for (const s of [...favs, ...playlists.flatMap(p => p.songs)]) {
      const k = songKey(s);
      if (!seen.has(k) && !s.unplayable) {
        seen.add(k);
        out.push(s);
      }
    }
    return out;
  }, [favs, playlists]);

  /** 清空最近播放（带确认） */
  const onClearRecent = () => {
    if (!recents.length) {
      return;
    }
    AppAlert.alert('清空最近播放', `确定清空全部 ${recents.length} 条播放记录？`, [
      {text: '取消', style: 'cancel'},
      {
        text: '清空',
        style: 'destructive',
        onPress: () => clearRecentSongs(),
      },
    ]);
  };

  /** 板块卡片图标：皮肤自定义图片优先，未设置时用内置 Icon；
   * 固定高度图标区让自定义图(44)与内置图(30)混搭时三张卡片内容对齐 */
  const renderCardIcon = (uri: string | undefined, fallback: React.ReactNode) => (
    <View style={styles.cardIconBox}>
      {uri ? (
        <Image
          source={{uri}}
          style={styles.cardSkinIcon}
          resizeMode="cover"
          resizeMethod="resize"
        />
      ) : (
        fallback
      )}
    </View>
  );

  return (
    <SafeAreaView
      style={[styles.container, !!skin.bg && styles.transparentBg]}
      edges={['top']}>
      <View style={styles.headerRow}>
        <Text style={styles.pageTitle}>我的</Text>
        <TouchableOpacity
          style={styles.settingsBtn}
          onPress={() => navigation.navigate('Settings')}>
          <Icon name="setting" size={22} color={t.text} />
        </TouchableOpacity>
      </View>

      {/* 入口卡片 */}
      <View style={styles.cards}>
        <TouchableOpacity
          style={styles.card}
          onPress={() => navigation.navigate('Local')}>
          {renderCardIcon(skin.mineLocal, <Icon name="phone" size={30} />)}
          <Text style={styles.cardText}>本地音乐</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.card}
          onPress={() => navigation.navigate('Download')}>
          {renderCardIcon(
            skin.mineDownload,
            <Icon name="downloadFilled" size={30} color={t.primary} />,
          )}
          <Text style={styles.cardText}>下载管理</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.card}
          onPress={() => navigation.navigate('NowPlaying')}>
          {renderCardIcon(skin.mineNowPlaying, <Icon name="headset" size={30} />)}
          <Text style={styles.cardText}>正在播放</Text>
        </TouchableOpacity>
      </View>

      {/* 歌单 / 最近播放 */}
      <View style={styles.tabs}>
        <TouchableOpacity onPress={() => setTab('pls')}>
          <Text style={[styles.tabText, tab === 'pls' && styles.tabActive]}>
            歌单 {plData.length ? `(${plData.length})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setTab('recent')}>
          <Text style={[styles.tabText, tab === 'recent' && styles.tabActive]}>
            最近播放 {recents.length ? `(${recents.length})` : ''}
          </Text>
        </TouchableOpacity>
        <View style={styles.tabSpacer} />
        {tab === 'recent' && recents.length > 0 && (
          <TouchableOpacity
            style={styles.clearRecent}
            onPress={onClearRecent}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="garbage" size={30} color={t.sub} />
          </TouchableOpacity>
        )}
      </View>

      {tab === 'pls' ? (
        <>
          {/* 标题行（参考图）：N张歌单 + 全部播放 / 新建歌单 */}
          <View style={styles.toolbar}>
            <Text style={styles.plCount}>{plData.length}张歌单</Text>
            <View style={styles.toolBtns}>
              <TouchableOpacity
                style={styles.toolBtn}
                onPress={async () => {
                  if (!allSongs.length) {
                    AppAlert.alert('歌单里还没有歌曲');
                    return;
                  }
                  // 渐进式：首批 12 首解析后立即开播，剩余后台分批追加
                  const ok = await playSongsProgressive(
                    allSongs,
                    0,
                    resolveSongUrls,
                  );
                  if (!ok) {
                    AppAlert.alert('播放失败', '无法获取歌曲播放地址');
                    return;
                  }
                  if (autoOpenPlayerEnabled()) {
                    navigation.navigate('Player');
                  }
                }}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="play" size={17} color={t.text} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.toolBtn}
                onPress={() => openInput('create')}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Text style={styles.addIcon}>＋</Text>
              </TouchableOpacity>
            </View>
          </View>
          <FlatList
            showsVerticalScrollIndicator={false}
            data={plData}
            keyExtractor={item => item.key}
            renderItem={({item}) => {
              // 收藏的在线歌单行：点击在线加载，长按取消收藏
              if (item.fav) {
                const fav = item.fav;
                return (
                  <TouchableOpacity
                    style={styles.plItem}
                    onPress={() =>
                      navigation.navigate('Playlist', {
                        id: fav.id,
                        name: fav.name,
                        ts: Date.now(),
                      })
                    }
                    onLongPress={() => onLongPressFavPl(fav)}
                    delayLongPress={400}>
                    <View style={styles.plCover}>
                      {fav.coverUrl ? (
                        <Image
                          source={{uri: fav.coverUrl}}
                          style={styles.plCoverImg}
                        />
                      ) : (
                        <Text style={styles.plCoverPh}>♪</Text>
                      )}
                    </View>
                    <View style={styles.itemInfo}>
                      <Text style={styles.plTitle} numberOfLines={1}>
                        {fav.name}
                      </Text>
                      <Text style={styles.plSub} numberOfLines={1}>
                        {fav.songCount ? `${fav.songCount}首 · ` : ''}收藏的歌单
                      </Text>
                    </View>
                    <Icon name="favOn" size={18} style={styles.plFavMark} />
                    <Text style={styles.chevron}>›</Text>
                  </TouchableOpacity>
                );
              }
              const pl = item.local!;
              const isFavPl = pl.id === '__fav__';
              const cover = pl.coverUrl ?? pl.songs[0]?.coverUrl;
              return (
                <TouchableOpacity
                  style={styles.plItem}
                  onPress={() =>
                    navigation.navigate('PlaylistDetail', {id: pl.id})
                  }
                  onLongPress={
                    isFavPl ? undefined : () => onLongPressPlaylist(pl)
                  }
                  delayLongPress={400}>
                  <View style={styles.plCover}>
                    {cover ? (
                      <Image source={{uri: cover}} style={styles.plCoverImg} />
                    ) : isFavPl ? (
                      <Icon name="heart" size={26} />
                    ) : (
                      <Text style={styles.plCoverPh}>♪</Text>
                    )}
                  </View>
                  <View style={styles.itemInfo}>
                    <Text style={styles.plTitle} numberOfLines={1}>
                      {pl.name}
                    </Text>
                    <Text style={styles.plSub} numberOfLines={1}>
                      {pl.songs.length}首
                    </Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              );
            }}
            ListFooterComponent={
              <TouchableOpacity
                style={styles.plItem}
                onPress={() => openInput('import')}>
                <View style={[styles.plCover, styles.plCoverGhost]}>
                  <Text style={styles.importIcon}>✎</Text>
                </View>
                <View style={styles.itemInfo}>
                  <Text style={styles.plTitle}>导入外部歌单</Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
            }
          />
        </>
      ) : (
        <FlatList
          showsVerticalScrollIndicator={false}
          data={recents}
          keyExtractor={(item, i) =>
            item.mid ?? item.localPath ?? `${item.title}-${i}`
          }
          ListEmptyComponent={<Text style={styles.empty}>暂无播放记录</Text>}
          renderItem={({item, index}) => (
            <TouchableOpacity
              style={styles.item}
              onPress={() => {
                playSongs(recents, index);
                if (autoOpenPlayerEnabled()) {
                  navigation.navigate('Player');
                }
              }}>
              <View style={styles.itemInfo}>
                <Text style={styles.title} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {item.singer?.map(s => s.name).join(' / ') ?? '未知歌手'}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.moreBtn}
                onPress={() => setActionSong(item)}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="more" size={16} style={styles.moreIcon} />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}

      {/* 新建 / 重命名 / 导入输入弹窗 */}
      <Modal
        visible={inputKind !== null}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setInputKind(null)}>
        <View style={styles.dialogMask}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>
              {inputKind === 'create'
                ? '新建歌单'
                : inputKind === 'rename'
                ? '重命名歌单'
                : '导入 QQ 音乐歌单'}
            </Text>
            <TextInput
              style={styles.dialogInput}
              placeholder={
                inputKind === 'import'
                  ? '粘贴歌单分享链接或歌单 ID'
                  : '输入歌单名称'
              }
              placeholderTextColor={t.sub}
              value={inputValue}
              onChangeText={setInputValue}
              onSubmitEditing={onInputConfirm}
              autoFocus
              multiline={inputKind === 'import'}
            />
            <View style={styles.dialogBtns}>
              <TouchableOpacity
                style={styles.dialogBtn}
                onPress={() => setInputKind(null)}>
                <Text style={styles.dialogCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.dialogBtn}
                disabled={importing}
                onPress={onInputConfirm}>
                <Text style={styles.dialogOkText}>
                  {importing ? '解析中…' : '确定'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 导入歌单解析中：全屏加载遮罩 */}
      <Modal visible={importing} transparent statusBarTranslucent>
        <View style={styles.loadingMask}>
          <ActivityIndicator color={t.primary} size="large" />
          <Text style={styles.loadingText}>正在解析歌单…</Text>
        </View>
      </Modal>

      <SongActionSheet
        song={actionSong}
        onClose={() => {
          setActionSong(null);
          reload();
        }}
      />
    </SafeAreaView>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: t.bg},
    // 有自定义背景图时透明，露出 MainTabs 层的背景图
    transparentBg: {backgroundColor: 'transparent'},
    // 图标区固定高度取自定义图尺寸，内置图居中，三张卡片混搭不错位
    cardIconBox: {height: 44, justifyContent: 'center', alignItems: 'center'},
    // 皮肤自定义板块图标：比内置 Icon 大一号更醒目（图片图标视觉上比线条图形显小），圆角裁剪自动缩放
    cardSkinIcon: {width: 44, height: 44, borderRadius: 10},
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 16,
      marginTop: 10,
    },
    pageTitle: {flex: 1, fontSize: 20, fontWeight: '800', color: t.text},
    settingsBtn: {padding: 4},
    cards: {flexDirection: 'row', gap: 10, padding: 12},
    card: {
      flex: 1,
      backgroundColor: t.card,
      borderRadius: 14,
      paddingVertical: 16,
      alignItems: 'center',
      gap: 6,
    },
    cardText: {fontSize: 13, fontWeight: '600', color: t.text},
    tabs: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 20,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    tabText: {fontSize: 15, color: t.sub},
    tabActive: {color: t.primary, fontWeight: '700'},
    tabSpacer: {flex: 1},
    clearRecent: {flexDirection: 'row', alignItems: 'center', gap: 4},
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingBottom: 6,
    },
    plCount: {flex: 1, fontSize: 14, color: t.text, fontWeight: '600'},
    toolBtns: {flexDirection: 'row', alignItems: 'center', gap: 22},
    toolBtn: {padding: 2},
    addIcon: {color: t.text, fontSize: 22, fontWeight: '600'},
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
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
    // 歌单行（参考图：大封面 + 两行式，无分隔线）
    plItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 9,
      paddingHorizontal: 16,
    },
    plCover: {
      width: 56,
      height: 56,
      borderRadius: 12,
      backgroundColor: t.cardLight,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      marginRight: 14,
    },
    plCoverImg: {width: '100%', height: '100%'},
    plCoverPh: {fontSize: 22, color: t.sub},
    plCoverGhost: {opacity: 0.7},
    importIcon: {fontSize: 20, color: t.sub},
    plTitle: {fontSize: 16, fontWeight: '600', color: t.text},
    plSub: {fontSize: 12, color: t.sub, marginTop: 5},
    plFavMark: {marginRight: 2},
    chevron: {color: t.sub, fontSize: 20, paddingHorizontal: 4, marginTop: -2},
    itemInfo: {flex: 1},
    title: {fontSize: 15, fontWeight: '600', color: t.text},
    sub: {fontSize: 12, color: t.sub, marginTop: 3},
    moreBtn: {paddingHorizontal: 8, paddingVertical: 6},
    moreIcon: {tintColor: t.sub},
    // 输入弹窗
    dialogMask: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'center',
      paddingHorizontal: 36,
    },
    dialog: {
      backgroundColor: t.card,
      borderRadius: 14,
      padding: 18,
    },
    dialogTitle: {
      color: t.text,
      fontSize: 16,
      fontWeight: '700',
      textAlign: 'center',
      marginBottom: 12,
    },
    dialogInput: {
      backgroundColor: t.cardLight,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      color: t.text,
      maxHeight: 96,
      textAlignVertical: 'top',
    },
    dialogBtns: {
      flexDirection: 'row',
      marginTop: 14,
      gap: 10,
    },
    dialogBtn: {
      flex: 1,
      paddingVertical: 10,
      alignItems: 'center',
    },
    dialogCancelText: {color: t.sub, fontSize: 15},
    dialogOkText: {color: t.primary, fontSize: 15, fontWeight: '700'},
    // 导入解析加载遮罩
    loadingMask: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
    },
    loadingText: {color: '#fff', fontSize: 13},
  });
