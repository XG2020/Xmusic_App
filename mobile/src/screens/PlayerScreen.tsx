import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
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
  GestureResponderEvent,
  PanResponder,
  TextInput,
  Switch,
  TouchableWithoutFeedback,
  ToastAndroid,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import TrackPlayer, {
  State,
  Track,
  useActiveTrack,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player';
import {formatDuration} from '../utils/format';
import {useTheme, Theme} from '../theme';
import {useSpin} from '../utils/useSpin';
import {startDownload} from '../services/downloadManager';
import {
  useSleepTimer,
  setSleepTimer,
  cancelSleepTimer,
  getSleepMinutes,
  getSleepRemaining,
  getSleepFinishTrack,
  setSleepFinishTrack,
} from '../services/sleepTimer';
import {
  Quality,
  QUALITY_OPTIONS,
  coverSpinEnabled,
  subscribeCoverSpin,
} from '../services/settings';
import {
  PlayMode,
  getPlayMode,
  getPlayModeAsync,
  seekTo,
  setPlayMode,
  skipToNextUser,
  skipToPreviousUser,
  resumeUser,
  getPendingRestoreProgress,
  getPendingRestoreTrack,
  subscribePendingRestore,
} from '../services/player';
import {cacheProgressOf, subscribeCacheProgress} from '../services/songCache';
import {isConnected, subscribeNetwork} from '../services/network';
import {isFav, toggleFav} from '../services/store';
import {useSkin} from '../services/skin';
import AnimatedBottomSheetModal from '../components/AnimatedBottomSheetModal';
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
const TIMER_PRESETS = [15, 30, 45, 60];

function fmtCountdown(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 倍速对应的图标名：1.0 为 normal，其余按 speed05~speed20（含浮点容差兜底） */
const rateIconName = (r: number): IconName => {
  const match = RATE_OPTIONS.find(v => Math.abs(v - r) < 0.01);
  if (!match || match === 1) {
    return 'speedNormal';
  }
  return `speed${String(Math.round(match * 10)).padStart(2, '0')}` as IconName;
};

// 详情页/歌词页内容与父级状态无关（各自订阅所需数据），
// memo 隔离父级重渲（收藏、翻页、弹层开关等），降低播放页常驻开销
const DetailPage = React.memo(SongDetailView);
const LyricPage = React.memo(LyricView);

/**
 * 进度条区（时间 + 可拖动进度条）。
 * 单独订阅 useProgress，避免每 500ms 的进度刷新带动整个播放页重渲。
 */
const ProgressSection = React.memo(function ProgressSection({
  styles,
  lockPager,
  songMid,
  isLocal,
  fallbackPosition = 0,
  fallbackDuration = 0,
}: {
  styles: ReturnType<typeof createStyles>;
  lockPager: (locked: boolean) => void;
  songMid?: string;
  isLocal: boolean;
  fallbackPosition?: number;
  fallbackDuration?: number;
}) {
  const progress = useProgress(500);
  const effectiveDuration = progress.duration || fallbackDuration;
  const effectivePosition =
    progress.duration > 0 || progress.position > 0
      ? progress.position
      : fallbackPosition;
  // 订阅整曲下载进度：缓存条显示「实际能播到哪」，下载推进时刷新本组件
  const [, bumpCache] = useState(0);
  useEffect(() => subscribeCacheProgress(() => bumpCache(x => x + 1)), []);
  // 订阅联网状态：离线时限制只能拖到「已缓存/可离线播放」的区域
  const [connected, setConnected] = useState(isConnected());
  useEffect(() => subscribeNetwork((_t, c) => setConnected(c)), []);
  // 进度条拖动：拖动中的临时比例（null = 未拖动，显示真实进度）
  const [dragPct, setDragPct] = useState<number | null>(null);
  const barWidthRef = useRef(0);
  const dragStartX = useRef(0);
  const durationRef = useRef(0);
  durationRef.current = effectiveDuration;
  // 供拖动松手回调读取最新值（PanResponder 闭包仅在创建时捕获一次）
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  // 整首是否已可离线播放（本地/已整曲缓存）：拖动不受限、且不显示缓存条
  const fullyCachedRef = useRef(false);
  // 离线时「可连续播放到的秒数上限」：拖过此处则定位后暂停
  const playableEndRef = useRef(0);

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
        const dur = durationRef.current;
        if (dur) {
          const target = ratio * dur;
          // 离线 + 在线曲目：拖到尚未缓冲(不可离线播放)的区域会让 ExoPlayer 重新
          // 联网打开数据源，离线必然失败并触发 PlaybackError，反而冲掉已缓冲的音频、
          // 导致这首歌连已听区段都无法继续播放。此时「不 seek」，仅提示，让播放停留在
          // 已缓冲区域（本地/已整曲缓存的歌曲不受限，可任意拖动）。
          if (
            !connectedRef.current &&
            !fullyCachedRef.current &&
            target > playableEndRef.current + 2
          ) {
            ToastAndroid.show('该位置尚未缓存，无法离线播放', ToastAndroid.SHORT);
          } else {
            seekTo(target);
          }
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

  const livePct = effectiveDuration
    ? (effectivePosition / effectiveDuration) * 100
    : 0;
  // 拖动中优先显示手指位置
  const pct = dragPct !== null ? dragPct * 100 : livePct;
  // 整首是否已可离线播放：本地文件(file://) 或 本次已整曲缓存(下载比例≥1)。
  // 掉线瞬间 network.ts 会把已整曲缓存的在线曲目切到本地，二者等价。
  const dlRatio = cacheProgressOf(songMid);
  const fullyCached = isLocal || dlRatio >= 1;
  fullyCachedRef.current = fullyCached;
  const bufferedRatio = effectiveDuration
    ? progress.buffered / effectiveDuration
    : 0;
  // 缓存条仅表示「整曲缓存进度」：
  //   在线联网 → 只显示后台整曲下载比例，不再把播放器 buffered 当成缓存显示
  //   在线离线 → 回退显示 ExoPlayer 实际缓冲到的位置（= 当前还能连续播放到哪）
  //   整首已缓存 → 整首可播，不显示缓存条
  const cacheRatio = fullyCached
    ? 1
    : !connected
    ? bufferedRatio
    : dlRatio;
  const bufferedPct = Math.min(Math.max(cacheRatio, 0), 1) * 100;
  // 在线歌曲缓存完成后仍显示满条；纯本地歌曲没有「缓存中/已缓存」语义，保持不显示
  const showBufferedBar = bufferedPct > 0 && (!!songMid || !isLocal);
  // 离线可连续播放到的秒数（整首已缓存不受限；在线离线以实际缓冲为界）
  playableEndRef.current = fullyCached
    ? durationRef.current
    : bufferedRatio * durationRef.current;

  return (
    <View style={styles.progress}>
      <Text style={styles.time}>
        {formatDuration(
          dragPct !== null && effectiveDuration
            ? dragPct * effectiveDuration
            : effectivePosition,
        )}
      </Text>
      <View
        style={styles.barTouch}
        onLayout={(e: LayoutChangeEvent) => {
          barWidthRef.current = e.nativeEvent.layout.width;
        }}
        {...barResponder.panHandlers}>
        <View style={styles.bar}>
          {/* 缓存进度：恢复为原来叠在播放进度下方的样式 */}
          {showBufferedBar && (
            <View style={[styles.barBuffered, {width: `${bufferedPct}%`}]} />
          )}
          <View style={[styles.barFill, {width: `${pct}%`}]} />
          <View style={[styles.barDot, {left: `${pct}%`}]} />
        </View>
      </View>
      <Text style={styles.time}>{formatDuration(effectiveDuration)}</Text>
    </View>
  );
});

export default function PlayerScreen({navigation}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  // 皮肤：有自定义播放页背景图时铺满整屏，容器随之透明
  const skin = useSkin();
  // 专属播放页背景优先；未设置时回退到软件全局背景图。
  const pageBackground = skin.playerBg ?? skin.bg;
  const pageBackgroundTint = skin.playerBg ? t.playerBg : t.bg;
  const playback = usePlaybackState();
  const nativeTrack = useActiveTrack();
  // 延迟恢复：原生队列为空时回退显示上次会话快照的当前曲目（仅只读展示，不抢音频焦点）。
  // 播放/切歌控件走 resumeUser / skipToXxxUser，仅在「真正播放」时才 materialize 抢焦点，
  // 因此进入播放页「查看」不会打断其他应用，符合「只有点播放才获取焦点」的预期。
  const [pendingTrack, setPendingTrack] = useState<Track | null>(() =>
    getPendingRestoreTrack(),
  );
  const [pendingProgress, setPendingProgress] = useState(() =>
    getPendingRestoreProgress(),
  );
  useEffect(
    () =>
      subscribePendingRestore(() => {
        setPendingTrack(getPendingRestoreTrack());
        setPendingProgress(getPendingRestoreProgress());
      }),
    [],
  );
  const track = nativeTrack ?? pendingTrack;
  // 播放模式取全局持久化状态，切换播放列表/重进播放页不重置
  const [mode, setMode] = useState<PlayMode>(getPlayMode());
  useEffect(() => {
    getPlayModeAsync().then(setMode).catch(() => {});
  }, []);
  const [fav, setFav] = useState(false);
  // 睡眠定时器
  const sleepRemain = useSleepTimer();
  const [timerSheet, setTimerSheet] = useState(false);
  const [sleepMinutes, setSleepMinutesState] = useState(getSleepMinutes());
  const [timerRemain, setTimerRemain] = useState(getSleepRemaining());
  const [finishTrack, setFinishTrackState] = useState(getSleepFinishTrack());
  const [customTimerModal, setCustomTimerModal] = useState(false);
  const [customSleepMin, setCustomSleepMin] = useState('');
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

  const refreshSleepState = useCallback(() => {
    setSleepMinutesState(getSleepMinutes());
    setTimerRemain(getSleepRemaining());
    setFinishTrackState(getSleepFinishTrack());
  }, []);

  useEffect(() => {
    refreshSleepState();
  }, [refreshSleepState, timerSheet, sleepRemain]);

  useEffect(() => {
    if (!timerSheet) {
      return;
    }
    const iv = setInterval(refreshSleepState, 1000);
    return () => clearInterval(iv);
  }, [refreshSleepState, timerSheet]);

  const playing = playback.state === State.Playing;

  // 封面连续旋转动画（暂停停在原角度，恢复继续转），可在设置中关闭
  const [spinOn, setSpinOn] = useState(coverSpinEnabled());
  useEffect(() => subscribeCoverSpin(setSpinOn), []);
  const rotate = useSpin(playing && spinOn, 20000);
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

  /** 拖动进度条期间锁定左右翻页，避免手势冲突（引用稳定，供 memo 子组件使用） */
  const lockPager = useCallback((locked: boolean) => {
    pagerRef.current?.setNativeProps({scrollEnabled: !locked});
  }, []);

  // 方向哨兵：原生横向 ScrollView 只要水平位移超过 touch slop（约 8dp）
  // 就开始翻页，完全不比较垂直分量，拇指斜着下滑很容易误触发翻页。
  // 在手势最初几 dp 先判定方向，非明确横滑立即锁定翻页
  // （setNativeProps 直达原生，能赶在原生 slop 判定之前生效），
  // 手势结束恢复；明确横滑则不干预，翻页手感不变
  const gateStart = useRef({x: 0, y: 0});
  const gateDecided = useRef(false);
  const onGateTouchStart = (e: GestureResponderEvent) => {
    gateStart.current = {x: e.nativeEvent.pageX, y: e.nativeEvent.pageY};
    gateDecided.current = false;
  };
  const onGateTouchMove = (e: GestureResponderEvent) => {
    if (gateDecided.current) {
      return;
    }
    const dx = e.nativeEvent.pageX - gateStart.current.x;
    const dy = e.nativeEvent.pageY - gateStart.current.y;
    // 位移太小方向不可信，继续观察
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) {
      return;
    }
    gateDecided.current = true;
    // 水平分量没有明显大于垂直分量（斜滑/竖滑）→ 禁止翻页
    if (Math.abs(dx) <= Math.abs(dy) * 1.2) {
      lockPager(true);
    }
  };
  const onGateTouchEnd = () => {
    gateDecided.current = false;
    lockPager(false);
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

  const cycleMode = async () => {
    const next: PlayMode =
      mode === 'list' ? 'single' : mode === 'single' ? 'shuffle' : 'list';
    setMode(next);
    await setPlayMode(next);
  };

  /** 选择播放倍速 */
  const onPickRate = async (r: number) => {
    setSpeedSheet(false);
    try {
      await TrackPlayer.setRate(r);
      setRate(r);
    } catch (e) {
      ToastAndroid.show('倍速切换失败', ToastAndroid.SHORT);
    }
  };

  /** 快进/快退指定秒数（按需取一次进度，父组件不常驻订阅 useProgress） */
  const seekBy = async (delta: number) => {
    try {
      const {position, duration} = await TrackPlayer.getProgress();
      if (!duration) {
        return;
      }
      seekTo(Math.min(Math.max(position + delta, 0), duration));
    } catch (e) {}
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
      ToastAndroid.show('已开始下载，进度可在下载管理中查看', ToastAndroid.SHORT);
    } else {
      AppAlert.alert('无法下载', '该歌曲正在下载中或没有可用地址');
    }
  };

  /** 弹层选中回调：点哪个音质就直接下哪个（不影响设置里的默认下载音质） */
  const onPickQuality = async (q: Quality) => {
    setDlSheet(false);
    await doDownload(q);
  };

  const closeCustomSleepModal = () => {
    setCustomSleepMin('');
    setCustomTimerModal(false);
  };

  const openCustomSleepModal = () => {
    setCustomSleepMin(sleepMinutes > 0 ? String(sleepMinutes) : '');
    setCustomTimerModal(true);
  };

  const pickSleep = (min: number) => {
    if (min <= 0) {
      cancelSleepTimer();
    } else {
      setSleepTimer(min);
    }
    refreshSleepState();
    setTimerSheet(false);
    closeCustomSleepModal();
  };

  const onSubmitCustomSleep = () => {
    const min = Math.floor(Number(customSleepMin));
    if (!min || min <= 0 || min > 24 * 60) {
      AppAlert.alert('请输入有效的分钟数（1-1440）');
      return;
    }
    pickSleep(min);
  };

  const [favLoading, setFavLoading] = useState(false);

  const onToggleFav = async () => {
    if (!track || favLoading) {
      return;
    }
    setFavLoading(true);
    try {
      const now = await toggleFav(trackToSong(track));
      setFav(now);
    } catch (e) {
      ToastAndroid.show('收藏操作失败', ToastAndroid.SHORT);
    } finally {
      setFavLoading(false);
    }
  };

  return (
    <View style={styles.bgWrap}>
      {/* 自定义播放页背景图：铺满整屏（含状态栏底下），未设置时用主题底色 */}
      {!!pageBackground && (
        <>
          <Image
            source={{uri: pageBackground}}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            resizeMethod="resize"
          />
          {/* 主题色半透明遮罩：压暗/压亮背景图，保证歌词、标题等内容可读 */}
          <View
            style={[
              StyleSheet.absoluteFill,
              {backgroundColor: pageBackgroundTint + 'A6'},
            ]}
          />
        </>
      )}
      <SafeAreaView
        style={[styles.container, !!pageBackground && styles.transparentBg]}
        edges={['top', 'bottom']}>
      {/* 下滑收起：整屏内容跟手下移 */}
      <Animated.View
        style={[styles.dragWrap, {transform: [{translateY: dragY}]}]}>
        {/* 顶部栏：收起 + 同级页签（详情｜歌曲｜歌词），支持下滑收起 */}
        <View style={styles.header} {...dismissResponder.panHandlers}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
            accessibilityRole="button"
            accessibilityLabel="收起播放页">
            <Text style={styles.headerBtn}>⌄</Text>
          </TouchableOpacity>
          <View style={styles.tabs}>
            {PAGES.map((label, i) => (
              <React.Fragment key={label}>
                {i > 0 && <Text style={styles.tabDivider}>|</Text>}
                <TouchableOpacity
                  onPress={() => goPage(i)}
                  accessibilityRole="button"
                  accessibilityLabel={`切换到${label}页`}
                  accessibilityState={{selected: page === i}}>
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
          onTouchStart={onGateTouchStart}
          onTouchMove={onGateTouchMove}
          onTouchEnd={onGateTouchEnd}
          onTouchCancel={onGateTouchEnd}
          onMomentumScrollEnd={e =>
            setPage(Math.round(e.nativeEvent.contentOffset.x / SCREEN_W))
          }>
          {/* 页 1：歌曲详情 */}
          <View style={styles.page}>
            <DetailPage />
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
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                  accessibilityRole="button"
                  accessibilityLabel={fav ? '取消收藏' : '收藏'}
                  accessibilityState={{selected: fav, disabled: favLoading}}>
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
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                accessibilityRole="button"
                accessibilityLabel="播放倍速"
                accessibilityState={{selected: rate !== 1}}>
                <Icon
                  name={rateIconName(rate)}
                  size={40}
                  color={rate !== 1 ? t.primary : t.playerSub}
                />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => seekBy(-15)}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                accessibilityRole="button"
                accessibilityLabel="快退15秒">
                <Icon name="speedBack15" size={40} color={t.playerSub} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => seekBy(15)}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                accessibilityRole="button"
                accessibilityLabel="快进15秒">
                <Icon name="speedForward15" size={40} color={t.playerSub} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onDownload}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                accessibilityRole="button"
                accessibilityLabel="下载歌曲">
                <Icon name="downloadOutline" size={40} color={t.playerSub} />
              </TouchableOpacity>
            </View>

            {/* 进度条（可点击/拖动定位），独立订阅进度避免整页高频重渲 */}
            <ProgressSection
              styles={styles}
              lockPager={lockPager}
              songMid={track?.mid ? String(track.mid) : undefined}
              isLocal={
                !!track?.url && !/^https?:/i.test(String(track.url))
              }
              fallbackPosition={!nativeTrack ? pendingProgress.position : 0}
              fallbackDuration={!nativeTrack ? pendingProgress.duration : 0}
            />

            {/* 播放控制 */}
            <View style={styles.controls}>
              <TouchableOpacity
                onPress={cycleMode}
                accessibilityRole="button"
                accessibilityLabel={`播放模式：${
                  mode === 'list' ? '列表循环' : mode === 'single' ? '单曲循环' : '随机播放'
                }`}
                accessibilityState={{selected: mode === 'single'}}>
                <Icon name={MODE_ICON[mode]} size={45} color={t.playerSub} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => skipToPreviousUser()}
                accessibilityRole="button"
                accessibilityLabel="上一首">
                <Icon name="prev" size={30} color={t.playerText} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.playBtn}
                onPress={() => {
                  playing ? TrackPlayer.pause() : resumeUser();
                }}
                accessibilityRole="button"
                accessibilityLabel={playing ? '暂停' : '播放'}>
                <Icon
                  name={playing ? 'pause' : 'play'}
                  size={26}
                  color="#fff"
                  style={playing ? undefined : styles.playIconShift}
                />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => skipToNextUser(mode)}
                accessibilityRole="button"
                accessibilityLabel="下一首">
                <Icon name="next" size={30} color={t.playerText} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setTimerSheet(true)}
                accessibilityRole="button"
                accessibilityLabel="睡眠定时"
                accessibilityState={{selected: sleepRemain > 0}}>
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
            <LyricPage />
          </View>
        </ScrollView>
      </Animated.View>

      {/* 睡眠定时弹层 */}
      <AnimatedBottomSheetModal
        visible={timerSheet}
        onClose={() => setTimerSheet(false)}
        sheetStyle={styles.sheet}>
        <View>
          <Text style={styles.sheetTitle}>定时关闭</Text>

          <TouchableOpacity
            style={styles.sheetItem}
            onPress={() => pickSleep(0)}
            accessibilityRole="button"
            accessibilityLabel="不开启定时关闭"
            accessibilityState={{selected: sleepMinutes === 0}}>
            <Text style={styles.sheetItemLabel}>不开启</Text>
            {sleepMinutes === 0 ? (
              <Text style={styles.timerCheck}>✓</Text>
            ) : null}
          </TouchableOpacity>

          {TIMER_PRESETS.map(min => {
            const active = sleepMinutes === min;
            return (
              <TouchableOpacity
                key={min}
                style={styles.sheetItem}
                onPress={() => pickSleep(min)}
                accessibilityRole="button"
                accessibilityLabel={`${min}分钟后关闭`}
                accessibilityState={{selected: active}}>
                <Text
                  style={[
                    styles.sheetItemLabel,
                    active && styles.timerActiveText,
                  ]}>
                  {min}分钟后
                </Text>
                {active && timerRemain > 0 ? (
                  <Text style={styles.timerCountdown}>
                    {fmtCountdown(timerRemain)}
                  </Text>
                ) : null}
                {active ? <Text style={styles.timerCheck}>✓</Text> : null}
              </TouchableOpacity>
            );
          })}

          <View style={styles.timerCustomBlock}>
            <TouchableOpacity
              style={[styles.sheetItem, styles.timerCustomHeader]}
              onPress={openCustomSleepModal}
              accessibilityRole="button"
              accessibilityLabel="自定义定时分钟数">
              <Text
                style={[
                  styles.sheetItemLabel,
                  sleepMinutes > 0 &&
                    !TIMER_PRESETS.includes(sleepMinutes) &&
                    styles.timerActiveText,
                ]}>
                自定义
                {sleepMinutes > 0 && !TIMER_PRESETS.includes(sleepMinutes)
                  ? `（${sleepMinutes}分钟）`
                  : ''}
              </Text>
              {sleepMinutes > 0 &&
              !TIMER_PRESETS.includes(sleepMinutes) &&
              timerRemain > 0 ? (
                <Text style={styles.timerCountdown}>
                  {fmtCountdown(timerRemain)}
                </Text>
              ) : null}
              {sleepMinutes > 0 && !TIMER_PRESETS.includes(sleepMinutes) ? (
                <Text style={styles.timerCheck}>✓</Text>
              ) : null}
            </TouchableOpacity>
          </View>

          <View style={[styles.sheetItem, styles.timerSwitchRow]}>
            <View style={styles.timerSwitchTextWrap}>
              <Text style={styles.sheetItemLabel}>播完整首歌再关闭</Text>
              <Text style={styles.sheetItemDesc}>
                {finishTrack ? '到时后播完当前歌曲再暂停' : '到时后立即暂停'}
              </Text>
            </View>
            <Switch
              value={finishTrack}
              onValueChange={v => {
                setFinishTrackState(v);
                setSleepFinishTrack(v);
              }}
              trackColor={{
                false: t.isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)',
                true: t.primary,
              }}
              thumbColor="#fff"
            />
          </View>

          <Text style={styles.sheetHint}>
            {finishTrack
              ? '计时结束后，播完当前歌曲停止播放'
              : '计时结束后，停止播放'}
          </Text>
          <TouchableOpacity
            style={styles.sheetCancel}
            onPress={() => setTimerSheet(false)}
            accessibilityRole="button"
            accessibilityLabel="关闭定时关闭弹层">
            <Text style={styles.sheetCancelText}>取消</Text>
          </TouchableOpacity>
        </View>
      </AnimatedBottomSheetModal>

      <Modal
        visible={customTimerModal}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeCustomSleepModal}>
        <TouchableWithoutFeedback onPress={closeCustomSleepModal}>
          <View style={styles.timerDialogOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.timerDialogCard}>
                <Text style={styles.timerDialogTitle}>自定义定时分钟数</Text>
                <TextInput
                  style={styles.timerDialogInput}
                  placeholder="输入分钟数（1-1440）"
                  placeholderTextColor={t.sub}
                  keyboardType="number-pad"
                  value={customSleepMin}
                  onChangeText={setCustomSleepMin}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={onSubmitCustomSleep}
                />
                <View style={styles.timerDialogBtnRow}>
                  <TouchableOpacity
                    style={[
                      styles.timerDialogBtn,
                      styles.timerDialogCancelBtn,
                    ]}
                    onPress={closeCustomSleepModal}
                    accessibilityRole="button"
                    accessibilityLabel="取消自定义定时">
                    <Text style={styles.timerDialogCancelText}>取消</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.timerDialogBtn,
                      styles.timerDialogConfirmBtn,
                    ]}
                    onPress={onSubmitCustomSleep}
                    accessibilityRole="button"
                    accessibilityLabel="确定自定义定时">
                    <Text style={styles.timerDialogConfirmText}>确定</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* 下载音质选择弹层 */}
      <AnimatedBottomSheetModal
        visible={dlSheet}
        onClose={() => setDlSheet(false)}
        sheetStyle={styles.sheet}>
        <View>
          <Text style={styles.sheetTitle}>选择下载音质</Text>
          {/* 点击即下载，不做选中态高亮 */}
          {QUALITY_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={styles.sheetItem}
              onPress={() => onPickQuality(opt.value)}
              accessibilityRole="button"
              accessibilityLabel={`下载音质${opt.label}`}>
              <View style={styles.sheetItemLeft}>
                <Text style={styles.sheetItemLabel}>{opt.label}</Text>
                <Text style={styles.sheetItemDesc}>{opt.desc}</Text>
              </View>
            </TouchableOpacity>
          ))}
          <Text style={styles.sheetHint}>高音质不可用时自动降级</Text>
          <TouchableOpacity
            style={styles.sheetCancel}
            onPress={() => setDlSheet(false)}
            accessibilityRole="button"
            accessibilityLabel="关闭下载音质选择">
            <Text style={styles.sheetCancelText}>取消</Text>
          </TouchableOpacity>
        </View>
      </AnimatedBottomSheetModal>

      {/* 播放倍速选择弹层 */}
      <AnimatedBottomSheetModal
        visible={speedSheet}
        onClose={() => setSpeedSheet(false)}
        sheetStyle={styles.sheet}>
        <View>
          <Text style={styles.sheetTitle}>播放倍速</Text>
          <View style={styles.rateGrid}>
            {RATE_OPTIONS.map(r => {
              const active = Math.abs(rate - r) < 0.01;
              return (
                <TouchableOpacity
                  key={r}
                  style={[styles.rateItem, active && styles.rateItemActive]}
                  onPress={() => onPickRate(r)}
                  accessibilityRole="button"
                  accessibilityLabel={`播放倍速${r.toFixed(1)}倍`}
                  accessibilityState={{selected: active}}>
                  <Text
                    style={[styles.rateText, active && styles.rateTextActive]}>
                    {r.toFixed(1)}x
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity
            style={styles.sheetCancel}
            onPress={() => setSpeedSheet(false)}
            accessibilityRole="button"
            accessibilityLabel="关闭倍速选择">
            <Text style={styles.sheetCancelText}>取消</Text>
          </TouchableOpacity>
        </View>
      </AnimatedBottomSheetModal>
      </SafeAreaView>
    </View>
  );
}

function trackToSong(track: any): Song {
  return {
    mid: track.mid,
    title: track.title ?? '未知歌曲',
    singer: track.artist ? [{name: String(track.artist)}] : undefined,
    // songToTrack 写入的自定义字段，下载时凭它拼封面直链
    album: track.album,
    interval: track.duration,
    url: track.url ? String(track.url) : undefined,
    coverUrl: track.artwork ? String(track.artwork) : undefined,
  };
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    // 背景层：自定义背景图铺满整屏（延伸到状态栏底下），底色兜底
    bgWrap: {flex: 1, backgroundColor: t.playerBg},
    container: {flex: 1, backgroundColor: t.playerBg},
    // 有自定义背景图时透明，露出下层背景图
    transparentBg: {backgroundColor: 'transparent'},
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
    // 缓存进度条：恢复为叠在播放进度条下方的原样式
    barBuffered: {
      position: 'absolute',
      left: 0,
      top: 0,
      height: 3,
      backgroundColor: t.isDark
        ? 'rgba(255,255,255,0.35)'
        : 'rgba(31,42,56,0.28)',
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
    sheet: {
      // 弹层背景：开启面板色时随板块色，否则保持卡片色
      backgroundColor: t.panel ?? t.card,
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
    timerActiveText: {color: t.primary, fontWeight: '600'},
    timerCountdown: {color: t.sub, fontSize: 14, marginRight: 12},
    timerCheck: {color: t.primary, fontSize: 18, fontWeight: '700'},
    timerCustomBlock: {marginTop: 2},
    timerCustomHeader: {paddingBottom: 12},
    timerSwitchRow: {marginTop: 8},
    timerSwitchTextWrap: {flex: 1, paddingRight: 12},
    timerDialogOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 28,
    },
    timerDialogCard: {
      width: '100%',
      maxWidth: 320,
      backgroundColor: t.panel ?? t.card,
      borderRadius: 14,
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 18,
      gap: 16,
    },
    timerDialogTitle: {
      color: t.text,
      fontSize: 16,
      fontWeight: '700',
      textAlign: 'center',
    },
    timerDialogInput: {
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 11,
      fontSize: 16,
      color: t.text,
      backgroundColor: t.bg,
      textAlign: 'center',
    },
    timerDialogBtnRow: {flexDirection: 'row', gap: 12},
    timerDialogBtn: {
      flex: 1,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    timerDialogCancelBtn: {backgroundColor: t.cardLight},
    timerDialogCancelText: {
      color: t.sub,
      fontSize: 15,
      fontWeight: '600',
    },
    timerDialogConfirmBtn: {backgroundColor: t.primary},
    timerDialogConfirmText: {
      color: '#fff',
      fontSize: 15,
      fontWeight: '600',
    },
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
