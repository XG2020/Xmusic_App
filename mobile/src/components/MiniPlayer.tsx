import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
  Dimensions,
  PanResponder,
  Modal,
  FlatList,
  ToastAndroid,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import TrackPlayer, {
  State,
  Track,
  useActiveTrack,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player';
import {
  skipToNextUser,
  skipToPreviousUser,
  resumeUser,
  hasPendingRestore,
  getPendingRestoreProgress,
  getPendingRestoreTrack,
  getPendingRestoreTracks,
  getPendingRestoreIndex,
  materializePendingSession,
  subscribePendingRestore,
  subscribeQueueSnapshot,
} from '../services/player';
import {getSwipeHintSeen, markSwipeHintSeen} from '../services/settings';
import {useSpin} from '../utils/useSpin';
import Marquee from './Marquee';
import Icon from './Icon';
import {useTheme, Theme} from '../theme';

const SWIPE_THRESHOLD = 60;

// 队列弹层上滑行程：覆盖面板最大高度（65% 屏高），保证首帧完全在屏外
const SHEET_SLIDE = Dimensions.get('window').height * 0.65;

// 播放按钮圆形进度环尺寸
const RING_SIZE = 34;
const RING_HALF = RING_SIZE / 2;
const RING_THICKNESS = 2.5;

/**
 * 圆形进度环（纯 View 实现，无 SVG 依赖）：
 * 灰色圆形底 + 主题色圆弧表示播放进度，用左右两个半圆遮罩窗口旋转半圆盘扇形填充
 */
function ProgressRing({
  progress,
  color,
  trackColor,
  innerColor,
  children,
}: {
  progress: number;
  color: string;
  trackColor: string;
  innerColor: string;
  children: React.ReactNode;
}) {
  const deg = Math.min(Math.max(progress, 0), 1) * 360;
  const firstDeg = Math.min(deg, 180);
  const secondDeg = Math.max(deg - 180, 0);
  return (
    <View style={[ringStyles.wrap, {backgroundColor: trackColor}]}>
      {/* 右半窗口：0~180° 扇形（无进度时置透明，避免 0° 时半圆边缘贴合裁剪边界出现竖线） */}
      <View style={ringStyles.rightWrap}>
        <View
          style={[
            ringStyles.leftHalfDisc,
            {
              backgroundColor: firstDeg > 0 ? color : 'transparent',
              transform: [
                {translateX: RING_HALF / 2},
                {rotate: `${firstDeg}deg`},
                {translateX: -RING_HALF / 2},
              ],
            },
          ]}
        />
      </View>
      {/* 左半窗口：180~360° 扇形 */}
      <View style={ringStyles.leftWrap}>
        <View
          style={[
            ringStyles.rightHalfDisc,
            {
              backgroundColor: secondDeg > 0 ? color : 'transparent',
              transform: [
                {translateX: -RING_HALF / 2},
                {rotate: `${secondDeg}deg`},
                {translateX: RING_HALF / 2},
              ],
            },
          ]}
        />
      </View>
      {/* 内圆盖住中心形成圆环 */}
      <View style={[ringStyles.inner, {backgroundColor: innerColor}]}>
        {children}
      </View>
    </View>
  );
}

/**
 * 自订阅播放进度的进度环：把 useProgress 隔离在这个小组件里，
 * 每秒的进度刷新只重渲小圆环，不带动常驻全局的整个 MiniPlayer
 */
function PlayProgressRing({
  color,
  trackColor,
  innerColor,
  fallbackPosition = 0,
  fallbackDuration = 0,
  children,
}: {
  color: string;
  trackColor: string;
  innerColor: string;
  fallbackPosition?: number;
  fallbackDuration?: number;
  children: React.ReactNode;
}) {
  const progress = useProgress(1000);
  const duration = progress.duration || fallbackDuration;
  const position =
    progress.duration > 0 || progress.position > 0
      ? progress.position
      : fallbackPosition;
  return (
    <ProgressRing
      progress={duration > 0 ? position / duration : 0}
      color={color}
      trackColor={trackColor}
      innerColor={innerColor}>
      {children}
    </ProgressRing>
  );
}

const ringStyles = StyleSheet.create({
  wrap: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_HALF,
    overflow: 'hidden',
  },
  rightWrap: {
    position: 'absolute',
    left: RING_HALF,
    top: 0,
    width: RING_HALF,
    height: RING_SIZE,
    overflow: 'hidden',
  },
  leftHalfDisc: {
    position: 'absolute',
    left: -RING_HALF,
    top: 0,
    width: RING_HALF,
    height: RING_SIZE,
    borderTopLeftRadius: RING_HALF,
    borderBottomLeftRadius: RING_HALF,
  },
  leftWrap: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: RING_HALF,
    height: RING_SIZE,
    overflow: 'hidden',
  },
  rightHalfDisc: {
    position: 'absolute',
    left: RING_HALF,
    top: 0,
    width: RING_HALF,
    height: RING_SIZE,
    borderTopRightRadius: RING_HALF,
    borderBottomRightRadius: RING_HALF,
  },
  inner: {
    position: 'absolute',
    left: RING_THICKNESS,
    top: RING_THICKNESS,
    width: RING_SIZE - RING_THICKNESS * 2,
    height: RING_SIZE - RING_THICKNESS * 2,
    borderRadius: RING_HALF - RING_THICKNESS,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

/**
 * 全局迷你播放条（仿 QQ 音乐底部播放栏）
 * 左滑 -> 下一曲，右滑 -> 上一曲，点击进入播放页
 */
export default function MiniPlayer() {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const nativeTrack = useActiveTrack();
  // 延迟恢复：原生队列为空时回退显示上次会话快照的当前曲目
  // （启动只显示不抢音频焦点，用户点播放才真正加载进原生播放器）
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
  const playback = usePlaybackState();
  const navigation = useNavigation<any>();
  const translateX = useRef(new Animated.Value(0)).current;
  // 播放队列弹层
  const [queueSheet, setQueueSheet] = useState(false);
  const [queue, setQueue] = useState<Track[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [queueLoading, setQueueLoading] = useState(false);
  // 弹层自绘动画：遮罩淡入 + 面板上滑（Modal 内置 slide 会连遮罩一起滑，观感差）
  const sheetAnim = useRef(new Animated.Value(0)).current;
  const queueSheetTicket = useRef(0);
  const refreshQueueSheet = useCallback(async (ticket = queueSheetTicket.current) => {
    if (hasPendingRestore()) {
      if (queueSheetTicket.current !== ticket) {
        return;
      }
      setQueue(getPendingRestoreTracks());
      setActiveIdx(getPendingRestoreIndex());
      setQueueLoading(false);
      return;
    }
    try {
      const [nextQueue, nextActiveIdx] = await Promise.all([
        TrackPlayer.getQueue(),
        TrackPlayer.getActiveTrackIndex(),
      ]);
      if (queueSheetTicket.current !== ticket) {
        return;
      }
      setQueue(nextQueue);
      setActiveIdx(nextActiveIdx ?? -1);
    } catch (e) {
      if (queueSheetTicket.current !== ticket) {
        return;
      }
      setQueue([]);
      setActiveIdx(-1);
    } finally {
      if (queueSheetTicket.current === ticket) {
        setQueueLoading(false);
      }
    }
  }, []);
  const openQueueSheet = () => {
    const ticket = ++queueSheetTicket.current;
    setQueueLoading(true);
    if (hasPendingRestore()) {
      setQueue(getPendingRestoreTracks());
      setActiveIdx(getPendingRestoreIndex());
    } else {
      setQueue([]);
      setActiveIdx(-1);
    }
    sheetAnim.setValue(0);
    setQueueSheet(true);
    refreshQueueSheet(ticket);
  };
  // Modal 挂载完成后再起动画，避免丢帧闪现
  const onSheetShow = () => {
    Animated.timing(sheetAnim, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };
  const closeQueueSheet = () => {
    const ticket = ++queueSheetTicket.current;
    setQueueLoading(false);
    Animated.timing(sheetAnim, {
      toValue: 0,
      duration: 160,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({finished}) => {
      if (finished && queueSheetTicket.current === ticket) {
        setQueueSheet(false);
      }
    });
  };

  const playing = playback.state === State.Playing;
  const rotate = useSpin(playing, 12000);

  // 「左右滑动切歌」提示：用户完成过一次滑动后不再显示
  const [showSwipeHint, setShowSwipeHint] = useState(false);
  const swipeHintDone = useRef(false);
  useEffect(() => {
    getSwipeHintSeen().then(seen => {
      swipeHintDone.current = seen;
      setShowSwipeHint(!seen);
    });
  }, []);
  const dismissSwipeHint = () => {
    if (!swipeHintDone.current) {
      swipeHintDone.current = true;
      setShowSwipeHint(false);
      markSwipeHintSeen();
    }
  };

  // 弹层打开期间订阅队列变化：建队、渐进式替换、手动移除/清空都要实时刷新
  useEffect(() => {
    if (!queueSheet) {
      return;
    }
    const runRefresh = () => {
      setQueueLoading(true);
      refreshQueueSheet(queueSheetTicket.current);
    };
    runRefresh();
    const unsubPending = subscribePendingRestore(runRefresh);
    const unsubQueue = subscribeQueueSnapshot(runRefresh);
    return () => {
      unsubPending();
      unsubQueue();
    };
  }, [queueSheet, refreshQueueSheet]);

  const playQueueItem = async (index: number) => {
    try {
      // 延迟恢复未落地时：先把快照队列灌进原生播放器（用户主动播放，允许抢焦点）
      await materializePendingSession();
      await TrackPlayer.skip(index);
      await TrackPlayer.play();
      setActiveIdx(index);
    } catch (e) {
      ToastAndroid.show('播放队列操作失败', ToastAndroid.SHORT);
    }
  };

  const springBack = () => {
    Animated.spring(translateX, {
      toValue: 0,
      useNativeDriver: true,
      friction: 8,
      tension: 60,
    }).start();
  };

  const panResponder = useRef(
    PanResponder.create({
      // 水平位移明显大于垂直时才接管手势，不影响点击
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_, g) => {
        translateX.setValue(g.dx * 0.6);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx <= -SWIPE_THRESHOLD) {
          // 左滑：下一曲，先滑出再弹回
          dismissSwipeHint();
          Animated.timing(translateX, {
            toValue: -80,
            duration: 120,
            useNativeDriver: true,
          }).start(() => {
            skipToNextUser();
            translateX.setValue(80);
            springBack();
          });
        } else if (g.dx >= SWIPE_THRESHOLD) {
          dismissSwipeHint();
          Animated.timing(translateX, {
            toValue: 80,
            duration: 120,
            useNativeDriver: true,
          }).start(() => {
            skipToPreviousUser();
            translateX.setValue(-80);
            springBack();
          });
        } else {
          springBack();
        }
      },
      onPanResponderTerminate: springBack,
    }),
  ).current;

  if (!track) {
    return null;
  }

  return (
    <View style={styles.bar} {...panResponder.panHandlers}>
      <TouchableOpacity
        style={styles.left}
        activeOpacity={0.9}
        onPress={() => navigation.navigate('Player')}
        accessibilityRole="button"
        accessibilityLabel={`打开播放页，当前播放${track.title ?? '未知歌曲'}`}>
        <Animated.View style={[styles.cover, {transform: [{rotate}]}]}>
          {track.artwork ? (
            <Image source={{uri: String(track.artwork)}} style={styles.coverImg} />
          ) : (
            <Text style={styles.coverPlaceholder}>♪</Text>
          )}
        </Animated.View>
        {/* 裁剪容器：滑动动画只在文字区内可见，不浮到封面上 */}
        <View style={styles.infoClip}>
          <Animated.View style={[styles.info, {transform: [{translateX}]}]}>
            {/* 歌名过长时跑马灯滚动；key 保证切歌后重新测量 */}
            <Marquee key={`${track.title}-${track.artist}`}>
              <Text style={styles.title} numberOfLines={1}>
                {track.title ?? '未在播放'}
                {track.artist ? (
                  <Text style={styles.artist}> - {track.artist}</Text>
                ) : null}
              </Text>
            </Marquee>
            {showSwipeHint && (
              <Text style={styles.swipeHint} numberOfLines={1}>
                左右滑动切歌
              </Text>
            )}
          </Animated.View>
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.ctrl}
        onPress={() => {
          playing ? TrackPlayer.pause() : resumeUser();
        }}
        accessibilityRole="button"
        accessibilityLabel={playing ? '暂停' : '播放'}
        accessibilityState={{selected: playing}}>
        {/* 圆形进度环：灰底 + 主题色进度圆弧（自订阅进度，不带动整条重渲）
        内圆背景与条底色一致（跟随板块颜色与透明度），图标用主题色 */}
        <PlayProgressRing
          color={t.primary}
          trackColor={t.isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.15)'}
          innerColor={t.miniBar}
          fallbackPosition={!nativeTrack ? pendingProgress.position : 0}
          fallbackDuration={!nativeTrack ? pendingProgress.duration : 0}>
          {/* 高清播控图标：pause 居中；play 三角素材自带右偏校正视觉居中 */}
          {playing ? (
            <Icon name="pause" size={14} color={t.primary} />
          ) : (
            <Icon name="play" size={14} color={t.primary} />
          )}
        </PlayProgressRing>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.listBtn}
        onPress={openQueueSheet}
        accessibilityRole="button"
        accessibilityLabel="打开当前播放队列"
        accessibilityState={{selected: queueSheet}}>
        {/* 播放列表图标（logo 素材，弹层打开时高亮） */}
        <Icon
          name={queueSheet ? 'miniListHl' : 'miniList'}
          size={30}
          color={queueSheet ? t.primary : t.sub}
        />
      </TouchableOpacity>

      {/* 播放队列弹层（自绘动画：遮罩淡入 + 面板上滑，均走 native driver） */}
      <Modal
        visible={queueSheet}
        transparent
        statusBarTranslucent
        animationType="none"
        onShow={onSheetShow}
        onRequestClose={closeQueueSheet}>
        <Animated.View style={[styles.sheetMask, {opacity: sheetAnim}]}>
          <TouchableOpacity
            style={styles.sheetMaskTouch}
            activeOpacity={1}
            onPress={closeQueueSheet}>
            <Animated.View
              style={[
                styles.sheet,
                {
                  transform: [
                    {
                      translateY: sheetAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [SHEET_SLIDE, 0],
                      }),
                    },
                  ],
                },
              ]}
              onStartShouldSetResponder={() => true}>
              <Text style={styles.sheetTitle}>
                当前播放 ({queue.length})
              </Text>
              {!queueLoading || queue.length > 0 ? (
                <FlatList
                  showsVerticalScrollIndicator={false}
                  data={queue}
                  extraData={activeIdx}
                  keyExtractor={(item, i) => `${item.id ?? item.title}-${i}`}
                  style={styles.queueList}
                  initialScrollIndex={
                    activeIdx > 4 && queue.length > 8 ? activeIdx - 2 : 0
                  }
                  getItemLayout={(_, index) => ({
                    length: 44,
                    offset: 44 * index,
                    index,
                  })}
                  initialNumToRender={10}
                  maxToRenderPerBatch={10}
                  updateCellsBatchingPeriod={50}
                  windowSize={5}
                  removeClippedSubviews
                  ListEmptyComponent={
                    <Text style={styles.queueEmpty}>播放队列为空</Text>
                  }
                  renderItem={({item, index}) => {
                    const active = index === activeIdx;
                    return (
                      <TouchableOpacity
                        style={styles.queueItem}
                        onPress={() => playQueueItem(index)}
                        accessibilityRole="button"
                        accessibilityLabel={`播放队列第${index + 1}首，${item.title ?? ''}`}>
                        <Text
                          style={[styles.queueNo, active && styles.queueActive]}>
                          {active ? '♪' : index + 1}
                        </Text>
                        <Text
                          style={[
                            styles.queueTitle,
                            active && styles.queueActive,
                          ]}
                          numberOfLines={1}>
                          {item.title}
                          {item.artist ? (
                            <Text style={styles.queueArtist}>
                              {'  '}
                              {item.artist}
                            </Text>
                          ) : null}
                        </Text>
                      </TouchableOpacity>
                    );
                  }}
                />
              ) : (
                <View style={styles.queueLoadingWrap}>
                  <Text style={styles.queueEmpty}>正在载入播放队列...</Text>
                </View>
              )}
              <TouchableOpacity
                style={styles.sheetCancel}
                onPress={closeQueueSheet}
                accessibilityRole="button"
                accessibilityLabel="关闭播放队列">
                <Text style={styles.sheetCancelText}>关闭</Text>
              </TouchableOpacity>
            </Animated.View>
          </TouchableOpacity>
        </Animated.View>
      </Modal>
    </View>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      // 迷你播放条底色：板块色开启时跟随板块颜色与透明度，关闭时回退卡片色不透明
      backgroundColor: t.miniBar,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
    left: {flex: 1, flexDirection: 'row', alignItems: 'center'},
    cover: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: t.discBg,
      borderWidth: 2,
      borderColor: 'rgba(49,194,124,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    coverImg: {width: 38, height: 38, borderRadius: 19},
    coverPlaceholder: {color: t.sub, fontSize: 16},
    infoClip: {flex: 1, marginHorizontal: 10, overflow: 'hidden'},
    info: {},
    title: {fontSize: 14, fontWeight: '600', color: t.text},
    artist: {fontSize: 12, fontWeight: '400', color: t.sub},
    swipeHint: {fontSize: 11, color: t.sub, marginTop: 2},
    ctrl: {
      width: 34,
      height: 34,
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: 8,
    },
    listBtn: {
      width: 34,
      height: 34,
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: 4,
    },
    // 播放队列弹层
    sheetMask: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    sheetMaskTouch: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    sheet: {
      // 弹层背景：开启面板色时随板块色，否则保持卡片色
      backgroundColor: t.panel ?? t.card,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingTop: 16,
      paddingBottom: 24,
      paddingHorizontal: 16,
      maxHeight: '65%',
      minHeight: 280,
    },
    sheetTitle: {
      color: t.text,
      fontSize: 16,
      fontWeight: '700',
      textAlign: 'center',
      marginBottom: 8,
    },
    queueList: {flexGrow: 0},
    queueLoadingWrap: {
      minHeight: 220,
      alignItems: 'center',
      justifyContent: 'center',
    },
    queueEmpty: {
      textAlign: 'center',
      color: t.sub,
      fontSize: 12,
      paddingVertical: 24,
    },
    queueItem: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 44,
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    queueNo: {width: 26, textAlign: 'center', color: t.sub, fontSize: 12},
    queueTitle: {flex: 1, color: t.text, fontSize: 14},
    queueArtist: {color: t.sub, fontSize: 12},
    queueActive: {color: t.primary, fontWeight: '700'},
    sheetCancel: {
      marginTop: 12,
      backgroundColor: t.sheetBtn,
      borderRadius: 22,
      paddingVertical: 11,
      alignItems: 'center',
    },
    sheetCancelText: {color: t.text, fontSize: 15},
  });
