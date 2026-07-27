import React, {useEffect, useMemo, useState} from 'react';
import {
  View,
  TextInput,
  FlatList,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  ActivityIndicator,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import {search, getPreferredSongUrls, albumCoverUrl} from '../services/api';
import type {Song} from '../types/music';
import {playSongs} from '../services/player';
import {
  autoOpenPlayerEnabled,
  getSearchHistory,
  addSearchHistory,
  clearSearchHistory,
} from '../services/settings';
import {addRecentSongs} from '../services/store';
import SongActionSheet from '../components/SongActionSheet';
import Icon from '../components/Icon';
import {formatDuration} from '../utils/format';
import {useTheme, Theme} from '../theme';

const PAGE_SIZE = 30;

export default function SearchScreen({navigation}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionSong, setActionSong] = useState<Song | null>(null);
  // 分页：query 为已发起搜索的关键词，滚动到底自动加载下一页
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // 搜索历史（未发起搜索时展示，点击直接搜）
  const [history, setHistory] = useState<string[]>([]);

  useEffect(() => {
    getSearchHistory().then(setHistory);
  }, []);

  /** 拉取一页搜索结果并补充封面和播放直链 */
  const fetchPage = async (kw: string, pageNo: number): Promise<Song[]> => {
    const list = ((await search(kw, 'song', PAGE_SIZE, pageNo)) ?? []) as Song[];
    const mids = list.map(x => x.mid!).filter(Boolean);
    const urls = mids.length ? await getPreferredSongUrls(mids) : {};
    return list.map(s => ({
      ...s,
      coverUrl: albumCoverUrl(s.album),
      url: s.mid ? urls?.[s.mid] : undefined,
    }));
  };

  const doSearch = async (kw: string) => {
    if (!kw) {
      return;
    }
    setLoading(true);
    try {
      const songs = await fetchPage(kw, 1);
      setResults(songs);
      setQuery(kw);
      setPage(1);
      setHasMore(songs.length >= PAGE_SIZE);
      // 搜索成功后记入历史（去重置顶）
      addSearchHistory(kw).then(setHistory).catch(() => {});
    } catch (error) {
      AppAlert.alert('搜索失败', '请检查网络后重试');
    } finally {
      setLoading(false);
    }
  };

  const onSearch = () => doSearch(keyword.trim());

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

  /** 滚动到底加载下一页 */
  const loadMore = async () => {
    if (loading || loadingMore || !hasMore || !query) {
      return;
    }
    setLoadingMore(true);
    try {
      const next = page + 1;
      const songs = await fetchPage(query, next);
      if (songs.length) {
        setResults(prev => [...prev, ...songs]);
        setPage(next);
      }
      setHasMore(songs.length >= PAGE_SIZE);
    } catch (error) {
      // 静默失败，继续滚动可重试
    } finally {
      setLoadingMore(false);
    }
  };

  const playAt = (index: number) => {
    addRecentSongs([results[index]]);
    playSongs(results, index);
    if (autoOpenPlayerEnabled()) {
      navigation.navigate('Player');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.searchBar}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          placeholder="搜索歌曲、歌手、专辑"
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

      {results.length > 0 && (
        <TouchableOpacity style={styles.playAll} onPress={() => playAt(0)}>
          <Text style={styles.playAllIcon}>▶</Text>
          <Text style={styles.playAllText}>播放全部 ({results.length})</Text>
        </TouchableOpacity>
      )}

      {/* 未发起搜索时展示历史记录 */}
      {!loading && !query && history.length > 0 && (
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
        <ActivityIndicator style={styles.loading} color={t.primary} size="large" />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item, i) => `${item.mid ?? item.title}-${i}`}
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator style={styles.footerLoading} color={t.primary} />
            ) : results.length > 0 && !hasMore ? (
              <Text style={styles.footerEnd}>没有更多结果了</Text>
            ) : null
          }
          renderItem={({item, index}) => (
            <TouchableOpacity style={styles.item} onPress={() => playAt(index)}>
              {item.coverUrl ? (
                <Image source={{uri: item.coverUrl}} style={styles.cover} />
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

      <SongActionSheet song={actionSong} onClose={() => setActionSong(null)} />
    </SafeAreaView>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: t.bg},
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
      backgroundColor: t.card,
      borderRadius: 18,
      paddingHorizontal: 14,
      height: 38,
      fontSize: 14,
      color: t.text,
    },
    searchBtn: {paddingHorizontal: 6},
    searchBtnText: {color: t.primary, fontWeight: '700', fontSize: 15},
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
      backgroundColor: t.card,
      borderRadius: 15,
      paddingHorizontal: 14,
      paddingVertical: 7,
      maxWidth: '100%',
    },
    historyChipText: {fontSize: 13, color: t.text},
    loading: {marginTop: 60},
    footerLoading: {paddingVertical: 16},
    footerEnd: {
      textAlign: 'center',
      color: t.sub,
      fontSize: 12,
      paddingVertical: 16,
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingLeft: 16,
      paddingRight: 4,
    },
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
  });
