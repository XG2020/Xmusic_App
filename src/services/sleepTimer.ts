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

// ===== 到时行为：播完当前歌曲再暂停 =====

const FINISH_KEY = 'sleep_finish_track';
let finishTrack = false; // true = 到时后播完当前歌曲再暂停
let waitingFinish = false; // 已到时，正在等待当前歌曲播完
let waitSubs: {remove: () => void}[] = [];

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

export function setSleepTimer(minutes: number) {
  cancelSleepTimer();
  lastMinutes = minutes;
  endTime = Date.now() + minutes * 60 * 1000;
  timeout = setTimeout(() => {
    timeout = null;
    endTime = 0;
    lastMinutes = 0;
    if (finishTrack) {
      startWaitFinish();
    } else {
      TrackPlayer.pause().catch(() => {});
    }
    notify();
  }, minutes * 60 * 1000);
  notify();
}

export function cancelSleepTimer() {
  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }
  clearWait();
  endTime = 0;
  lastMinutes = 0;
  notify();
}

/** 当前定时器设置的分钟档位，0 = 未开启 */
export function getSleepMinutes(): number {
  return endTime ? lastMinutes : 0;
}

/** 剩余秒数，0 = 未开启 */
export function getSleepRemaining(): number {
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
    const iv = setInterval(update, 20000);
    return () => {
      listeners.delete(update);
      clearInterval(iv);
    };
  }, []);
  return remain;
}
