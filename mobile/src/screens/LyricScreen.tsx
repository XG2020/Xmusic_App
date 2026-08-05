import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Animated,
  Easing,
  Clipboard,
  ToastAndroid,
  Platform,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import TrackPlayer, {
  State,
  useActiveTrack,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player';
import {getLyric} from '../services/api';
import {readLocalLyric} from '../services/download';
import {parseLrc, parseQrc, findActiveLine, LrcLine, QrcWord} from '../utils/lrc';
import {
  seekTo,
  getPendingRestoreTrack,
  getPendingRestoreProgress,
  subscribePendingRestore,
} from '../services/player';
import {formatDuration} from '../utils/format';
import {useTheme, Theme} from '../theme';

/** 聚焦行容器：以左侧为锚点平滑放大，失焦缓和还原（纯原生驱动，无弹跳） */
function FocusLine({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  const anim = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: active ? 1 : 0,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [active, anim]);
  return (
    <Animated.View
      style={{
        transformOrigin: 'left center',
        transform: [
          {
            scale: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 1.08],
            }),
          },
        ],
      }}>
      {children}
    </Animated.View>
  );
}

type RowStyles = ReturnType<typeof createStyles>;

/**
 * 逐字卡拉OK染色（优化版，纯原生驱动）：
 * - 不动画 width（JS 驱动会卡），改用「裁剪容器 + 内容反向位移」遮罩，
 *   两个 translateX 都走 useNativeDriver，动画期间不占 JS 线程
 * - 有 QRC 逐字时间轴时按每个字的真实演唱起止拼接动画序列，
 *   绿色进度与演唱进度一致；无 QRC 时退回按行时长线性推进
 * - 进度 tick 只做漂移校验（seek/暂停/倍速偏差 >10% 才重新对表）
 */
function KaraokeLine({
  text,
  styles,
  fillColor,
  start,
  end,
  position,
  playing,
  words,
}: {
  text: string;
  styles: RowStyles;
  fillColor: string;
  start: number;
  end: number;
  position: number;
  playing: boolean;
  words?: QrcWord[];
}) {
  const anim = useRef(new Animated.Value(0)).current;
  const valRef = useRef(0); // 监听器同步的当前动画值，供漂移校验
  const posRef = useRef(position);
  posRef.current = position;
  const [boxW, setBoxW] = useState(0);
  // 每个视觉行的位置尺寸：折行时逐行推进绿色，避免所有行同时横向染色
  const [lineBoxes, setLineBoxes] = useState<
    {x: number; y: number; width: number; height: number}[]
  >([]);

  // QRC 逐字分段：每个字占的宽度份额按字符数比例，时间用真实起止
  const segs = useMemo(() => {
    if (!words || !words.length) {
      return null;
    }
    const total = words.reduce((s, w) => s + w.text.length, 0);
    if (!total) {
      return null;
    }
    let acc = 0;
    return words.map(w => {
      acc += w.text.length;
      return {start: w.start, end: w.start + w.dur, frac: acc / total};
    });
  }, [words]);

  /** 某播放位置对应的已唱比例（逐字分段插值，无 QRC 时按行线性） */
  const fracAt = useCallback(
    (pos: number) => {
      if (!segs) {
        const dur = Math.max(end - start, 0.3);
        return Math.min(Math.max((pos - start) / dur, 0), 1);
      }
      let prev = 0;
      for (const seg of segs) {
        if (pos >= seg.end) {
          prev = seg.frac;
          continue;
        }
        if (pos <= seg.start) {
          return prev; // 字间空隙：停在上一字末尾
        }
        return (
          prev +
          ((seg.frac - prev) * (pos - seg.start)) /
            Math.max(seg.end - seg.start, 0.01)
        );
      }
      return prev;
    },
    [segs, start, end],
  );

  useEffect(() => {
    const id = anim.addListener(({value}) => {
      valRef.current = value;
    });
    return () => anim.removeListener(id);
  }, [anim]);

  /** 从当前播放位置对表，并启动后续动画 */
  const resync = useCallback(async () => {
    const pos = posRef.current;
    const frac = fracAt(pos);
    anim.stopAnimation();
    anim.setValue(frac);
    valRef.current = frac;
    if (!playing || frac >= 1) {
      return;
    }
    let rate = 1;
    try {
      rate = (await TrackPlayer.getRate()) || 1;
    } catch (e) {}
    if (segs) {
      // 逐字：按每个字真实起止时间拼动画序列，字间空隙用 delay 停顿
      const steps: Animated.CompositeAnimation[] = [];
      let cursor = pos;
      let lastFrac = frac;
      for (const seg of segs) {
        if (seg.end <= cursor || seg.frac <= lastFrac) {
          continue;
        }
        if (seg.start > cursor + 0.02) {
          steps.push(Animated.delay(((seg.start - cursor) * 1000) / rate));
          cursor = seg.start;
        }
        const durMs = Math.max(((seg.end - cursor) * 1000) / rate, 16);
        steps.push(
          Animated.timing(anim, {
            toValue: seg.frac,
            duration: durMs,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
        );
        cursor = seg.end;
        lastFrac = seg.frac;
      }
      if (steps.length) {
        Animated.sequence(steps).start();
      }
      return;
    }
    const dur = Math.max(end - start, 0.3);
    const remainMs = ((1 - frac) * dur * 1000) / rate;
    if (remainMs > 32) {
      Animated.timing(anim, {
        toValue: 1,
        duration: remainMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start();
    }
  }, [anim, segs, fracAt, start, end, playing]);

  // 行切换/播放暂停恢复时对表
  useEffect(() => {
    resync();
  }, [resync]);

  // 每个进度 tick 做漂移校验（seek/倍速变化时重新对表）
  useEffect(() => {
    if (Math.abs(fracAt(position) - valRef.current) > 0.1) {
      resync();
    }
  }, [position, fracAt, resync]);

  const totalW = lineBoxes.reduce((s, l) => s + l.width, 0);
  let accW = 0;
  return (
    <View onLayout={e => setBoxW(e.nativeEvent.layout.width)}>
      <Text
        style={[styles.line, styles.lineActive]}
        onTextLayout={e =>
          setLineBoxes(
            e.nativeEvent.lines.map(l => ({
              x: l.x,
              y: l.y,
              width: l.width,
              height: l.height,
            })),
          )
        }>
        {text}
      </Text>
      {boxW > 0 &&
        totalW > 0 &&
        lineBoxes.map((ln, i) => {
          const c0 = accW / totalW;
          accW += ln.width;
          const c1 = accW / totalW;
          if (ln.width <= 0 || c1 <= c0) {
            return null;
          }
          // 每个视觉行一个裁剪窗口，同一动画值按行宽份额分段插值
          return (
            <Animated.View
              key={i}
              pointerEvents="none"
              style={[
                styles.karaokeClip,
                {
                  left: ln.x,
                  top: ln.y,
                  width: ln.width,
                  height: ln.height,
                  transform: [
                    {
                      translateX: anim.interpolate({
                        inputRange: [c0, c1],
                        outputRange: [-ln.width, 0],
                        extrapolate: 'clamp',
                      }),
                    },
                  ],
                },
              ]}>
              <Animated.Text
                style={[
                  styles.line,
                  styles.lineActive,
                  {
                    color: fillColor,
                    width: boxW,
                    position: 'absolute',
                    left: -ln.x,
                    top: -ln.y,
                    transform: [
                      {
                        translateX: anim.interpolate({
                          inputRange: [c0, c1],
                          outputRange: [ln.width, 0],
                          extrapolate: 'clamp',
                        }),
                      },
                    ],
                  },
                ]}>
                {text}
              </Animated.Text>
            </Animated.View>
          );
        })}
    </View>
  );
}

/** 单行歌词（memo：非聚焦行 props 稳定不重渲染，只有聚焦行随进度刷新） */
const LyricRow = React.memo(function LyricRow({
  text,
  trans,
  time,
  end,
  active,
  position,
  playing,
  fillColor,
  words,
  timeOpacity,
  styles,
  onSeek,
  onCopy,
}: {
  text: string;
  trans?: string;
  time: number;
  end: number;
  active: boolean;
  position: number;
  playing: boolean;
  fillColor: string;
  words?: QrcWord[];
  timeOpacity: Animated.Value;
  styles: RowStyles;
  onSeek: (time: number) => void;
  onCopy: (text: string) => void;
}) {
  return (
    <TouchableOpacity
      style={styles.lineRow}
      activeOpacity={0.7}
      onPress={() => onSeek(time)}
      onLongPress={() => onCopy(text)}
      delayLongPress={400}>
      <FocusLine active={active}>
        {active ? (
          <KaraokeLine
            text={text}
            styles={styles}
            fillColor={fillColor}
            start={time}
            end={end}
            position={position}
            playing={playing}
            words={words}
          />
        ) : (
          <Text style={styles.line}>{text}</Text>
        )}
        {!!trans && (
          <Text style={[styles.trans, active && styles.transActive]}>
            {trans}
          </Text>
        )}
      </FocusLine>
      {/* 时间气泡：仅聚焦行右侧显示，手滑时渐显 */}
      {active && (
        <Animated.View style={[styles.timeBubble, {opacity: timeOpacity}]}>
          <Text style={styles.timeBubbleText}>{formatDuration(time)}</Text>
        </Animated.View>
      )}
    </TouchableOpacity>
  );
});

export default function LyricView() {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const nativeTrack = useActiveTrack();
  // 延迟恢复：冷启动原生队列为空（未点播放）时，回退显示上次会话快照的当前曲目，
  // 歌词照常请求并按快照进度定位高亮行；用户点播放后原生曲目就绪自动切换
  const [pendingTrack, setPendingTrack] = useState(() =>
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
  const progress = useProgress(500);
  const playing = usePlaybackState().state === State.Playing;
  // 原生播放器无内容（延迟恢复期）时用快照进度/时长定位歌词高亮行
  const displayPosition =
    progress.duration > 0 || progress.position > 0
      ? progress.position
      : pendingProgress.position;
  const displayDuration = progress.duration || pendingProgress.duration;
  const [lines, setLines] = useState<LrcLine[]>([]);
  const [transMap, setTransMap] = useState<Record<number, string>>({});
  // QRC 逐字时间轴（按行下标对齐 lines，拿不到逐字数据时为空）
  const [wordsMap, setWordsMap] = useState<Record<number, QrcWord[]>>({});
  const [loaded, setLoaded] = useState(false);
  const listRef = useRef<FlatList<LrcLine>>(null);
  const lastIndex = useRef(-1);
  // 用户手动滑动中/等待恢复期间不自动滚动
  const userScrolling = useRef(false);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeIndexRef = useRef(-1);
  // 手滑时右侧时间的渐隐渐出透明度（所有行共用）
  const timeOpacity = useRef(new Animated.Value(0)).current;

  const mid = (track as any)?.mid as string | undefined;
  const trackUrl = track?.url ? String(track.url) : '';
  const isLocal = !!trackUrl && !/^https?:/i.test(trackUrl);

  useEffect(() => {
    let cancelled = false;
    setLines([]);
    setTransMap({});
    setWordsMap({});
    setLoaded(false);
    // 切歌重置定位记录：新歌词加载后的首次定位直接跳转（不做滚动动画）
    lastIndex.current = -1;
    (async () => {
      // 本地歌曲优先读同名 .lrc（下载时保存），离线也能显示歌词
      if (isLocal) {
        const text = await readLocalLyric(trackUrl.replace(/^file:\/\//, ''));
        const parsed = parseLrc(text);
        if (cancelled) {
          return;
        }
        if (parsed.length) {
          setLines(parsed);
          setLoaded(true);
          return;
        }
      }
      if (!mid) {
        if (!cancelled) {
          setLoaded(true);
        }
        return;
      }
      try {
        // 优先请求 QRC 逐字歌词，绿色进度才能和演唱进度一致
        const data = await getLyric({mid, qrc: true, trans: true});
        if (cancelled) {
          return;
        }
        const raw = data?.lyric ?? '';
        let parsed: LrcLine[] = [];
        const qrcLines = parseQrc(raw);
        if (qrcLines.length) {
          parsed = qrcLines.map(l => ({time: l.time, text: l.text}));
          const wm: Record<number, QrcWord[]> = {};
          qrcLines.forEach((l, i) => {
            wm[i] = l.words;
          });
          setWordsMap(wm);
        } else {
          // 无逐字数据（接口退回 LRC 文本）：按普通 LRC 解析
          parsed = parseLrc(raw);
          if (!parsed.length) {
            const plain = await getLyric({mid, trans: true});
            if (cancelled) {
              return;
            }
            parsed = parseLrc(plain?.lyric ?? '');
          }
        }
        setLines(parsed);
        // 翻译按时间对齐；「//」等无意义占位翻译（原文无需翻译的 Oh 等）不显示
        const trans = parseLrc(data?.trans ?? '');
        const map: Record<number, string> = {};
        for (const tl of trans) {
          if (/^[\/\\\s]*$/.test(tl.text)) {
            continue;
          }
          const idx = parsed.findIndex(l => Math.abs(l.time - tl.time) < 0.5);
          if (idx >= 0) {
            map[idx] = tl.text;
          }
        }
        setTransMap(map);
      } catch (e) {
        // 歌词加载失败显示占位
      }
      if (!cancelled) {
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mid, isLocal, trackUrl]);

  const activeIndex = useMemo(
    () => findActiveLine(lines, displayPosition),
    [lines, displayPosition],
  );
  activeIndexRef.current = activeIndex;

  // 自动滚动到当前行（用户手滑期间暂停）；
  // 首次定位（进页/切歌，歌曲可能已播一半）立即跳转，之后逐行平滑滚动
  useEffect(() => {
    if (
      !userScrolling.current &&
      activeIndex >= 0 &&
      activeIndex !== lastIndex.current &&
      lines.length > 0
    ) {
      const firstSync = lastIndex.current < 0;
      lastIndex.current = activeIndex;
      listRef.current?.scrollToIndex({
        index: activeIndex,
        viewPosition: 0.4,
        animated: !firstSync,
      });
    }
  }, [activeIndex, lines.length]);

  // 卸载时清理恢复定时器
  useEffect(
    () => () => {
      if (resumeTimer.current) {
        clearTimeout(resumeTimer.current);
      }
    },
    [],
  );

  /** 用户开始手动滑动：暂停自动滚动，渐显右侧时间 */
  const onUserScrollStart = useCallback(() => {
    userScrolling.current = true;
    if (resumeTimer.current) {
      clearTimeout(resumeTimer.current);
      resumeTimer.current = null;
    }
    Animated.timing(timeOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [timeOpacity]);

  /** 用户滑动结束：2 秒无操作后恢复自动滚动并跳回当前播放行 */
  const onUserScrollEnd = useCallback(() => {
    if (!userScrolling.current) {
      return; // 程序化滚动触发的 momentum 结束，忽略
    }
    if (resumeTimer.current) {
      clearTimeout(resumeTimer.current);
    }
    resumeTimer.current = setTimeout(() => {
      resumeTimer.current = null;
      userScrolling.current = false;
      // 渐隐右侧时间
      Animated.timing(timeOpacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
      const idx = activeIndexRef.current;
      if (idx >= 0) {
        lastIndex.current = idx;
        listRef.current?.scrollToIndex({
          index: idx,
          viewPosition: 0.4,
          animated: true,
        });
      }
    }, 2000);
  }, [timeOpacity]);

  /** 长按复制该行歌词 */
  const copyLine = useCallback((text: string) => {
    Clipboard.setString(text);
    if (Platform.OS === 'android') {
      ToastAndroid.show('已复制歌词', ToastAndroid.SHORT);
    } else {
      AppAlert.alert('已复制歌词');
    }
  }, []);

  return (
    <View style={styles.container}>
      {lines.length > 0 ? (
        <FlatList
          ref={listRef}
          showsVerticalScrollIndicator={false}
          data={lines}
          keyExtractor={(_, i) => String(i)}
          contentContainerStyle={styles.lyricList}
          initialNumToRender={16}
          maxToRenderPerBatch={16}
          windowSize={7}
          removeClippedSubviews
          onScrollToIndexFailed={info => {
            // 目标行超出已渲染范围（虚拟化）：先按估算行高直接跳到附近，
            // 待该区域渲染完成后再精确对齐当前行
            listRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: false,
            });
            setTimeout(() => {
              if (!userScrolling.current && activeIndexRef.current >= 0) {
                listRef.current?.scrollToIndex({
                  index: activeIndexRef.current,
                  viewPosition: 0.4,
                  animated: false,
                });
              }
            }, 120);
          }}
          onScrollBeginDrag={onUserScrollStart}
          onScrollEndDrag={onUserScrollEnd}
          onMomentumScrollEnd={onUserScrollEnd}
          renderItem={({item, index}) => (
            <LyricRow
              text={item.text}
              trans={transMap[index]}
              time={item.time}
              end={
                index + 1 < lines.length
                  ? lines[index + 1].time
                  : Math.max(displayDuration, item.time + 1)
              }
              active={index === activeIndex}
              position={index === activeIndex ? displayPosition : 0}
              playing={index === activeIndex ? playing : false}
              fillColor={t.primary}
              words={wordsMap[index]}
              timeOpacity={timeOpacity}
              styles={styles}
              onSeek={seekTo}
              onCopy={copyLine}
            />
          )}
        />
      ) : (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>
            {loaded ? '暂无歌词' : '歌词加载中…'}
          </Text>
        </View>
      )}
    </View>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1},
    // 参考 QQ 音乐：左对齐、接近全宽，右侧留出放大与时间气泡空间
    lyricList: {paddingVertical: 160, paddingLeft: 24, paddingRight: 30},
    lineRow: {paddingVertical: 13, justifyContent: 'center'},
    line: {
      fontSize: 17,
      color: t.playerFaint,
      textAlign: 'left',
      lineHeight: 25,
      // 聚焦放大 1.08 倍时不撞右边界
      paddingRight: 28,
    },
    lineActive: {color: t.playerText, fontWeight: '700'},
    // 卡拉OK染色裁剪窗口（位置/尺寸按视觉行在组件内动态设置）
    karaokeClip: {
      position: 'absolute',
      overflow: 'hidden',
    },
    trans: {
      fontSize: 13,
      color: t.playerFaint,
      textAlign: 'left',
      lineHeight: 19,
      marginTop: 4,
      paddingRight: 28,
    },
    // 高亮行译文：主题文字色 75% 透明度，明暗模式都清晰可读
    transActive: {color: t.playerText + 'BF'},
    // 聚焦行右侧时间气泡（仅手滑时渐显）
    timeBubble: {
      position: 'absolute',
      right: -14,
      top: 0,
      bottom: 0,
      justifyContent: 'center',
    },
    timeBubbleText: {
      fontSize: 11,
      color: t.playerText,
      // 主题文字色低透明度做浮层底，明暗模式都有轻微衬托
      backgroundColor: t.playerText + '24',
      paddingHorizontal: 6,
      paddingVertical: 3,
      borderRadius: 6,
      overflow: 'hidden',
    },
    placeholder: {flex: 1, alignItems: 'center', justifyContent: 'center'},
    placeholderText: {color: t.playerFaint, fontSize: 14},
  });
