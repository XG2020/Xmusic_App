import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {useColorScheme} from 'react-native';
import {
  ThemeMode,
  getThemeMode,
  setThemeMode as persistThemeMode,
  FontSize,
  FONT_SCALE,
  getFontSize,
  setFontSize as persistFontSize,
  getThemeColor,
  subscribeThemeColor,
  panelEnabled,
  panelColor,
  panelAlpha,
  subscribePanel,
} from '../services/settings';
import {setGlobalFontScale} from '../utils/globalFont';

/**
 * 用户自定义主题色的可读性收敛：按明度线性缩放并收敛到与默认绿（相对亮度≈0.41）
 * 相当的亮度区间，兼顾两类用途的对比度：
 * - 深色底上的文字/图标/线条（需足够亮）
 * - 主色底上的白色文字（按钮/选中胶囊，需避免过亮导致白字看不清）
 * 色相保持不变，仅整体明度迁移到安全区间。
 */
function fitPrimary(hex: string, isDark: boolean): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 0xff;
  let g = (n >> 8) & 0xff;
  let b = n & 0xff;
  const lum = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
  // 暗色主题：收敛到 [0.42, 0.55]；亮色主题：收敛到 [0.32, 0.45]
  const target = isDark
    ? Math.min(0.55, Math.max(lum + 0.08, 0.42))
    : Math.min(0.45, Math.max(lum - 0.08, 0.32));
  const scale = target / (lum || 0.5);
  const cl = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * scale)));
  r = cl(r);
  g = cl(g);
  b = cl(b);
  // 兜底：蓝/紫等色相相对亮度极低（蓝通道对亮度贡献仅 7%），纯缩放提亮有限，
  // 暗色主题下向白色混合补足对比度，保证深底上的文字/图标清晰可辨
  if (isDark) {
    const lin = (v: number) => Math.pow((v / 255 + 0.055) / 1.055, 2.4);
    const rel = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    if (rel < 0.18) {
      const t = 1 - rel / 0.18;
      r = Math.round(r + (255 - r) * t);
      g = Math.round(g + (255 - g) * t);
      b = Math.round(b + (255 - b) * t);
    }
  }
  return `rgb(${r}, ${g}, ${b})`;
}

/** 解析颜色为 [r,g,b]（支持 #RRGGBB 与 rgb(r, g, b)），失败返回 null */
function parseRgb(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(color);
  if (m) {
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

/** 板块背景：板块色按 alpha 输出为半透明色（alpha=1 纯板块色，alpha=0 完全透明，
 * 页面底色/背景图直接透出）。不透明度叠加在底色上的视觉效果与原混合逻辑一致，
 * 但支持真正的透明——浓度调低时不再残留一层默认主题色 */
function mixPanel(color: string, alpha: number): string {
  const p = parseRgb(color);
  if (!p) {
    return color;
  }
  return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${Math.max(0, Math.min(1, alpha))})`;
}

/** 预置主题色色板（#RRGGBB，明暗模式下由 fitPrimary 自动保证对比度），首项为默认色 */
export const PRESET_THEME_COLORS: string[] = [
  '#31C27C',
  '#2F6FE4',
  '#8A5CF5',
  '#E5484D',
  '#E8792B',
  '#12B8A6',
  '#E05A9E',
  '#D98E04',
];

/** 主题色板（深/浅两套，primary 绿色两套一致） */
export type Theme = {
  isDark: boolean;
  primary: string;
  bg: string;
  card: string;
  cardLight: string;
  text: string;
  sub: string;
  /** 分隔线 */
  border: string;
  /** 播放/歌词页背景与文字 */
  playerBg: string;
  playerText: string;
  playerSub: string;
  /** 更弱的文字（歌词未激活行、提示） */
  playerFaint: string;
  /** 唱片底色与描边 */
  discBg: string;
  discBorder: string;
  /** 弹层次要按钮背景 */
  sheetBtn: string;
  /** 全屏加载遮罩 */
  mask: string;
  /** 板块背景（搜索栏/底栏/迷你条/歌单分类栏）：用户自定义板块色按透明度输出半透明色，
   *  未自定义时回退当前明暗模式的卡片色；透明度 0 = 完全透明；null = 不启用 */
  panel: string | null;
  /** 迷你播放条底色：始终跟随板块颜色与透明度（不受板块背景总开关影响），
   *  未自定义板块色时回退当前明暗模式的卡片色 @ 当前透明度 */
  miniBar: string;
};

export const DARK_THEME: Theme = {
  isDark: true,
  primary: '#31C27C',
  bg: '#0F1B2A',
  card: '#182A3F',
  cardLight: '#213650',
  text: '#EAF0F6',
  sub: '#7E8CA0',
  border: 'rgba(255,255,255,0.06)',
  playerBg: '#0B1622',
  playerText: '#FFFFFF',
  playerSub: 'rgba(255,255,255,0.6)',
  playerFaint: 'rgba(255,255,255,0.42)',
  discBg: '#1B1D21',
  discBorder: 'rgba(255,255,255,0.08)',
  sheetBtn: 'rgba(255,255,255,0.06)',
  mask: 'rgba(11,22,34,0.7)',
  panel: null,
  miniBar: mixPanel('#182A3F', 0.5),
};

export const LIGHT_THEME: Theme = {
  isDark: false,
  primary: '#31C27C',
  bg: '#F5F7FA',
  card: '#FFFFFF',
  cardLight: '#EEF2F7',
  text: '#1F2A38',
  sub: '#8A97A8',
  border: 'rgba(0,0,0,0.06)',
  playerBg: '#EEF2F7',
  playerText: '#1F2A38',
  playerSub: 'rgba(31,42,56,0.6)',
  // 浅色底吃对比度，未激活歌词行要比深色模式（0.42）更实一些才可读
  playerFaint: 'rgba(31,42,56,0.55)',
  discBg: '#DCE4EE',
  discBorder: 'rgba(0,0,0,0.08)',
  sheetBtn: 'rgba(0,0,0,0.05)',
  mask: 'rgba(245,247,250,0.75)',
  panel: null,
  miniBar: mixPanel('#FFFFFF', 0.5),
};

type ThemeContextValue = {
  t: Theme;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  fontSize: FontSize;
  setFontSize: (f: FontSize) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  t: DARK_THEME,
  mode: 'system',
  setMode: () => {},
  fontSize: 'standard',
  setFontSize: () => {},
});

export function ThemeProvider({children}: {children: React.ReactNode}) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [fontSize, setFontSizeState] = useState<FontSize>('standard');
  // 用户自定义主题色（null = 默认色），设置页选择后立即重建主题
  const [customColor, setCustomColor] = useState<string | null>(getThemeColor());
  // 板块背景设置（开关 + 透明度）变化时重建主题
  const [panelTick, setPanelTick] = useState(0);

  useEffect(() => {
    getThemeMode().then(setModeState);
    getFontSize().then(f => {
      setGlobalFontScale(FONT_SCALE[f]);
      setFontSizeState(f);
    });
    return subscribeThemeColor(setCustomColor);
  }, []);

  useEffect(() => subscribePanel(() => setPanelTick(t => t + 1)), []);

  const setMode = (m: ThemeMode) => {
    setModeState(m);
    persistThemeMode(m).catch(() => {});
  };

  // 先更新全局缩放倍数，再触发 context 变化让全树重渲染生效
  const setFontSize = (f: FontSize) => {
    setGlobalFontScale(FONT_SCALE[f]);
    setFontSizeState(f);
    persistFontSize(f).catch(() => {});
  };

  const value = useMemo(() => {
    const isDark =
      mode === 'dark' || (mode === 'system' && systemScheme !== 'light');
    const base = isDark ? DARK_THEME : LIGHT_THEME;
    // 自定义主题色：按当前明暗模式做亮度收敛保证可读性，未设置时用默认色
    const primary = customColor ? fitPrimary(customColor, isDark) : base.primary;
    // 板块背景：开启后 = 用户自定义板块色（未设置时回退当前明暗模式的卡片色，
    // 即板块未开启自定义时的原生颜色，而非主题色）按透明度输出半透明色；
    // 独立于主题色配置；浓度 0 时完全透明、不残留默认主题色；关闭时保持原有背景色
    let panel: string | null = null;
    if (panelEnabled()) {
      panel = mixPanel(panelColor() ?? base.card, panelAlpha());
    }
    // 迷你播放条底色：板块色开启时跟随板块颜色与透明度；关闭时回退卡片色不透明
    const miniBar = panelEnabled()
      ? mixPanel(panelColor() ?? base.card, panelAlpha())
      : base.card;
    const themed = primary !== base.primary || !!panel || miniBar !== base.miniBar;
    return {
      t: themed ? {...base, primary, panel, miniBar} : base,
      mode,
      setMode,
      fontSize,
      setFontSize,
    };
    // panelTick：板块背景外部订阅（subscribePanel）的触发计数器，
    // 变化时重算主题；panelEnabled()/panelColor()/panelAlpha() 是模块级
    // 全局缓存读取，静态分析看不到依赖，实为必要依赖，勿删
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, systemScheme, fontSize, customColor, panelTick]);

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
