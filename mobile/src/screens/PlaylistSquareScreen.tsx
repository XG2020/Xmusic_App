import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import {
  getPlaylistCategories,
  getPlaylistsByCategory,
  CATEGORY_ALL_ID,
  PlaylistCategoryGroup,
  PlaylistCategory,
  PlaylistInfo,
} from '../services/api';
import {useFavPlaylistIds, toggleFavPlaylist} from '../services/store';
import Icon from '../components/Icon';
import {useTheme, Theme} from '../theme';

const PAGE_SIZE = 20;

/** 播放量缩写（12.3万 / 1.2亿） */
export function formatListen(n?: number) {
  if (!n) {
    return '';
  }
  if (n >= 100_000_000) {
    return `${(n / 100_000_000).toFixed(1)}亿`;
  }
  if (n >= 10_000) {
    return `${(n / 10_000).toFixed(1)}万`;
  }
  return String(n);
}

/**
 * 歌单页（主页 pager 第二页）：
 * 顶部搜索入口复用推荐页样式（点击进统一搜索页的歌单分类），
 * 下方为官网歌单广场分类（横滑 chips + 展开全部分组网格），
 * 列表数据来自官方分类接口，点击进入在线歌单页加载歌曲
 */
export default function PlaylistSquareScreen({navigation}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  // 官网分类分组（语种/流派/主题/心情/场景）
  const [groups, setGroups] = useState<PlaylistCategoryGroup[]>([]);
  const [cat, setCat] = useState<PlaylistCategory>({
    id: CATEGORY_ALL_ID,
    name: '全部',
  });
  // 展开全部分类面板
  const [expanded, setExpanded] = useState(false);
  const [list, setList] = useState<PlaylistInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadedRef = useRef(false);
  // 已收藏歌单 id 集合（收藏/取消实时刷新）
  const favIds = useFavPlaylistIds();

  const loadFirst = async (c: PlaylistCategory) => {
    setLoading(true);
    try {
      const res = await getPlaylistsByCategory(c.id, PAGE_SIZE, 1);
      setList(res.list);
      setTotal(res.total);
      setPage(1);
    } catch (e) {
      // 静默失败，保留旧列表
    } finally {
      setLoading(false);
    }
  };

  // 首次进入：拉分类配置 + 默认「全部」歌单
  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true;
      getPlaylistCategories()
        .then(setGroups)
        .catch(() => {});
      loadFirst(cat);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 选择分类：收起面板并重拉第一页 */
  const pickCat = (c: PlaylistCategory) => {
    setExpanded(false);
    if (c.id === cat.id) {
      return;
    }
    setCat(c);
    loadFirst(c);
  };

  /** 滚动到底加载下一页（官方接口 sum 为总数） */
  const loadMore = async () => {
    if (loading || loadingMore || list.length >= total) {
      return;
    }
    setLoadingMore(true);
    try {
      const next = page + 1;
      const res = await getPlaylistsByCategory(cat.id, PAGE_SIZE, next);
      if (res.list.length) {
        setList(prev => [...prev, ...res.list]);
        setPage(next);
      }
      setTotal(res.total);
    } catch (e) {
      // 静默失败，继续滚动可重试
    } finally {
      setLoadingMore(false);
    }
  };

  const openPlaylist = (p: PlaylistInfo) => {
    navigation.navigate('Playlist', {
      id: p.dissid,
      name: p.title,
      ts: Date.now(),
    });
  };

  /** 收藏/取消收藏歌单（只存摘要，「我的」页可见） */
  const onToggleFav = (p: PlaylistInfo) => {
    toggleFavPlaylist({
      id: p.dissid,
      name: p.title,
      coverUrl: p.coverUrl,
      songCount: p.songCount,
    });
  };

  // 横滑 chips：全部分组拍平（含「全部」）
  const flatCats = groups.flatMap(g => g.items);

  return (
    <View style={styles.container}>
      {/* 搜索入口：复用推荐页搜索栏样式，点击进统一搜索页（默认歌单分类） */}
      <TouchableOpacity
        style={styles.searchBox}
        activeOpacity={0.8}
        onPress={() => navigation.navigate('Search', {tab: 'playlist'})}>
        <View style={styles.searchInner}>
          <Icon name="search" size={15} />
          <Text style={styles.searchHint}>搜索歌单</Text>
        </View>
      </TouchableOpacity>

      {/* 分类栏：横滑 chips + 展开全部 */}
      <View style={styles.catBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.catChips}>
          {flatCats.map(c => (
            <TouchableOpacity
              key={c.id}
              style={[styles.catChip, c.id === cat.id && styles.catChipOn]}
              onPress={() => pickCat(c)}>
              <Text
                style={[
                  styles.catChipText,
                  c.id === cat.id && styles.catChipTextOn,
                ]}>
                {c.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TouchableOpacity
          style={styles.catExpandBtn}
          onPress={() => setExpanded(e => !e)}
          hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}>
          <Text style={styles.catExpandText}>{expanded ? '收起' : '分类'}</Text>
          <Text style={styles.catExpandArrow}>{expanded ? '▲' : '▼'}</Text>
        </TouchableOpacity>
      </View>

      {expanded ? (
        // 全部分类面板：按官网分组展示网格
        <ScrollView showsVerticalScrollIndicator={false}>
          {groups.map(g => (
            <View key={g.group}>
              <Text style={styles.catGroupTitle}>{g.group}</Text>
              <View style={styles.catGrid}>
                {g.items.map(c => (
                  <TouchableOpacity
                    key={c.id}
                    style={[
                      styles.catChip,
                      c.id === cat.id && styles.catChipOn,
                    ]}
                    onPress={() => pickCat(c)}>
                    <Text
                      style={[
                        styles.catChipText,
                        c.id === cat.id && styles.catChipTextOn,
                      ]}>
                      {c.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ))}
          <View style={styles.bottomSpace} />
        </ScrollView>
      ) : (
        <>
          <Text style={styles.sectionTitle}>
            {cat.id === CATEGORY_ALL_ID ? '热门歌单' : `${cat.name} · 歌单`}
          </Text>

          {loading ? (
            <ActivityIndicator
              style={styles.loading}
              color={t.primary}
              size="large"
            />
          ) : (
            <FlatList
              showsVerticalScrollIndicator={false}
              data={list}
              keyExtractor={(item, i) => `${item.dissid}-${i}`}
              initialNumToRender={8}
              maxToRenderPerBatch={12}
              windowSize={7}
              removeClippedSubviews
              onEndReached={loadMore}
              onEndReachedThreshold={0.3}
              ListEmptyComponent={
                <Text style={styles.emptyText}>没有找到相关歌单</Text>
              }
              ListFooterComponent={
                loadingMore ? (
                  <ActivityIndicator
                    style={styles.footerLoading}
                    color={t.primary}
                  />
                ) : list.length > 0 && list.length >= total ? (
                  <Text style={styles.footerEnd}>没有更多歌单了</Text>
                ) : (
                  <View style={styles.bottomSpace} />
                )
              }
              renderItem={({item}) => (
                <TouchableOpacity
                  style={styles.plCard}
                  activeOpacity={0.85}
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
                      {item.title}
                    </Text>
                    {!!item.introduction && (
                      <Text style={styles.plDesc} numberOfLines={2}>
                        {item.introduction}
                      </Text>
                    )}
                    <Text style={styles.plMeta} numberOfLines={1}>
                      {[
                        item.songCount ? `${item.songCount}首` : '',
                        item.listenNum
                          ? `${formatListen(item.listenNum)}次播放`
                          : '',
                        item.creatorName ?? '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.favBtn}
                    onPress={() => onToggleFav(item)}
                    hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                    <Icon
                      name={
                        favIds.has(String(item.dissid)) ? 'favOn' : 'favOff'
                      }
                      size={22}
                      color={
                        favIds.has(String(item.dissid)) ? undefined : t.sub
                      }
                    />
                  </TouchableOpacity>
                </TouchableOpacity>
              )}
            />
          )}
        </>
      )}
    </View>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1},
    // 搜索入口：与推荐页搜索栏同款
    searchBox: {
      height: 38,
      borderRadius: 19,
      backgroundColor: t.card,
      justifyContent: 'center',
      paddingHorizontal: 14,
      marginHorizontal: 16,
      marginTop: 12,
      marginBottom: 10,
    },
    searchInner: {flexDirection: 'row', alignItems: 'center', gap: 6},
    searchHint: {fontSize: 13, color: t.sub},
    // 分类栏
    catBar: {flexDirection: 'row', alignItems: 'center', paddingRight: 10},
    catChips: {paddingHorizontal: 12, gap: 8, alignItems: 'center'},
    catChip: {
      backgroundColor: t.card,
      borderRadius: 15,
      paddingHorizontal: 13,
      paddingVertical: 6,
    },
    catChipOn: {backgroundColor: t.primary},
    catChipText: {fontSize: 13, color: t.text},
    catChipTextOn: {color: '#fff', fontWeight: '700'},
    catExpandBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      paddingLeft: 8,
    },
    catExpandText: {fontSize: 13, color: t.sub},
    catExpandArrow: {fontSize: 8, color: t.sub},
    // 展开面板：分组网格
    catGroupTitle: {
      fontSize: 15,
      fontWeight: '700',
      color: t.text,
      marginHorizontal: 16,
      marginTop: 16,
      marginBottom: 10,
    },
    catGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      paddingHorizontal: 12,
    },
    sectionTitle: {
      fontSize: 17,
      fontWeight: '700',
      color: t.text,
      marginHorizontal: 16,
      marginTop: 14,
      marginBottom: 10,
    },
    loading: {marginTop: 40},
    emptyText: {
      color: t.sub,
      fontSize: 13,
      textAlign: 'center',
      marginTop: 40,
    },
    footerLoading: {marginVertical: 16},
    footerEnd: {
      color: t.sub,
      fontSize: 12,
      textAlign: 'center',
      marginVertical: 16,
    },
    bottomSpace: {height: 24},
    // 套用首页榜单卡布局：左封面 / 中简介 / 右收藏
    plCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.card,
      marginHorizontal: 12,
      marginBottom: 10,
      borderRadius: 14,
      padding: 12,
    },
    plCover: {width: 84, height: 84, borderRadius: 10},
    plCoverFallback: {
      backgroundColor: t.cardLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    plCoverFallbackText: {fontSize: 28, color: t.sub},
    plInfo: {flex: 1, marginHorizontal: 12, gap: 3},
    plName: {color: t.text, fontSize: 15, fontWeight: '700', marginBottom: 2},
    plDesc: {color: t.sub, fontSize: 12, lineHeight: 17},
    plMeta: {color: t.sub, fontSize: 11, marginTop: 2},
    favBtn: {paddingHorizontal: 6, paddingVertical: 6},
  });
