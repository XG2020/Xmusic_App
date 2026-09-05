import {useEffect, useState} from 'react';
import TrackPlayer, {Event, RepeatMode, Track} from 'react-native-track-player';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 全局睡眠定时器：到点暂停播放。
 * 支持两种到时行为：立即暂停 / 播完当前歌曲再暂停。
 * 播放页与设置页共用同一份状态。
 */

let timeout: ReturnType<typeof setTimeout> | null = null;
let endTime = 0; // 结束时间戳（ms），0 = 未开启
let lastMinutes = 0; // 当前定时选择的分钟档位（用于界面回显）
const listeners = new Set<() => void>();
const STATE_KEY = 'sleep_timer_state_v1';
const STORAGE_SYNC_INTERVAL = 1000;

// ===== 到时行为：播完当前歌曲再暂停 =====

const FINISH_KEY = 'sleep_finish_track';
let finishTrack = false; // true = 到时后播完当前歌曲再暂停
let waitingFinish = false; // 已到时，正在等待当前歌曲播完
let waitSubs: {remove: () => void}[] = [];
let finishRestoreTracks: Track[] = [];
let finishRestoreRepeatMode: RepeatMode | null = null;
let finishHandled = false;
let finishRestoreInFlight: Promise<void> | null = null;
let finishPreparation: Promise<void> | null = null;
// 每次定时器真正到期时递增。播放请求在开始时记录该值，
// 到期后解析完成的旧请求不得再次启动播放器。
let playbackGeneration = 0;

export function getSleepPlaybackGeneration(): number {
  return playbackGeneration;
}

export function isSleepPlaybackGenerationCurrent(generation: number): boolean {
  return generation === playbackGeneration;
}

function restoreFinishQueueLater() {
  void (async () => {
    if (finishPreparation) {
      await finishPreparation;
    }
    await restoreFinishQueue();
  })();
}
let lastStorageSyncAt = 0;
let syncPromise: Promise<void> | null = null;

AsyncStorage.getItem(FINISH_KEY)
  .then(v => {
    finishTrack = v === '1';
  })
  .catch(() => {});

export function getSleepFinishTrack(): boolean {
  return finishTrack;
}

export function setSleepFinishTrack(v: boolean) {
  finishTrack = v;
  if (!v && waitingFinish) {
    clearWait();
    restoreFinishQueueLater();
  }
  AsyncStorage.setItem(FINISH_KEY, v ? '1' : '0').catch(() => {});
  notify();
}

/** 是否已到时、正在等待当前歌曲播完 */
export function isSleepWaitingFinish(): boolean {
  return waitingFinish;
}

function clearWait() {
  waitSubs.forEach(s => s.remove());
  waitSubs = [];
  waitingFinish = false;
}

/** 恢复到时前被暂时移除的后续队列，避免定时器影响用户原播放列表。 */
async function restoreFinishQueue() {
  if (finishRestoreInFlight) {
    await finishRestoreInFlight;
    return;
  }
  const tracks = finishRestoreTracks;
  const repeatMode = finishRestoreRepeatMode;
  finishRestoreTracks = [];
  finishRestoreRepeatMode = null;
  if (!tracks.length && repeatMode === null) {
    return;
  }
  finishRestoreInFlight = (async () => {
    try {
      const currentIndex = await TrackPlayer.getActiveTrackIndex();
      if (tracks.length && typeof currentIndex === 'number') {
        await TrackPlayer.add(tracks, currentIndex + 1);
      }
      if (repeatMode !== null) {
        await TrackPlayer.setRepeatMode(repeatMode);
      }
    } catch (e) {
      // 队列已被用户修改时不阻塞播放。
    } finally {
      finishRestoreInFlight = null;
    }
  })();
  await finishRestoreInFlight;
}

/** 到时后等待当前曲目自然结束，再暂停并恢复被隔离的队列。 */
async function finishAtCurrentBoundary() {
  if (!waitingFinish || finishHandled) {
    return;
  }
  finishHandled = true;
  clearWait();
  if (finishPreparation) {
    await finishPreparation;
  }
  await TrackPlayer.pause().catch(() => {});
  await restoreFinishQueue();
  notify();
}

/** 到时后等当前歌曲播完（切歌或队列结束）再暂停 */
async function startWaitFinish() {
  clearWait();
  waitingFinish = true;
  finishHandled = false;
  // 先注册监听，再异步隔离后续队列，避免曲目恰好在隔离期间结束时漏事件。
  const onDone = () => {
    void finishAtCurrentBoundary();
  };
  waitSubs = [
    TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, onDone),
    TrackPlayer.addEventListener(Event.PlaybackQueueEnded, onDone),
  ];
  finishPreparation = (async () => {
    try {
      const queue = await TrackPlayer.getQueue();
      const currentIndex = await TrackPlayer.getActiveTrackIndex();
      finishRestoreRepeatMode = await TrackPlayer.getRepeatMode();
      finishRestoreTracks =
        typeof currentIndex === 'number' ? queue.slice(currentIndex + 1) : [];
      // 取消队列循环并移除后续曲目，使当前曲目结束后直接触发 QueueEnded，
      // 不会先激活并播放下一首。队列在暂停后再恢复。
      await TrackPlayer.setRepeatMode(RepeatMode.Off);
      if (finishRestoreTracks.length) {
        await TrackPlayer.removeUpcomingTracks();
      }
    } catch (e) {
      // 无法隔离队列时仍保留结束监听，作为兜底暂停。
    } finally {
      finishPreparation = null;
    }
  })();
  await finishPreparation;
}

function notify() {
  listeners.forEach(l => l());
}

function clearTimeoutHandle() {
  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }
}

async function persistTimerState() {
  try {
    if (!endTime) {
      await AsyncStorage.removeItem(STATE_KEY);
      return;
    }
    await AsyncStorage.setItem(
      STATE_KEY,
      JSON.stringify({
        endTime,
        lastMinutes,
      }),
    );
  } catch (e) {
    // 持久化失败不阻塞定时器
  }
}

async function handleTimerExpired() {
  // Expiry is one-shot. After switching to waitingFinish, storage syncs may
  // observe endTime=0 again and must not restart the finish workflow.
  if (!endTime || waitingFinish) {
    return;
  }
  clearTimeoutHandle();
  endTime = 0;
  lastMinutes = 0;
  playbackGeneration += 1;
  await AsyncStorage.removeItem(STATE_KEY).catch(() => {});
  if (finishTrack) {
    await startWaitFinish();
  } else {
    clearWait();
    TrackPlayer.pause().catch(() => {});
  }
  notify();
}

function scheduleTimeout() {
  clearTimeoutHandle();
  if (!endTime) {
    return;
  }
  const delay = endTime - Date.now();
  if (delay <= 0) {
    void handleTimerExpired();
    return;
  }
  timeout = setTimeout(() => {
    timeout = null;
    void handleTimerExpired();
  }, delay);
}

function parseState(raw: string | null): {endTime: number; lastMinutes: number} {
  if (!raw) {
    return {endTime: 0, lastMinutes: 0};
  }
  try {
    const parsed = JSON.parse(raw) as {
      endTime?: number;
      lastMinutes?: number;
    };
    return {
      endTime: Number(parsed.endTime) || 0,
      lastMinutes: Number(parsed.lastMinutes) || 0,
    };
  } catch (e) {
    return {endTime: 0, lastMinutes: 0};
  }
}

async function applyStoredState(rawState: string | null, rawFinishTrack: string | null) {
  const prevEndTime = endTime;
  const prevLastMinutes = lastMinutes;
  const prevFinishTrack = finishTrack;
  const prevWaitingFinish = waitingFinish;
  const next = parseState(rawState);

  finishTrack = rawFinishTrack === '1';

  if (!next.endTime) {
    endTime = 0;
    lastMinutes = 0;
    clearTimeoutHandle();
    // endTime 在“播完当前歌曲再暂停”模式下会先被清零；
    // 此时必须保留 waitingFinish，不能被存储同步误清监听。
  } else {
    endTime = next.endTime;
    lastMinutes = next.lastMinutes;
    scheduleTimeout();
  }

  if (
    prevEndTime !== endTime ||
    prevLastMinutes !== lastMinutes ||
    prevFinishTrack !== finishTrack ||
    prevWaitingFinish !== waitingFinish
  ) {
    notify();
  }
}

export async function syncSleepTimerState(force = false) {
  const now = Date.now();
  if (!force && now - lastStorageSyncAt < STORAGE_SYNC_INTERVAL) {
    if (endTime && endTime <= now) {
      await handleTimerExpired();
    }
    return;
  }
  if (syncPromise) {
    await syncPromise;
    return;
  }
  syncPromise = (async () => {
    lastStorageSyncAt = Date.now();
    const [[, rawState], [, rawFinishTrack]] = await AsyncStorage.multiGet([
      STATE_KEY,
      FINISH_KEY,
    ]);
    await applyStoredState(rawState, rawFinishTrack);
    if (endTime && endTime <= Date.now()) {
      await handleTimerExpired();
    }
  })()
    .catch(() => {})
    .finally(() => {
      syncPromise = null;
    });
  await syncPromise;
}

function ensureNotExpired() {
  if (endTime && endTime <= Date.now()) {
    void handleTimerExpired();
    return false;
  }
  return true;
}

export function setSleepTimer(minutes: number) {
  cancelSleepTimer();
  lastMinutes = minutes;
  endTime = Date.now() + minutes * 60 * 1000;
  scheduleTimeout();
  void persistTimerState();
  notify();
}

export function cancelSleepTimer() {
  clearTimeoutHandle();
  const wasWaitingFinish = waitingFinish;
  clearWait();
  if (wasWaitingFinish) {
    restoreFinishQueueLater();
  }
  endTime = 0;
  lastMinutes = 0;
  void AsyncStorage.removeItem(STATE_KEY).catch(() => {});
  notify();
}

/** 当前定时器设置的分钟档位，0 = 未开启 */
export function getSleepMinutes(): number {
  if (!ensureNotExpired()) {
    return 0;
  }
  return endTime ? lastMinutes : 0;
}

/** 剩余秒数，0 = 未开启 */
export function getSleepRemaining(): number {
  if (!ensureNotExpired()) {
    return 0;
  }
  return endTime ? Math.max(0, Math.round((endTime - Date.now()) / 1000)) : 0;
}

/** 剩余分钟文案，如 "14 分钟"，未开启返回空串 */
export function formatSleepRemaining(seconds: number): string {
  if (seconds <= 0) {
    return '';
  }
  return `${Math.max(1, Math.ceil(seconds / 60))} 分钟`;
}

/** Hook：订阅剩余秒数（每 20 秒刷新一次显示） */
export function useSleepTimer(): number {
  const [remain, setRemain] = useState(getSleepRemaining());
  useEffect(() => {
    const update = () => setRemain(getSleepRemaining());
    listeners.add(update);
    void syncSleepTimerState(true).then(update);
    const iv = setInterval(update, 20000);
    return () => {
      listeners.delete(update);
      clearInterval(iv);
    };
  }, []);
  return remain;
}

void syncSleepTimerState(true);
