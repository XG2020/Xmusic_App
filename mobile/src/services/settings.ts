import AsyncStorage from '@react-native-async-storage/async-storage';
import {NativeModules} from 'react-native';
import RNFS from 'react-native-fs';

/** 音质可选值（与 api.md /api/song/url 的 quality 参数一致，不可用时服务端自动降级） */
export type Quality = 'master' | 'atmos_2' | 'atmos_51' | 'flac' | '320' | '128';

export type QualityOption = {
  value: Quality;
  label: string;
  desc: string;
  /** 该音质对应的文件格式（用于下载文件扩展名兜底） */
  ext: 'mp3' | 'flac';
};

/** 从低到高排列，方便 UI 展示 */
export const QUALITY_OPTIONS: QualityOption[] = [
  {value: '128', label: '标准', desc: 'MP3 128kbps', ext: 'mp3'},
  {value: '320', label: 'HQ 高品质', desc: 'MP3 320kbps', ext: 'mp3'},
  {value: 'flac', label: 'SQ 无损', desc: 'FLAC', ext: 'flac'},
  {value: 'atmos_51', label: '臻品音质', desc: 'FLAC 16Bit 44.1kHz', ext: 'flac'},
  {value: 'atmos_2', label: '臻品全景声', desc: 'FLAC 16Bit 44.1kHz', ext: 'flac'},
  {value: 'master', label: '臻品母带', desc: 'FLAC 24Bit 192kHz', ext: 'flac'},
];

export function qualityOption(q: Quality): QualityOption {
  return QUALITY_OPTIONS.find(o => o.value === q) ?? QUALITY_OPTIONS[1];
}

const PLAY_QUALITY_KEY = 'play_quality';
const DOWNLOAD_QUALITY_KEY = 'download_quality';

const VALID = new Set(QUALITY_OPTIONS.map(o => o.value));

async function readQuality(key: string, fallback: Quality): Promise<Quality> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw && VALID.has(raw as Quality) ? (raw as Quality) : fallback;
  } catch (e) {
    return fallback;
  }
}

/** 播放音质，默认 320（流量友好） */
export async function getPlayQuality(): Promise<Quality> {
  return readQuality(PLAY_QUALITY_KEY, '320');
}

export async function setPlayQuality(q: Quality) {
  await AsyncStorage.setItem(PLAY_QUALITY_KEY, q);
}

/** 下载音质，默认无损 */
export async function getDownloadQuality(): Promise<Quality> {
  return readQuality(DOWNLOAD_QUALITY_KEY, 'flac');
}

export async function setDownloadQuality(q: Quality) {
  await AsyncStorage.setItem(DOWNLOAD_QUALITY_KEY, q);
}

// ===== 下载附件开关（歌词/封面） =====

const DL_LYRIC_KEY = 'dl_with_lyric';
const DL_COVER_KEY = 'dl_with_cover';

/** 下载歌曲时同时下载歌词（.lrc），默认开启 */
export async function getDownloadLyric(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(DL_LYRIC_KEY)) !== '0';
  } catch (e) {
    return true;
  }
}

export async function setDownloadLyric(on: boolean) {
  await AsyncStorage.setItem(DL_LYRIC_KEY, on ? '1' : '0');
}

/** 下载歌曲时同时下载封面（.jpg），默认开启 */
export async function getDownloadCover(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(DL_COVER_KEY)) !== '0';
  } catch (e) {
    return true;
  }
}

export async function setDownloadCover(on: boolean) {
  await AsyncStorage.setItem(DL_COVER_KEY, on ? '1' : '0');
}

// ===== 主题模式 =====

export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_MODE_KEY = 'theme_mode';

// 把主题模式同步给原生（写 SharedPreferences）：下次冷启动的启动窗口
// 按应用内主题解析明暗资源，而不是只认系统深浅色
function syncNativeThemeMode(mode: ThemeMode) {
  NativeModules.LocalMusic?.setThemeMode?.(mode);
}

export async function getThemeMode(): Promise<ThemeMode> {
  try {
    const raw = await AsyncStorage.getItem(THEME_MODE_KEY);
    const mode = raw === 'light' || raw === 'dark' ? raw : 'system';
    // 启动时校准原生侧标志，修复清数据/异常导致的两侧不一致
    syncNativeThemeMode(mode);
    return mode;
  } catch (e) {
    return 'system';
  }
}

export async function setThemeMode(mode: ThemeMode) {
  syncNativeThemeMode(mode);
  await AsyncStorage.setItem(THEME_MODE_KEY, mode);
}

// ===== 自定义本地扫描文件夹 =====

const SCAN_FOLDERS_KEY = 'scan_folders';

export async function getScanFolders(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(SCAN_FOLDERS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch (e) {
    return [];
  }
}

export async function addScanFolder(path: string): Promise<string[]> {
  const list = await getScanFolders();
  if (!list.includes(path)) {
    list.push(path);
    await AsyncStorage.setItem(SCAN_FOLDERS_KEY, JSON.stringify(list));
  }
  return list;
}

export async function removeScanFolder(path: string): Promise<string[]> {
  const list = (await getScanFolders()).filter(p => p !== path);
  await AsyncStorage.setItem(SCAN_FOLDERS_KEY, JSON.stringify(list));
  return list;
}

// ===== 软件字号（大/中/小三档，全局缩放） =====

export type FontSize = 'small' | 'standard' | 'large';

export const FONT_SIZE_OPTIONS: {value: FontSize; label: string}[] = [
  {value: 'small', label: '小'},
  {value: 'standard', label: '中（标准）'},
  {value: 'large', label: '大'},
];

/** 各档位对应的全局字号缩放倍数 */
export const FONT_SCALE: Record<FontSize, number> = {
  small: 0.9,
  standard: 1,
  large: 1.12,
};

export function fontSizeLabel(f: FontSize): string {
  return FONT_SIZE_OPTIONS.find(o => o.value === f)?.label ?? '中（标准）';
}

const FONT_SIZE_KEY = 'font_size';

export async function getFontSize(): Promise<FontSize> {
  try {
    const raw = await AsyncStorage.getItem(FONT_SIZE_KEY);
    return raw === 'small' || raw === 'large' ? raw : 'standard';
  } catch (e) {
    return 'standard';
  }
}

export async function setFontSize(f: FontSize) {
  await AsyncStorage.setItem(FONT_SIZE_KEY, f);
}

// ===== 播放歌曲后自动进入播放页 =====

const AUTO_OPEN_PLAYER_KEY = 'auto_open_player';

/** 内存缓存：点歌瞬间需同步判断，模块加载时预热，默认开启 */
let autoOpenPlayerCache = true;
AsyncStorage.getItem(AUTO_OPEN_PLAYER_KEY)
  .then(raw => {
    autoOpenPlayerCache = raw !== '0';
  })
  .catch(() => {});

/** 同步读取（列表点歌时判断是否跳转播放页） */
export function autoOpenPlayerEnabled(): boolean {
  return autoOpenPlayerCache;
}

export async function getAutoOpenPlayer(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(AUTO_OPEN_PLAYER_KEY);
    autoOpenPlayerCache = raw !== '0';
  } catch (e) {
    // 读取失败沿用缓存值
  }
  return autoOpenPlayerCache;
}

export async function setAutoOpenPlayer(on: boolean) {
  autoOpenPlayerCache = on;
  await AsyncStorage.setItem(AUTO_OPEN_PLAYER_KEY, on ? '1' : '0');
}

// ===== 迷你播放条滑动提示 =====

const SWIPE_HINT_KEY = 'swipe_hint_seen';

/** 用户是否已在迷你播放条上完成过左右滑动切歌（完成后不再显示提示） */
export async function getSwipeHintSeen(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(SWIPE_HINT_KEY)) === '1';
  } catch (e) {
    return false;
  }
}

export function markSwipeHintSeen() {
  AsyncStorage.setItem(SWIPE_HINT_KEY, '1').catch(() => {});
}

// ===== 底栏排行榜入口开关 =====

const SHOW_RANK_TAB_KEY = 'show_rank_tab';

/** 内存缓存 + 订阅：底栏需同步判断且设置页切换后立即生效，默认显示 */
let showRankTabCache = true;
const rankTabListeners = new Set<(on: boolean) => void>();
AsyncStorage.getItem(SHOW_RANK_TAB_KEY)
  .then(raw => {
    showRankTabCache = raw !== '0';
    rankTabListeners.forEach(l => l(showRankTabCache));
  })
  .catch(() => {});

/** 同步读取（底栏渲染/首页榜单卡跳转判断） */
export function showRankTabEnabled(): boolean {
  return showRankTabCache;
}

/** 订阅开关变化，返回取消函数 */
export function subscribeShowRankTab(fn: (on: boolean) => void): () => void {
  rankTabListeners.add(fn);
  return () => {
    rankTabListeners.delete(fn);
  };
}

export async function getShowRankTab(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SHOW_RANK_TAB_KEY);
    showRankTabCache = raw !== '0';
  } catch (e) {
    // 读取失败沿用缓存值
  }
  return showRankTabCache;
}

export async function setShowRankTab(on: boolean) {
  showRankTabCache = on;
  rankTabListeners.forEach(l => l(on));
  await AsyncStorage.setItem(SHOW_RANK_TAB_KEY, on ? '1' : '0');
}

// ===== 播放页封面旋转开关 =====

const COVER_SPIN_KEY = 'cover_spin';

/** 内存缓存 + 订阅：播放页可能常驻导航栈，设置页切换后需立即生效，默认开启 */
let coverSpinCache = true;
const coverSpinListeners = new Set<(on: boolean) => void>();
AsyncStorage.getItem(COVER_SPIN_KEY)
  .then(raw => {
    coverSpinCache = raw !== '0';
    coverSpinListeners.forEach(l => l(coverSpinCache));
  })
  .catch(() => {});

/** 同步读取（播放页初始渲染判断） */
export function coverSpinEnabled(): boolean {
  return coverSpinCache;
}

/** 订阅开关变化，返回取消函数 */
export function subscribeCoverSpin(fn: (on: boolean) => void): () => void {
  coverSpinListeners.add(fn);
  return () => {
    coverSpinListeners.delete(fn);
  };
}

export async function getCoverSpin(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(COVER_SPIN_KEY);
    coverSpinCache = raw !== '0';
  } catch (e) {
    // 读取失败沿用缓存值
  }
  return coverSpinCache;
}

export async function setCoverSpin(on: boolean) {
  coverSpinCache = on;
  coverSpinListeners.forEach(l => l(on));
  await AsyncStorage.setItem(COVER_SPIN_KEY, on ? '1' : '0');
}

// ===== 自定义主题色 =====

const THEME_COLOR_KEY = 'theme_color';

/** 合法主题色：#RRGGBB（大写），null 表示使用默认主题色 */
export function isValidThemeColor(v: string | null | undefined): v is string {
  return typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);
}

function normalizeThemeColor(raw: string | null): string | null {
  return isValidThemeColor(raw) ? raw.toUpperCase() : null;
}

/** 内存缓存 + 订阅：设置页选择后主题立即重建，null = 默认主题色 */
let themeColorCache: string | null = null;
const themeColorListeners = new Set<(color: string | null) => void>();
AsyncStorage.getItem(THEME_COLOR_KEY)
  .then(raw => {
    themeColorCache = normalizeThemeColor(raw);
    themeColorListeners.forEach(l => l(themeColorCache));
  })
  .catch(() => {});

/** 同步读取（主题 Provider 初始渲染判断） */
export function getThemeColor(): string | null {
  return themeColorCache;
}

/** 订阅主题色变化，返回取消函数 */
export function subscribeThemeColor(
  fn: (color: string | null) => void,
): () => void {
  themeColorListeners.add(fn);
  return () => {
    themeColorListeners.delete(fn);
  };
}

/** 设置自定义主题色（null 恢复默认） */
export async function setThemeColor(hex: string | null) {
  const normalized = normalizeThemeColor(hex);
  themeColorCache = normalized;
  themeColorListeners.forEach(l => l(normalized));
  if (normalized) {
    await AsyncStorage.setItem(THEME_COLOR_KEY, normalized);
  } else {
    await AsyncStorage.removeItem(THEME_COLOR_KEY);
  }
}

// ===== 板块背景（搜索栏/底栏/迷你条/歌单分类栏） =====

const PANEL_ENABLED_KEY = 'panel_enabled';
const PANEL_COLOR_KEY = 'panel_color';
const PANEL_ALPHA_KEY = 'panel_alpha';

/** 面板色透明度（0~1，1 = 纯板块色，0 = 完全透明，露出页面底色/背景图） */
export const PANEL_ALPHA_MIN = 0;
export const PANEL_ALPHA_MAX = 1;

/** 内存缓存 + 订阅：板块背景实时重建主题，默认关闭（板块保持原有背景色） */
let panelEnabledCache = false;
/** 用户自定义板块色（独立于主题色），null = 未自定义（跟随深浅模式默认色） */
let panelColorCache: string | null = null;
let panelAlphaCache = 0.5;
const panelListeners = new Set<() => void>();
AsyncStorage.multiGet([PANEL_ENABLED_KEY, PANEL_COLOR_KEY, PANEL_ALPHA_KEY])
  .then(pairs => {
    panelEnabledCache = (pairs[0]?.[1] ?? '0') === '1';
    const rawColor = pairs[1]?.[1] ?? null;
    panelColorCache = isValidThemeColor(rawColor) ? rawColor.toUpperCase() : null;
    const a = Number(pairs[2]?.[1] ?? NaN);
    if (Number.isFinite(a) && a >= PANEL_ALPHA_MIN && a <= PANEL_ALPHA_MAX) {
      panelAlphaCache = a;
    }
    panelListeners.forEach(l => l());
  })
  .catch(() => {});

/** 同步读取（主题 Provider 初始渲染判断） */
export function panelEnabled(): boolean {
  return panelEnabledCache;
}

/** 同步读取用户自定义板块色（null = 未自定义，板块色跟随深浅模式默认色） */
export function panelColor(): string | null {
  return panelColorCache;
}

/** 同步读取面板色透明度（0~1，0 = 完全透明） */
export function panelAlpha(): number {
  return panelAlphaCache;
}

/** 订阅板块背景设置变化，返回取消函数 */
export function subscribePanel(fn: () => void): () => void {
  panelListeners.add(fn);
  return () => {
    panelListeners.delete(fn);
  };
}

export async function setPanelEnabled(on: boolean) {
  panelEnabledCache = on;
  panelListeners.forEach(l => l());
  await AsyncStorage.setItem(PANEL_ENABLED_KEY, on ? '1' : '0');
}

/** 设置自定义板块色（#RRGGBB，null 恢复深浅模式默认） */
export async function setPanelColor(hex: string | null) {
  const normalized = isValidThemeColor(hex) ? hex.toUpperCase() : null;
  panelColorCache = normalized;
  panelListeners.forEach(l => l());
  if (normalized) {
    await AsyncStorage.setItem(PANEL_COLOR_KEY, normalized);
  } else {
    await AsyncStorage.removeItem(PANEL_COLOR_KEY);
  }
}

export async function setPanelAlpha(alpha: number) {
  panelAlphaCache = Math.max(
    PANEL_ALPHA_MIN,
    Math.min(PANEL_ALPHA_MAX, alpha),
  );
  panelListeners.forEach(l => l());
  await AsyncStorage.setItem(PANEL_ALPHA_KEY, String(panelAlphaCache));
}

// ===== 流量播放提醒开关 =====

const DATA_REMINDER_KEY = 'data_reminder';

/** 内存缓存 + 订阅：点歌瞬间需同步判断是否弹流量提醒，设置页切换后立即生效，默认开启 */
let dataReminderCache = true;
const dataReminderListeners = new Set<(on: boolean) => void>();
AsyncStorage.getItem(DATA_REMINDER_KEY)
  .then(raw => {
    dataReminderCache = raw !== '0';
    dataReminderListeners.forEach(l => l(dataReminderCache));
  })
  .catch(() => {});

/** 同步读取（播放前判断是否需要弹流量提醒） */
export function dataReminderEnabled(): boolean {
  return dataReminderCache;
}

/** 订阅开关变化，返回取消函数 */
export function subscribeDataReminder(fn: (on: boolean) => void): () => void {
  dataReminderListeners.add(fn);
  return () => {
    dataReminderListeners.delete(fn);
  };
}

export async function getDataReminder(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(DATA_REMINDER_KEY);
    dataReminderCache = raw !== '0';
  } catch (e) {
    // 读取失败沿用缓存值
  }
  return dataReminderCache;
}

export async function setDataReminder(on: boolean) {
  dataReminderCache = on;
  dataReminderListeners.forEach(l => l(on));
  await AsyncStorage.setItem(DATA_REMINDER_KEY, on ? '1' : '0');
}

// ===== 边播边存开关 =====

const CACHE_WHILE_PLAY_KEY = 'cache_while_play';

/** 内存缓存 + 订阅：切歌瞬间需同步判断是否后台缓存，默认开启 */
let cacheWhilePlayCache = true;
const cacheWhilePlayListeners = new Set<(on: boolean) => void>();
AsyncStorage.getItem(CACHE_WHILE_PLAY_KEY)
  .then(raw => {
    cacheWhilePlayCache = raw !== '0';
    cacheWhilePlayListeners.forEach(l => l(cacheWhilePlayCache));
  })
  .catch(() => {});

/** 同步读取（在线曲目开播时判断是否后台缓存整曲） */
export function cacheWhilePlayEnabled(): boolean {
  return cacheWhilePlayCache;
}

/** 订阅开关变化，返回取消函数 */
export function subscribeCacheWhilePlay(fn: (on: boolean) => void): () => void {
  cacheWhilePlayListeners.add(fn);
  return () => {
    cacheWhilePlayListeners.delete(fn);
  };
}

export async function getCacheWhilePlay(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_WHILE_PLAY_KEY);
    cacheWhilePlayCache = raw !== '0';
  } catch (e) {
    // 读取失败沿用缓存值
  }
  return cacheWhilePlayCache;
}

export async function setCacheWhilePlay(on: boolean) {
  cacheWhilePlayCache = on;
  cacheWhilePlayListeners.forEach(l => l(on));
  await AsyncStorage.setItem(CACHE_WHILE_PLAY_KEY, on ? '1' : '0');
}

// ===== 仅 Wi-Fi 联网开关 =====

const WIFI_ONLY_KEY = 'wifi_only';

/**
 * 内存缓存：切歌瞬间需同步判断是否允许在蜂窝网络下后台缓存，默认关闭。
 * 关闭时流量下也「边播边存」缓存歌曲不做限制；开启时仅在 Wi-Fi 下缓存。
 */
let wifiOnlyCache = false;
AsyncStorage.getItem(WIFI_ONLY_KEY)
  .then(raw => {
    wifiOnlyCache = raw === '1';
  })
  .catch(() => {});

/** 同步读取（后台缓存前判断当前网络是否允许） */
export function wifiOnlyEnabled(): boolean {
  return wifiOnlyCache;
}

export async function getWifiOnly(): Promise<boolean> {
  try {
    wifiOnlyCache = (await AsyncStorage.getItem(WIFI_ONLY_KEY)) === '1';
  } catch (e) {
    // 读取失败沿用缓存值
  }
  return wifiOnlyCache;
}

export async function setWifiOnly(on: boolean) {
  wifiOnlyCache = on;
  await AsyncStorage.setItem(WIFI_ONLY_KEY, on ? '1' : '0');
}

// ===== 允许与其他应用同时播放开关 =====

const ALLOW_MIX_KEY = 'allow_mix';

/**
 * 内存缓存：音频焦点打断回调需同步判断，默认开启（混音，不因其他应用出声而暂停）。
 * 关闭时其他应用出声则本软件暂停，对方结束（临时焦点归还）时本软件恢复续播。
 */
let allowMixCache = true;
AsyncStorage.getItem(ALLOW_MIX_KEY)
  .then(raw => {
    allowMixCache = raw !== '0';
  })
  .catch(() => {});

/** 同步读取（setupPlayer 据此决定 autoHandleInterruptions） */
export function allowMixWithOthersEnabled(): boolean {
  return allowMixCache;
}

export async function getAllowMix(): Promise<boolean> {
  try {
    allowMixCache = (await AsyncStorage.getItem(ALLOW_MIX_KEY)) !== '0';
  } catch (e) {
    // 读取失败沿用缓存值
  }
  return allowMixCache;
}

export async function setAllowMix(on: boolean) {
  allowMixCache = on;
  await AsyncStorage.setItem(ALLOW_MIX_KEY, on ? '1' : '0');
}

// ===== 开发者模式 =====

const DEV_UNLOCKED_KEY = 'dev_unlocked';

/** 是否已通过密钥解锁开发者模式（解锁后连点版本号直接进接口设置） */
export async function getDevUnlocked(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(DEV_UNLOCKED_KEY)) === '1';
  } catch (e) {
    return false;
  }
}

export async function setDevUnlocked(on: boolean) {
  await AsyncStorage.setItem(DEV_UNLOCKED_KEY, on ? '1' : '0');
}

// ===== 搜索历史记录 =====

const SEARCH_HISTORY_KEY = 'search_history';
const SEARCH_HISTORY_MAX = 20;

export async function getSearchHistory(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(SEARCH_HISTORY_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch (e) {
    return [];
  }
}

/** 新关键词去重置顶，最多保留 20 条 */
export async function addSearchHistory(keyword: string): Promise<string[]> {
  const kw = keyword.trim();
  if (!kw) {
    return getSearchHistory();
  }
  const list = [kw, ...(await getSearchHistory()).filter(k => k !== kw)].slice(
    0,
    SEARCH_HISTORY_MAX,
  );
  await AsyncStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list));
  return list;
}

export async function clearSearchHistory() {
  await AsyncStorage.removeItem(SEARCH_HISTORY_KEY);
}

// ===== 下载目录 =====

const DOWNLOAD_DIR_KEY = 'download_dir';
/** SAF 授权目录的显示名（设置页展示用），无则回退显示 uri/路径 */
const DOWNLOAD_DIR_NAME_KEY = 'download_dir_name';
const DEFAULT_DOWNLOAD_DIR = `${
  RNFS.DownloadDirectoryPath ?? '/storage/emulated/0/Download'
}/Xmusic`;
const DEFAULT_DOWNLOAD_DIR_NAME = 'Download/Xmusic';

/** 默认下载目录：系统 Download/Xmusic */
export function getDefaultDownloadDir(): string {
  return DEFAULT_DOWNLOAD_DIR;
}

/** 默认下载目录显示名 */
export function getDefaultDownloadDirName(): string {
  return DEFAULT_DOWNLOAD_DIR_NAME;
}

/** 自定义下载目录，空字符串表示使用默认 Download/Xmusic */
export async function getDownloadDir(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(DOWNLOAD_DIR_KEY)) ?? '';
  } catch (e) {
    return '';
  }
}

export async function setDownloadDir(path: string) {
  await AsyncStorage.setItem(DOWNLOAD_DIR_KEY, path);
}

/** SAF 授权目录的显示名（如 Music/QQMusic），无显示名时返回空串 */
export async function getDownloadDirName(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(DOWNLOAD_DIR_NAME_KEY)) ?? '';
  } catch (e) {
    return '';
  }
}

export async function setDownloadDirName(name: string) {
  await AsyncStorage.setItem(DOWNLOAD_DIR_NAME_KEY, name);
}
