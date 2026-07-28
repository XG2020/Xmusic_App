import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  RepeatMode,
  State,
  Track,
} from 'react-native-track-player';
import {ToastAndroid} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {getPreferredSongUrls, getSongUrls} from './api';
import {enrichLocalSong} from './download';
import type {Quality} from './settings';
import type {Song} from '../types/music';

export type PlayMode = 'list' | 'single' | 'shuffle';

// 上次播放会话持久化（重启后恢复队列与进度）
const K_LAST_QUEUE = 'last_queue_v1';
const K_LAST_POS = 'last_pos_v1';

// 全局播放模式：模块级状态 + 持久化，切换播放列表/退出播放页/重启都不重置
const K_PLAY_MODE = 'play_mode_v1';
let currentMode: PlayMode = 'list';
const modeLoaded = AsyncStorage.getItem(K_PLAY_MODE)
  .then(raw => {
    if (raw === 'list' || raw === 'single' || raw === 'shuffle') {
      currentMode = raw;
    }
  })
  .catch(() => {});

/** 当前全局播放模式（同步读） */
export function getPlayMode(): PlayMode {
  return currentMode;
}

// 渐进式入队会话号：队列被替换/清空时递增，使旧的后台追加失效
let enqueueSession = 0;

// 占位歌曲登记表：pendingKey -> 歌曲与解析器，播放切到占位曲目时可优先解析
type PendingEntry = {song: Song; resolver: (batch: Song[]) => Promise<Song[]>};
const pendingMap = new Map<string, PendingEntry>();
const pendingInFlight = new Set<string>();

/** 队列被外部清空（如当前播放页清空按钮）时调用，停止后台追加 */
export function cancelProgressiveEnqueue() {
  enqueueSession += 1;
  pendingMap.clear();
}

let playerReady = false;

export async function setupPlayer(): Promise<boolean> {
  if (playerReady) {
    return true;
  }
  try {
    // v4: setupPlayer 重复调用会抛错，用 try/catch 兜底
    await TrackPlayer.setupPlayer({autoHandleInterruptions: true});
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!msg.includes('already been initialized')) {
      return false;
    }
  }
  try {
    await TrackPlayer.updateOptions({
      android: {
        appKilledPlaybackBehavior:
          AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
      },
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SeekTo,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
        Capability.Stop,
      ],
      compactCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],
      progressUpdateEventInterval: 1,
    });
    // 按持久化的播放模式恢复循环方式（单曲循环 = RepeatMode.Track）
    await modeLoaded;
    await TrackPlayer.setRepeatMode(
      currentMode === 'single' ? RepeatMode.Track : RepeatMode.Queue,
    );
  } catch (e) {
    // 配置失败不阻塞使用
  }
  playerReady = true;
  return true;
}

export function songToTrack(s: Song): Track {
  return {
    id: s.mid ?? String(s.id ?? s.title),
    url: s.url ?? s.localPath ?? '',
    title: s.title,
    artist: s.singer?.map(x => x.name).join(' / ') ?? '未知歌手',
    artwork: s.coverUrl,
    duration: s.interval,
    // 自定义字段，供歌词等页面使用
    mid: s.mid,
    // 自定义字段：播放页下载时凭专辑信息拼封面直链（artwork 缺失/本地路径时兜底）
    album: s.album,
  } as Track;
}

export async function playSongs(songs: Song[], startIndex = 0) {
  const ok = await setupPlayer();
  if (!ok) {
    return;
  }
  // 使进行中的后台追加失效，避免旧列表的歌混入新队列
  enqueueSession += 1;
  pendingMap.clear();
  // 本地歌曲补全下载时保存的封面与元数据（mid/歌手等），播放页才能完整显示
  const enriched = await Promise.all(songs.map(enrichLocalSong));
  const tracks = enriched.map(songToTrack).filter(t => !!t.url);
  if (!tracks.length) {
    return;
  }
  // 无播放地址的歌曲（VIP 专属/已下架等）会被跳过，明确提示避免队列数与歌单数不一致的困惑
  if (tracks.length < songs.length) {
    ToastAndroid.show(
      `${songs.length - tracks.length}首歌曲无播放地址已跳过（可能需要VIP或已下架）`,
      ToastAndroid.SHORT,
    );
  }
  await TrackPlayer.reset();
  await TrackPlayer.add(tracks);
  // v4: skip 按队列下标
  const idx = Math.min(Math.max(startIndex, 0), tracks.length - 1);
  if (idx > 0) {
    await TrackPlayer.skip(idx);
  }
  await TrackPlayer.play();
  // 新队列建立后立即保存会话快照，重启可恢复
  saveQueueSnapshot().catch(() => {});
}

/** 占位直链：歌曲已入队但地址还未解析（后台替换后可播放） */
export const PENDING_URL = 'https://pending.invalid/resolving.mp3';

/**
 * 优先解析指定占位曲目（用户手动切到还没解析到的歌时调用），
 * 解析成功后立即替换队列中的占位并续播，不等后台批次轮到它。
 */
export async function resolvePendingTrack(pendingKey: string): Promise<boolean> {
  const entry = pendingMap.get(pendingKey);
  if (!entry || pendingInFlight.has(pendingKey)) {
    return false;
  }
  pendingInFlight.add(pendingKey);
  try {
    const session = enqueueSession;
    const resolved = await entry.resolver([entry.song]);
    const enriched = await Promise.all(resolved.map(enrichLocalSong));
    const fresh = enriched.map(songToTrack).find(t => !!t.url);
    if (session !== enqueueSession) {
      return false;
    }
    const queue = (await TrackPlayer.getQueue()) as any[];
    const qIdx = queue.findIndex(t => t.pendingKey === pendingKey);
    if (qIdx < 0) {
      // 已被后台批次替换
      pendingMap.delete(pendingKey);
      return true;
    }
    const active = await TrackPlayer.getActiveTrackIndex();
    if (!fresh) {
      // 无播放地址（VIP/下架）：非当前曲目直接移除
      if (qIdx !== active) {
        await TrackPlayer.remove(qIdx);
      }
      pendingMap.delete(pendingKey);
      return false;
    }
    if (qIdx === active) {
      await TrackPlayer.load(fresh);
      await TrackPlayer.play();
    } else {
      await TrackPlayer.remove(qIdx);
      await TrackPlayer.add(fresh, qIdx);
    }
    pendingMap.delete(pendingKey);
    // 占位替换成直链后刷新会话快照，重启恢复不丢歌
    saveQueueSnapshot().catch(() => {});
    return true;
  } catch (e) {
    return false;
  } finally {
    pendingInFlight.delete(pendingKey);
  }
}

/**
 * 渐进式播放：首批 12 首解析直链后立即开播；其余歌曲立刻以占位形式全部入队
 * （播放列表一开始就显示完整数量），后台分批解析直链后原位替换占位曲目。
 * 点击位置之前的歌旋转到队尾（列表循环下顺序不变）。
 * resolver 由调用方提供（歌单直链解析 / 榜单 id->mid 再解析等），需保留入参额外字段。
 */
export async function playSongsProgressive(
  songs: Song[],
  startIndex: number,
  resolver: (batch: Song[]) => Promise<Song[]>,
): Promise<boolean> {
  const ok = await setupPlayer();
  if (!ok) {
    return false;
  }
  const session = ++enqueueSession;
  const FIRST = 12;
  const BATCH = 30;
  // 旋转列表：从点击位置开始，前面的歌排到队尾
  const idx = Math.min(Math.max(startIndex, 0), songs.length - 1);
  const ordered = [...songs.slice(idx), ...songs.slice(0, idx)];

  // 首批：解析直链后立即开播
  const firstBatch = ordered.slice(0, FIRST);
  const resolvedFirst = await resolver(firstBatch);
  const enrichedFirst = await Promise.all(resolvedFirst.map(enrichLocalSong));
  const firstTracks = enrichedFirst.map(songToTrack).filter(t => !!t.url);
  if (session !== enqueueSession) {
    return false;
  }
  if (!firstTracks.length) {
    return false;
  }
  let skipped = firstBatch.length - firstTracks.length;

  // 其余歌曲立即以占位入队：本地路径/旧直链可直接播，否则挂占位地址等待替换
  const rest = ordered.slice(FIRST);
  pendingMap.clear();
  const pendingTracks = rest.map((s, i) => {
    const key = `pk-${session}-${i}`;
    pendingMap.set(key, {song: s, resolver});
    return {
      ...songToTrack(s),
      url: s.localPath ?? s.url ?? PENDING_URL,
      pendingKey: key,
    } as Track;
  });

  await TrackPlayer.reset();
  await TrackPlayer.add(firstTracks);
  if (pendingTracks.length) {
    await TrackPlayer.add(pendingTracks);
  }
  await TrackPlayer.play();
  // 新队列建立后立即保存会话快照（不等切歌事件），重启可恢复
  saveQueueSnapshot().catch(() => {});

  const finishToast = () => {
    if (skipped > 0 && session === enqueueSession) {
      ToastAndroid.show(
        `${skipped}首歌曲无播放地址已跳过（可能需要VIP或已下架）`,
        ToastAndroid.SHORT,
      );
    }
  };
  if (!rest.length) {
    finishToast();
    return true;
  }

  // 后台分批解析直链，逐个原位替换占位曲目（边播边缓存后面的歌）
  (async () => {
    for (let i = 0; i < rest.length; i += BATCH) {
      if (session !== enqueueSession) {
        return;
      }
      const batch = rest.slice(i, i + BATCH);
      // 打标后交给 resolver（可能过滤掉无效歌），用标记匹配回占位位置
      const tagged = batch.map((s, k) => ({...s, __pk: k} as Song));
      const trackByPk = new Map<number, Track>();
      try {
        const resolved = await resolver(tagged);
        const enriched = await Promise.all(resolved.map(enrichLocalSong));
        enriched.forEach((s, j) => {
          const track = songToTrack(s);
          if (track.url) {
            trackByPk.set((resolved[j] as any).__pk, track);
          }
        });
      } catch (e) {
        // 整批解析失败：保留占位（本地路径/旧直链可能仍可播放）
        continue;
      }
      if (session !== enqueueSession) {
        return;
      }
      for (let k = 0; k < batch.length; k++) {
        if (session !== enqueueSession) {
          return;
        }
        const key = `pk-${session}-${i + k}`;
        const fresh = trackByPk.get(k);
        if (pendingInFlight.has(key)) {
          continue; // 该曲正在被优先解析，交给 resolvePendingTrack 处理
        }
        try {
          const queue = (await TrackPlayer.getQueue()) as any[];
          const qIdx = queue.findIndex(t => t.pendingKey === key);
          if (qIdx < 0) {
            pendingMap.delete(key);
            continue; // 已被优先解析替换或用户手动移出队列
          }
          const active = await TrackPlayer.getActiveTrackIndex();
          if (!fresh) {
            // 解析不到地址（VIP/下架）：从队列移除；正在播放的留给缺失跳过逻辑
            if (qIdx !== active) {
              await TrackPlayer.remove(qIdx);
              pendingMap.delete(key);
              skipped += 1;
            }
            continue;
          }
          if (qIdx === active) {
            // 用户已切到这首占位歌：替换当前曲目并续播
            const {state} = await TrackPlayer.getPlaybackState();
            await TrackPlayer.load(fresh);
            if (state === State.Playing || state === State.Error) {
              await TrackPlayer.play();
            }
          } else {
            await TrackPlayer.remove(qIdx);
            await TrackPlayer.add(fresh, qIdx);
          }
          pendingMap.delete(key);
        } catch (e) {
          // 单曲替换失败跳过，不影响其余
        }
      }
      // 每批替换完成后刷新快照：快照里的占位地址逐批变成可恢复的直链
      saveQueueSnapshot().catch(() => {});
    }
    finishToast();
  })();
  return true;
}

export async function togglePlay() {
  const {state} = await TrackPlayer.getPlaybackState();
  if (state === 'playing') {
    await TrackPlayer.pause();
  } else {
    await TrackPlayer.play();
  }
}

export async function setPlayMode(mode: PlayMode) {
  currentMode = mode;
  AsyncStorage.setItem(K_PLAY_MODE, mode).catch(() => {});
  if (mode === 'single') {
    await TrackPlayer.setRepeatMode(RepeatMode.Track);
  } else {
    await TrackPlayer.setRepeatMode(RepeatMode.Queue);
  }
}

/** 下一曲：不传 mode 时按全局播放模式（迷你条/通知栏切歌同样遵循随机） */
export async function skipToNext(mode?: PlayMode) {
  const m = mode ?? currentMode;
  try {
    if (m === 'shuffle') {
      const queue = await TrackPlayer.getQueue();
      if (queue.length > 1) {
        const current = (await TrackPlayer.getActiveTrackIndex()) ?? 0;
        let next = current;
        while (next === current) {
          next = Math.floor(Math.random() * queue.length);
        }
        await TrackPlayer.skip(next);
        await TrackPlayer.play();
        return;
      }
    }
    await TrackPlayer.skipToNext();
    await TrackPlayer.play();
  } catch (e) {
    // 队列尾部无下一首时忽略
  }
}

export async function skipToPrevious() {
  try {
    await TrackPlayer.skipToPrevious();
    await TrackPlayer.play();
  } catch (e) {
    // 队列头部无上一首时忽略
  }
}

export async function seekTo(position: number) {
  await TrackPlayer.seekTo(position);
}

/** 插入到当前曲目之后（下一曲播放），必要时先解析直链 */
export async function playNext(song: Song): Promise<boolean> {
  const ok = await setupPlayer();
  if (!ok) {
    return false;
  }
  let s = song;
  if (s.localPath) {
    s = await enrichLocalSong(s);
  }
  if (!s.url && !s.localPath && s.mid) {
    try {
      const urls = await getPreferredSongUrls([s.mid]);
      s = {...s, url: urls?.[s.mid]};
    } catch (e) {
      // 解析失败走下方兜底判断
    }
  }
  const track = songToTrack(s);
  if (!track.url) {
    return false;
  }
  const queue = await TrackPlayer.getQueue();
  if (!queue.length) {
    await TrackPlayer.add(track);
    await TrackPlayer.play();
    return true;
  }
  const current = (await TrackPlayer.getActiveTrackIndex()) ?? 0;
  await TrackPlayer.add(track, current + 1);
  return true;
}

/** 切换播放音质：无缝替换当前在线曲目（保持进度与播放状态），返回是否已切换 */
export async function applyQualityToCurrent(q: Quality): Promise<boolean> {
  try {
    const track = (await TrackPlayer.getActiveTrack()) as any;
    if (!track?.mid) {
      return false;
    }
    const urls = await getSongUrls([String(track.mid)], q);
    const url = urls?.[String(track.mid)];
    if (!url) {
      return false;
    }
    const {position} = await TrackPlayer.getProgress();
    const {state} = await TrackPlayer.getPlaybackState();
    await TrackPlayer.load({...track, url});
    if (position > 1) {
      await TrackPlayer.seekTo(position);
    }
    if (state === State.Playing) {
      await TrackPlayer.play();
    }
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- 播放会话持久化：重启后恢复上次的队列与进度 ----------

type SavedTrack = {
  id?: string;
  url: string;
  title?: string;
  artist?: string;
  artwork?: string;
  duration?: number;
  mid?: string;
};

/** 保存当前队列快照（切歌/队列变化时调用） */
export async function saveQueueSnapshot() {
  try {
    const queue = (await TrackPlayer.getQueue()) as any[];
    if (!queue.length) {
      return;
    }
    const index = (await TrackPlayer.getActiveTrackIndex()) ?? 0;
    const tracks: SavedTrack[] = queue.map(t => ({
      id: t.id,
      url: t.url,
      title: t.title,
      artist: t.artist,
      artwork: typeof t.artwork === 'string' ? t.artwork : undefined,
      duration: t.duration,
      mid: t.mid,
    }));
    await AsyncStorage.setItem(K_LAST_QUEUE, JSON.stringify({tracks, index}));
  } catch (e) {
    // 保存失败不影响播放
  }
}

/** 保存当前播放进度（进度事件节流调用/暂停时调用） */
export async function savePlayPosition(position: number) {
  try {
    await AsyncStorage.setItem(K_LAST_POS, String(Math.floor(position)));
  } catch (e) {
    // 保存失败不影响播放
  }
}

/**
 * 启动时恢复上次播放会话：加载队列、定位曲目与进度，保持暂停不自动播放。
 * 在线直链可能已过期，按 mid 批量重新解析；本地曲目直接用原路径。
 */
export async function restoreLastSession(): Promise<boolean> {
  const ok = await setupPlayer();
  if (!ok) {
    return false;
  }
  try {
    // 播放服务仍存活（如从后台回到前台）时队列非空，不覆盖
    const existing = await TrackPlayer.getQueue();
    if (existing.length) {
      return false;
    }
    const raw = await AsyncStorage.getItem(K_LAST_QUEUE);
    if (!raw) {
      return false;
    }
    const {tracks, index} = JSON.parse(raw) as {
      tracks: SavedTrack[];
      index: number;
    };
    if (!tracks?.length) {
      return false;
    }
    // 收集在线曲目的 mid 重新解析直链（过期兜底：解析失败沿用旧链）
    const onlineMids = tracks
      .filter(t => t.mid && /^https?:/i.test(t.url))
      .map(t => String(t.mid));
    let fresh: Record<string, string | undefined> = {};
    if (onlineMids.length) {
      try {
        fresh = await getPreferredSongUrls(onlineMids);
      } catch (e) {
        // 解析失败沿用保存的旧链
      }
    }
    const restored = tracks
      .map(t => ({
        ...t,
        url:
          t.mid && /^https?:/i.test(t.url)
            ? fresh[String(t.mid)] || t.url
            : t.url,
      }))
      // 过滤仍是占位地址的曲目（上次退出前还没解析完且本次也解析失败）
      .filter(t => !!t.url && t.url !== PENDING_URL);
    if (!restored.length) {
      return false;
    }
    await TrackPlayer.add(restored as Track[]);
    const idx = Math.min(Math.max(index ?? 0, 0), restored.length - 1);
    if (idx > 0) {
      await TrackPlayer.skip(idx);
    }
    const pos = Number(await AsyncStorage.getItem(K_LAST_POS)) || 0;
    if (pos > 1) {
      await TrackPlayer.seekTo(pos);
    }
    return true;
  } catch (e) {
    return false;
  }
}
