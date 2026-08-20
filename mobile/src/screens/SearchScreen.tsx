import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  TextInput,
  FlatList,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  ActivityIndicator,
  Animated,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  search,
  searchPlaylists,
  getPreferredSongUrls,
  albumCoverUrl,
  pinPlaylistCache,
  PlaylistInfo,
} from '../services/api';
import type {Song} from '../types/music';
import {playSongs} from '../services/player';
import {isConnected, waitForNetworkState} from '../services/network';
import {
  autoOpenPlayerEnabled,
  getSearchHistory,
  addSearchHistory,
  clearSearchHistory,
} from '../services/settings';
import {
  addRecentSongs,
  useFavPlaylistIds,
  toggleFavPlaylist,
  addFavSongs,
  addSongsToPlaylist,
  getLocalPlaylists,
  songKey,
  LocalPlaylist,
  getFavSongs,
  getLocalPlaylist,
} from '../services/store';
import SongActionSheet from '../components/SongActionSheet';
import {startDownload} from '../services/downloadManager';
import Icon from '../components/Icon';
import {formatDuration} from '../utils/format';
import {formatListen} from './PlaylistSquareScreen';
import {useTheme, Theme} from '../theme';
import {useSkin} from '../services/skin';

const PAGE_SIZE = 30;

type SearchTab = 'song' | 'playlist';

export default function SearchScreen({navigation, route}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const fromHomeSearch = !!route?.params?.fromHomeSearch;
  const playlistScope = !!route?.params?.playlistId;
  const playlistId = route?.params?.playlistId as string | undefined;
  const playlistName = route?.params?.playlistName ?? '歌单';
  // 首页搜索框先在上一页完成上移动画；本页只让其下方内容向下展开。
  const bodyEntry = useRef(new Animated.Value(fromHomeSearch ? 0 : 1)).current;
  const bodyTranslateY = bodyEntry.interpolate({
    inputRange: [0, 1],
    outputRange: [-32, 0],
  });
  // 皮肤：搜索页背景图已提升到导航外层统一绘制，本页只在有背景图时改为透明承接。
  const skin = useSkin();
  const [keyword, setKeyword] = useState('');
  // 结果分类：默认歌曲，可切换歌单（切换时懒加载对应类型结果）；
  // 从歌单页搜索入口进入时默认歌单分类
  const [tab, setTab] = useState<SearchTab>(
    route?.params?.tab === 'playlist' ? 'playlist' : 'song',
  );
  const [results, setResults] = useState<Song[]>([]);
  const [playlistSongs, setPlaylistSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionSong, setActionSong] = useState<Song | null>(null);
  // 搜索歌曲支持长按进入多选，批量添加到其他歌单
  const [batchMode, setBatchMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // 分页：query 为已发起搜索的关键词，滚动到底自动加载下一页
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // 分页加载失败（footer 显示点击重试）
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  // 歌单分类结果（独立分页）
  const [plResults, setPlResults] = useState<PlaylistInfo[]>([]);
  const [plPage, setPlPage] = useState(1);
  const [plHasMore, setPlHasMore] = useState(false);
  // 搜索历史（未发起搜索时展示，点击直接搜）
  const [history, setHistory] = useState<string[]>([]);
  // 已收藏歌单 id 集合（收藏/取消实时刷新）
  const favIds = useFavPlaylistIds();

  useEffect(() => {
    if (!playlistScope || !playlistId) return;
    let alive = true;
    (async () => {
      const list = playlistId === '__fav__'
        ? await getFavSongs()
        : (await getLocalPlaylist(playlistId))?.songs ?? [];
      if (!alive) return;
      setTab('song');
      setPlaylistSongs(list);
      setResults(list);
      setQuery('');
    })().catch(() => {
      if (alive) AppAlert.alert('读取歌单失败', '请稍后重试');
    });
    return () => { alive = false; };
  }, [playlistScope, playlistId, route?.params?.ts]);

  useEffect(() => {
    if (!fromHomeSearch) {
      bodyEntry.setValue(1);
      return;
    }
    bodyEntry.setValue(0);
    Animated.timing(bodyEntry, {
      toValue: 1,
      duration: 240,
      useNativeDriver: true,
    }).start();
  }, [bodyEntry, fromHomeSearch]);

  useEffect(() => {
    getSearchHistory().then(setHistory);
  }, []);

  /** 拉取一页歌曲搜索结果并补充封面和播放直链 */
  const fetchPage = async (kw: string, pageNo: number): Promise<Song[]> => {
    const list = ((await search(kw, 'song', PAGE_SIZE, pageNo)) ??
      []) as Song[];
    const mids = list.map(x => x.mid!).filter(Boolean);
    const urls =
      mids.length && isConnected() ? await getPreferredSongUrls(mids) : {};
    return list.map(s => ({
      ...s,
      coverUrl: albumCoverUrl(s.album),
      url: s.mid ? urls?.[s.mid] : undefined,
    }));
  };

  const fetchPlPage = (kw: string, pageNo: number) =>
    searchPlaylists(kw, PAGE_SIZE, pageNo);

  /** 拉取指定分类的第一页并写入对应结果状态 */
  const loadFirstPage = async (kw: string, type: SearchTab) => {
    setLoading(true);
    try {
      if (type === 'song') {
        const songs = await fetchPage(kw, 1);
        setResults(songs);
        setPage(1);
        setHasMore(songs.length >= PAGE_SIZE);
      } else {
        const pls = await fetchPlPage(kw, 1);
        setPlResults(pls);
        setPlPage(1);
        setPlHasMore(pls.length >= PAGE_SIZE);
      }
      return true;
    } catch (error) {
      AppAlert.alert('搜索失败', '请检查网络后重试');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const doSearch = async (kw: string) => {
    if (!kw) {
      if (playlistScope) {
        setResults(playlistSongs);
        setQuery('');
      }
      return;
    }
    if (playlistScope) {
      const q = kw.toLocaleLowerCase();
      setResults(playlistSongs.filter(s => `${s.title} ${s.singer?.map(x => x.name).join(' ') ?? ''} ${s.album?.name ?? ''}`.toLocaleLowerCase().includes(q)));
      setQuery(kw);
      return;
    }
    await waitForNetworkState();
    if (!isConnected()) {
      AppAlert.alert('当前离线', '搜索在线歌曲需要网络连接，本地歌曲可在“我的”或“本地音乐”中使用');
      return;
    }
    // 新关键词：两类旧结果都作废，先拉当前分类，另一类切过去时懒加载
    setResults([]);
    setHasMore(false);
    setPlResults([]);
    setPlHasMore(false);
    const ok = await loadFirstPage(kw, tab);
    if (ok) {
      setQuery(kw);
      // 搜索成功后记入历史（去重置顶）
      addSearchHistory(kw)
        .then(setHistory)
        .catch(() => {});
    }
  };

  const onSearch = () => doSearch(keyword.trim());

  /** 切换分类：已搜索且目标分类还没结果时懒加载第一页 */
  const switchTab = (next: SearchTab) => {
    if (next === tab) {
      return;
    }
    setTab(next);
    if (
      query &&
      (next === 'playlist' ? plResults.length === 0 : results.length === 0)
    ) {
      loadFirstPage(query, next);
    }
  };

  /** 点击历史关键词：回填输入框并直接搜索 */
  const onPickHistory = (kw: string) => {
    setKeyword(kw);
    doSearch(kw);
  };

  const onClearHistory = () => {
    AppAlert.alert('清空搜索历史', '确定清空全部搜索记录？', [
      {text: '取消', style: 'cancel'},
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          setHistory([]);
          clearSearchHistory().catch(() => {});
        },
      },
    ]);
  };

  /** 滚动到底加载下一页（按当前分类独立翻页） */
  const loadMore = async () => {
    if (loading || loadingMore || !query) {
      return;
    }
    if (tab === 'song' ? !hasMore : !plHasMore) {
      return;
    }
    setLoadingMore(true);
    try {
      if (tab === 'song') {
        const next = page + 1;
        const songs = await fetchPage(query, next);
        if (songs.length) {
          setResults(prev => [...prev, ...songs]);
          setPage(next);
        }
        setHasMore(songs.length >= PAGE_SIZE);
      } else {
        const next = plPage + 1;
        const pls = await fetchPlPage(query, next);
        if (pls.length) {
          setPlResults(prev => [...prev, ...pls]);
          setPlPage(next);
        }
        setPlHasMore(pls.length >= PAGE_SIZE);
      }
      setLoadMoreFailed(false);
    } catch (error) {
      // 分页失败：footer 显示点击重试
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

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

  const selectedSongs = results.filter(s => selectedKeys.has(songKey(s)));

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

  /** 将所选搜索结果逐首加入全局下载队列。 */
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
    addRecentSongs([results[index]]);
    playSongs(results, index);
    if (autoOpenPlayerEnabled()) {
      navigation.navigate('Player');
    }
  };

  const openPlaylist = (p: PlaylistInfo) => {
    navigation.navigate('Playlist', {
      id: p.dissid,
      name: p.title,
      ts: Date.now(),
    });
  };

  /** 歌曲结果行 */
  const renderSongItem = ({item, index}: {item: Song; index: number}) => (
    <View style={styles.item}>
      {/* 主点击区与右侧「⋮」拆成兄弟节点，避免点按钮时误触发行点击 */}
      <TouchableOpacity
        style={styles.itemMain}
        activeOpacity={0.7}
        onPress={() => (batchMode ? toggleBatchSong(item) : playAt(index))}
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
        {item.coverUrl ? (
          <Image
            source={{uri: item.coverUrl}}
            style={styles.cover}
            resizeMethod="resize"
          />
        ) : (
          <View style={[styles.cover, styles.coverFallback]}>
            <Text style={styles.coverFallbackText}>♪</Text>
          </View>
        )}
        <View style={styles.itemInfo}>
          <Text style={styles.title} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {item.singer?.map(s => s.name).join(' / ')}
            {item.album?.name ? ` · ${item.album.name}` : ''}
          </Text>
        </View>
        <Text style={styles.duration}>{formatDuration(item.interval)}</Text>
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
  );

  /** 标题内关键词高亮（参考 QQ 音乐搜索结果样式） */
  const highlightTitle = (text: string) => {
    if (!query || !text.includes(query)) {
      return text;
    }
    const parts = text.split(query);
    const out: React.ReactNode[] = [];
    parts.forEach((p, i) => {
      if (i > 0) {
        out.push(
          <Text key={`k${i}`} style={styles.plNameHl}>
            {query}
          </Text>,
        );
      }
      if (p) {
        out.push(p);
      }
    });
    return out;
  };

  /** 歌单结果行（参考图布局：左封面 / 标题+一行元信息 / 右箭头，无卡片底） */
  const renderPlItem = ({item}: {item: PlaylistInfo}) => (
    <TouchableOpacity
      style={styles.plItem}
      activeOpacity={0.7}
      onPress={() => openPlaylist(item)}>
      {item.coverUrl ? (
        <Image
          source={{uri: item.coverUrl}}
          style={styles.plCover}
          resizeMethod="resize"
        />
      ) : (
        <View style={[styles.plCover, styles.plCoverFallback]}>
          <Text style={styles.plCoverFallbackText}>♪</Text>
        </View>
      )}
      <View style={styles.plInfo}>
        <Text style={styles.plName} numberOfLines={1}>
          {highlightTitle(item.title)}
        </Text>
        <Text style={styles.plMeta} numberOfLines={1}>
          {[
            item.songCount ? `${item.songCount}首` : '',
            item.creatorName ?? '',
            item.listenNum ? `${formatListen(item.listenNum)}次播放` : '',
          ]
            .filter(Boolean)
            .join('  ')}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.plFavBtn}
        onPress={async () => {
          const next = await toggleFavPlaylist({
            id: item.dissid,
            name: item.title,
            coverUrl: item.coverUrl,
            songCount: item.songCount,
          });
          if (next) {
            // 若之前打开过该歌单，把已有内容缓存续期为长缓存
            pinPlaylistCache(item.dissid);
          }
        }}
        hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
        <Icon
          name={favIds.has(String(item.dissid)) ? 'favOn' : 'favOff'}
          size={22}
          color={favIds.has(String(item.dissid)) ? undefined : t.sub}
        />
      </TouchableOpacity>
    </TouchableOpacity>
  );

  const isSong = tab === 'song';
  const listData: any[] = isSong ? results : plResults;

  return (
    <View style={[styles.container, !!skin.bg && styles.transparentBg]}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <View style={styles.searchBar}>
          <TouchableOpacity
            style={styles.back}
            onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            placeholder={playlistScope ? `搜索${playlistName}中的歌曲` : tab === 'playlist' ? '搜索歌单' : '搜索歌曲、歌手、专辑'}
            placeholderTextColor={t.sub}
            value={keyword}
            onChangeText={setKeyword}
            onSubmitEditing={onSearch}
            returnKeyType="search"
            autoFocus
          />
          <TouchableOpacity style={styles.searchBtn} onPress={onSearch}>
            <Text style={styles.searchBtnText}>搜索</Text>
          </TouchableOpacity>
        </View>

        <Animated.View
          style={[
            styles.body,
            {opacity: bodyEntry, transform: [{translateY: bodyTranslateY}]},
          ]}>
          {/* 结果分类 tab（文字+下划线风格）：歌曲 / 歌单，仅在发起搜索后显示 */}
          {!!query && !playlistScope && (
            <View style={styles.typeTabs}>
              <TouchableOpacity
                style={styles.typeTab}
                onPress={() => switchTab('song')}>
                <Text
                  style={[
                    styles.typeTabText,
                    isSong && styles.typeTabTextActive,
                  ]}>
                  歌曲
                </Text>
                <View
                  style={[styles.typeTabLine, isSong && styles.typeTabLineOn]}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.typeTab}
                onPress={() => switchTab('playlist')}>
                <Text
                  style={[
                    styles.typeTabText,
                    !isSong && styles.typeTabTextActive,
                  ]}>
                  歌单
                </Text>
                <View
                  style={[styles.typeTabLine, !isSong && styles.typeTabLineOn]}
                />
              </TouchableOpacity>
            </View>
          )}

          {isSong && results.length > 0 && (
            <TouchableOpacity style={styles.playAll} onPress={() => playAt(0)}>
              <Text style={styles.playAllIcon}>▶</Text>
              <Text style={styles.playAllText}>
                播放全部 ({results.length})
              </Text>
            </TouchableOpacity>
          )}

          {isSong && batchMode && (
            <View style={styles.batchBar}>
              <TouchableOpacity
                onPress={() =>
                  setSelectedKeys(
                    selectedKeys.size === results.length
                      ? new Set()
                      : new Set(results.map(songKey)),
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
          {/* 未发起搜索时展示历史记录 */}
          {!playlistScope && !loading && !query && history.length > 0 && (
            <View style={styles.historyWrap}>
              <View style={styles.historyHeader}>
                <Text style={styles.historyTitle}>搜索历史</Text>
                <TouchableOpacity
                  onPress={onClearHistory}
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  <Icon name="garbage" size={30} color={t.sub} />
                </TouchableOpacity>
              </View>
              <View style={styles.historyChips}>
                {history.map(kw => (
                  <TouchableOpacity
                    key={kw}
                    style={styles.historyChip}
                    onPress={() => onPickHistory(kw)}>
                    <Text style={styles.historyChipText} numberOfLines={1}>
                      {kw}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
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
              data={listData}
              keyExtractor={(item, i) =>
                isSong
                  ? `${item.mid ?? item.title}-${i}`
                  : `${item.dissid}-${i}`
              }
              initialNumToRender={12}
              maxToRenderPerBatch={16}
              windowSize={9}
              removeClippedSubviews
              onEndReached={loadMore}
              onEndReachedThreshold={0.3}
              ListEmptyComponent={
                query ? (
                  <Text style={styles.emptyText}>
                    {isSong ? '没有找到相关歌曲' : '没有找到相关歌单'}
                  </Text>
                ) : null
              }
              ListFooterComponent={
                loadingMore ? (
                  <ActivityIndicator
                    style={styles.footerLoading}
                    color={t.primary}
                  />
                ) : loadMoreFailed ? (
                  <TouchableOpacity
                    style={styles.footerRetry}
                    onPress={loadMore}>
                    <Text style={styles.footerRetryText}>
                      加载失败，点击重试
                    </Text>
                  </TouchableOpacity>
                ) : listData.length > 0 && !(isSong ? hasMore : plHasMore) ? (
                  <Text style={styles.footerEnd}>没有更多结果了</Text>
                ) : null
              }
              renderItem={isSong ? renderSongItem : (renderPlItem as any)}
            />
          )}
        </Animated.View>
        <SongActionSheet
          song={actionSong}
          onClose={() => setActionSong(null)}
        />
      </SafeAreaView>
    </View>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: t.bg},
    // 皮肤模式容器透明，让导航外层的整屏背景贯穿页面与迷你播放条
    transparentBg: {backgroundColor: 'transparent'},
    safeArea: {flex: 1},
    body: {flex: 1},
    searchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    back: {paddingHorizontal: 4},
    backText: {fontSize: 30, color: t.text, lineHeight: 32},
    input: {
      flex: 1,
      // 搜索框胶囊：开启面板色时随板块色（自定义色 @ 透明度），否则保持卡片色
      backgroundColor: t.panel ?? t.card,
      borderRadius: 18,
      paddingHorizontal: 14,
      height: 38,
      fontSize: 14,
      color: t.text,
    },
    searchBtn: {paddingHorizontal: 6},
    searchBtnText: {color: t.primary, fontWeight: '700', fontSize: 15},
    // 结果分类 tab（文字+下划线，参考 QQ 音乐搜索页）
    typeTabs: {
      flexDirection: 'row',
      gap: 32,
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 4,
    },
    typeTab: {alignItems: 'center'},
    typeTabText: {fontSize: 15, color: t.text},
    typeTabTextActive: {color: t.primary, fontWeight: '700'},
    typeTabLine: {
      height: 3,
      width: 22,
      borderRadius: 2,
      marginTop: 5,
      backgroundColor: 'transparent',
    },
    typeTabLineOn: {backgroundColor: t.primary},
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
    playAll: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    playAllIcon: {color: t.primary, fontSize: 14},
    playAllText: {fontSize: 14, fontWeight: '700', color: t.text},
    historyWrap: {paddingHorizontal: 16, paddingTop: 8},
    historyHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    historyTitle: {fontSize: 15, fontWeight: '700', color: t.text},
    historyChips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
    historyChip: {
      // 历史词胶囊：开启面板色时随板块色，否则保持卡片色
      backgroundColor: t.panel ?? t.card,
      borderRadius: 15,
      paddingHorizontal: 14,
      paddingVertical: 7,
      maxWidth: '100%',
    },
    historyChipText: {fontSize: 13, color: t.text},
    loading: {marginTop: 60},
    emptyText: {
      color: t.sub,
      fontSize: 13,
      textAlign: 'center',
      marginTop: 40,
    },
    footerLoading: {paddingVertical: 16},
    footerEnd: {
      textAlign: 'center',
      color: t.sub,
      fontSize: 12,
      paddingVertical: 16,
    },
    // 分页失败重试
    footerRetry: {alignItems: 'center', paddingVertical: 16},
    footerRetryText: {color: t.primary, fontSize: 13},
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingLeft: 16,
      paddingRight: 4,
    },
    // 行主点击区（占满左侧空间，与右侧按钮兄弟布局）
    itemMain: {flex: 1, flexDirection: 'row', alignItems: 'center'},
    cover: {width: 44, height: 44, borderRadius: 6},
    coverFallback: {
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    coverFallbackText: {color: t.sub, fontSize: 18},
    itemInfo: {flex: 1, marginHorizontal: 10},
    title: {fontSize: 15, fontWeight: '600', color: t.text},
    sub: {fontSize: 12, color: t.sub, marginTop: 3},
    duration: {fontSize: 12, color: t.sub},
    moreBtn: {paddingHorizontal: 12, paddingVertical: 6},
    moreIcon: {tintColor: t.sub},
    // 歌单结果行（参考图：无卡片底、封面+标题+一行元信息）
    plItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 11,
    },
    plCover: {width: 76, height: 76, borderRadius: 8},
    plCoverFallback: {
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    plCoverFallbackText: {fontSize: 26, color: t.sub},
    plInfo: {flex: 1, marginHorizontal: 14},
    plName: {color: t.text, fontSize: 16, fontWeight: '600'},
    plNameHl: {color: t.primary},
    plMeta: {color: t.sub, fontSize: 12.5, marginTop: 8},
    plFavBtn: {paddingHorizontal: 4, paddingVertical: 6},
  });
