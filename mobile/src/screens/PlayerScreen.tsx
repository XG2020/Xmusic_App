import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  Animated,
  Modal,
  ScrollView,
  Dimensions,
  LayoutChangeEvent,
  PanResponder,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import TrackPlayer, {
  State,
  useActiveTrack,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player';
import {formatDuration} from '../utils/format';
import {useTheme, Theme} from '../theme';
import {useSpin} from '../utils/useSpin';
import {startDownload} from '../services/downloadManager';
import {useSleepTimer} from '../services/sleepTimer';
import {Quality, QUALITY_OPTIONS} from '../services/settings';
import {
  PlayMode,
  getPlayMode,
  seekTo,
  setPlayMode,
  skipToNext,
  skipToPrevious,
} from '../services/player';
import {isFav, toggleFav} from '../services/store';
import Icon, {IconName} from '../components/Icon';
import SongDetailView from './SongDetailScreen';
import LyricView from './LyricScreen';
import type {Song} from '../types/music';

const SCREEN_W = Dimensions.get('window').width;
const PAGES = ['详情', '歌曲', '歌词'];

const MODE_ICON: Record<PlayMode, IconName> = {
  list: 'modeList',
  single: 'modeSingle',
  shuffle: 'modeShuffle',
};

/** 可选播放倍速（1.0 = 原速） */
const RATE_OPTIONS = [
  0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9,
  2.0,
];

/** 倍速对应的图标名：1.0 为 normal，其余按 speed05~speed20（含浮点容差兜底） */
const rateIconName = (r: number): IconName => {
  const match = RATE_OPTIONS.find(v => Math.abs(v - r) < 0.01);
  if (!match || match === 1) {
    return 'speedNormal';
  }
  return `speed${String(Math.round(match * 10)).padStart(2, '0')}` as IconName;
};

export default function PlayerScreen({navigation}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const playback = usePlaybackState();
  const progress = useProgress(500);
  const track = useActiveTrack();
  // 播放模式取全局持久化状态，切换播放列表/重进播放页不重置
  const [mode, setMode] = useState<PlayMode>(getPlayMode());
  const [fav, setFav] = useState(false);
  // 进度条拖动：拖动中的临时比例（null = 未拖动，显示真实进度）
  const [dragPct, setDragPct] = useState<number | null>(null);
  const barWidthRef = useRef(0);
  const dragStartX = useRef(0);
  const durationRef = useRef(0);
  durationRef.current = progress.duration;
  // 睡眠定时器
  const sleepRemain = useSleepTimer();
  // 音质设置（播放音质已移至设置页，这里仅保留下载音质选择弹层）
  const [dlSheet, setDlSheet] = useState(false);
  // 播放倍速
  const [rate, setRate] = useState(1);
  const [speedSheet, setSpeedSheet] = useState(false);

  useEffect(() => {
    TrackPlayer.getRate()
      .then(setRate)
      .catch(() => {});
  }, []);

  const playing = playback.state === State.Playing;

  // 封面连续旋转动画（暂停停在原角度，恢复继续转）
  const rotate = useSpin(playing, 20000);
  // 播放/暂停时唱片轻微缩放，减少生硬感
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.spring(scale, {
      toValue: playing ? 1 : 0.92,
      useNativeDriver: true,
      friction: 7,
      tension: 50,
    }).start();
  }, [playing, scale]);

  // 收藏状态
  useEffect(() => {
    if (track) {
      isFav(trackToSong(track)).then(setFav);
    }
  }, [track]);

  // 左右滑动同级三页（详情 / 歌曲 / 歌词），初始停在中间「歌曲」页
  const pagerRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(1);
  const pagerInit = useRef(false);
  const goPage = (i: number) => {
    pagerRef.current?.scrollTo({x: i * SCREEN_W, animated: true});
    setPage(i);
  };
  const onPagerLayout = () => {
    // 首次布局后定位到中间页（contentOffset 在安卓上不完全可靠，双保险）
    if (!pagerInit.current) {
      pagerInit.current = true;
      pagerRef.current?.scrollTo({x: SCREEN_W, animated: false});
    }
  };

  /** 拖动进度条期间锁定左右翻页，避免手势冲突 */
  const lockPager = (locked: boolean) => {
    pagerRef.current?.setNativeProps({scrollEnabled: !locked});
  };

  // 下滑收起：顶栏与歌曲页支持下拉跟手位移，超过阈值或快速下甩后收起
  const dragY = useRef(new Animated.Value(0)).current;
  const springBack = () => {
    Animated.spring(dragY, {
      toValue: 0,
      useNativeDriver: true,
      friction: 7,
      tension: 60,
    }).start();
  };
  const dismissResponder = useRef(
    PanResponder.create({
      // 仅接管明确向下为主的拖动，不影响点击与横向翻页
      onMoveShouldSetPanResponder: (_e, g) =>
        g.dy > 12 && g.dy > Math.abs(g.dx) * 1.5,
      onPanResponderGrant: () => lockPager(true),
      onPanResponderMove: (_e, g) => {
        dragY.setValue(Math.max(g.dy, 0));
      },
      onPanResponderRelease: (_e, g) => {
        lockPager(false);
        if (g.dy > 120 || g.vy > 0.8) {
          navigation.goBack();
        } else {
          springBack();
        }
      },
      onPanResponderTerminate: () => {
        lockPager(false);
        springBack();
      },
    }),
  ).current;

  const clampRatio = (x: number) =>
    Math.min(Math.max(barWidthRef.current ? x / barWidthRef.current : 0, 0), 1);

  // 进度条支持点击 + 拖动定位（拖动中圆点跟随手指，松手才 seek）
  const barResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // 不让父级横向 pager 抢走手势
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: e => {
        lockPager(true);
        dragStartX.current = e.nativeEvent.locationX;
        setDragPct(clampRatio(e.nativeEvent.locationX));
      },
      onPanResponderMove: (_e, g) => {
        setDragPct(clampRatio(dragStartX.current + g.dx));
      },
      onPanResponderRelease: (_e, g) => {
        lockPager(false);
        const ratio = clampRatio(dragStartX.current + g.dx);
        if (durationRef.current) {
          seekTo(ratio * durationRef.current);
        }
        // 稍延迟恢复真实进度，避免 seek 生效前圆点瞬间跳回
        setTimeout(() => setDragPct(null), 400);
      },
      onPanResponderTerminate: () => {
        lockPager(false);
        setDragPct(null);
      },
    }),
  ).current;

  const cycleMode = async () => {
    const next: PlayMode =
      mode === 'list' ? 'single' : mode === 'single' ? 'shuffle' : 'list';
    setMode(next);
    await setPlayMode(next);
  };

  /** 选择播放倍速 */
  const onPickRate = async (r: number) => {
    setSpeedSheet(false);
    setRate(r);
    try {
      await TrackPlayer.setRate(r);
    } catch (e) {}
  };

  /** 快进/快退指定秒数 */
  const seekBy = (delta: number) => {
    if (!progress.duration) {
      return;
    }
    seekTo(Math.min(Math.max(progress.position + delta, 0), progress.duration));
  };

  /** 下载入口：先选音质 */
  const onDownload = () => {
    if (!track) {
      AppAlert.alert('无法下载', '当前没有正在播放的歌曲');
      return;
    }
    if (!track.mid && (!track.url || String(track.url).startsWith('file://'))) {
      AppAlert.alert('无法下载', '当前歌曲没有在线播放地址');
      return;
    }
    setDlSheet(true);
  };

  /** 按所选音质交给下载管理器后台执行 */
  const doDownload = async (q: Quality) => {
    if (!track) {
      return;
    }
    const ok = await startDownload(trackToSong(track), q);
    if (ok) {
      AppAlert.alert('已开始下载', '进度可在「下载管理」中查看');
    } else {
      AppAlert.alert('无法下载', '该歌曲正在下载中或没有可用地址');
    }
  };

  /** 弹层选中回调：点哪个音质就直接下哪个（不影响设置里的默认下载音质） */
  const onPickQuality = async (q: Quality) => {
    setDlSheet(false);
    await doDownload(q);
  };

  const onToggleFav = async () => {
    if (!track) {
      return;
    }
    const now = await toggleFav(trackToSong(track));
    setFav(now);
  };

  const livePct = progress.duration
    ? (progress.position / progress.duration) * 100
    : 0;
  // 拖动中优先显示手指位置
  const pct = dragPct !== null ? dragPct * 100 : livePct;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* 下滑收起：整屏内容跟手下移 */}
      <Animated.View
        style={[styles.dragWrap, {transform: [{translateY: dragY}]}]}>
        {/* 顶部栏：收起 + 同级页签（详情｜歌曲｜歌词），支持下滑收起 */}
        <View style={styles.header} {...dismissResponder.panHandlers}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Text style={styles.headerBtn}>⌄</Text>
          </TouchableOpacity>
          <View style={styles.tabs}>
            {PAGES.map((label, i) => (
              <React.Fragment key={label}>
                {i > 0 && <Text style={styles.tabDivider}>|</Text>}
                <TouchableOpacity onPress={() => goPage(i)}>
                  <Text style={[styles.tab, page === i && styles.tabActive]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              </React.Fragment>
            ))}
          </View>
          <View style={styles.headerRight} />
        </View>

        {/* 左右滑动同级三页 */}
        <ScrollView
          ref={pagerRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          contentOffset={{x: SCREEN_W, y: 0}}
          onLayout={onPagerLayout}
          onMomentumScrollEnd={e =>
            setPage(Math.round(e.nativeEvent.contentOffset.x / SCREEN_W))
          }>
          {/* 页 1：歌曲详情 */}
          <View style={styles.page}>
            <SongDetailView />
          </View>

          {/* 页 2：歌曲（播放主页），支持下滑收起 */}
          <View style={styles.page} {...dismissResponder.panHandlers}>
            {/* 旋转唱片封面 */}
            <View style={styles.discWrap}>
              <Animated.View
                style={[styles.disc, {transform: [{rotate}, {scale}]}]}>
                {track?.artwork ? (
                  <Image
                    source={{uri: String(track.artwork)}}
                    style={styles.discCover}
                  />
                ) : (
                  <View style={styles.discCenter}>
                    <Text style={styles.discNote}>♪</Text>
                  </View>
                )}
              </Animated.View>
            </View>

            {/* 歌名 + 收藏（封面下方，参考 QQ 音乐） */}
            <View style={styles.songInfo}>
              <View style={styles.songTitleRow}>
                <Text style={styles.songTitle} numberOfLines={1}>
                  {track?.title ?? '未在播放'}
                </Text>
                <TouchableOpacity
                  onPress={onToggleFav}
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  {fav ? (
                    <Icon name="favOn" size={35} />
                  ) : (
                    <Icon name="favOff" size={35} color={t.playerSub} />
                  )}
                </TouchableOpacity>
              </View>
              <Text style={styles.songArtist} numberOfLines={1}>
                {track?.artist ?? ''}
              </Text>
            </View>

            {/* 工具行（进度条右上方）：倍速 / 后退15s / 前进15s / 下载 */}
            <View style={styles.dlRow}>
              <TouchableOpacity
                onPress={() => setSpeedSheet(true)}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon
                  name={rateIconName(rate)}
                  size={40}
                  color={rate !== 1 ? t.primary : t.playerSub}
                />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => seekBy(-15)}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="speedBack15" size={40} color={t.playerSub} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => seekBy(15)}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="speedForward15" size={40} color={t.playerSub} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onDownload}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="downloadOutline" size={40} color={t.playerSub} />
              </TouchableOpacity>
            </View>

            {/* 进度条（可点击/拖动定位） */}
            <View style={styles.progress}>
              <Text style={styles.time}>
                {formatDuration(
                  dragPct !== null && progress.duration
                    ? dragPct * progress.duration
                    : progress.position,
                )}
              </Text>
              <View
                style={styles.barTouch}
                onLayout={(e: LayoutChangeEvent) => {
                  barWidthRef.current = e.nativeEvent.layout.width;
                }}
                {...barResponder.panHandlers}>
                <View style={styles.bar}>
                  <View style={[styles.barFill, {width: `${pct}%`}]} />
                  <View style={[styles.barDot, {left: `${pct}%`}]} />
                </View>
              </View>
              <Text style={styles.time}>
                {formatDuration(progress.duration)}
              </Text>
            </View>

            {/* 播放控制 */}
            <View style={styles.controls}>
              <TouchableOpacity onPress={cycleMode}>
                <Icon name={MODE_ICON[mode]} size={45} color={t.playerSub} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => skipToPrevious()}>
                <Icon name="prev" size={30} color={t.playerText} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.playBtn}
                onPress={() =>
                  playing ? TrackPlayer.pause() : TrackPlayer.play()
                }>
                <Icon
                  name={playing ? 'pause' : 'play'}
                  size={26}
                  color="#fff"
                  style={playing ? undefined : styles.playIconShift}
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => skipToNext(mode)}>
                <Icon name="next" size={30} color={t.playerText} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => navigation.navigate('SleepTimer')}>
                <Icon
                  name="timer"
                  size={35}
                  color={sleepRemain > 0 ? t.primary : t.playerSub}
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* 页 3：歌词 */}
          <View style={styles.page}>
            <LyricView />
          </View>
        </ScrollView>
      </Animated.View>

      {/* 下载音质选择弹层 */}
      <Modal
        visible={dlSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setDlSheet(false)}>
        <TouchableOpacity
          style={styles.sheetMask}
          activeOpacity={1}
          onPress={() => setDlSheet(false)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.sheetTitle}>选择下载音质</Text>
            {/* 点击即下载，不做选中态高亮 */}
            {QUALITY_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={styles.sheetItem}
                onPress={() => onPickQuality(opt.value)}>
                <View style={styles.sheetItemLeft}>
                  <Text style={styles.sheetItemLabel}>{opt.label}</Text>
                  <Text style={styles.sheetItemDesc}>{opt.desc}</Text>
                </View>
              </TouchableOpacity>
            ))}
            <Text style={styles.sheetHint}>高音质不可用时自动降级</Text>
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={() => setDlSheet(false)}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 播放倍速选择弹层 */}
      <Modal
        visible={speedSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setSpeedSheet(false)}>
        <TouchableOpacity
          style={styles.sheetMask}
          activeOpacity={1}
          onPress={() => setSpeedSheet(false)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.sheetTitle}>播放倍速</Text>
            <View style={styles.rateGrid}>
              {RATE_OPTIONS.map(r => {
                const active = Math.abs(rate - r) < 0.01;
                return (
                  <TouchableOpacity
                    key={r}
                    style={[styles.rateItem, active && styles.rateItemActive]}
                    onPress={() => onPickRate(r)}>
                    <Text
                      style={[
                        styles.rateText,
                        active && styles.rateTextActive,
                      ]}>
                      {r.toFixed(1)}x
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={() => setSpeedSheet(false)}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

function trackToSong(track: any): Song {
  return {
    mid: track.mid,
    title: track.title ?? '未知歌曲',
    singer: track.artist ? [{name: String(track.artist)}] : undefined,
    interval: track.duration,
    url: track.url ? String(track.url) : undefined,
    coverUrl: track.artwork ? String(track.artwork) : undefined,
  };
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: t.playerBg},
    dragWrap: {flex: 1},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    /* 收起图标：横向拉宽的 ⌄ */
    headerBtn: {
      color: t.playerText,
      fontSize: 26,
      width: 44,
      textAlign: 'center',
      transform: [{scaleX: 1.9}],
    },
    headerRight: {width: 44},
    tabs: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 14,
    },
    tab: {fontSize: 15, color: t.playerFaint},
    tabActive: {color: t.playerText, fontWeight: '700', fontSize: 16},
    tabDivider: {color: t.playerFaint, fontSize: 12, opacity: 0.5},
    page: {width: SCREEN_W},
    favActive: {color: '#FF5A79'},
    discWrap: {alignItems: 'center', marginTop: 30},
    disc: {
      width: 260,
      height: 260,
      borderRadius: 130,
      backgroundColor: t.discBg,
      borderWidth: 8,
      borderColor: t.discBorder,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    discCover: {width: 244, height: 244, borderRadius: 122},
    discCenter: {
      width: 244,
      height: 244,
      borderRadius: 122,
      backgroundColor: t.isDark ? '#23262B' : '#CBD6E4',
      alignItems: 'center',
      justifyContent: 'center',
    },
    discNote: {fontSize: 64, color: t.playerFaint},
    /* 歌名 + 收藏（封面下方） */
    songInfo: {paddingHorizontal: 28, marginTop: 26},
    songTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    songTitle: {
      flex: 1,
      fontSize: 22,
      fontWeight: '700',
      color: t.playerText,
    },
    favIcon: {fontSize: 24, color: t.playerSub},
    songArtist: {fontSize: 13, color: t.playerSub, marginTop: 6},
    dlRow: {
      flexDirection: 'row',
      alignItems: 'center',
      // 参考 QQ 音乐：工具图标均匀铺满整行
      justifyContent: 'space-evenly',
      paddingHorizontal: 16,
      marginTop: 'auto',
      marginBottom: 6,
    },
    dlIcon: {color: t.playerSub, fontSize: 20, padding: 4},
    progress: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 20,
    },
    barTouch: {flex: 1, paddingVertical: 12},
    bar: {
      height: 3,
      backgroundColor: t.isDark
        ? 'rgba(255,255,255,0.2)'
        : 'rgba(31,42,56,0.15)',
      borderRadius: 2,
    },
    barFill: {
      position: 'absolute',
      left: 0,
      top: 0,
      height: 3,
      backgroundColor: t.primary,
      borderRadius: 2,
    },
    barDot: {
      position: 'absolute',
      top: -4,
      width: 11,
      height: 11,
      borderRadius: 6,
      backgroundColor: t.isDark ? '#fff' : t.primary,
      marginLeft: -5,
    },
    time: {fontSize: 11, color: t.playerSub, width: 40, textAlign: 'center'},
    controls: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-around',
      paddingHorizontal: 24,
      marginTop: 8,
      paddingBottom: 20,
    },
    modeText: {color: t.playerSub, fontSize: 20},
    timerActive: {color: t.primary},
    ctrlIcon: {color: t.playerText, fontSize: 30},
    playBtn: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: t.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // 新播放图标素材已自带右偏居中，仅留微量补偿
    playIconShift: {marginLeft: 1},
    playBtnText: {color: '#fff', fontSize: 22, fontWeight: '700'},
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
    },
    sheetTitle: {
      color: t.text,
      fontSize: 16,
      fontWeight: '700',
      textAlign: 'center',
      marginBottom: 8,
    },
    sheetItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    sheetItemLeft: {flex: 1},
    sheetItemLabel: {color: t.text, fontSize: 15},
    sheetItemDesc: {color: t.sub, fontSize: 11, marginTop: 2},
    sheetHint: {
      color: t.sub,
      fontSize: 11,
      textAlign: 'center',
      marginTop: 10,
    },
    sheetCancel: {
      marginTop: 12,
      backgroundColor: t.sheetBtn,
      borderRadius: 22,
      paddingVertical: 11,
      alignItems: 'center',
    },
    sheetCancelText: {color: t.text, fontSize: 15},
    // 倍速选择网格
    rateGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      justifyContent: 'center',
      paddingVertical: 8,
    },
    rateItem: {
      width: '22%',
      paddingVertical: 9,
      borderRadius: 10,
      backgroundColor: t.cardLight,
      alignItems: 'center',
    },
    rateItemActive: {backgroundColor: t.primary},
    rateText: {color: t.text, fontSize: 14},
    rateTextActive: {color: '#fff', fontWeight: '700'},
  });
