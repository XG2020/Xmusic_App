import TrackPlayer, {Event, State} from 'react-native-track-player';
import {ToastAndroid} from 'react-native';
import {localSongFileExists} from './download';
import {addRecentSongs} from './store';
import {getPreferredSongUrls} from './api';
import {getPlayQuality, wifiOnlyEnabled} from './settings';
import {isCellular, isConnected, onlinePlaybackBlockReason} from './network';
import {cacheSongInBackground} from './songCache';
import {
  saveQueueSnapshot,
  savePlayPosition,
  resolvePendingTrack,
  skipToNext,
  seekTo,
  isSeekInFlight,
  getPendingPlayTrack,
  clearPendingPlayTrack,
  PENDING_URL,
} from './player';
import {syncSleepTimerState} from './sleepTimer';
import type {Song} from '../types/music';

export default async function playbackService() {
  syncSleepTimerState(true).catch(() => {});

  TrackPlayer.addEventListener(Event.RemotePlay, async () => {
    await syncSleepTimerState(true).catch(() => {});
    // 通知栏续播：在线曲目遇无网/仅Wi-Fi 时硬拦截（后台无法弹窗，用 Toast 提示）
    try {
      const tr = (await TrackPlayer.getActiveTrack()) as any;
      const u = String(tr?.url ?? '');
      if (/^https?:/i.test(u) && u !== PENDING_URL) {
        const reason = onlinePlaybackBlockReason();
        if (reason) {
          ToastAndroid.show(reason, ToastAndroid.SHORT);
          return;
        }
      }
    } catch (e) {
      // 查询失败则照常续播
    }
    TrackPlayer.play();
  });

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    TrackPlayer.pause();
  });

  // 音频焦点打断（其他应用出声/系统抢焦点）由 RNTP 原生处理：
  // 「允许与其他应用同时播放」关闭时（autoHandleInterruptions=true）被打断自动暂停、
  // 临时打断结束后自动续播；开启时（autoHandleInterruptions=false）由 KotlinAudio 管理，
  // 被其他应用抢焦点只压低音量(duck)而不暂停（别人出声我也不停），故无需在此自定义处理。

  // 通知栏下一曲走统一逻辑，随机模式下同样随机切
  TrackPlayer.addEventListener(Event.RemoteNext, () => skipToNext());

  TrackPlayer.addEventListener(Event.RemotePrevious, () =>
    TrackPlayer.skipToPrevious(),
  );

  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());

  TrackPlayer.addEventListener(Event.RemoteSeek, event =>
    seekTo(event.position).catch(() => {}),
  );

  // 切歌（含队列自动播放下一首）时写入最近播放，保证列表实时刷新
  // 本地文件已被删除时：Toast 提示并自动跳下一首（连续跳保护，避免全队列缺失死循环）
  let missingSkips = 0;
  const localTrackKey = (tr: any) =>
    String(tr?.id ?? tr?.mid ?? tr?.url ?? '');
  const isLocalTrack = (tr: any) => {
    const url = String(tr?.url ?? '');
    return !!url && !/^https?:/i.test(url) && url !== PENDING_URL;
  };

  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async e => {
    const tr = e.track as any;
    if (!tr?.title) {
      return;
    }
    const pending = getPendingPlayTrack();
    const pendingKey = String(pending?.id ?? pending?.mid ?? pending?.url ?? '');
    const activeKey = String(tr.id ?? tr.mid ?? tr.url ?? '');
    if (pending && pendingKey && pendingKey === activeKey) {
      // 只接受与当前请求目标匹配的事件，避免旧队列的迟到事件清掉新请求。
      clearPendingPlayTrack();
    }
    const url = typeof tr.url === 'string' ? tr.url : '';
    // 切到还未解析直链的占位曲目：立即优先解析这首，不等后台批次轮到
    if (tr.pendingKey && url === PENDING_URL) {
      resolvePendingTrack(tr.pendingKey).catch(() => {});
    }
    const isLocal = !!url && !/^https?:/i.test(url) && url !== PENDING_URL;
    if (isLocal) {
      const exists = await localSongFileExists(url);
      if (!exists) {
        ToastAndroid.show(
          `「${tr.title}」本地文件不存在，已自动播放下一首`,
          ToastAndroid.SHORT,
        );
        missingSkips += 1;
        try {
          const queue = await TrackPlayer.getQueue();
          if (missingSkips < queue.length) {
            await TrackPlayer.skipToNext();
            await TrackPlayer.play();
          } else {
            // 队列全部缺失：停止尝试
            await TrackPlayer.pause();
          }
        } catch (err) {
          // 队列尾部无下一首时忽略
        }
        return; // 缺失曲目不写入最近播放
      }
    }
    missingSkips = 0;
    // 无网 / 仅Wi-Fi 蜂窝 下切到在线曲目：立即暂停并提示。
    // 这是覆盖所有切歌路径（自动连播、通知栏下一曲、会话恢复等）的兜底硬拦截。
    const isOnlineHttp = !isLocal && !!url && url !== PENDING_URL;
    if (isOnlineHttp) {
      const reason = onlinePlaybackBlockReason();
      if (reason) {
        TrackPlayer.pause().catch(() => {});
        ToastAndroid.show(reason, ToastAndroid.SHORT);
      }
    }
    // 在线曲目：后台整曲缓存（断网可回听已听部分、下次离线可播）。
    // 为避免流量翻倍，仅在 Wi-Fi 下缓存；但「仅 Wi-Fi 联网」关闭时流量下也缓存不限制
    if (
      !isLocal &&
      url &&
      url !== PENDING_URL &&
      tr.mid &&
      (!isCellular() || !wifiOnlyEnabled())
    ) {
      getPlayQuality()
        .then(q => cacheSongInBackground(String(tr.mid), q, url))
        .catch(() => {});
    }
    const song: Song = {
      mid: tr.mid,
      title: tr.title,
      singer: tr.artist
        ? String(tr.artist)
            .split(' / ')
            .map((name: string) => ({name}))
        : undefined,
      coverUrl: typeof tr.artwork === 'string' ? tr.artwork : undefined,
      interval: tr.duration,
      // 占位地址不写入（点最近播放会按 mid 重新解析）
      url: isLocal || url === PENDING_URL ? undefined : url || undefined,
      localPath: isLocal ? url : undefined,
    };
    addRecentSongs([song]).catch(() => {});
    // 队列/当前曲目变化时保存会话快照，供重启后恢复
    saveQueueSnapshot().catch(() => {});
  });

  // 占位/过期地址播放失败：占位曲优先解析；缓存/快照里的旧直链强制重解析后续播
  const urlRetried = new Set<string>(); // 每曲只重解析一次，避免死循环
  TrackPlayer.addEventListener(Event.PlaybackError, async () => {
    try {
      const tr = (await TrackPlayer.getActiveTrack()) as any;
      if (isLocalTrack(tr)) {
        // 本地坏帧由自编译 FFmpeg 原生扩展解码器处理；JS 层不再 seek/reload，避免打断
        // 解码线程和已经输出的 PCM 缓冲。
        return;
      }
      // 用户正在拖动进度条时，PlaybackError 可能只是 seek 触发的瞬态状态。
      // 不要并行刷新直链/load，否则会把用户目标覆盖回新音源的 0 秒。
      if (isSeekInFlight()) {
        return;
      }
      // PlaybackError 事件有时在网络流仍处于 Buffering/Connecting 时到达。
      // 这类状态不是媒体地址失效，必须交给 ExoPlayer 继续等待缓冲，
      // 不能因为进度暂时不变而重新 load 或改变播放位置。
      const onlinePlayback = await TrackPlayer.getPlaybackState().catch(() => null);
      if (
        onlinePlayback?.state === State.Buffering ||
        onlinePlayback?.state === State.Connecting
      ) {
        return;
      }
      if (tr?.pendingKey) {
        if (tr.url === PENDING_URL) {
          ToastAndroid.show('歌曲地址解析中，请稍候…', ToastAndroid.SHORT);
        }
        resolvePendingTrack(tr.pendingKey).catch(() => {});
        return;
      }
      // 离线时不重解析：seek 到未缓冲区触发的播放失败若在此联网重取直链并 load()，
      // 会重建音源、冲掉 ExoPlayer 已缓冲的音频，导致已缓存部分也无法继续播放。
      // 保持当前音源不动，待恢复网络或用户重新播放即可（本地/已整曲缓存曲目为 file://，
      // 不会走到这里，离线照常播放）。
      if (!isConnected()) {
        return;
      }
      // 在线流只有在错误状态持续后才刷新失效直链；网络流刚进入
      // Buffering/短暂 Error 时交给原生播放器继续恢复。
      await new Promise(resolve => setTimeout(resolve, 1800));
      const stillActive = (await TrackPlayer.getActiveTrack().catch(() => null)) as any;
      if (localTrackKey(stillActive) !== localTrackKey(tr)) {
        return;
      }
      const delayedState = (await TrackPlayer.getPlaybackState().catch(() => null))?.state;
      if (delayedState !== State.Error) {
        return;
      }
      // 在线曲目直链失效（缓存/会话快照里的旧地址过期）时，绕过缓存
      // 重取直链；帧级错误由原生 decoder fallback 负责。
      const mid = tr?.mid ? String(tr.mid) : '';
      const sourceUrl = String(tr.url ?? '');
      const retryKey = mid || localTrackKey(tr);
      if (
        !retryKey ||
        !/^https?:/i.test(sourceUrl) ||
        urlRetried.has(retryKey)
      ) {
        return;
      }
      urlRetried.add(retryKey);
      let url = sourceUrl;
      if (mid) {
        try {
          const fresh = await getPreferredSongUrls([mid], true);
          url = fresh?.[mid] || sourceUrl;
        } catch (e) {
          // 直链刷新失败时保持当前音源，避免无谓重建。
        }
      }
      // 同 URL 说明地址没有失效，不在 JS 层 reload，避免打断原生解码器。
      if (url === sourceUrl) {
        return;
      }
      const {position, duration} = await TrackPlayer.getProgress().catch(() => ({position: 0, duration: 0}));
      const knownDuration = Number(duration || tr.duration || 0);
      await TrackPlayer.load({...tr, url});
      // 仅在 URL 确实更新时恢复原播放位置；这不是坏帧恢复路径。
      const currentPosition = Math.max(Number(position) || 0, 0);
      const target = Math.min(
        currentPosition,
        knownDuration > 0
          ? Math.max(knownDuration - 0.1, 0)
          : currentPosition,
      );
      await seekTo(target, {timeoutMs: 4500}).catch(() => {});
      await TrackPlayer.play();
      saveQueueSnapshot().catch(() => {});
    } catch (e) {
      // 忽略
    }
  });

  // 播放进度节流保存（progressUpdateEventInterval 为 1s，这里每 5s 落盘一次）
  let lastPosSave = 0;
  TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, e => {
    syncSleepTimerState().catch(() => {});
    const now = Date.now();
    if (now - lastPosSave >= 5000) {
      lastPosSave = now;
      savePlayPosition(e.position).catch(() => {});
    }
  });

  // 暂停/停止时立即保存进度，避免节流窗口内的进度丢失
  TrackPlayer.addEventListener(Event.PlaybackState, async e => {
    if (e.state === State.Paused || e.state === State.Stopped) {
      try {
        const {position} = await TrackPlayer.getProgress();
        await savePlayPosition(position);
      } catch (err) {
        // 忽略
      }
    }
  });
}
