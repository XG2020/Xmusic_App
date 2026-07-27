import TrackPlayer, {Event, State} from 'react-native-track-player';
import {ToastAndroid} from 'react-native';
import RNFS from 'react-native-fs';
import {addRecentSongs} from './store';
import {getPreferredSongUrls} from './api';
import {
  saveQueueSnapshot,
  savePlayPosition,
  resolvePendingTrack,
  PENDING_URL,
} from './player';
import type {Song} from '../types/music';

export default async function playbackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());

  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());

  TrackPlayer.addEventListener(Event.RemoteNext, () =>
    TrackPlayer.skipToNext(),
  );

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
