import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Image,
  RefreshControl,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useRecentSongs} from '../services/store';
import {playSongs} from '../services/player';
import {autoOpenPlayerEnabled, showRankTabEnabled} from '../services/settings';
import {getTopGroups, RankInfo} from '../services/api';
import Icon from '../components/Icon';
import PlaylistSquareScreen from './PlaylistSquareScreen';
import {useSkin} from '../services/skin';
import {useTheme, Theme} from '../theme';

/** 首页顶部「推荐 | 歌单」双 tab + 下载入口（推荐页与歌单页共用） */
export function HomeHeader({navigation, active, goTab}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return (
    <View style={styles.header}>
      <View style={styles.headerTabs}>
        <TouchableOpacity onPress={() => goTab?.(0)}>
          <Text
            style={active === 0 ? styles.headerTitle : styles.headerTitleDim}>
            推荐
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => goTab?.(1)}>
          <Text
            style={active === 1 ? styles.headerTitle : styles.headerTitleDim}>
            歌单
          </Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity
        style={styles.headerDisc}
        onPress={() => navigation.navigate('Download')}
        hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
        <Icon name="downloadFilled" size={25} color={t.text} />
      </TouchableOpacity>
    </View>
  );
}

/** 主页 pager 第二页：歌单（顶部同款双 tab，内容为歌单搜索页） */
export function PlaylistTabPage({navigation, goTab}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const skin = useSkin();
  return (
    <SafeAreaView
      style={[styles.container, !!skin.bg && styles.transparentBg]}
      edges={['top']}>
      <HomeHeader navigation={navigation} active={1} goTab={goTab} />
      <PlaylistSquareScreen navigation={navigation} />
    </SafeAreaView>
  );
}

export default function HomeScreen({navigation, goTab}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  // 皮肤：有自定义背景图时容器透明露出 MainTabs 层背景
  const skin = useSkin();
  // 最近播放实时订阅（切歌/清空自动刷新）
  const recents = useRecentSongs();
  const [ranks, setRanks] = useState<RankInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadRanks = useCallback(async (force?: boolean) => {
    try {
      const list = await getTopGroups(force);
      setRanks(list.slice(0, 6));
    } catch (e) {
      // 保留旧数据，静默失败
    }
  }, []);

  useEffect(() => {
    loadRanks();
  }, [loadRanks]);

  // 下拉刷新：丢弃缓存重拉榜单（最近播放已实时订阅无需手动刷新）
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadRanks(true);
    setRefreshing(false);
  }, [loadRanks]);

  return (
    <SafeAreaView
          style={[styles.container, !!skin.bg && styles.transparentBg]}
          edges={['top']}>
      {/* 顶部标题栏：推荐 / 歌单 双 tab（歌单页是主页 pager 独立一页，点击切外层） */}
      <HomeHeader navigation={navigation} active={0} goTab={goTab} />

      {/* 搜索栏 */}
      <TouchableOpacity
        style={styles.searchBox}
        activeOpacity={0.8}
        onPress={() => navigation.navigate('Search')}>
        <View style={styles.searchInner}>
          <Icon name="search" size={15} />
          <Text style={styles.searchHint}>搜索歌曲、歌手、专辑</Text>
        </View>
      </TouchableOpacity>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[t.primary]}
            progressBackgroundColor={t.card}
          />
        }>
        {/* 最近播放 */}
        {recents.length > 0 && (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>最近播放</Text>
              <TouchableOpacity
                style={styles.moreBtn}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                onPress={() =>
                  navigation.navigate('Main', {
                    tab: 'mine',
                    mineTab: 'recent',
                    ts: Date.now(),
                  })
                }>
                <Text style={styles.moreText}>更多 ›</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.recentRow}>
              {recents.slice(0, 10).map((s, i) => (
                <TouchableOpacity
                  key={`${s.mid ?? s.localPath ?? s.title}-${i}`}
                  style={styles.recentItem}
                  onPress={() => {
                    playSongs([s]);
                    if (autoOpenPlayerEnabled()) {
                      navigation.navigate('Player');
                    }
                  }}>
                  {s.coverUrl ? (
                    <Image source={{uri: s.coverUrl}} style={styles.recentCover} />
                  ) : (
                    <View style={[styles.recentCover, styles.recentFallback]}>
                      <Text style={styles.recentFallbackText}>♪</Text>
                    </View>
                  )}
                  <Text style={styles.recentTitle} numberOfLines={1}>
                    {s.title}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        )}

        {/* 官方榜单（动态获取，带封面与前三歌曲） */}
        <Text style={styles.sectionTitle}>官方榜单</Text>
        {ranks.length === 0 && (
          <Text style={styles.rankLoading}>榜单加载中…</Text>
        )}
        {ranks.map(r => (
          <TouchableOpacity
            key={r.topId}
            style={styles.rankCard}
            activeOpacity={0.85}
            onPress={() =>
              // 底栏排行入口开启时滑到主页排行页，关闭时打开独立排行榜页
              showRankTabEnabled()
                ? navigation.navigate('Main', {
                    tab: 'rank',
                    rankId: r.topId,
                    ts: Date.now(),
                  })
                : navigation.navigate('Rank', {rankId: r.topId})
            }>
            {r.coverUrl ? (
              <Image source={{uri: r.coverUrl}} style={styles.rankCover} />
            ) : (
              <View style={[styles.rankCover, styles.recentFallback]}>
                <Text style={styles.recentFallbackText}>♪</Text>
              </View>
            )}
            <View style={styles.rankInfo}>
              <Text style={styles.rankName}>{r.title}</Text>
              {(r.top3 ?? []).map((s, i) => (
                <Text key={i} style={styles.rankSong} numberOfLines={1}>
                  {i + 1}. {s.title} - {s.singerName}
                </Text>
              ))}
            </View>
            <Text style={styles.rankArrow}>›</Text>
          </TouchableOpacity>
        ))}
        <View style={styles.bottomSpace} />
      </ScrollView>
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
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    headerTabs: {flexDirection: 'row', alignItems: 'flex-end', gap: 18},
    headerTitle: {
      fontSize: 24,
      fontWeight: '800',
      color: t.text,
      borderBottomWidth: 3,
      borderColor: t.primary,
      paddingBottom: 2,
    },
    // 未选中 tab：灰色无下划线，字号稍小底部对齐
    headerTitleDim: {
      fontSize: 19,
      fontWeight: '700',
      color: t.sub,
      paddingBottom: 4,
    },
    // 下载入口：无底色纯图标
    headerDisc: {
      padding: 4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerDiscText: {color: t.text, fontSize: 16},
    searchBox: {
      height: 38,
      borderRadius: 19,
      backgroundColor: t.card,
      justifyContent: 'center',
      paddingHorizontal: 14,
      marginHorizontal: 16,
      marginTop: 12,
      // 与下方滚动内容留出间隔，避免榜单滑动时视觉上贴住搜索框
      marginBottom: 10,
    },
    searchInner: {flexDirection: 'row', alignItems: 'center', gap: 6},
    searchHint: {fontSize: 13, color: t.sub},
    sectionTitle: {
      fontSize: 17,
      fontWeight: '700',
      color: t.text,
      marginHorizontal: 16,
      marginTop: 20,
      marginBottom: 10,
    },
    sectionRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      paddingRight: 16,
    },
    moreBtn: {marginBottom: 10},
    moreText: {fontSize: 13, color: t.sub},
    recentRow: {paddingHorizontal: 12, gap: 12},
    recentItem: {width: 96},
    recentCover: {width: 96, height: 96, borderRadius: 10},
    recentFallback: {
      backgroundColor: t.cardLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    recentFallbackText: {fontSize: 28, color: t.sub},
    recentTitle: {fontSize: 12, color: t.text, marginTop: 6},
    rankLoading: {color: t.sub, fontSize: 13, marginHorizontal: 16},
    rankCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.card,
      marginHorizontal: 12,
      marginBottom: 10,
      borderRadius: 14,
      padding: 12,
    },
    rankCover: {width: 84, height: 84, borderRadius: 10},
    rankInfo: {flex: 1, marginHorizontal: 12, gap: 3},
    rankName: {color: t.text, fontSize: 15, fontWeight: '700', marginBottom: 2},
    rankSong: {color: t.sub, fontSize: 12},
    rankArrow: {color: t.sub, fontSize: 22, paddingHorizontal: 4},
    bottomSpace: {height: 24},
  });
