import {useEffect, useState} from 'react';
import TrackPlayer, {Event} from 'react-native-track-player';
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

/** 到时后等当前歌曲播完（切歌或队列结束）再暂停 */
function startWaitFinish() {
  clearWait();
  waitingFinish = true;
  const onDone = () => {
    TrackPlayer.pause().catch(() => {});
    clearWait();
    notify();
  };
  waitSubs = [
    TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, onDone),
    TrackPlayer.addEventListener(Event.PlaybackQueueEnded, onDone),
  ];
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
  if (!endTime && !waitingFinish) {
    return;
  }
  clearTimeoutHandle();
  endTime = 0;
  lastMinutes = 0;
  await AsyncStorage.removeItem(STATE_KEY).catch(() => {});
  if (finishTrack) {
    startWaitFinish();
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
    if (waitingFinish) {
      clearWait();
    }
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
  clearWait();
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
