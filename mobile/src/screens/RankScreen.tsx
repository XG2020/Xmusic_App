import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
  Image,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  getTopGroups,
  getTopSongs,
  resolveSongById,
  resolveSongUrls,
  RankInfo,
} from '../services/api';
import {playSongsProgressive} from '../services/player';
import {autoOpenPlayerEnabled} from '../services/settings';
import SongActionSheet from '../components/SongActionSheet';
import Icon from '../components/Icon';
import {useSkin} from '../services/skin';
import {useTheme, Theme} from '../theme';
import type {Song} from '../types/music';
import {addFavSongs, addSongsToPlaylist, getLocalPlaylists, songKey, LocalPlaylist} from '../services/store';
import {startDownload} from '../services/downloadManager';

// 兜底榜单（接口失败时使用）
const FALLBACK_RANKS: RankInfo[] = [
  {topId: 26, title: '热歌榜'},
  {topId: 27, title: '新歌榜'},
  {topId: 4, title: '流行指数榜'},
  {topId: 62, title: '飙升榜'},
];

/**
 * 榜单歌曲只有 songId，播放前需要换取 mid 再取播放地址。
 * 作为渐进式播放的批量 resolver：补全 mid 后统一解析直链。
 */
async function resolveRankBatch(batch: Song[]): Promise<Song[]> {
  const withMid = (
    await Promise.all(
      batch.map(async s => {
        if (s.mid) {
          return s;
        }
        if (!s.id) {
          return undefined;
        }
        const full = await resolveSongById(s.id);
        return full
          ? {...s, ...full, coverUrl: s.coverUrl ?? full.coverUrl}
          : undefined;
      }),
    )
  ).filter((s): s is Song => !!s?.mid);
  return resolveSongUrls(withMid);
}

export default function RankScreen({navigation, route, lockPager}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  // 皮肤：作为主页 pager 子页且有背景图时容器透明
  const skin = useSkin();
  // 作为独立 Stack 页打开时（底栏入口关闭后从首页榜单卡进入）显示返回键
  const standalone = route?.name === 'Rank';
  const [ranks, setRanks] = useState<RankInfo[]>(FALLBACK_RANKS);
  const [rankId, setRankId] = useState<number>(route?.params?.rankId ?? 26);
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionSong, setActionSong] = useState<Song | null>(null);
  // 榜单分类：收起时横滑胶囊，展开时显示完整网格
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const [multiMode, setMultiMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    getTopGroups()
      .then(list => {
        if (list.length) {
          setRanks(list);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (route?.params?.rankId) {
      setRankId(route.params.rankId);
    }
  }, [route?.params?.rankId]);

  const load = useCallback(async (id: number) => {
    setLoading(true);
    try {
      const list = await getTopSongs(id, 50);
      setSongs(list);
    } catch (e) {
      setSongs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(rankId);
  }, [rankId, load]);

  const pickRank = (nextRankId: number) => {
    setMultiMode(false);
    setSelectedKeys(new Set());
    setChipsExpanded(false);
    if (nextRankId === rankId) {
      return;
    }
    setRankId(nextRankId);
  };

  const playAt = async (index: number) => {
    if (starting) {
      return;
    }
    setStarting(true);
    try {
      // 渐进式：首批 12 首解析后立即开播，剩余后台分批追加
      const ok = await playSongsProgressive(songs, index, resolveRankBatch);
      if (!ok) {
        AppAlert.alert('播放失败', '无法获取播放地址，歌曲可能需要 VIP');
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

  /** 播放全部：从第一首开始渐进式入队 */
  const playAll = () => playAt(0);

  /** 点击行尾「⋮」打开操作菜单；榜单歌曲缺 mid 时先解析补全 */
  const openActions = async (item: Song) => {
    let s = item;
    if (!s.mid && s.id) {
      const full = await resolveSongById(s.id);
      if (full) {
        s = {...s, ...full, coverUrl: s.coverUrl ?? full.coverUrl};
      }
    }
    setActionSong(s);
  };
  const enterMulti = (song?: Song) => { setSelectedKeys(song ? new Set([songKey(song)]) : new Set()); setMultiMode(true); };
  const exitMulti = () => { setMultiMode(false); setSelectedKeys(new Set()); };
  const toggleSelected = (song: Song) => setSelectedKeys(prev => { const n = new Set(prev); const k = songKey(song); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const selectedSongs = songs.filter(s => selectedKeys.has(songKey(s)));
  const resolveSelected = async () => {
    const resolved = await Promise.all(selectedSongs.map(async s => {
      if (s.mid || !s.id) return s;
      const full = await resolveSongById(s.id);
      return full ? {...s, ...full, coverUrl: s.coverUrl ?? full.coverUrl} : s;
    }));
    return resolved;
  };
  const batchAdd = async () => {
    const targets = await resolveSelected();
    let pls: LocalPlaylist[] = []; try { pls = await getLocalPlaylists(); } catch (e) { AppAlert.alert('读取歌单失败', '请稍后重试'); return; }
    AppAlert.alert('批量添加到歌单', '选择目标歌单', [
      {text: `我喜欢（${targets.length} 首）`, onPress: async () => { const n = await addFavSongs(targets); AppAlert.alert('添加完成', n ? `新增 ${n} 首` : '歌曲均已存在'); exitMulti(); }},
      ...pls.map(pl => ({text: `${pl.name}（${pl.songs.length} 首）`, onPress: async () => { const r = await addSongsToPlaylist(pl.id, targets); AppAlert.alert('添加完成', r.limitReached ? `已添加 ${r.added} 首，歌单已达上限` : `新增 ${r.added} 首`); exitMulti(); }})),
      {text: '取消', style: 'cancel' as const},
    ]);
  };
  const batchDownload = async () => {
    const targets = await resolveSelected(); exitMulti(); let n = 0;
    for (const s of targets) { try { if (await startDownload(s)) n++; } catch (e) {} }
    AppAlert.alert(n ? '已加入下载队列' : '无法下载', n ? `共 ${n} 首` : '没有可用播放地址');
  };

  return (
    <SafeAreaView
      style={[styles.container, !!skin.bg && styles.transparentBg]}
      edges={['top']}>
      {multiMode ? <View style={styles.batchBar}>
        <TouchableOpacity onPress={() => setSelectedKeys(selectedKeys.size === songs.length ? new Set() : new Set(songs.map(songKey)))}><Text style={styles.batchAction}>全选</Text></TouchableOpacity>
        <Text style={styles.batchCount}>已选 {selectedKeys.size} 首</Text>
        <TouchableOpacity disabled={!selectedKeys.size} onPress={batchAdd}><Text style={[styles.batchAction, !selectedKeys.size && styles.batchDisabled]}>添加到歌单</Text></TouchableOpacity>
        <TouchableOpacity disabled={!selectedKeys.size} onPress={batchDownload}><Text style={[styles.batchAction, !selectedKeys.size && styles.batchDisabled]}>下载</Text></TouchableOpacity>
        <TouchableOpacity onPress={exitMulti}><Text style={styles.batchAction}>完成</Text></TouchableOpacity>
      </View> : <View style={styles.titleRow}>
        {standalone && (
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
        )}
        <Text style={styles.pageTitle}>排行榜</Text>
      </View>}
      {/* 分类栏：对齐歌单页逻辑，横滑胶囊 + 右侧展开按钮 */}
      <View style={styles.chipsBar}>
        <ScrollView
          horizontal
          style={styles.chipsScroll}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          onTouchStart={() => lockPager?.(true)}
          onTouchEnd={() => lockPager?.(false)}
          onTouchCancel={() => lockPager?.(false)}>
          {ranks.map(r => (
            <TouchableOpacity
              key={r.topId}
              style={[styles.chip, rankId === r.topId && styles.chipActive]}
              onPress={() => pickRank(r.topId)}>
              <Text
                style={[
                  styles.chipText,
                  rankId === r.topId && styles.chipTextActive,
                ]}>
                {r.title}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TouchableOpacity
          style={styles.expandBtn}
          onPress={() => setChipsExpanded(v => !v)}
          hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}>
          <Text style={styles.expandText}>{chipsExpanded ? '收起' : '分类'}</Text>
          <Text style={styles.expandArrow}>{chipsExpanded ? '▲' : '▼'}</Text>
        </TouchableOpacity>
      </View>

      {chipsExpanded ? (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.expandPanel}>
          <Text style={styles.sectionTitle}>全部排行榜</Text>
          <View style={styles.chipsWrap}>
            {ranks.map(r => (
              <TouchableOpacity
                key={r.topId}
                style={[styles.chip, rankId === r.topId && styles.chipActive]}
                onPress={() => pickRank(r.topId)}>
                <Text
                  style={[
                    styles.chipText,
                    rankId === r.topId && styles.chipTextActive,
                  ]}>
                  {r.title}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.bottomSpace} />
        </ScrollView>
      ) : (
        <>
          {/* 播放全部 */}
          {!multiMode && !loading && songs.length > 0 && (
            <TouchableOpacity style={styles.playAllRow} onPress={playAll}>
              <Icon name="play" size={18} color={t.primary} />
              <Text style={styles.playAllText}>播放全部</Text>
              <Text style={styles.playAllCount}>（{songs.length}首）</Text>
            </TouchableOpacity>
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
              keyExtractor={(item, i) => String(item.id ?? `${item.title}-${i}`)}
              initialNumToRender={12}
              maxToRenderPerBatch={16}
              windowSize={9}
              removeClippedSubviews
              ListEmptyComponent={
                <Text style={styles.empty}>榜单加载失败，下拉重试</Text>
              }
              refreshing={loading}
              onRefresh={() => load(rankId)}
              renderItem={({item, index}) => (
                <View style={styles.item}>
                  {/* 主点击区与右侧「⋮」拆成兄弟节点，避免点按钮时误触发行点击 */}
                  <TouchableOpacity
                    style={styles.itemMain}
                    activeOpacity={0.7}
                    onPress={() => (multiMode ? toggleSelected(item) : playAt(index))}
                    onLongPress={multiMode ? undefined : () => enterMulti(item)}
                    delayLongPress={400}>
                    {multiMode && <View style={[styles.checkbox, selectedKeys.has(songKey(item)) && styles.checkboxOn]}>{selectedKeys.has(songKey(item)) && <Text style={styles.checkboxTick}>✓</Text>}</View>}
                    <Text style={[styles.rankNo, index < 3 && styles.rankNoTop]}>
                      {index + 1}
                    </Text>
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
                      </Text>
                    </View>
                  </TouchableOpacity>
                  {!multiMode && <TouchableOpacity
                    style={styles.moreBtn}
                    onPress={() => openActions(item)}
                    hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                    <Icon name="more" size={16} style={styles.moreIcon} />
                  </TouchableOpacity>}
                </View>
              )}
            />
          )}
        </>
      )}

      <SongActionSheet song={actionSong} onClose={() => setActionSong(null)} />

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
    transparentBg: {backgroundColor: 'transparent'},
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 16,
      marginTop: 10,
    },
    backText: {fontSize: 30, color: t.text, lineHeight: 32},
    pageTitle: {
      fontSize: 20,
      fontWeight: '800',
      color: t.text,
    },
    chipsBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingRight: 10,
      marginTop: 4,
    },
    chipsScroll: {flex: 1},
    chips: {paddingHorizontal: 12, gap: 8, alignItems: 'center'},
    expandPanel: {paddingBottom: 12},
    sectionTitle: {
      fontSize: 17,
      fontWeight: '700',
      color: t.text,
      marginHorizontal: 16,
      marginTop: 14,
      marginBottom: 10,
    },
    chipsWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      paddingHorizontal: 12,
    },
    expandBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      paddingLeft: 8,
    },
    expandText: {fontSize: 13, color: t.sub},
    expandArrow: {fontSize: 8, color: t.sub},
    chip: {
      paddingHorizontal: 13,
      paddingVertical: 6,
      borderRadius: 15,
      // 分类胶囊：开启面板色时随板块色，否则保持卡片色
      backgroundColor: t.panel ?? t.card,
    },
    chipActive: {backgroundColor: t.primary},
    chipText: {fontSize: 13, color: t.sub},
    chipTextActive: {color: '#fff', fontWeight: '700'},
    loading: {marginTop: 60},
    playAllRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    playAllText: {fontSize: 15, fontWeight: '700', color: t.text},
    playAllCount: {fontSize: 12, color: t.sub},
    batchBar: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: t.panel ?? t.card},
    batchAction: {color: t.primary, fontSize: 13, fontWeight: '700'},
    batchCount: {flex: 1, color: t.sub, fontSize: 12},
    batchDisabled: {opacity: 0.45},
    checkbox: {width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: t.sub, alignItems: 'center', justifyContent: 'center', marginRight: 8},
    checkboxOn: {backgroundColor: t.primary, borderColor: t.primary},
    checkboxTick: {color: '#fff', fontSize: 12, fontWeight: '700'},
    empty: {textAlign: 'center', color: t.sub, marginTop: 60, fontSize: 13},
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingLeft: 16,
      paddingRight: 4,
    },
    // 行主点击区（占满左侧空间，与右侧按钮兄弟布局）
    itemMain: {flex: 1, flexDirection: 'row', alignItems: 'center'},
    rankNo: {width: 30, fontSize: 16, fontWeight: '700', color: t.sub},
    rankNoTop: {color: '#FF4D4F'},
    cover: {width: 46, height: 46, borderRadius: 8},
    coverFallback: {
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    coverFallbackText: {color: t.sub, fontSize: 18},
    itemInfo: {flex: 1, marginHorizontal: 10},
    title: {fontSize: 15, fontWeight: '600', color: t.text},
    sub: {fontSize: 12, color: t.sub, marginTop: 3},
    moreBtn: {paddingHorizontal: 12, paddingVertical: 6},
    moreIcon: {tintColor: t.sub},
    bottomSpace: {height: 24},
    mask: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: t.mask,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
    },
    maskText: {color: t.text, fontSize: 13},
  });
