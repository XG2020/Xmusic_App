import TrackPlayer, {Event, State} from 'react-native-track-player';
import {ToastAndroid} from 'react-native';
import RNFS from 'react-native-fs';
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
  PENDING_URL,
} from './player';
import type {Song} from '../types/music';

export default async function playbackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, async () => {
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
    TrackPlayer.seekTo(event.position),
  );

  // 切歌（含队列自动播放下一首）时写入最近播放，保证列表实时刷新
  // 本地文件已被删除时：Toast 提示并自动跳下一首（连续跳保护，避免全队列缺失死循环）
  let missingSkips = 0;
  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async e => {
    const tr = e.track as any;
    if (!tr?.title) {
      return;
    }
    const url = typeof tr.url === 'string' ? tr.url : '';
    // 切到还未解析直链的占位曲目：立即优先解析这首，不等后台批次轮到
    if (tr.pendingKey && url === PENDING_URL) {
      resolvePendingTrack(tr.pendingKey).catch(() => {});
    }
    const isLocal = !!url && !/^https?:/i.test(url);
    if (isLocal) {
      const path = url.replace(/^file:\/\//i, '');
      const exists = await RNFS.exists(path).catch(() => true);
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
      // 在线曲目直链失效（缓存/会话快照里的旧地址过期）：绕过缓存重取直链替换续播
      const mid = tr?.mid ? String(tr.mid) : '';
      if (!mid || !/^https?:/i.test(String(tr.url ?? '')) || urlRetried.has(mid)) {
        return;
      }
      urlRetried.add(mid);
      const fresh = await getPreferredSongUrls([mid], true);
      const url = fresh?.[mid];
      if (!url || url === tr.url) {
        return;
      }
      await TrackPlayer.load({...tr, url});
      await TrackPlayer.play();
      saveQueueSnapshot().catch(() => {});
    } catch (e) {
      // 忽略
    }
  });

  // 播放进度节流保存（progressUpdateEventInterval 为 1s，这里每 5s 落盘一次）
  let lastPosSave = 0;
  TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, e => {
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
