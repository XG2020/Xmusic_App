import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {clearApiCache, getApiCacheBytes} from './cache';

/**
 * 缓存管理：统计/清除应用缓存（封面图片等系统缓存目录 + API 响应缓存），
 * 支持设置最大缓存上限，超限时自动清理。
 */

const MAX_CACHE_KEY = 'max_cache_mb';

/** 最大缓存下限 100MB */
export const MIN_CACHE_MB = 100;
export const DEFAULT_CACHE_MB = 500;

/** 可选的最大缓存档位（MB） */
export const CACHE_LIMIT_OPTIONS = [100, 200, 500, 1024, 2048];

export function cacheLimitLabel(mb: number): string {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
}

export async function getMaxCacheMb(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(MAX_CACHE_KEY);
    const mb = raw ? parseInt(raw, 10) : DEFAULT_CACHE_MB;
    return Number.isFinite(mb) ? Math.max(MIN_CACHE_MB, mb) : DEFAULT_CACHE_MB;
  } catch (e) {
    return DEFAULT_CACHE_MB;
  }
}

export async function setMaxCacheMb(mb: number) {
  await AsyncStorage.setItem(
    MAX_CACHE_KEY,
    String(Math.max(MIN_CACHE_MB, Math.round(mb))),
  );
}

/** 递归统计目录大小（字节） */
async function dirSize(path: string): Promise<number> {
  let total = 0;
  try {
    const entries = await RNFS.readDir(path);
    for (const e of entries) {
      if (e.isDirectory()) {
        total += await dirSize(e.path);
      } else {
        total += Number(e.size) || 0;
      }
    }
  } catch (e) {
    // 目录不可读时忽略
  }
  return total;
}

/** 当前缓存总大小：系统缓存目录（封面图片等） + API 响应缓存 */
export async function getCacheBytes(): Promise<number> {
  const [fs, api] = await Promise.all([
    dirSize(RNFS.CachesDirectoryPath),
    getApiCacheBytes(),
  ]);
  return fs + api;
}

/** 清空全部缓存（不影响已下载的歌曲文件） */
export async function clearAllCache() {
  await clearApiCache();
  try {
    const entries = await RNFS.readDir(RNFS.CachesDirectoryPath);
    for (const e of entries) {
      await RNFS.unlink(e.path).catch(() => {});
    }
  } catch (e) {
    // 忽略清理失败
  }
}

/** 缓存超过上限时自动清理，返回是否触发了清理 */
export async function enforceCacheLimit(): Promise<boolean> {
  const limit = (await getMaxCacheMb()) * 1024 * 1024;
  const size = await getCacheBytes();
  if (size <= limit) {
    return false;
  }
  await clearAllCache();
  return true;
}

/** 字节数格式化为可读文本 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
