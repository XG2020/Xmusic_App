import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Animated,
  Dimensions,
  ImageSourcePropType,
  NativeModules,
  StatusBar,
  StyleSheet,
  useColorScheme,
} from 'react-native';
import {getSkin, isSkinReady, skinReady} from '../services/skin';
import {DARK_THEME, LIGHT_THEME} from '../theme';

// 内置启动图（明/暗两套，跟随当前主题；JPG 体积小解码快，避免首屏黑屏）
// 素材是「主题色纯底 + logo + 文字」，底色与 t.bg 完全一致：
// 背景由容器底色铺满全屏，图只居中显示，任何屏幕比例都无缺口无拉伸
const SPLASH_LIGHT = require('../assets/splash_light.jpg');
const SPLASH_DARK = require('../assets/splash_dark.jpg');

// 内置图画布 660x760，按 xxhdpi(3x) 投放到原生 drawable，等价 220x253dp；
// JS 侧用相同 dp 居中绘制，与原生启动窗口几何完全一致，衔接不跳变
const LOGO_W = 220;
const LOGO_H = 253;

/** 启动图停留时长：从图片真正显示出来后起算，为启动任务做缓冲 */
const HOLD_MS = 2000;
// 淡出分两段：先隐 logo 图再隐背景。图与背景若同步半透明，logo 方块区域
// 双层叠加会比周围更不透明，淡出中途能看见图的方块底色边界
const IMG_FADE_MS = 150;
const BG_FADE_MS = 300;
/** 图片迟迟加载不出来（如自定义图已被删除）时的兜底，避免卡死在启动图 */
const MAX_WAIT_MS = 2000;

/**
 * 启动图遮罩：App 首帧全屏盖在页面上（隐藏状态栏），停留片刻后淡出。
 * 优先使用皮肤自定义启动图（个性化装扮里配置），未设置时按明暗模式用内置图。
 */
export default function Splash({onDone}: {onDone: () => void}) {
  // 跟随原生 uiMode 选图/底色：应用内设了 dark/light 时，原生已通过
  // setDefaultNightMode 强制 DayNight（useColorScheme 返回强制后的值），
  // 启动窗口与 JS Splash 读到同一明暗，任何组合下都零跳变衔接
  const sysDark = useColorScheme() !== 'light';
  const baseTheme = sysDark ? DARK_THEME : LIGHT_THEME;
  // 自定义图用 screen 尺寸铺满：Android 的 window 尺寸不含状态栏/导航栏，
  // 用 window 尺寸会上下漏出底色；screen 略大于容器时 cover 多裁一点无感，
  // 显式尺寸同时规避 absoluteFill 首帧测量为 0 时 Fresco 只画左上角的问题
  const {width: screenW, height: screenH} = Dimensions.get('screen');
  const opacity = useRef(new Animated.Value(1)).current;
  // logo 图独立透明度：淡出时先于背景消失
  const imgOpacity = useRef(new Animated.Value(1)).current;
  // 自定义启动图三态：null=皮肤配置未就绪（不渲染图，纯色底等待）；
  // ''=确认无自定义图（显示内置图）；其余为自定义图 uri。
  // 首帧用原生常量 hasCustomSplash 同步判断：设置过自定义图的用户
  // 不再闪内置图（原生启动窗口此时也是纯色底，全程见不到默认启动图）
  const [customSplash, setCustomSplash] = useState<string | null>(() => {
    if (isSkinReady()) {
      return getSkin().splash ?? '';
    }
    return NativeModules.LocalMusic?.hasCustomSplash ? null : '';
  });
  const [loaded, setLoaded] = useState(false);
  const [fading, setFading] = useState(false);
  const fadingRef = useRef(false);

  // 无自定义图时首帧同步显示内置图（与原生启动窗口同一张图无缝衔接）
  const source: ImageSourcePropType | null =
    customSplash === null
      ? null
      : customSplash
      ? {uri: customSplash}
      : sysDark
      ? SPLASH_DARK
      : SPLASH_LIGHT;

  useEffect(() => {
    let alive = true;
    skinReady.then(() => {
      if (!alive) {
        return;
      }
      setCustomSplash(getSkin().splash ?? '');
    });
    return () => {
      alive = false;
    };
  }, []);

  const startFade = useCallback(() => {
    // 停留计时与兜底计时可能先后触发，只淡出一次
    if (fadingRef.current) {
      return;
    }
    fadingRef.current = true;
    setFading(true);
    // 先隐 logo 图，图完全消失后纯色背景再淡出，避免露出图的方块底色
    Animated.sequence([
      Animated.timing(imgOpacity, {
        toValue: 0,
        duration: IMG_FADE_MS,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: BG_FADE_MS,
        useNativeDriver: true,
      }),
    ]).start(() => onDone());
  }, [imgOpacity, opacity, onDone]);

  // 停留计时从图片渲染完成（onLoad）起算，保证用户能完整看到启动图
  useEffect(() => {
    if (!loaded) {
      return;
    }
    const timer = setTimeout(startFade, HOLD_MS);
    return () => clearTimeout(timer);
  }, [loaded, startFade]);

  // 兜底：图片加载失败/过慢也要按时放行进入 App
  useEffect(() => {
    const timer = setTimeout(startFade, MAX_WAIT_MS);
    return () => clearTimeout(timer);
  }, [startFade]);

  return (
    <Animated.View
      // 停留期间拦截触摸，淡出时放行避免挡住已就绪的页面
      pointerEvents={fading ? 'none' : 'auto'}
      style={[
        StyleSheet.absoluteFill,
        styles.center,
        {backgroundColor: baseTheme.bg, opacity},
      ]}>
      {/* 与原生阶段一致的透明状态栏（不再隐藏，避免原生→JS 状态栏消失跳变），
          淡出时移除让 App 级 StatusBar 接管 */}
      {!fading && (
        <StatusBar
          translucent
          backgroundColor="transparent"
          barStyle={sysDark ? 'light-content' : 'dark-content'}
        />
      )}
      {source && (
        <Animated.Image
          source={source}
          // 内置图：主题色底自然融入容器背景，固定 dp 居中与原生窗口一致；
          // 自定义图：用户自选整张图，按 screen 尺寸 cover 铺满全屏
          style={[
            customSplash
              ? {width: screenW, height: screenH}
              : {width: LOGO_W, height: LOGO_H},
            {opacity: imgOpacity},
          ]}
          resizeMode={customSplash ? 'cover' : 'contain'}
          // 按显示尺寸降采样解码，自定义大图也能快速显示
          resizeMethod="resize"
          // 关掉 Android 默认 300ms 渐显，解码完成立即整图呈现
          fadeDuration={0}
          onLoad={() => setLoaded(true)}
          onError={startFade}
        />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: {alignItems: 'center', justifyContent: 'center'},
});
