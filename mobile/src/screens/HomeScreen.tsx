import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Image,
  Animated,
  RefreshControl,
  LayoutChangeEvent,
} from 'react-native';
import {useRecentSongs} from '../services/store';
import {playSongs} from '../services/player';
import {autoOpenPlayerEnabled, showRankTabEnabled} from '../services/settings';
import {getTopGroups, RankInfo} from '../services/api';
import Icon from '../components/Icon';
import PlaylistSquareScreen from './PlaylistSquareScreen';
import {useSkin} from '../services/skin';
import {useTheme, Theme} from '../theme';

/**
 * 首页固定顶栏（overlay）：推荐｜歌单 双标题 + 下载入口 + 搜索栏。
 * 悬浮在主页 pager 之上不随页滑动；标题/搜索提示随横滑进度交叉渐变，
 * 由页1继续滑向排行页时整体左移淡出。
 */
export function HomeTopBar({
  navigation,
  goTab,
  page,
  scrollX,
  width,
  insetsTop,
  onHeight,
}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  // 推荐(页0)↔歌单(页1) 交叉渐变：scrollX 在 [0, width] 之间
  const recActive = scrollX.interpolate({
    inputRange: [0, width],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const plActive = scrollX.interpolate({
    inputRange: [0, width],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  // 标题：激活项字体放大（scale=1）、非激活项缩小并淡化，随横滑连续过渡
  const INACTIVE_SCALE = 19 / 24;
  const recScale = scrollX.interpolate({
    inputRange: [0, width],
    outputRange: [1, INACTIVE_SCALE],
    extrapolate: 'clamp',
  });
  const plScale = scrollX.interpolate({
    inputRange: [0, width],
    outputRange: [INACTIVE_SCALE, 1],
    extrapolate: 'clamp',
  });
  const recOpacity = scrollX.interpolate({
    inputRange: [0, width],
    outputRange: [1, 0.5],
    extrapolate: 'clamp',
  });
  const plOpacity = scrollX.interpolate({
    inputRange: [0, width],
    outputRange: [0.5, 1],
    extrapolate: 'clamp',
  });
  // 下划线光标：测量两个标题的位置后，随横滑在两者中心之间平移
  const CURSOR_W = 22;
  const [tabBox, setTabBox] = useState<{x: number; w: number}[]>([
    {x: 0, w: 0},
    {x: 0, w: 0},
  ]);
  const onTabLayout = (i: number) => (e: LayoutChangeEvent) => {
    const {x, width: w} = e.nativeEvent.layout;
    setTabBox(prev => {
      if (prev[i].x === x && prev[i].w === w) {
        return prev;
      }
      const next = [...prev];
      next[i] = {x, w};
      return next;
    });
  };
  const cursorX = scrollX.interpolate({
    inputRange: [0, width],
    outputRange: [
      tabBox[0].x + tabBox[0].w / 2 - CURSOR_W / 2,
      tabBox[1].x + tabBox[1].w / 2 - CURSOR_W / 2,
    ],
    extrapolate: 'clamp',
  });
  // 由歌单页(页1)继续滑向排行页(页2)时整体左移并淡出
  const translateX = scrollX.interpolate({
    inputRange: [width, 2 * width],
    outputRange: [0, -width],
    extrapolate: 'clamp',
  });
  const barOpacity = scrollX.interpolate({
    inputRange: [width, 1.5 * width],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  return (
    <Animated.View
      style={[
        styles.overlay,
        {paddingTop: insetsTop, transform: [{translateX}], opacity: barOpacity},
      ]}
      pointerEvents={page <= 1 ? 'auto' : 'none'}
      onLayout={e => onHeight?.(e.nativeEvent.layout.height)}>
      <View style={styles.header}>
        <View style={styles.headerTabs}>
          <TouchableOpacity
            onPress={() => goTab?.(0)}
            activeOpacity={0.8}
            onLayout={onTabLayout(0)}>
            <Animated.Text
              style={[
                styles.headerTitle,
                {opacity: recOpacity, transform: [{scale: recScale}]},
              ]}>
              推荐
            </Animated.Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => goTab?.(1)}
            activeOpacity={0.8}
            onLayout={onTabLayout(1)}>
            <Animated.Text
              style={[
                styles.headerTitle,
                {opacity: plOpacity, transform: [{scale: plScale}]},
              ]}>
              歌单
            </Animated.Text>
          </TouchableOpacity>
          {/* 滑动下划线光标：随横滑在「推荐」「歌单」中心之间平移 */}
          <Animated.View
            style={[styles.tabCursor, {transform: [{translateX: cursorX}]}]}
          />
        </View>
        <TouchableOpacity
          style={styles.headerDisc}
          onPress={() => navigation.navigate('Download')}
          hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
          <Icon name="downloadFilled" size={25} color={t.text} />
        </TouchableOpacity>
      </View>

      {/* 搜索栏：按当前页跳转（歌曲/歌单），提示文案随横滑交叉渐变 */}
      <TouchableOpacity
        style={styles.searchBox}
        activeOpacity={0.8}
        onPress={() =>
          page === 1
            ? navigation.navigate('Search', {tab: 'playlist'})
            : navigation.navigate('Search')
        }>
        <View style={styles.searchInner}>
          <Icon name="search" size={15} />
          <View style={styles.searchHintWrap}>
            <Animated.Text style={[styles.searchHint, {opacity: recActive}]}>
              搜索歌曲、歌手、专辑
            </Animated.Text>
            <Animated.Text
              style={[
                styles.searchHint,
                StyleSheet.absoluteFill,
                {opacity: plActive},
              ]}>
              搜索歌单
            </Animated.Text>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

/** 主页 pager 第二页：歌单广场（顶栏由外层固定 overlay 统一绘制，内容按 topPad 下移） */
export function PlaylistTabPage({navigation, topPad = 0}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const skin = useSkin();
  return (
    <View style={[styles.container, !!skin.bg && styles.transparentBg]}>
      <PlaylistSquareScreen navigation={navigation} topPad={topPad} />
    </View>
  );
}

export default function HomeScreen({navigation, topPad = 0}: any) {
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
    <View style={[styles.container, !!skin.bg && styles.transparentBg]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingTop: topPad}}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            progressViewOffset={topPad}
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
    </View>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: t.bg},
    transparentBg: {backgroundColor: 'transparent'},
    // 固定顶栏 overlay：悬浮在 pager 之上不随页滞动，不透明底遮挡滚动内容
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10,
      paddingBottom: 4,
      backgroundColor: t.bg,
    },
    // 搜索提示层叠容器：首行文本定尺寸，第二行绝对定位叠加做交叉渐变
    searchHintWrap: {justifyContent: 'center'},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    headerTabs: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 18,
      position: 'relative',
    },
    headerTitle: {
      fontSize: 24,
      fontWeight: '800',
      color: t.text,
      paddingBottom: 2,
      // 缩放锚定底部中心：非激活标题缩小时基线保持不变，光标对齐稳定
      transformOrigin: 'center bottom',
    },
    // 滑动下划线光标（宽度需与组件内 CURSOR_W 一致）
    tabCursor: {
      position: 'absolute',
      left: 0,
      bottom: -7,
      width: 22,
      height: 3,
      borderRadius: 2,
      backgroundColor: t.primary,
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
