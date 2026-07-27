import AsyncStorage from '@react-native-async-storage/async-storage';

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

export async function getThemeMode(): Promise<ThemeMode> {
  try {
    const raw = await AsyncStorage.getItem(THEME_MODE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  } catch (e) {
    return 'system';
  }
}

export async function setThemeMode(mode: ThemeMode) {
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

/** 自定义下载目录，空字符串表示使用应用私有目录 */
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
