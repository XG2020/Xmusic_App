import RNFS from 'react-native-fs';
import {QUALITY_OPTIONS, cacheWhilePlayEnabled} from './settings';
import type {Quality} from './settings';
import type {Song} from '../types/music';
import {localSongFileExists} from './download';

/**
 * 边播边缓存（参考网易云/QQ音乐做法）：
 * 播放在线歌曲时在后台把整曲下载到缓存目录（键 = mid + 音质），
 * 下载完成的整曲文件仅落盘保存、不打断当前播放；
 * 后续再次播放同一首优先使用本地缓存，完全离线可用。
 *
 * 缓存文件放在系统缓存目录下，自动纳入「缓存管理」的统计与清理。
 * 为避免流量翻倍（流媒体 + 后台整曲下载），后台缓存仅在非蜂窝网络进行。
 */

const DIR = `${RNFS.CachesDirectoryPath}/songcache`;
// 正在后台缓存中的键，避免重复下载
const inflight = new Set<string>();

// ===== 整曲下载进度（供播放页「缓存条」显示这首歌实际能播到哪）=====
// 键为 mid，值为 0~1 的整曲下载比例。UI 侧：本地/已缓存文件直接按 100% 处理，
// 在线曲目边播边存时按此比例显示——即离线状态下真正能连续播放到的位置。
const dlProgress = new Map<string, number>();
const dlProgressListeners = new Set<() => void>();

/** 同步读取某首歌整曲缓存的下载比例（0~1）；无记录返回 0 */
export function cacheProgressOf(mid: string | undefined): number {
  return mid ? dlProgress.get(mid) ?? 0 : 0;
}

/** 订阅整曲下载进度变化（无参，回调内按当前 mid 自行重读），返回取消函数 */
export function subscribeCacheProgress(fn: () => void): () => void {
  dlProgressListeners.add(fn);
  return () => {
    dlProgressListeners.delete(fn);
  };
}

function setCacheProgress(mid: string, ratio: number) {
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  dlProgress.set(mid, clamped);
  dlProgressListeners.forEach(l => l());
}

/**
 * 清空整曲下载进度记录（缓存被清理/超限自动清理后调用）。
 * 否则播放页会因残留的「已满」记录误判某首歌仍可整曲离线播放（缓存条隐藏、
 * 离线拖动不受限），而其缓存文件其实已被删除。
 */
export function clearCacheProgress() {
  dlProgress.clear();
  dlProgressListeners.forEach(l => l());
}

function keyOf(mid: string, quality: Quality): string {
  return `${mid}_${quality}`;
}

/** 由直链推断音频扩展名（无损优先按 flac，其余按 mp3） */
function extOf(url: string): 'flac' | 'mp3' {
  return /\.flac(\?|$)/i.test(url) ? 'flac' : 'mp3';
}

async function ensureDir() {
  await RNFS.mkdir(DIR).catch(() => {});
}

/** 已缓存则返回本地文件绝对路径，否则返回 null */
export async function cachedSongPath(
  mid: string,
  quality: Quality,
): Promise<string | null> {
  const base = `${DIR}/${keyOf(mid, quality)}`;
  for (const ext of ['flac', 'mp3'] as const) {
    const p = `${base}.${ext}`;
    if (await RNFS.exists(p).catch(() => false)) {
      return p;
    }
  }
  return null;
}

/**
 * 不限音质：返回该 mid 任一已整曲缓存的本地文件路径，否则 null。
 * 用于离线兜底——只要磁盘上存在任一音质的完整缓存就能离线播放，
 * 避免「缓存时音质」与「当前播放音质」不一致导致已缓存歌曲被判为不可离线播放。
 */
export async function anyCachedSongPath(mid: string): Promise<string | null> {
  for (const opt of QUALITY_OPTIONS) {
    const p = await cachedSongPath(mid, opt.value);
    if (p) {
      return p;
    }
  }
  return null;
}

/**
 * 该曲目当前是否可离线播放（本地文件 / 已是本地直链 / 已整曲缓存）。
 * 供播放前网络门禁放行：已缓存歌曲无网络时也应可直接播放，不消耗流量。
 * deep=true（离线场景）时放宽到任一已缓存音质。
 */
async function existingLocalPath(song: Song): Promise<string | null> {
  const paths = [
    song.localPath,
    song.uri,
    song.filePath,
    song.url && !/^https?:/i.test(song.url) ? song.url : undefined,
  ].filter((path): path is string => !!path);
  for (const path of [...new Set(paths)]) {
    if (await localSongFileExists(path)) {
      return path;
    }
  }
  return null;
}

export async function isOfflinePlayable(
  song: Song,
  quality: Quality,
  deep = false,
): Promise<boolean> {
  if (!song) {
    return false;
  }
  if (await existingLocalPath(song)) {
    return true;
  }
  if (!song.mid) {
    return false;
  }
  if (await cachedSongPath(song.mid, quality)) {
    return true;
  }
  return deep ? !!(await anyCachedSongPath(song.mid)) : false;
}
/**
 * 播放前优先替换为本地缓存：在线曲目（有 mid、直链为 http）若已整曲缓存，
 * 则把 url 换成本地文件路径，实现离线/秒开播放。
 * allowAnyQuality=true（离线场景）时放宽到任一已缓存音质，
 * 避免因播放音质变更而无法命中此前缓存的文件。
 */
export async function preferCachedSong(
  song: Song,
  quality: Quality,
  allowAnyQuality = false,
): Promise<Song> {
  const localPath = await existingLocalPath(song);
  if (localPath) {
    return {
      ...song,
      localPath,
      uri: undefined,
      filePath: undefined,
    };
  }
  const withoutMissingLocal = {
    ...song,
    localPath: undefined,
    uri: undefined,
    filePath: undefined,
    url: /^https?:/i.test(song.url ?? '') ? song.url : undefined,
  };
  if (!song.mid) {
    return withoutMissingLocal;
  }
  let p = await cachedSongPath(song.mid, quality);
  if (!p && allowAnyQuality) {
    p = await anyCachedSongPath(song.mid);
  }
  return p ? {...withoutMissingLocal, url: `file://${p}`} : withoutMissingLocal;
}
/**
 * 后台缓存当前在线曲目的整曲文件；下载完成仅落盘、不打断当前播放。
 * 已缓存/正在缓存/无有效直链时直接跳过。
 */
export async function cacheSongInBackground(
  mid: string | undefined,
  quality: Quality,
  url: string | undefined,
) {
  // 「边播边存」开关关闭时不做后台缓存
  if (!cacheWhilePlayEnabled()) {
    return;
  }
  if (!mid || !url || !/^https?:/i.test(url)) {
    return;
  }
  const k = keyOf(mid, quality);
  if (inflight.has(k)) {
    return;
  }
  if (await cachedSongPath(mid, quality)) {
    return;
  }
  inflight.add(k);
  try {
    await ensureDir();
    const dest = `${DIR}/${k}.${extOf(url)}`;
    const tmp = `${dest}.part`;
    let totalBytes = 0;
    const {promise} = RNFS.downloadFile({
      fromUrl: url,
      toFile: tmp,
      begin: r => {
        totalBytes = Number(r.contentLength) || 0;
      },
      // 每增长 1% 上报一次，驱动播放页缓存条按「整曲实际下载比例」推进
      progressDivider: 1,
      progress: p => {
        const expected = totalBytes > 0 ? totalBytes : Number(p.contentLength) || 0;
        if (expected > 0) {
          setCacheProgress(mid, p.bytesWritten / expected);
        }
      },
    });
    const res = await promise;
    if (res.statusCode !== 200) {
      RNFS.unlink(tmp).catch(() => {});
      setCacheProgress(mid, 0); // 下载失败：缓存条回退到前向缓冲
      return;
    }
    await RNFS.moveFile(tmp, dest);
    setCacheProgress(mid, 1); // 整曲落盘：可完整离线播放，缓存条置满
    // 注意：此处刻意不再「热切换」当前正在播放的曲目到本地文件。
    // 早期实现会在下载完成时调用 TrackPlayer.load() 把 http 流替换成本地文件，
    // 虽然能立即支持整曲离线拖动，但 load() 会重建音源 + 重新缓冲，
    // 造成播放中途「暂停一下再继续」的可闻空档，且几乎每首歌都会触发，体验很差。
    // 现在只把整曲文件落盘：
    //   - 下次播放同一首时由 preferCachedSong 直接用本地文件（离线 / 秒开）；
    //   - 本次播放继续走流媒体不打断，已听区段的离线回拖由 backBuffer 兜底。
  } catch (e) {
    // 下载失败忽略，继续流媒体播放；缓存条回退到前向缓冲
    if (mid) {
      setCacheProgress(mid, 0);
    }
  } finally {
    inflight.delete(k);
  }
}
