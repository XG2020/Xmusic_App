import React, {useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  getPlaylist,
  getCachedPlaylist,
  getPreferredSongUrls,
  pinPlaylistCache,
  resolvePlaylistId,
} from '../services/api';
import type {Playlist, Song} from '../types/music';
import {playSongs} from '../services/player';
import {autoOpenPlayerEnabled} from '../services/settings';
import {isConnected, waitForNetworkState} from '../services/network';
import {
  addRecentSongs,
  isFavPlaylist,
  toggleFavPlaylist,
  addFavSongs,
  addSongsToPlaylist,
  getLocalPlaylists,
  hydrateDownloadedSong,
  songKey,
  LocalPlaylist,
} from '../services/store';
import SongActionSheet from '../components/SongActionSheet';
import {startDownload} from '../services/downloadManager';
import Icon from '../components/Icon';
import {useSkin} from '../services/skin';
import {useTheme, Theme} from '../theme';

export default function PlaylistScreen({navigation, route}: any) {
  const {t} = useTheme();
  const skin = useSkin();
  const styles = useMemo(() => createStyles(t), [t]);
  // 从歌单搜索结果进入时带 id/name 参数，自动加载并隐藏手动输入行
  const routeId = route?.params?.id;
  const routeName: string = route?.params?.name ?? '';
  const [playlistId, setPlaylistId] = useState(routeId ? String(routeId) : '');
  const [name, setName] = useState(routeName);
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionSong, setActionSong] = useState<Song | null>(null);
  // 网络歌单歌曲支持长按多选，批量添加到本地歌单
  const [batchMode, setBatchMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // 收藏在线歌单：记录成功加载的 dissid/封面用作收藏摘要
  const [resolvedId, setResolvedId] = useState<string | number | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined);
  const [faved, setFaved] = useState(false);

  const load = async (input?: string) => {
    const text = (input ?? playlistId).trim();
    if (!text) {
      return;
    }
    // 分享短链需请求跟随重定向才能拿到歌单 ID，解析期间也显示加载态
    setLoading(true);
    try {
      const id = await resolvePlaylistId(text);
      if (!id) {
        AppAlert.alert('无法识别', '请输入歌单 ID 或粘贴 QQ 音乐分享链接');
        return;
      }
      await waitForNetworkState();
      const online = isConnected();
      let data: Playlist | undefined;
      if (online) {
        try {
          data = await getPlaylist(id);
        } catch (e) {
          data = await getCachedPlaylist(id);
        }
      } else {
        data = await getCachedPlaylist(id);
      }
      // 在线请求失败时也回退到最近一次歌单缓存，弱网下不丢失已下载歌曲入口。
      if (!data && online) {
        data = await getCachedPlaylist(id);
      }
      if (!data) {
        AppAlert.alert('离线无法打开', '该收藏歌单尚未缓存，请联网打开一次后再离线使用');
        return;
      }
      const list = await Promise.all(
        (data.songs ?? []).map(hydrateDownloadedSong),
      );
      const mids = list
        .filter(s => !s.localPath && !s.uri && !s.filePath)
        .map(s => s.mid!)
        .filter(Boolean);
      const urls =
        mids.length && online ? await getPreferredSongUrls(mids) : {};
      setName(data?.name ?? '');
      setResolvedId(id);
      setCoverUrl(data?.coverUrl);
      isFavPlaylist(id).then(setFaved);
      setSongs(
        list.map(s => ({
          ...s,
          url: s.mid ? urls?.[s.mid] ?? s.url : s.url,
        })),
      );
    } catch (e) {
      AppAlert.alert('加载失败', '请确认歌单 ID 是否正确');
    } finally {
      setLoading(false);
    }
  };

  // 带 id 参数进入（歌单搜索结果点击）时自动加载
  useEffect(() => {
    if (routeId) {
      setPlaylistId(String(routeId));
      load(String(routeId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, route?.params?.ts]);

  const enterBatch = (song?: Song) => {
    setSelectedKeys(song ? new Set([songKey(song)]) : new Set());
    setBatchMode(true);
  };

  const exitBatch = () => {
    setBatchMode(false);
    setSelectedKeys(new Set());
  };

  const toggleBatchSong = (song: Song) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      const key = songKey(song);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedSongs = songs.filter(s => selectedKeys.has(songKey(s)));

  const batchAddToPlaylist = async () => {
    if (!selectedSongs.length) return;
    let local: LocalPlaylist[];
    try {
      local = await getLocalPlaylists();
    } catch (e) {
      AppAlert.alert('读取歌单失败', '请稍后重试');
      return;
    }
    AppAlert.alert('批量添加到歌单', '选择目标歌单', [
      {
        text: `我喜欢（${selectedSongs.length} 首）`,
        onPress: async () => {
          try {
            const added = await addFavSongs(selectedSongs);
            AppAlert.alert('已添加到“我喜欢”', added ? `新增 ${added} 首` : '歌曲均已存在');
            exitBatch();
          } catch (e) {
            AppAlert.alert('添加失败', '请稍后重试');
          }
        },
      },
      ...local.map((pl: LocalPlaylist) => ({
        text: `${pl.name}（${pl.songs.length} 首）`,
        onPress: async () => {
          try {
            const result = await addSongsToPlaylist(pl.id, selectedSongs);
            AppAlert.alert(result.limitReached ? '歌单歌曲已达上限' : `已添加到「${pl.name}」`, result.limitReached ? `已添加 ${result.added} 首，每个歌单最多 1000 首` : result.added ? `新增 ${result.added} 首，重复歌曲已自动去重` : '歌曲已全部存在，无需重复添加');
            exitBatch();
          } catch (e) {
            AppAlert.alert('添加失败', '请稍后重试');
          }
        },
      })),
      {text: '取消', style: 'cancel' as const},
    ]);
  };

  /** 将所选在线歌曲逐首加入全局下载队列。 */
  const batchDownload = async () => {
    const targets = selectedSongs.filter(s => !s.localPath && !s.uri && !s.filePath);
    if (!targets.length) {
      AppAlert.alert('无需下载', '所选歌曲均已在本地');
      return;
    }
    // 先退出多选，避免解析多首下载地址期间界面看起来没有响应。
    exitBatch();
    let started = 0;
    for (const song of targets) {
      try {
        if (await startDownload(song)) started += 1;
      } catch (e) {
        // 单首解析/入队失败不应中断其余歌曲。
      }
    }
    AppAlert.alert(
      started ? '已加入下载队列' : '无法下载',
      started
        ? `共 ${started} 首，进度可在下载管理中查看${
            started < targets.length
              ? `；另有 ${targets.length - started} 首正在下载或暂无可用地址`
              : ''
          }`
        : '所选歌曲正在下载中或没有可用地址',
    );
  };

  const playAt = (index: number) => {
    addRecentSongs([songs[index]]);
    playSongs(songs, index);
    if (autoOpenPlayerEnabled()) {
      navigation.navigate('Player');
    }
  };

  /** 收藏/取消收藏当前歌单（成功加载后才可用） */
  const onToggleFav = async () => {
    if (!resolvedId) {
      return;
    }
    const next = await toggleFavPlaylist({
      id: resolvedId,
      name: name || `歌单 ${resolvedId}`,
      coverUrl: coverUrl ?? songs[0]?.coverUrl,
      songCount: songs.length,
    });
    if (next) {
      // 收藏即把当前歌单内容缓存续期为长缓存，下次进入秒开
      pinPlaylistCache(resolvedId);
    }
    setFaved(next);
  };

  return (
    <SafeAreaView
      style={[styles.container, !!skin.bg && styles.transparentBg]}
      edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle} numberOfLines={1}>
          {name || '歌单'}
        </Text>
      </View>

      {/* 搜索结果进入时隐藏手动输入行（id 已确定） */}
      {!routeId && (
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            placeholder="输入歌单 ID 或粘贴分享链接"
            placeholderTextColor={t.sub}
            value={playlistId}
            onChangeText={setPlaylistId}
            onSubmitEditing={() => load()}
          />
          <TouchableOpacity style={styles.btn} onPress={() => load()}>
            <Text style={styles.btnText}>{loading ? '...' : '加载'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {!!name && !routeId && <Text style={styles.playlistName}>{name}</Text>}
      {batchMode && (
        <View style={styles.batchBar}>
          <TouchableOpacity
            onPress={() =>
              setSelectedKeys(
                selectedKeys.size === songs.length
                  ? new Set()
                  : new Set(songs.map(songKey)),
              )
            }>
            <Text style={styles.batchAction}>全选</Text>
          </TouchableOpacity>
          <Text style={styles.batchCount}>已选 {selectedKeys.size} 首</Text>
          <TouchableOpacity
            disabled={!selectedKeys.size}
            onPress={batchAddToPlaylist}>
            <Text
              style={[
                styles.batchAction,
                !selectedKeys.size && styles.batchDisabled,
              ]}>
              添加到歌单
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            disabled={!selectedKeys.size}
            onPress={batchDownload}>
            <Text
              style={[
                styles.batchAction,
                !selectedKeys.size && styles.batchDisabled,
              ]}>
              下载
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={exitBatch}>
            <Text style={styles.batchAction}>完成</Text>
          </TouchableOpacity>
        </View>
      )}
      {songs.length > 0 && (
        <View style={styles.playAllRow}>
          <TouchableOpacity style={styles.playAll} onPress={() => playAt(0)}>
            <Text style={styles.playAllIcon}>▶</Text>
            <Text style={styles.playAllText}>播放全部 ({songs.length})</Text>
          </TouchableOpacity>
          {/* 在线歌单（有 dissid）才可收藏 */}
          {!!resolvedId && (
            <TouchableOpacity
              style={styles.favBtn}
              onPress={onToggleFav}
              hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
              <Icon
                name={faved ? 'favOn' : 'favOff'}
                size={22}
                color={faved ? undefined : t.sub}
              />
            </TouchableOpacity>
          )}
        </View>
      )}

      {loading ? (
        <ActivityIndicator
          style={styles.loading}
          color={t.primary}
          size="large"
        />
      ) : (
        <FlatList
          showsVerticalScrollIndicator={false}
          data={songs}
          keyExtractor={(item, i) => item.mid ?? `${item.title}-${i}`}
          renderItem={({item, index}) => (
            <View style={styles.item}>
              {/* 主点击区与右侧「⋮」拆成兄弟节点，避免点按钮时误触发行点击 */}
              <TouchableOpacity
                style={styles.itemMain}
                activeOpacity={0.7}
                onPress={() =>
                  batchMode ? toggleBatchSong(item) : playAt(index)
                }
                onLongPress={() => enterBatch(item)}
                delayLongPress={400}>
                {batchMode && (
                  <View
                    style={[
                      styles.batchCheckbox,
                      selectedKeys.has(songKey(item)) && styles.batchCheckboxOn,
                    ]}>
                    {selectedKeys.has(songKey(item)) && (
                      <Text style={styles.batchCheckboxTick}>✓</Text>
                    )}
                  </View>
                )}
                <Text style={styles.index}>{index + 1}</Text>
                <View style={styles.itemInfo}>
                  <Text style={styles.title} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <View style={styles.subRow}>
                    {!!(item.localPath || item.uri || item.filePath) && (
                      <View style={styles.tag}>
                        <Text style={styles.tagText}>本地</Text>
                      </View>
                    )}
                    <Text style={styles.sub} numberOfLines={1}>
                      {item.singer?.map(s => s.name).join(' / ')}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
              {!batchMode && (
                <TouchableOpacity
                  style={styles.moreBtn}
                  onPress={() => setActionSong(item)}
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  <Icon name="more" size={16} style={styles.moreIcon} />
                </TouchableOpacity>
              )}
            </View>
          )}
        />
      )}

      <SongActionSheet song={actionSong} onClose={() => setActionSong(null)} />
    </SafeAreaView>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: t.bg},
    transparentBg: {backgroundColor: 'transparent'},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    backText: {
      fontSize: 30,
      color: t.text,
      lineHeight: 32,
      paddingHorizontal: 4,
    },
    pageTitle: {fontSize: 18, fontWeight: '700', color: t.text, flex: 1},
    row: {flexDirection: 'row', gap: 8, paddingHorizontal: 12},
    input: {
      flex: 1,
      // 搜索框胶囊：开启面板色时随板块色，否则保持卡片色
      backgroundColor: t.panel ?? t.card,
      borderRadius: 18,
      paddingHorizontal: 14,
      height: 38,
      fontSize: 14,
      color: t.text,
    },
    btn: {
      backgroundColor: t.primary,
      paddingHorizontal: 18,
      justifyContent: 'center',
      borderRadius: 18,
    },
    btnText: {color: '#fff', fontWeight: '700'},
    playlistName: {
      fontSize: 16,
      fontWeight: '700',
      color: t.text,
      marginHorizontal: 16,
      marginTop: 12,
    },
    batchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: t.panel ?? t.card,
    },
    batchAction: {color: t.primary, fontSize: 13, fontWeight: '700'},
    batchCount: {flex: 1, color: t.sub, fontSize: 12},
    batchDisabled: {opacity: 0.45},
    batchCheckbox: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 1.5,
      borderColor: t.sub,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 6,
    },
    batchCheckboxOn: {backgroundColor: t.primary, borderColor: t.primary},
    batchCheckboxTick: {color: '#fff', fontSize: 12, fontWeight: '700'},
    playAllRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
    },
    playAll: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 10,
    },
    playAllIcon: {color: t.primary, fontSize: 14},
    playAllText: {fontSize: 14, fontWeight: '700', color: t.text},
    favBtn: {paddingHorizontal: 4, paddingVertical: 6},
    loading: {marginTop: 40},
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingLeft: 16,
      paddingRight: 4,
    },
    // 行主点击区（占满左侧空间，与右侧按钮兄弟布局）
    itemMain: {flex: 1, flexDirection: 'row', alignItems: 'center'},
    index: {width: 30, fontSize: 14, color: t.sub},
    itemInfo: {flex: 1},
    title: {fontSize: 15, fontWeight: '600', color: t.text},
    subRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 3,
    },
    tag: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.primary,
      borderRadius: 3,
      paddingHorizontal: 3,
      paddingVertical: 0.5,
    },
    tagText: {fontSize: 11, color: t.primary},
    sub: {flex: 1, fontSize: 12, color: t.sub},
    moreBtn: {paddingHorizontal: 12, paddingVertical: 6},
    moreIcon: {tintColor: t.sub},
  });
