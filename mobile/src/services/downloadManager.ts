import {useEffect, useState} from 'react';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {getSongUrls, getLyric, albumCoverUrl} from './api';
import {resolveDownloadDir, downloadCompanions} from './download';
import {
  Quality,
  qualityOption,
  getDownloadQuality,
  getDownloadLyric,
  getDownloadCover,
} from './settings';
import type {Song} from '../types/music';

/**
 * 全局下载管理器：任务进度实时可见，完成/失败记录持久化为下载历史
 */

export type DownloadTask = {
  id: string;
  title: string;
  artist?: string;
  quality: Quality;
  path?: string;
  status: 'downloading' | 'done' | 'error';
  /** 0-1，下载中实时更新 */
  progress: number;
  error?: string;
  createdAt: number;
};

const HISTORY_KEY = 'download_history';
const MAX_HISTORY = 100;

/** 进行中的任务（内存） */
let active: DownloadTask[] = [];
/** 已完成/失败历史（持久化） */
let history: DownloadTask[] = [];
let historyLoaded = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach(l => l());
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
    status: 'downloading',
    progress: 0,
    createdAt: Date.now(),
  };
  active = [task, ...active];
  notify();

  (async () => {
    try {
      const opt = qualityOption(q);
      // 从直链推断真实格式（服务端可能降级），失败按音质兜底
      const extMatch = url.match(/\.(flac|mp3|m4a|ogg|ape|wav)(\?|$)/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : opt.ext;
      const safeName = String(song.title ?? 'song').replace(/[\\/:*?"<>|]/g, '');
      const dir = await resolveDownloadDir();
      const dest = `${dir}/${safeName} [${opt.label}].${ext}`;
      const ret = await RNFS.downloadFile({
        fromUrl: url,
        toFile: dest,
        progressDivider: 5,
        progress: p => {
          if (p.contentLength > 0) {
            task.progress = p.bytesWritten / p.contentLength;
            notify();
          }
        },
      }).promise;
      if (ret.statusCode < 200 || ret.statusCode >= 300) {
        throw new Error(`下载失败: ${ret.statusCode}`);
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
      // 封面：歌曲自带地址优先，缺失时用专辑 mid 拼官方 CDN 直链兜底
      const coverUrl = wantCover
        ? song.coverUrl ?? albumCoverUrl(song.album)
        : undefined;
      await downloadCompanions(dest, {coverUrl, lyric, song});
      finishTask({...task, status: 'done', progress: 1, path: dest});
    } catch (e: any) {
      finishTask({...task, status: 'error', error: e?.message ?? String(e)});
    }
  })();
  return true;
}

export async function clearDownloadHistory() {
  history = [];
  await AsyncStorage.removeItem(HISTORY_KEY).catch(() => {});
  notify();
}

/** 删除单条下载记录，可选同时删除已下载的文件 */
export async function removeDownloadRecord(
  task: DownloadTask,
  deleteFile = false,
) {
  history = history.filter(
    x => !(x.id === task.id && x.createdAt === task.createdAt),
  );
  saveHistory();
  if (deleteFile && task.path) {
    await RNFS.unlink(task.path).catch(() => {});
  }
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
