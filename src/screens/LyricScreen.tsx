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
  TextStyle,
  StyleProp,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {useActiveTrack, useProgress} from 'react-native-track-player';
import {getLyric} from '../services/api';
import {readLocalLyric} from '../services/download';
import {parseLrc, findActiveLine, LrcLine} from '../utils/lrc';
import {seekTo} from '../services/player';
import {formatDuration} from '../utils/format';
import {useTheme, Theme} from '../theme';

/**
 * 卡拉OK逐字染色行：底层文字 + 顶层绿色文字（宽度按进度裁剪）
 * fraction 为该行已唱进度 0~1，每次进度刷新用线性动画平滑推进
 */
function KaraokeLine({
  text,
  fraction,
  baseStyle,
  fillColor,
}: {
  text: string;
  fraction: number;
  baseStyle: StyleProp<TextStyle>;
  fillColor: string;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  const first = useRef(true);
  const [boxW, setBoxW] = useState(0);
  // 单行文字时取实际文字的起点与宽度，避免绿色从空白处开始扫
  const [textArea, setTextArea] = useState<{left: number; width: number} | null>(
    null,
  );

  useEffect(() => {
    if (first.current) {
      // 首次（切到该行时）直接定位，不做从 0 开始的突兀动画
      first.current = false;
      anim.setValue(fraction);
      return;
    }
    Animated.timing(anim, {
      toValue: fraction,
      duration: 500,
      easing: Easing.linear,
      useNativeDriver: false, // 宽度动画不支持原生驱动
    }).start();
  }, [fraction, anim]);

  const areaLeft = textArea?.left ?? 0;
  const areaWidth = textArea?.width ?? boxW;
  const fillWidth = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, areaWidth],
    extrapolate: 'clamp',
  });

  return (
    <View onLayout={e => setBoxW(e.nativeEvent.layout.width)}>
      <Text
        style={baseStyle}
        onTextLayout={e => {
          const ls = e.nativeEvent.lines;
          if (ls.length === 1) {
            setTextArea({left: ls[0].x, width: ls[0].width});
          } else {
            setTextArea(null); // 多行折行时整行宽度扫过
          }
        }}>
        {text}
      </Text>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: areaLeft,
          top: 0,
          bottom: 0,
          width: fillWidth,
          overflow: 'hidden',
        }}>
        {boxW > 0 && (
          <Text
            style={[baseStyle, {color: fillColor, width: boxW, marginLeft: -areaLeft}]}
            numberOfLines={0}>
            {text}
          </Text>
        )}
      </Animated.View>
    </View>
  );
}

/** 聚焦行容器：成为当前播放行时轻微上浮 + 放大，失焦时还原 */
function FocusLine({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(anim, {
      toValue: active ? 1 : 0,
      useNativeDriver: true,
      friction: 7,
      tension: 60,
    }).start();
  }, [active, anim]);
  return (
    <Animated.View
      style={{
        transform: [
          {
            scale: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 1.06],
            }),
          },
          {
            translateY: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [0, -3],
            }),
          },
        ],
      }}>
      {children}
    </Animated.View>
  );
}

export default function LyricView() {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const track = useActiveTrack();
  const progress = useProgress(500);
  const [lines, setLines] = useState<LrcLine[]>([]);
  const [transMap, setTransMap] = useState<Record<number, string>>({});
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
    setLoaded(false);
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
        const data = await getLyric({mid, trans: true});
        if (cancelled) {
          return;
        }
        const parsed = parseLrc(data?.lyric ?? '');
        setLines(parsed);
        // 翻译按时间对齐
        const trans = parseLrc(data?.trans ?? '');
        const map: Record<number, string> = {};
        for (const tl of trans) {
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
    () => findActiveLine(lines, progress.position),
    [lines, progress.position],
  );
  activeIndexRef.current = activeIndex;

  // 当前行已唱进度 0~1（行时长 = 下一行时间 - 本行时间，末行用总时长兜底）
  const activeFraction = useMemo(() => {
    if (activeIndex < 0 || activeIndex >= lines.length) {
      return 0;
    }
    const start = lines[activeIndex].time;
    const end =
      activeIndex + 1 < lines.length
        ? lines[activeIndex + 1].time
        : Math.max(progress.duration, start + 1);
    const dur = Math.max(end - start, 0.3);
    return Math.min(Math.max((progress.position - start) / dur, 0), 1);
  }, [lines, activeIndex, progress.position, progress.duration]);

  // 自动滚动到当前行（用户手滑期间暂停）
  useEffect(() => {
    if (
      !userScrolling.current &&
      activeIndex >= 0 &&
      activeIndex !== lastIndex.current &&
      lines.length > 0
    ) {
      lastIndex.current = activeIndex;
      listRef.current?.scrollToIndex({
        index: activeIndex,
        viewPosition: 0.4,
        animated: true,
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

  /** 用户滑动结束：3 秒无操作后恢复自动滚动并跳回当前播放行 */
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
    }, 3000);
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
          data={lines}
          keyExtractor={(_, i) => String(i)}
          contentContainerStyle={styles.lyricList}
          onScrollToIndexFailed={() => {}}
          onScrollBeginDrag={onUserScrollStart}
          onScrollEndDrag={onUserScrollEnd}
          onMomentumScrollEnd={onUserScrollEnd}
          renderItem={({item, index}) => (
            <TouchableOpacity
              style={styles.lineRow}
              onPress={() => seekTo(item.time)}
              onLongPress={() => copyLine(item.text)}
              delayLongPress={400}>
              {/* 左侧对应播放时间：仅手滑时渐显 */}
              <Animated.Text
                style={[
                  styles.lineTime,
                  index === activeIndex && styles.lineTimeActive,
                  {opacity: timeOpacity},
                ]}>
                {formatDuration(item.time)}
              </Animated.Text>
              <View style={styles.lineBody}>
                <FocusLine active={index === activeIndex}>
                  {index === activeIndex ? (
                    // 当前行：逐字卡拉OK染色
                    <KaraokeLine
                      text={item.text}
                      fraction={activeFraction}
                      baseStyle={[styles.line, styles.lineActiveBase]}
                      fillColor={t.primary}
                    />
                  ) : (
                    <Text style={styles.line}>{item.text}</Text>
                  )}
                  {!!transMap[index] && (
                    <Text
                      style={[
                        styles.trans,
                        index === activeIndex && styles.transActive,
                      ]}>
                      {transMap[index]}
                    </Text>
                  )}
                </FocusLine>
              </View>
              {/* 右侧占位，保持歌词视觉居中 */}
              <View style={styles.lineSpace} />
            </TouchableOpacity>
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
    lyricList: {paddingVertical: 160, paddingHorizontal: 16},
    lineRow: {flexDirection: 'row', alignItems: 'center'},
    lineTime: {
      width: 40,
      fontSize: 10,
      color: t.playerFaint,
      textAlign: 'left',
    },
    lineTimeActive: {color: t.primary, fontWeight: '700'},
    lineBody: {flex: 1},
    lineSpace: {width: 40},
    line: {
      fontSize: 15,
      color: t.playerFaint,
      textAlign: 'center',
      lineHeight: 24,
      marginVertical: 8,
    },
    lineActiveBase: {color: t.playerText, fontSize: 17, fontWeight: '700'},
    trans: {
      fontSize: 12,
      color: t.playerFaint,
      textAlign: 'center',
      marginTop: -4,
      marginBottom: 6,
    },
    transActive: {color: 'rgba(49,194,124,0.8)'},
    placeholder: {flex: 1, alignItems: 'center', justifyContent: 'center'},
    placeholderText: {color: t.playerFaint, fontSize: 14},
  });
