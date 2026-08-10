import {useEffect, useState} from 'react';
import {DeviceEventEmitter, NativeModules} from 'react-native';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {getSongUrls, getLyric, getSongDetail, albumCoverUrl} from './api';
import {
  resolveDownloadDir,
  downloadCompanions,
  deleteLocalSongWithCompanions,
  isTreeUri,
} from './download';
import {
  Quality,
  qualityOption,
  getDownloadQuality,
  getDownloadLyric,
  getDownloadCover,
} from './settings';
import type {Song} from '../types/music';
import {markSongDownloaded} from './store';

/**
 * 全局下载管理器：任务进度实时可见，完成/失败记录持久化为下载历史
 */

export type DownloadTask = {
  id: string;
  title: string;
  artist?: string;
  quality: Quality;
  path?: string;
  /** 文件所在目录：普通路径为父目录，SAF 下载为 tree/document uri，供“打开所在文件夹”使用 */
  folderPath?: string;
  status: 'queued' | 'downloading' | 'done' | 'error' | 'paused';
  /** 0-1，下载中实时更新 */
  progress: number;
  error?: string;
  createdAt: number;
};

const HISTORY_KEY = 'download_history';
const MAX_HISTORY = 100;
const MAX_CONCURRENT = 3;
const NOTIFY_INTERVAL = 250;

type RunningJob = {
  jobId?: number;
  partPath?: string;
  cancelled?: boolean;
  paused?: boolean;
  /** 暂停/取消所需的工作快照（歌曲与直链） */
  work: PendingWork;
};
type PendingWork = {task: DownloadTask; song: Song; url: string};
/** 已暂停任务（内存）：保留歌曲/直链快照，等待恢复或取消 */
type PausedWork = {
  task: DownloadTask;
  song: Song;
  url: string;
  partPath?: string;
};

const {LocalMusic} = NativeModules;

function canDeleteTaskFile(path?: string): boolean {
  if (!path) {
    return false;
  }
  if (!path.startsWith('content://')) {
    return true;
  }
  return path.includes('/document/');
}

/**
 * 原生下载进度事件（SAF 授权目录任务）：按百分比转发给对应任务，
 * 与 RNFS 的 progressDivider 回调行为保持一致（任务暂停/取消后忽略）
 */
DeviceEventEmitter.addListener('LocalMusic.DownloadProgress', (e: any) => {
  const job = running.get(e?.token);
  if (!job || job.cancelled || job.paused) {
    return;
  }
  const total = Number(e?.total ?? 0);
  if (total > 0) {
    job.work.task.progress = Number(e?.written ?? 0) / total;
    notify(true);
  }
});

/** 进行中的任务（内存） */
let active: DownloadTask[] = [];
const queue: PendingWork[] = [];
const pausedWork = new Map<string, PausedWork>();
const running = new Map<string, RunningJob>();
let runningCount = 0;
/** 已完成/失败历史（持久化） */
let history: DownloadTask[] = [];
let historyLoaded = false;
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let notifyPending = false;

function emitNotify() {
  listeners.forEach(l => l());
}

function notify(throttle = false) {
  if (!throttle) {
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    notifyPending = false;
    emitNotify();
    return;
  }
  if (notifyTimer) {
    notifyPending = true;
    return;
  }
  emitNotify();
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    if (notifyPending) {
      notifyPending = false;
      emitNotify();
    }
  }, NOTIFY_INTERVAL);
}

async function loadHistory() {
  if (historyLoaded) {
    return;
  }
  historyLoaded = true;
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    history = raw ? (JSON.parse(raw) as DownloadTask[]) : [];
    notify();
  } catch (e) {
    history = [];
  }
}

function saveHistory() {
  AsyncStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(history.slice(0, MAX_HISTORY)),
  ).catch(() => {});
}

/** 任务转入历史（完成或失败） */
function finishTask(task: DownloadTask) {
  active = active.filter(x => x.id !== task.id);
  history = [task, ...history].slice(0, MAX_HISTORY);
  saveHistory();
  notify();
  pumpQueue();
}

function removePart(path?: string) {
  if (path) {
    RNFS.unlink(path).catch(() => {});
  }
}

async function runDownload(work: PendingWork) {
  const {task, song, url} = work;
  runningCount += 1;
  const job: RunningJob = {work};
  running.set(task.id, job);
  task.status = 'downloading';
  notify();
  try {
    const opt = qualityOption(task.quality);
    // 从直链推断真实格式（服务端可能降级），失败按音质兜底
    const extMatch = url.match(/\.(flac|mp3|m4a|ogg|ape|wav)(\?|$)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : opt.ext;
    // 文件名带歌手前缀（歌手 - 歌名），本地扫描无标签时也能解析出歌手
    const artistPart = song.singer?.map(s => s.name).join('、') ?? '';
    const rawName = artistPart
      ? `${artistPart} - ${song.title ?? 'song'}`
      : String(song.title ?? 'song');
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, '');
    const dir = await resolveDownloadDir();
    const dest = `${dir}/${safeName} [${opt.label}].${ext}`;
    // 完成记录：普通路径保存文件完整路径；SAF 下载同时保存文件 document uri 与目录 uri，
    // 分别用于“删除文件”和“打开所在文件夹”
    let finalPath = dest;
    let folderPath: string | undefined;
    if (isTreeUri(dir)) {
      // SAF 授权目录：原生 ContentResolver 直写最终文件（无 .part，取消时原生清理半成品）
      if (!LocalMusic?.startDownload) {
        throw new Error('当前系统不支持授权目录下载');
      }
      const ret = await LocalMusic.startDownload(
        task.id,
        url,
        dir,
        `${safeName} [${opt.label}].${ext}`,
      );
      finalPath = String(ret?.fileUri ?? ret?.uri ?? dir);
      folderPath = String(ret?.folderUri ?? dir);
    } else {
      const part = `${dest}.part`;
      job.partPath = part;
      await RNFS.unlink(part).catch(() => {});
      const dl = RNFS.downloadFile({
        fromUrl: url,
        toFile: part,
        progressDivider: 5,
        progress: p => {
          if (p.contentLength > 0 && !job.cancelled && !job.paused) {
            task.progress = p.bytesWritten / p.contentLength;
            notify(true);
          }
        },
      });
      job.jobId = dl.jobId;
      const ret = await dl.promise;
      if (job.cancelled) {
        throw new Error('已取消');
      }
      if (job.paused) {
        // 暂停与停止的竞态：stopDownload 后 promise 通常以异常结束（走 catch），
        // 若恰好正常完成也按暂停处理，任务保留现场
        removePart(job.partPath);
        task.status = 'paused';
        notify();
        return;
      }
      if (ret.statusCode < 200 || ret.statusCode >= 300) {
        throw new Error(`下载失败: ${ret.statusCode}`);
      }
      await RNFS.unlink(dest).catch(() => {});
      await RNFS.moveFile(part, dest);
      job.partPath = undefined;
      folderPath = dest.slice(0, dest.lastIndexOf('/'));
    }
    // 附带封面歌词与元数据（受设置开关控制，失败不影响主文件）
    const [wantLyric, wantCover] = await Promise.all([
      getDownloadLyric(),
      getDownloadCover(),
    ]);
    let lyric: string | undefined;
    if (wantLyric && song.mid) {
      try {
        lyric = (await getLyric({mid: song.mid}))?.lyric || undefined;
      } catch (e) {}
    }
    // 封面三级兜底：歌曲自带地址 → 专辑 mid 拼 CDN 直链 → 详情接口取专辑再拼
    let coverUrl = wantCover
      ? song.coverUrl ?? albumCoverUrl(song.album)
      : undefined;
    if (wantCover && !coverUrl && song.mid) {
      try {
        const detail = await getSongDetail({mid: song.mid});
        // 详情接口外层包着 track_info（与 resolveSongById 一致），
        // 直接读 detail.album 永远取不到专辑导致封面兜底失效
        coverUrl = albumCoverUrl((detail?.track_info ?? detail)?.album);
      } catch (e) {
        // 详情接口失败放弃封面
      }
    }
    await downloadCompanions(finalPath, {coverUrl, lyric, song, folderUri: folderPath});
    // 下载完成后把本地路径同步回已经存在的收藏/本地歌单，离线播放不再依赖网络直链。
    await markSongDownloaded(song, finalPath).catch(() => {});
    finishTask({
      ...task,
      status: 'done',
      progress: 1,
      path: finalPath,
      folderPath,
    });
  } catch (e: any) {
    removePart(job.partPath);
    if (job.paused) {
      // 暂停：清理临时文件，任务留在下载中列表等待恢复/取消
      task.status = 'paused';
      notify();
    } else {
      finishTask({
        ...task,
        status: 'error',
        // 用户主动取消（RNFS stopDownload/原生 cancelDownload）统一显示"已取消"
        error: job.cancelled ? '已取消' : (e?.message ?? String(e)),
      });
    }
  } finally {
    running.delete(task.id);
    runningCount = Math.max(0, runningCount - 1);
    pumpQueue();
  }
}

function pumpQueue() {
  while (runningCount < MAX_CONCURRENT && queue.length) {
    const work = queue.shift()!;
    runDownload(work);
  }
  notify();
}

/**
 * 发起下载：默认使用设置中的下载音质。
 * 返回是否成功开始（同名任务下载中/无地址时返回 false）。
 */
export async function startDownload(
  song: Song,
  quality?: Quality,
): Promise<boolean> {
  const q = quality ?? (await getDownloadQuality());
  const taskId = `${song.mid ?? song.localPath ?? song.title}:${q}`;
  if (active.some(x => x.id === taskId)) {
    return false;
  }
  // 取直链（本地歌曲不支持下载）
  let url = song.url && /^https?:/i.test(song.url) ? song.url : '';
  if (song.mid) {
    try {
      const urls = await getSongUrls([song.mid], q);
      url = urls?.[song.mid] || url;
    } catch (e) {
      // 取直链失败时尝试已有 url
    }
  }
  if (!url) {
    return false;
  }
  const task: DownloadTask = {
    id: taskId,
    title: song.title,
    artist: song.singer?.map(s => s.name).join(' / '),
    quality: q,
    status: 'queued',
    progress: 0,
    createdAt: Date.now(),
  };
  active = [task, ...active];
  queue.push({task, song, url});
  notify();
  pumpQueue();
  return true;
}

export async function clearDownloadHistory() {
  history = [];
  await AsyncStorage.removeItem(HISTORY_KEY).catch(() => {});
  notify();
}

/**
 * 暂停下载任务：下载中会停止原生下载（保留进度显示），
 * 排队中直接从队列移除。暂停后任务留在下载中列表，可恢复或取消。
 * 返回是否找到并暂停了该任务。
 */
export function pauseDownload(taskId: string): boolean {
  // 排队中：移出队列，转为已暂停（恢复时重新入队）
  const qIdx = queue.findIndex(w => w.task.id === taskId);
  if (qIdx >= 0) {
    const [work] = queue.splice(qIdx, 1);
    work.task.status = 'paused';
    pausedWork.set(taskId, {
      task: work.task,
      song: work.song,
      url: work.url,
    });
    notify();
    return true;
  }
  // 下载中：标记暂停并停止原生下载（runDownload 的 catch 会转为已暂停）
  const job = running.get(taskId);
  if (job) {
    job.paused = true;
    pausedWork.set(taskId, {
      task: job.work.task,
      song: job.work.song,
      url: job.work.url,
      partPath: job.partPath,
    });
    if (job.jobId !== undefined) {
      try {
        // stopDownload 为同步方法（返回 void），失败忽略
        RNFS.stopDownload(job.jobId);
      } catch (e) {
        // 停止失败忽略
      }
    }
    // SAF 授权目录任务：通知原生中断并清理半成品文件
    if (LocalMusic?.cancelDownload) {
      try {
        LocalMusic.cancelDownload(taskId);
      } catch (e) {
        // 失败忽略
      }
    }
    notify();
    return true;
  }
  return false;
}

/**
 * 恢复已暂停的下载任务：重新获取直链（旧链接可能已过期）后放回队列。
 * 注：当前 RNFS Android 端不支持断点续传，恢复后从头下载。
 * 返回是否成功恢复（取不到直链时返回 false，任务保持暂停）。
 */
export async function resumeDownload(taskId: string): Promise<boolean> {
  const work = pausedWork.get(taskId);
  if (!work) {
    return false;
  }
  const {task, song} = work;
  let url = song.url && /^https?:/i.test(song.url) ? song.url : '';
  if (song.mid) {
    try {
      const urls = await getSongUrls([song.mid], task.quality);
      url = urls?.[song.mid] || url;
    } catch (e) {
      // 取直链失败时尝试已有 url
    }
  }
  if (!url) {
    return false;
  }
  pausedWork.delete(taskId);
  task.status = 'queued';
  queue.push({task, song, url});
  notify();
  pumpQueue();
  return true;
}

/**
 * 取消下载任务：下载中会停止原生下载并清理 .part 临时文件，
 * 排队中直接从队列移除，已暂停的从暂停列表移除。取消后任务以「已取消」记入历史。
 * 返回是否找到并取消了该任务。
 */
export function cancelDownload(taskId: string): boolean {
  // 已暂停：清理暂停快照与临时文件并结束任务
  const pw = pausedWork.get(taskId);
  if (pw) {
    pausedWork.delete(taskId);
    removePart(pw.partPath);
    finishTask({...pw.task, status: 'error', error: '已取消'});
    return true;
  }
  // 排队中：直接从队列移除并结束任务
  const qIdx = queue.findIndex(w => w.task.id === taskId);
  if (qIdx >= 0) {
    const [work] = queue.splice(qIdx, 1);
    finishTask({...work.task, status: 'error', error: '已取消'});
    return true;
  }
  // 下载中：标记取消并停止原生下载（runDownload 的 catch 会清理 .part 并转入历史）
  const job = running.get(taskId);
  if (job) {
    job.cancelled = true;
    if (job.jobId !== undefined) {
      try {
        // stopDownload 为同步方法（返回 void），失败忽略
        RNFS.stopDownload(job.jobId);
      } catch (e) {
        // 停止失败忽略
      }
    }
    // SAF 授权目录任务：通知原生中断并清理半成品文件
    if (LocalMusic?.cancelDownload) {
      try {
        LocalMusic.cancelDownload(taskId);
      } catch (e) {
        // 失败忽略
      }
    }
    notify();
    return true;
  }
  return false;
}

/** 删除单条下载记录，可选同时删除已下载的文件 */
export async function removeDownloadRecord(
  task: DownloadTask,
  deleteFile = false,
) {
  if (deleteFile && task.path && canDeleteTaskFile(task.path)) {
    // 连同歌词/封面/元数据附件一起删除
    await deleteLocalSongWithCompanions(task.path);
  }
  history = history.filter(
    x => !(x.id === task.id && x.createdAt === task.createdAt),
  );
  saveHistory();
  notify();
}

/** Hook：订阅进行中任务与下载历史 */
export function useDownloads() {
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force(v => v + 1);
    listeners.add(update);
    loadHistory();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return {active, history};
}
