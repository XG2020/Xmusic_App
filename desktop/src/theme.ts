import {useCallback, useLayoutEffect, useState} from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = Exclude<ThemeMode, 'system'>;

export interface ThemePreferences {
  mode: ThemeMode;
  accent: string;
  backgrounds: Record<ResolvedTheme, string | null>;
  backgroundImages: Record<ResolvedTheme, string | null>;
  floatingBackgroundImage: string | null;
}

export interface ThemeController extends ThemePreferences {
  resolvedMode: ResolvedTheme;
  background: string | null;
  backgroundImage: string | null;
  themeError: string;
  floatingBackgroundError: string;
  setMode: (mode: ThemeMode) => void;
  setAccent: (color: string) => void;
  setBackground: (color: string | null, mode?: ResolvedTheme) => void;
  setBackgroundImage: (image: string | null, mode?: ResolvedTheme) => void;
  importBackgroundImage: (file: File, mode?: ResolvedTheme) => Promise<boolean>;
  setFloatingBackgroundImage: (image: string | null) => void;
  importFloatingBackgroundImage: (file: File) => Promise<boolean>;
  reset: () => void;
}

export const THEME_STORAGE_KEY = 'xmusic:theme';
export const DEFAULT_ACCENT = '#63da9d';
export const DEFAULT_BACKGROUNDS: Record<ResolvedTheme, string> = {dark: '#15191b', light: '#f5f7f8'};
export const MAX_BACKGROUND_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_BACKGROUND_DATA_URL_LENGTH = 850000;
export const ACCENT_PRESETS = [
  {name: '薄荷绿', color: DEFAULT_ACCENT},
  {name: '晴空蓝', color: '#6ea8fe'},
  {name: '鸢尾紫', color: '#b49aff'},
  {name: '蔷薇粉', color: '#ee8faf'},
  {name: '琥珀金', color: '#edb76d'},
  {name: '海盐青', color: '#5ecdd3'},
] as const;

const defaultPreferences = (): ThemePreferences => ({mode: 'dark', accent: DEFAULT_ACCENT, backgrounds: {dark: null, light: null}, backgroundImages: {dark: null, light: null}, floatingBackgroundImage: null});

/** Keep locally imported raster images bounded and exclude executable SVG/CSS URLs. */
export function normalizeBackgroundImage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_BACKGROUND_DATA_URL_LENGTH) return null;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

export async function prepareBackgroundImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
  if (!file.size || file.size > MAX_BACKGROUND_FILE_BYTES) throw new Error('图片大小需在 8 MB 以内。');
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取这张图片，请重新选择。'));
    reader.onerror = () => reject(new Error('无法读取这张图片，请重新选择。'));
    reader.readAsDataURL(file);
  });
  const picture = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片无法解码，请选择其他图片。'));
    image.src = source;
  });
  if (!picture.naturalWidth || !picture.naturalHeight || picture.naturalWidth * picture.naturalHeight > 40000000) {
    throw new Error('图片分辨率过大，请使用 4000 万像素以内的图片。');
  }
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1920 / Math.max(picture.naturalWidth, picture.naturalHeight));
  canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境无法处理图片，请重启后重试。');
  for (let attempt = 0; attempt < 5; attempt++) {
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL('image/webp', Math.max(0.55, 0.85 - attempt * 0.1));
    const normalized = normalizeBackgroundImage(result);
    if (normalized) return normalized;
    canvas.width = Math.max(1, Math.round(canvas.width * 0.8));
    canvas.height = Math.max(1, Math.round(canvas.height * 0.8));
  }
  throw new Error('图片处理后仍然过大，请选择尺寸更小的图片。');
}

/** Only opaque RGB hex colors are accepted; no CSS expressions or alpha values. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${[...hex].map(character => character + character).join('')}`;
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : null;
}

export function parseThemePreferences(value: unknown): ThemePreferences {
  const result = defaultPreferences();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const record = value as Record<string, unknown>;
  if (record.mode === 'dark' || record.mode === 'light' || record.mode === 'system') result.mode = record.mode;
  result.accent = normalizeHex(record.accent) ?? DEFAULT_ACCENT;
  if (record.backgrounds && typeof record.backgrounds === 'object' && !Array.isArray(record.backgrounds)) {
    const backgrounds = record.backgrounds as Record<string, unknown>;
    result.backgrounds = {dark: normalizeHex(backgrounds.dark), light: normalizeHex(backgrounds.light)};
  }
  if (record.backgroundImages && typeof record.backgroundImages === 'object' && !Array.isArray(record.backgroundImages)) {
    const images = record.backgroundImages as Record<string, unknown>;
    result.backgroundImages = {dark: normalizeBackgroundImage(images.dark), light: normalizeBackgroundImage(images.light)};
  }
  result.floatingBackgroundImage = normalizeBackgroundImage(record.floatingBackgroundImage);
  return result;
}

function readPreferences(): ThemePreferences {
  try { return parseThemePreferences(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? 'null')); }
  catch { return defaultPreferences(); }
}

function channels(hex: string): number[] {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
}

function mix(first: string, second: string, amount: number): string {
  const other = channels(second);
  return `#${channels(first).map((channel, index) => Math.round(channel * (1 - amount) + other[index] * amount).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(color: string): number {
  const [red, green, blue] = channels(color).map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

export function contrastRatio(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function textOnColor(color: string): string {
  return contrastRatio('#ffffff', color) > contrastRatio('#000000', color) ? '#ffffff' : '#000000';
}

function readable(color: string, backgrounds: string[], ratio: number, target: string): string {
  if (backgrounds.every(background => contrastRatio(color, background) >= ratio)) return color;
  // Move toward the palette's foreground, preserving the requested hue when possible.
  for (let step = 1; step <= 100; step++) {
    const candidate = mix(color, target, step / 100);
    if (backgrounds.every(background => contrastRatio(candidate, background) >= ratio)) return candidate;
  }
  return target;
}

/** Derive every surface from the user's base/accent, including extreme custom colors. */
export function createThemePalette(mode: ResolvedTheme, requestedAccent: string, requestedBackground: string | null = null, hasBackgroundImage = false): Record<string, string> {
  const accent = normalizeHex(requestedAccent) ?? DEFAULT_ACCENT;
  const background = normalizeHex(requestedBackground) ?? DEFAULT_BACKGROUNDS[mode];
  const foreground = textOnColor(background);
  const darkSurface = foreground === '#ffffff';
  // Surfaces move away from text, so arbitrary custom backgrounds remain readable.
  const backdrop = darkSurface ? '#000000' : '#ffffff';
  const surface = mix(background, backdrop, 0.12);
  const raised = mix(background, backdrop, 0.22);
  const inset = mix(background, backdrop, 0.32);
  const chrome = mix(background, backdrop, 0.28);
  const player = mix(background, backdrop, 0.16);
  const tint = (base: string, color: string, amount: number) => {
    // Constrain tinted surfaces to the same contrast side as the page background.
    let candidate = mix(base, color, amount);
    while (contrastRatio(foreground, candidate) < 4.65 && amount > 0) {
      amount = Math.max(0, amount - 0.01);
      candidate = mix(base, color, amount);
    }
    return candidate;
  };
  const soft = tint(surface, accent, 0.09);
  const strong = tint(surface, accent, 0.17);
  const heroStart = tint(raised, accent, 0.18);
  const heroMiddle = tint(surface, accent, 0.12);
  const heroEnd = tint(surface, accent, 0.05);
  const coverStart = tint(raised, accent, 0.23);
  const coverEnd = tint(surface, accent, 0.1);
  const hover = tint(background, foreground, 0.05);
  const backgrounds = [background, surface, raised, inset, chrome, player, soft, strong, heroStart, heroMiddle, heroEnd, coverStart, coverEnd, hover];
  const text = readable(darkSurface ? '#edf3ef' : '#17241c', backgrounds, 4.5, foreground);
  const muted = readable(mix(text, background, 0.36), backgrounds, 4.5, foreground);
  const subtle = readable(mix(text, background, 0.46), backgrounds, 4.5, foreground);
  const accentText = readable(accent, backgrounds, 4.5, foreground);
  // Timed lyrics need a visible boundary between the sung and pending glyphs.
  // The active row has an opaque soft surface, including over custom photos.
  // Keep the light-mode karaoke fill bright green: applying the normal text
  // contrast correction here darkens it until sung and pending words look alike.
  const lyricSung = darkSurface ? readable(accent, [soft], 7, foreground)
    : accent === DEFAULT_ACCENT ? '#16c76b' : accent;
  const lyricPending = darkSurface
    ? readable(mix(text, soft, 0.62), [soft], 3, foreground)
    : readable('#536259', [soft, lyricSung], 3, foreground);
  const accentHover = mix(accent, textOnColor(accent), 0.09);
  const dangerBase = darkSurface ? '#f29f97' : '#a92d28';
  const warningBase = darkSurface ? '#ecd08b' : '#795408';
  const dangerBackground = tint(surface, dangerBase, 0.13);
  const warningBackground = tint(surface, warningBase, 0.13);
  const danger = readable(dangerBase, [dangerBackground], 4.5, foreground);

  const palette = {
    '--text': text,
    '--muted': muted,
    '--subtle': subtle,
    '--page-bg': background,
    '--chrome-bg': chrome,
    '--surface': surface,
    '--surface-raised': raised,
    '--surface-inset': inset,
    '--player-bg': player,
    '--border': mix(background, foreground, 0.14),
    '--border-strong': mix(background, foreground, 0.27),
    '--hover': hover,
    '--range-track': mix(background, foreground, 0.2),
    '--scrollbar': mix(background, foreground, 0.23),
    '--accent': accentText,
    '--lyric-sung': lyricSung,
    '--lyric-pending': lyricPending,
    '--accent-fill': accent,
    '--accent-contrast': textOnColor(accent),
    '--accent-hover': accentHover,
    '--accent-hover-contrast': textOnColor(accentHover),
    '--accent-soft': soft,
    '--accent-soft-strong': strong,
    '--accent-border': mix(surface, accentText, 0.32),
    '--accent-glow': `${accent}22`,
    '--hero-start': heroStart,
    '--hero-middle': heroMiddle,
    '--hero-end': heroEnd,
    '--cover-start': coverStart,
    '--cover-end': coverEnd,
    '--shadow': darkSurface ? '#00000055' : '#182c241c',
    '--danger': danger,
    '--danger-contrast': textOnColor(danger),
    '--danger-bg': dangerBackground,
    '--danger-border': mix(dangerBackground, dangerBase, 0.4),
    '--warning': readable(warningBase, [warningBackground], 4.5, foreground),
    '--warning-bg': warningBackground,
    '--warning-border': mix(warningBackground, warningBase, 0.4),
  };
  // Match the mobile 65% theme-colored mask, strengthening it only for custom
  // colors that otherwise cannot support readable text over a bright/dark photo.
  let maskAlpha = 166;
  let imageSurfaces: string[] = [];
  if (hasBackgroundImage) {
    do {
      imageSurfaces = ['#000000', '#ffffff'].map(color => mix(color, background, maskAlpha / 255));
      if (imageSurfaces.every(color => contrastRatio(foreground, color) >= 4.65)) break;
      maskAlpha++;
    } while (maskAlpha < 255);
    for (const name of ['--text', '--muted', '--subtle', '--accent'] as const) {
      palette[name] = readable(palette[name], [...backgrounds, ...imageSurfaces], 4.5, foreground);
    }
  }
  return {...palette, '--page-image-mask': `${background}${maskAlpha.toString(16).padStart(2, '0')}`};
}

function systemIsDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true;
}

function applyTheme(preferences: ThemePreferences, mode: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const backgroundImage = preferences.backgroundImages[mode];
  root.dataset.theme = mode;
  root.dataset.backgroundImage = backgroundImage ? 'true' : 'false';
  root.style.setProperty('--page-background-image', backgroundImage ? `url("${backgroundImage}")` : 'none');
  root.style.colorScheme = mode;
  for (const [name, value] of Object.entries(createThemePalette(mode, preferences.accent, preferences.backgrounds[mode], !!backgroundImage))) {
    root.style.setProperty(name, value);
  }
}

// Run at module evaluation, before React mounts, so a saved light theme never flashes dark.
if (typeof document !== 'undefined') {
  const initial = readPreferences();
  applyTheme(initial, initial.mode === 'system' ? systemIsDark() ? 'dark' : 'light' : initial.mode);
}

export function useTheme(): ThemeController {
  const [preferences, setPreferences] = useState(readPreferences);
  const [systemDark, setSystemDark] = useState(systemIsDark);
  const [themeError, setThemeError] = useState('');
  const [floatingBackgroundError, setFloatingBackgroundError] = useState('');
  const resolvedMode = preferences.mode === 'system' ? systemDark ? 'dark' : 'light' : preferences.mode;

  useLayoutEffect(() => {
    if (preferences.mode !== 'system' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(query.matches);
    const change = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, [preferences.mode]);

  useLayoutEffect(() => {
    applyTheme(preferences, resolvedMode);
    try { localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(preferences)); }
    catch { setThemeError('外观已应用，但保存失败。请移除背景图片或释放存储空间后重试。'); window.dispatchEvent(new CustomEvent('storage-error')); }
  }, [preferences, resolvedMode]);

  const setMode = useCallback((mode: ThemeMode) => {
    setThemeError('');
    if (mode === 'dark' || mode === 'light' || mode === 'system') setPreferences(current => ({...current, mode}));
  }, []);
  const setAccent = useCallback((color: string) => {
    setThemeError('');
    const accent = normalizeHex(color);
    if (accent) setPreferences(current => ({...current, accent}));
  }, []);
  const setBackground = useCallback((color: string | null, mode: ResolvedTheme = resolvedMode) => {
    setThemeError('');
    if (mode !== 'dark' && mode !== 'light') return;
    const background = normalizeHex(color);
    if (color !== null && !background) return;
    setPreferences(current => ({...current, backgrounds: {...current.backgrounds, [mode]: background}}));
  }, [resolvedMode]);
  const setBackgroundImage = useCallback((image: string | null, mode: ResolvedTheme = resolvedMode) => {
    if (mode !== 'dark' && mode !== 'light') return;
    const normalized = normalizeBackgroundImage(image);
    if (image !== null && !normalized) { setThemeError('背景图片格式无效或过大，请重新选择。'); return; }
    setThemeError('');
    setPreferences(current => ({...current, backgroundImages: {...current.backgroundImages, [mode]: normalized}}));
  }, [resolvedMode]);
  const importBackgroundImage = useCallback(async (file: File, mode: ResolvedTheme = resolvedMode) => {
    try { setBackgroundImage(await prepareBackgroundImage(file), mode); return true; }
    catch (error) { setThemeError(error instanceof Error ? error.message : '图片导入失败，请重试。'); return false; }
  }, [resolvedMode, setBackgroundImage]);
  const setFloatingBackgroundImage = useCallback((image: string | null) => {
    const normalized = normalizeBackgroundImage(image);
    if (image !== null && !normalized) { setFloatingBackgroundError('背景图片格式无效或过大，请重新选择。'); return; }
    setFloatingBackgroundError('');
    setThemeError('');
    setPreferences(current => ({...current, floatingBackgroundImage: normalized}));
  }, []);
  const importFloatingBackgroundImage = useCallback(async (file: File) => {
    try { setFloatingBackgroundImage(await prepareBackgroundImage(file)); return true; }
    catch (error) { setFloatingBackgroundError(error instanceof Error ? error.message : '图片导入失败，请重试。'); return false; }
  }, [setFloatingBackgroundImage]);
  const reset = useCallback(() => {
    setThemeError('');
    setPreferences(current => ({...defaultPreferences(), floatingBackgroundImage: current.floatingBackgroundImage}));
  }, []);

  return {...preferences, resolvedMode, background: preferences.backgrounds[resolvedMode], backgroundImage: preferences.backgroundImages[resolvedMode], themeError, floatingBackgroundError, setMode, setAccent, setBackground, setBackgroundImage, importBackgroundImage, setFloatingBackgroundImage, importFloatingBackgroundImage, reset};
}
