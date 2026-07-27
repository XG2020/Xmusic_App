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
} from '../services/settings';
import {setGlobalFontScale} from '../utils/globalFont';

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
  playerFaint: 'rgba(31,42,56,0.42)',
  discBg: '#DCE4EE',
  discBorder: 'rgba(0,0,0,0.08)',
  sheetBtn: 'rgba(0,0,0,0.05)',
  mask: 'rgba(245,247,250,0.75)',
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

  useEffect(() => {
    getThemeMode().then(setModeState);
    getFontSize().then(f => {
      setGlobalFontScale(FONT_SCALE[f]);
      setFontSizeState(f);
    });
  }, []);

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
    return {
      t: isDark ? DARK_THEME : LIGHT_THEME,
      mode,
      setMode,
      fontSize,
      setFontSize,
    };
  }, [mode, systemScheme, fontSize]);

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
