import { useCallback, useEffect, useRef, useState } from 'react';
import type { Quality, Track } from './types';
import { resolveTrackById } from './services/musicApi';
import { useStoredState } from './state';

export type DownloadStatus = 'queued' | 'resolving' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface DownloadTask {
  id: string;
  track: Track;
  quality: Quality;
  actualQuality?: Quality;
  downloadCover?: boolean;
  downloadLyrics?: boolean;
  status: DownloadStatus;
  receivedBytes: number;
  totalBytes?: number;
  fileName?: string;
  coverFileName?: string;
  lyricsFileName?: string;
  attachmentWarnings?: string[];
  directory: string;
  error?: string;
  imported: boolean;
  createdAt: number;
}

export interface DownloadSnapshot {
  directory: string;
  tasks: DownloadTask[];
}

export interface DownloadRequest {
  track: Track;
  quality: Quality;
  baseUrl?: string;
  downloadCover?: boolean;
  downloadLyrics?: boolean;
}

export interface DownloadRemovalResult { snapshot: DownloadSnapshot; removedLocalIds: string[] }

/** Actions accept task IDs; the renderer cannot supply a destination path or a resolved audio URL. */
export interface DownloadBridge {
  getDownloads(): Promise<DownloadSnapshot>;
  startDownload(request: DownloadRequest): Promise<DownloadTask>;
  cancelDownload(id: string): Promise<DownloadTask>;
  retryDownload(id: string): Promise<DownloadTask>;
  pauseDownload(id: string): Promise<DownloadTask>;
  resumeDownload(id: string): Promise<DownloadTask>;
  redownload(id: string): Promise<DownloadTask>;
  removeDownload(request: {id: string; deleteFiles: boolean}): Promise<DownloadRemovalResult>;
  selectDownloadDirectory(): Promise<DownloadSnapshot>;
  openDownloadDirectory(id?: string): Promise<void>;
  importDownload(id: string): Promise<Track[]>;
  clearDownloadHistory(): Promise<DownloadSnapshot>;
  onDownloadsChanged(listener: (snapshot: DownloadSnapshot) => void): () => void;
}

export function isDownloadActive(task: DownloadTask): boolean {
  return task.status === 'queued' || task.status === 'resolving' || task.status === 'downloading';
}

export function isDownloadFinished(task: DownloadTask): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
}

const validQuality = (value: unknown): value is Quality => value === '128' || value === '320' || value === 'flac';
const validBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

function desktopDownloads(): DownloadBridge {
  const bridge = window.desktop as (typeof window.desktop & DownloadBridge) | undefined;
  if (!bridge?.startDownload) throw new Error('请在 XMusic Windows 客户端中使用下载功能。');
  return bridge;
}

export function useDownloads({ baseUrl, onError, onImported, onRemovedLocalIds }: {
  baseUrl: string;
  onError: (message: string) => void;
  onImported: (tracks: Track[]) => void;
  onRemovedLocalIds?: (ids: string[]) => void;
}) {
  // Match mobile defaults while keeping download choices independent of playback quality.
  const [downloadQuality, setDownloadQuality] = useStoredState<Quality>('downloadQuality', 'flac', validQuality);
  const [downloadCover, setDownloadCover] = useStoredState('downloadCover', true, validBoolean);
  const [downloadLyrics, setDownloadLyrics] = useStoredState('downloadLyrics', true, validBoolean);
  const [snapshot, setSnapshot] = useState<DownloadSnapshot>({ directory: '', tasks: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(new Set());
  const pendingIds = useRef(new Set<string>());
  const eventRevision = useRef(0);
  const alive = useRef(true);
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  useEffect(() => {
    let mounted = true;
    let receivedEvent = false;
    let unsubscribe: (() => void) | undefined;
    try {
      const bridge = desktopDownloads();
      unsubscribe = bridge.onDownloadsChanged(next => {
        eventRevision.current += 1;
        receivedEvent = true;
        if (mounted) setSnapshot(next);
      });
      void bridge.getDownloads().then(next => {
        if (mounted && !receivedEvent) setSnapshot(next);
      }).catch(error => {
        if (mounted) onError(error instanceof Error ? error.message : '无法读取下载列表');
      }).finally(() => { if (mounted) setLoading(false); });
    } catch {
      setLoading(false);
    }
    return () => { mounted = false; unsubscribe?.(); };
  }, [onError]);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (alive.current) setError('');
    try { return await action(); }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : '下载操作失败，请重试';
      if (alive.current) {setError(message); onError(message);}
    }
  }, [onError]);

  const runTask = useCallback(async <T,>(id: string, action: () => Promise<T>): Promise<T | undefined> => {
    if (pendingIds.current.has(id)) return undefined;
    pendingIds.current.add(id);
    if (alive.current) setPendingTaskIds(new Set(pendingIds.current));
    try {return await run(action);}
    finally {
      pendingIds.current.delete(id);
      if (alive.current) setPendingTaskIds(new Set(pendingIds.current));
    }
  }, [run]);

  const updateTask = useCallback(async (action: () => Promise<DownloadTask>) => {
    const revision = eventRevision.current;
    const task = await action();
    if (alive.current && revision === eventRevision.current) setSnapshot(previous => ({...previous,
      tasks: previous.tasks.some(item => item.id === task.id) ? previous.tasks.map(item => item.id === task.id ? task : item) : [task, ...previous.tasks]}));
    return task;
  }, []);
  const start = useCallback((track: Track) => run(() => updateTask(async () => desktopDownloads().startDownload({
    track: await resolveTrackById(track, baseUrl), quality: downloadQuality, baseUrl, downloadCover, downloadLyrics,
  }))), [baseUrl, downloadQuality, downloadCover, downloadLyrics, run, updateTask]);
  const cancel = useCallback((id: string) => runTask(id, () => updateTask(() => desktopDownloads().cancelDownload(id))), [runTask, updateTask]);
  const retry = useCallback((id: string) => runTask(id, () => updateTask(() => desktopDownloads().retryDownload(id))), [runTask, updateTask]);
  const pause = useCallback((id: string) => runTask(id, () => updateTask(() => desktopDownloads().pauseDownload(id))), [runTask, updateTask]);
  const resume = useCallback((id: string) => runTask(id, () => updateTask(() => desktopDownloads().resumeDownload(id))), [runTask, updateTask]);
  const redownload = useCallback((id: string) => runTask(id, () => updateTask(() => desktopDownloads().redownload(id))), [runTask, updateTask]);
  const removeTask = useCallback((id: string, deleteFiles: boolean) => runTask(id, async () => {
    const revision = eventRevision.current;
    const result = await desktopDownloads().removeDownload({id, deleteFiles});
    if (alive.current) {
      if (revision === eventRevision.current) setSnapshot(result.snapshot);
      if (result.removedLocalIds.length) onRemovedLocalIds?.(result.removedLocalIds);
    }
    return result;
  }), [runTask, onRemovedLocalIds]);
  const selectDirectory = useCallback(() => run(async () => {
    const revision = eventRevision.current;
    const next = await desktopDownloads().selectDownloadDirectory();
    if (alive.current && revision === eventRevision.current) setSnapshot(next);
  }), [run]);
  const openDirectory = useCallback((id?: string) => run(() => desktopDownloads().openDownloadDirectory(id)), [run]);
  const importTrack = useCallback((id: string) => runTask(id, async () => { onImported(await desktopDownloads().importDownload(id)); }), [onImported, runTask]);
  const clearHistory = useCallback(() => run(async () => {
    const revision = eventRevision.current;
    const next = await desktopDownloads().clearDownloadHistory();
    if (alive.current && revision === eventRevision.current) setSnapshot(next);
  }), [run]);
  const clearError = useCallback(() => setError(''), []);

  return { ...snapshot, loading, error, clearError, pendingTaskIds, downloadQuality, setDownloadQuality, downloadCover, setDownloadCover,
    downloadLyrics, setDownloadLyrics, start, cancel, retry, pause, resume, redownload, removeTask, selectDirectory, openDirectory, importTrack, clearHistory };
}

export type DownloadsController = ReturnType<typeof useDownloads>;
