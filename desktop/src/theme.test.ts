// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ACCENT_PRESETS, DEFAULT_ACCENT, MAX_BACKGROUND_DATA_URL_LENGTH, MAX_BACKGROUND_FILE_BYTES, THEME_STORAGE_KEY, contrastRatio, createThemePalette, normalizeBackgroundImage, normalizeHex, parseThemePreferences, prepareBackgroundImage, useTheme, type ThemeController} from './theme';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=';

it('separates sung and pending lyrics in both themes, including photo backgrounds', () => {
  for (const mode of ['light', 'dark'] as const) for (const {color} of ACCENT_PRESETS) for (const photo of [false, true]) {
    const palette = createThemePalette(mode, color, null, photo);
    if (mode === 'light') expect(palette['--lyric-sung']).toBe(color === DEFAULT_ACCENT ? '#16c76b' : color);
    else expect(contrastRatio(palette['--lyric-sung'], palette['--accent-soft'])).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(palette['--lyric-pending'], palette['--accent-soft'])).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(palette['--lyric-sung'], palette['--lyric-pending'])).toBeGreaterThanOrEqual(2);
  }
});

it('lets custom colors override the bright green light-mode lyric default', () => {
  for (const color of ['#e43bab', '#2878ff', '#ab38dd']) {
    expect(createThemePalette('light', color)['--lyric-sung']).toBe(color);
    expect(createThemePalette('light', color, null, true)['--lyric-sung']).toBe(color);
  }
  expect(createThemePalette('light', DEFAULT_ACCENT)['--lyric-sung']).toBe('#16c76b');
});

describe('theme colors and persistence validation', () => {
  it('normalizes hex colors while rejecting unsafe expressions and transparency', () => {
    expect(normalizeHex(' #AbC ')).toBe('#aabbcc');
    expect(normalizeHex('7C8CF8')).toBe('#7c8cf8');
    for (const input of ['', '#abcd', '#12345678', 'red', 'var(--danger)', 'url(file:///secret)', '#gggggg', null, 123]) {
      expect(normalizeHex(input)).toBeNull();
    }
  });

  it('repairs invalid saved fields independently and keeps dark/light background overrides separate', () => {
    expect(parseThemePreferences({mode: 'sepia', accent: '#AbC', backgrounds: {dark: '#012345', light: 'not-a-color'}})).toEqual({
      mode: 'dark', accent: '#aabbcc', backgrounds: {dark: '#012345', light: null}, backgroundImages: {dark: null, light: null}, floatingBackgroundImage: null,
    });
    expect(parseThemePreferences({mode: 'system', accent: null})).toEqual({mode: 'system', accent: DEFAULT_ACCENT, backgrounds: {dark: null, light: null}, backgroundImages: {dark: null, light: null}, floatingBackgroundImage: null});
    expect(parseThemePreferences([]).mode).toBe('dark');
  });

  it('accepts bounded local raster data and rejects remote, SVG and oversized backgrounds', () => {
    expect(normalizeBackgroundImage(image)).toBe(image);
    for (const input of ['https://example.com/photo.png', 'file:///photo.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AAAA\")', `data:image/png;base64,${'A'.repeat(MAX_BACKGROUND_DATA_URL_LENGTH)}`, 12, null]) {
      expect(normalizeBackgroundImage(input)).toBeNull();
    }
    expect(parseThemePreferences({backgroundImages: {dark: image, light: 'javascript:alert(1)'}}).backgroundImages).toEqual({dark: image, light: null});
    expect(parseThemePreferences({backgroundImages: {dark: image}}).floatingBackgroundImage).toBeNull();
    expect(parseThemePreferences({floatingBackgroundImage: image}).floatingBackgroundImage).toBe(image);
    expect(parseThemePreferences({floatingBackgroundImage: 'data:image/svg+xml;base64,AAAA'}).floatingBackgroundImage).toBeNull();
  });

  it('rejects unsuitable image files before reading or decoding them', async () => {
    await expect(prepareBackgroundImage(new File(['<svg/>'], 'drawing.svg', {type: 'image/svg+xml'}))).rejects.toThrow('JPG');
    await expect(prepareBackgroundImage(new File([], 'empty.png', {type: 'image/png'}))).rejects.toThrow('8 MB');
    await expect(prepareBackgroundImage(new File([new Uint8Array(MAX_BACKGROUND_FILE_BYTES + 1)], 'large.jpg', {type: 'image/jpeg'}))).rejects.toThrow('8 MB');
  });

  it('keeps text readable over the brightest and darkest image regions with theme masks', () => {
    for (const mode of ['dark', 'light'] as const) {
      for (const base of [null, '#777777', '#ff0000', '#0000ff', '#00ff00']) {
        const palette = createThemePalette(mode, DEFAULT_ACCENT, base, true);
        const mask = palette['--page-image-mask'];
        const alpha = parseInt(mask.slice(7, 9), 16) / 255;
        expect(alpha).toBeGreaterThanOrEqual(166 / 255);
        for (const channel of [0, 255]) {
          const background = `#${[1, 3, 5].map(index => Math.round(channel * (1 - alpha) + parseInt(mask.slice(index, index + 2), 16) * alpha).toString(16).padStart(2, '0')).join('')}`;
          for (const label of ['--text', '--muted', '--subtle', '--accent']) expect(contrastRatio(palette[label], background)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('keeps text and accent labels readable on all content surfaces, including extreme custom colors', () => {
    const accents = [...ACCENT_PRESETS.map(preset => preset.color), '#000000', '#ffffff', '#ff0000', '#0000ff', '#777777'];
    const bases = [null, '#000000', '#ffffff', '#777777', '#888888', '#ff0000', '#00ff00', '#0000ff', '#ff00ff'];
    const surfaces = ['--page-bg', '--chrome-bg', '--surface', '--surface-raised', '--surface-inset', '--player-bg', '--accent-soft', '--accent-soft-strong', '--hero-start', '--hero-middle', '--hero-end', '--cover-start', '--cover-end', '--hover'];
    for (const mode of ['dark', 'light'] as const) {
      for (const accent of accents) {
        for (const base of bases) {
          const palette = createThemePalette(mode, accent, base);
          expect(palette['--accent-fill']).toBe(accent);
          for (const surface of surfaces) {
            for (const foreground of ['--text', '--muted', '--subtle', '--accent']) {
              expect(contrastRatio(palette[foreground], palette[surface]), `${mode}, ${accent}, ${base}, ${foreground} on ${surface}`).toBeGreaterThanOrEqual(4.5);
            }
          }
          for (const [foreground, background] of [['--accent-contrast', '--accent-fill'], ['--accent-hover-contrast', '--accent-hover'], ['--danger', '--danger-bg'], ['--warning', '--warning-bg']]) {
            expect(contrastRatio(palette[foreground], palette[background])).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });
});

let root: Root | undefined;
let container: HTMLDivElement;
let theme: ThemeController;
let systemDark = false;
const listeners = new Set<(event: MediaQueryListEvent) => void>();
const query = {
  get matches() { return systemDark; },
  addEventListener: vi.fn((_event: string, handler: (event: MediaQueryListEvent) => void) => listeners.add(handler)),
  removeEventListener: vi.fn((_event: string, handler: (event: MediaQueryListEvent) => void) => listeners.delete(handler)),
};

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  function Probe() { theme = useTheme(); return null; }
  await act(async () => { root!.render(createElement(Probe)); });
}

async function changeSystem(dark: boolean) {
  await act(async () => {
    systemDark = dark;
    listeners.forEach(handler => handler({matches: dark} as MediaQueryListEvent));
  });
}

beforeEach(() => {
  localStorage.clear();
  listeners.clear();
  systemDark = false;
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', vi.fn(() => query));
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('theme controller', () => {
  it('applies and restores saved light/custom theme before paint', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({mode: 'light', accent: '#7c8cf8', backgrounds: {dark: '#161127', light: '#faf4ed'}}));
    await mount();
    expect(theme.mode).toBe('light');
    expect(theme.background).toBe('#faf4ed');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--page-bg')).toBe('#faf4ed');
    expect(document.documentElement.style.getPropertyValue('--accent-fill')).toBe('#7c8cf8');
    expect(listeners.size).toBe(0);
  });

  it('responds to system changes only in system mode, including switching back later', async () => {
    await mount();
    expect(theme.resolvedMode).toBe('dark');
    await act(async () => { theme.setMode('system'); });
    expect(theme.resolvedMode).toBe('light');
    expect(listeners.size).toBe(1);
    await changeSystem(true);
    expect(theme.resolvedMode).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await act(async () => { theme.setMode('light'); });
    expect(listeners.size).toBe(0);
    await changeSystem(false);
    await changeSystem(true);
    expect(theme.resolvedMode).toBe('light');
    await act(async () => { theme.setMode('system'); });
    expect(theme.resolvedMode).toBe('dark');
  });

  it('persists valid changes, ignores invalid input and remembers independent backgrounds', async () => {
    await mount();
    await act(async () => { theme.setAccent('f0a'); theme.setBackground('#121026'); });
    await act(async () => { theme.setMode('light'); });
    expect(theme.background).toBeNull();
    await act(async () => { theme.setBackground('#fafafa'); theme.setAccent('url(secret)'); });
    expect(theme.accent).toBe('#ff00aa');
    expect(theme.backgrounds).toEqual({dark: '#121026', light: '#fafafa'});
    const saved = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!);
    expect(saved).toEqual({mode: 'light', accent: '#ff00aa', backgrounds: {dark: '#121026', light: '#fafafa'}, backgroundImages: {dark: null, light: null}, floatingBackgroundImage: null});
    await act(async () => { theme.setMode('dark'); });
    expect(theme.background).toBe('#121026');
    await act(async () => { theme.reset(); });
    expect(theme.mode).toBe('dark');
    expect(theme.accent).toBe(DEFAULT_ACCENT);
    expect(theme.backgrounds).toEqual({dark: null, light: null});
  });

  it('persists independent pictures, applies masks, and clears image styles on removal', async () => {
    await mount();
    await act(async () => { theme.setBackgroundImage(image); });
    expect(theme.backgroundImage).toBe(image);
    expect(document.documentElement.dataset.backgroundImage).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--page-background-image')).toContain(image);
    await act(async () => { theme.setMode('light'); });
    expect(theme.backgroundImage).toBeNull();
    expect(document.documentElement.dataset.backgroundImage).toBe('false');
    await act(async () => { theme.setBackgroundImage(image); theme.setMode('dark'); });
    await act(async () => { theme.setBackgroundImage(null); });
    expect(theme.backgroundImages).toEqual({dark: null, light: image});
    expect(document.documentElement.style.getPropertyValue('--page-background-image')).toBe('none');
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!).backgroundImages).toEqual({dark: null, light: image});
    await act(async () => { theme.reset(); });
    expect(theme.backgroundImages).toEqual({dark: null, light: null});
  });

  it('surfaces image validation and storage failures without silently claiming persistence', async () => {
    await mount();
    await act(async () => { theme.setBackgroundImage('https://example.com/bg.jpg'); });
    expect(theme.themeError).toContain('格式无效');
    expect(theme.backgroundImage).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    await act(async () => { theme.setBackgroundImage(image); });
    expect(theme.backgroundImage).toBe(image);
    expect(theme.themeError).toContain('保存失败');
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!).backgroundImages.dark).toBeNull();
  });

  it('keeps a saved floating image independent of theme pictures, mode changes and appearance reset', async () => {
    const floatingImage = 'data:image/webp;base64,AAAA';
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({mode: 'dark', backgroundImages: {dark: image}, floatingBackgroundImage: floatingImage}));
    await mount();
    expect(theme.floatingBackgroundImage).toBe(floatingImage);
    expect(theme.backgroundImage).toBe(image);
    expect(document.documentElement.style.getPropertyValue('--page-background-image')).toContain(image);
    await act(async () => { theme.setBackgroundImage(null); theme.setMode('light'); });
    expect(theme.floatingBackgroundImage).toBe(floatingImage);
    expect(theme.backgroundImage).toBeNull();
    await act(async () => { theme.reset(); });
    expect(theme.floatingBackgroundImage).toBe(floatingImage);
    await act(async () => { theme.setBackgroundImage(image); theme.setFloatingBackgroundImage(null); });
    expect(theme.backgroundImage).toBe(image);
    expect(theme.floatingBackgroundImage).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--page-background-image')).toContain(image);
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!).floatingBackgroundImage).toBeNull();
  });

  it('persists floating image changes without applying them to the application and rejects invalid imports', async () => {
    await mount();
    await act(async () => { theme.setFloatingBackgroundImage(image); });
    expect(theme.floatingBackgroundImage).toBe(image);
    expect(theme.backgroundImages).toEqual({dark: null, light: null});
    expect(document.documentElement.style.getPropertyValue('--page-background-image')).toBe('none');
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!).floatingBackgroundImage).toBe(image);
    await act(async () => { theme.setFloatingBackgroundImage('https://example.com/bg.jpg'); });
    expect(theme.floatingBackgroundImage).toBe(image);
    expect(theme.floatingBackgroundError).toContain('格式无效');
    await act(async () => {
      expect(await theme.importFloatingBackgroundImage(new File(['<svg/>'], 'picture.svg', {type: 'image/svg+xml'}))).toBe(false);
    });
    expect(theme.floatingBackgroundImage).toBe(image);
    expect(theme.floatingBackgroundError).toContain('JPG');
    expect(theme.themeError).toBe('');
    await act(async () => { theme.setFloatingBackgroundImage(null); });
    expect(theme.floatingBackgroundError).toBe('');
  });

  it('recovers from corrupt storage and removes the system listener on unmount', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, '{broken');
    await mount();
    expect(theme.accent).toBe(DEFAULT_ACCENT);
    await act(async () => { theme.setMode('system'); });
    expect(listeners.size).toBe(1);
    await act(async () => { root!.unmount(); root = undefined; });
    expect(listeners.size).toBe(0);
  });
});
