import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  RepeatMode,
  State,
  Track,
} from 'react-native-track-player';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {getPreferredSongUrls, getSongUrls} from './api';
import {enrichLocalSong} from './download';
import {hydrateDownloadedSong} from './store';
import {ensureOnlinePlayback, isConnected, waitForNetworkState} from './network';
import {isOfflinePlayable, preferCachedSong} from './songCache';
import {getPlayQuality, allowMixWithOthersEnabled} from './settings';
import type {Quality} from './settings';
import type {Song} from '../types/music';

export type PlayMode = 'list' | 'single' | 'shuffle';

/** 是否为需要联网的在线曲目（有 mid 待解析或直链为 http，且非本地文件） */
function isOnlineSong(s?: Song): boolean {
  if (!s || s.localPath || s.uri || s.filePath) {
    return false;
  }
  return !!s.mid || /^https?:/i.test(s.url ?? '');
}

/** 队列 Track 是否为在线曲目（本地 file:// 直链视为离线可播，不受网络门禁限制） */
function isTrackOnline(t: any): boolean {
  if (!t) {
    return false;
  }
  const url = String(t.url ?? '');
  if (url && !/^https?:/i.test(url) && url !== PENDING_URL) {
    return false; // 本地文件路径
  }
  return /^https?:/i.test(url) || url === PENDING_URL || !!t.mid;
}

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

// ---------- 延迟恢复（deferred restore）状态 ----------
// 启动恢复上次会话时，为避免原生 prepare()→READY 在「允许同时播放」(Mode F) 下抢占音频
// 焦点、打断其他应用，先把恢复出来的队列保存在这里（JS 快照），「不」灌进原生播放器；
// 迷你条/播放页据此回退显示上次歌曲，直到用户「真正点播放」才 materialize 进原生队列。
type PendingSession = {tracks: Track[]; index: number; position: number};
let pendingRestore: PendingSession | null = null;
const pendingRestoreSubs = new Set<() => void>();
const queueSnapshotSubs = new Set<() => void>();

function notifyPendingRestore() {
  pendingRestoreSubs.forEach(fn => {
    try {
      fn();
    } catch (e) {
      // 单个订阅者异常不影响其余
    }
  });
}

function notifyQueueSnapshot() {
  queueSnapshotSubs.forEach(fn => {
    try {
      fn();
    } catch (e) {
      // 单个订阅者异常不影响其余
    }
  });
}

/** 订阅待恢复快照变化（设置/清空/插入时触发），返回取消订阅函数 */
export function subscribePendingRestore(fn: () => void): () => void {
  pendingRestoreSubs.add(fn);
  return () => {
    pendingRestoreSubs.delete(fn);
  };
}

/** 订阅原生播放队列变化（建队/替换/清空等） */
export function subscribeQueueSnapshot(fn: () => void): () => void {
  queueSnapshotSubs.add(fn);
  return () => {
    queueSnapshotSubs.delete(fn);
  };
}

/** 是否存在待恢复（尚未 materialize 进原生播放器）的会话 */
export function hasPendingRestore(): boolean {
  return !!pendingRestore;
}

/** 待恢复会话的「当前曲目」（原生队列为空时供迷你条/播放页回退显示） */
export function getPendingRestoreTrack(): Track | null {
  if (!pendingRestore) {
    return null;
  }
  return (
    pendingRestore.tracks[pendingRestore.index] ??
    pendingRestore.tracks[0] ??
    null
  );
}

/** 待恢复会话的完整队列（原生队列为空时供播放队列弹层回退显示） */
export function getPendingRestoreTracks(): Track[] {
  return pendingRestore ? pendingRestore.tracks : [];
}

/** 待恢复会话的当前曲目下标 */
export function getPendingRestoreIndex(): number {
  return pendingRestore ? pendingRestore.index : -1;
}

/** 待恢复会话的当前进度快照（仅供界面回退展示，不驱动原生播放器） */
export function getPendingRestoreProgress(): {
  position: number;
  duration: number;
} {
  if (!pendingRestore) {
    return {position: 0, duration: 0};
  }
  const track =
    pendingRestore.tracks[pendingRestore.index] ?? pendingRestore.tracks[0];
  return {
    position: pendingRestore.position,
    duration: Number(track?.duration) || 0,
  };
}

/**
 * 把待恢复会话真正加载进原生播放器（首次「用户点播放」时调用）。
 * 此刻申请音频焦点、打断其他应用是符合预期的（用户主动播放）。
 * @returns 是否发生了 materialize（存在待恢复会话且已加载进原生队列）
 */
export async function materializePendingSession(): Promise<boolean> {
  const pending = pendingRestore;
  if (!pending) {
    return false;
  }
  // 先清空，避免并发重入重复入队
  pendingRestore = null;
  try {
    // 原生队列已被其他播放入口建立时，放弃快照（以现有队列为准）
    const existing = await TrackPlayer.getQueue();
    if (existing.length) {
      notifyPendingRestore();
      return false;
    }
    await TrackPlayer.add(pending.tracks);
    if (pending.index > 0) {
      await TrackPlayer.skip(pending.index);
    }
    if (pending.position > 1) {
      await TrackPlayer.seekTo(pending.position);
    }
    notifyPendingRestore();
    return true;
  } catch (e) {
    notifyPendingRestore();
    return false;
  }
}

/** 前台播放入口做网络门禁用：优先取待恢复快照当前曲目，否则取原生当前曲目 */
async function currentTrackForGate(): Promise<any> {
  if (pendingRestore) {
    return getPendingRestoreTrack();
  }
  return (await TrackPlayer.getActiveTrack()) as any;
}

export async function setupPlayer(): Promise<boolean> {
  if (playerReady) {
    return true;
  }
  try {
    // v4: setupPlayer 重复调用会抛错，用 try/catch 兜底。
    // autoHandleInterruptions（= KotlinAudio 的 handleAudioFocus，在播放器创建时定死）：
    //   - 「允许与其他应用同时播放」开启（默认）→ false：KotlinAudio 自行管理焦点——
    //     一旦播放器进入 READY 就申请 AUDIOFOCUS_GAIN（因此不能在启动恢复时就把队列灌进
    //     原生播放器，否则 prepare()→READY 会抢占焦点打断其他应用，见 restoreLastSession
    //     的「延迟恢复」）；被其他应用抢焦点时只压低音量(duck)而不暂停，实现「别人出声我也不停」。
    //   - 关闭 → true：交给 ExoPlayer 管理焦点，仅在「真正播放」时才申请（空闲/仅加载都不抢占），
    //     被其他应用打断时原生自动暂停、临时打断结束后自动续播；且只会恢复「因焦点被迫暂停」
    //     的曲目，手动暂停的状态不受影响。
    // 该选项只在冷启动创建播放器时生效，切换开关需重启应用。
    await TrackPlayer.setupPlayer({
      autoHandleInterruptions: !allowMixWithOthersEnabled(),
      // 保留播放头之后的缓冲（流媒体预缓冲），配合下方 backBuffer 支持离线拖动
      maxBuffer: 60,
      // 已播放过的音频保留在缓冲中（默认 0 会立即丢弃）：
      // 断网/流量受限时，可将进度条拖回「已听过的位置」继续离线播放，
      // 覆盖「边播边存」整曲缓存完成前的空窗期（完成后整曲已是本地文件可任意拖动）。
      backBuffer: 300,
    });
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
        // 「允许同时播放」关闭时，被其他应用打断则暂停而非降低音量（仅 autoHandleInterruptions=true 时生效）
        alwaysPauseOnInterruption: true,
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
    // 本地文件必须优先于线上 url；否则已下载歌曲离线时仍会请求网络。
    url: s.localPath ?? s.uri ?? s.filePath ?? s.url ?? '',
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

async function offlinePlayableQueue(
  songs: Song[],
  quality: Quality,
): Promise<Song[]> {
  const playable = await Promise.all(
    songs.map(async song =>
      (await isOfflinePlayable(song, quality, true))
        ? preferCachedSong(song, quality, true)
        : null,
    ),
  );
  return playable.filter((song): song is Song => !!song);
}

export async function playSongs(songs: Song[], startIndex = 0) {
  const ok = await setupPlayer();
  if (!ok) {
    return;
  }
  // Android 13+ 首次播放时请求通知权限（媒体通知展示，不阻塞播放流程）
  requestNotificationPermissionOnce();
  await waitForNetworkState();
  let hydratedSongs = await Promise.all(songs.map(hydrateDownloadedSong));
  const offline = !isConnected();
  const q = await getPlayQuality();
  let queueSongs = offline
    ? await offlinePlayableQueue(hydratedSongs, q)
    : hydratedSongs;
  if (!queueSongs.length) {
    return;
  }
  const requestedSong =
    hydratedSongs[Math.min(Math.max(startIndex, 0), hydratedSongs.length - 1)];
  const startSong = offline
    ? queueSongs.find(
        s => songToTrack(s).id === songToTrack(requestedSong).id,
      ) ?? queueSongs[0]
    : requestedSong;
  // 播放在线内容前的网络门禁：无网提示 / 流量三选项弹窗，用户拒绝则不加载。
  // 已整曲缓存 / 本地曲目可离线播放（不消耗流量）→ 直接放行，跳过门禁与流量提醒；
  // 离线时（deep）放宽到任一已缓存音质，避免播放音质变更后命中不到旧缓存。
  if (
    isOnlineSong(startSong) &&
    !(await isOfflinePlayable(startSong, q, offline)) &&
    !(await ensureOnlinePlayback())
  ) {
    return;
  }
  // Only resolve missing online URLs after the playback gate has allowed network use.
  if (!offline) {
    const missingMids = [
      ...new Set(
        hydratedSongs
          .filter(
            s =>
              !!s.mid &&
              !s.localPath &&
              !s.uri &&
              !s.filePath &&
              !s.url,
          )
          .map(s => s.mid as string),
      ),
    ];
    if (missingMids.length) {
      try {
        const urls = await getPreferredSongUrls(missingMids);
        hydratedSongs = hydratedSongs.map(s =>
          s.mid && urls[s.mid] ? {...s, url: urls[s.mid]} : s,
        );
        queueSongs = hydratedSongs;
      } catch (e) {
        // Keep the remaining playable songs when individual URL resolution fails.
      }
    }
  }
  // 使进行中的后台追加失效，避免旧列表的歌混入新队列
  enqueueSession += 1;
  pendingMap.clear();
  // 本地歌曲补全下载时保存的封面与元数据（mid/歌手等），播放页才能完整显示
  const enriched = await Promise.all(queueSongs.map(enrichLocalSong));
  // 已整曲缓存的在线曲目优先用本地文件（离线/秒开）；离线时放宽到任一已缓存音质
  const preferred = await Promise.all(
    enriched.map(s => preferCachedSong(s, q, offline)),
  );
  const tracks = preferred.map(songToTrack).filter(t => !!t.url);
  if (!tracks.length) {
    return;
  }
  await TrackPlayer.reset();
  await TrackPlayer.add(tracks);
  // v4: skip 按队列下标
  const startTrackId = songToTrack(startSong).id;
  const idx = Math.max(
    tracks.findIndex(t => t.id === startTrackId),
    0,
  );
  if (idx > 0) {
    await TrackPlayer.skip(idx);
  }
  await TrackPlayer.play();
  // 新队列建立后立即保存会话快照，重启可恢复
  saveQueueSnapshot().catch(() => {});
}

/** 占位直链：歌曲已入队但地址还未解析（后台替换后可播放） */
export const PENDING_URL = 'https://pending.invalid/resolving.mp3';

// 通知权限请求只需一次（Android 13+）；用 require 延迟加载避免与 LocalScreen
// 循环依赖（tsconfig module=es2015 不支持动态 import()，metro 下 require 等价）
let notificationAsked = false;
function requestNotificationPermissionOnce() {
  if (notificationAsked) {
    return;
  }
  notificationAsked = true;
  (async () => {
    try {
      const mod = require('../screens/LocalScreen') as typeof import('../screens/LocalScreen');
      await mod.ensureNotificationPermission();
    } catch (e) {
      // 请求失败不影响播放
    }
  })();
}

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
  // Android 13+ 首次播放时请求通知权限（媒体通知展示，不阻塞播放流程）
  requestNotificationPermissionOnce();
  await waitForNetworkState();
  const hydratedSongs = await Promise.all(songs.map(hydrateDownloadedSong));
  const offline = !isConnected();
  // 当前播放音质：用于匹配已整曲缓存的本地文件
  const q = await getPlayQuality();
  const queueSongs = offline
    ? await offlinePlayableQueue(hydratedSongs, q)
    : hydratedSongs;
  if (!queueSongs.length) {
    return false;
  }
  // 播放在线内容前的网络门禁：无网提示 / 流量三选项弹窗，用户拒绝则不加载
  const requestedSong =
    hydratedSongs[Math.min(Math.max(startIndex, 0), hydratedSongs.length - 1)];
  const startSong = offline
    ? queueSongs.find(
        s => songToTrack(s).id === songToTrack(requestedSong).id,
      ) ?? queueSongs[0]
    : requestedSong;
  // 已整曲缓存 / 本地曲目可离线播放 → 跳过网络门禁；离线放宽到任一已缓存音质
  if (
    isOnlineSong(startSong) &&
    !(await isOfflinePlayable(startSong, q, offline)) &&
    !(await ensureOnlinePlayback())
  ) {
    return false;
  }
  const session = ++enqueueSession;
  const FIRST = 12;
  const BATCH = 30;
  // 从已下载/本地歌曲开始播放时只物化当前歌曲，避免顺带解析后续在线歌曲消耗流量。
  const localStart = offline || !!(
    startSong?.localPath ||
    startSong?.uri ||
    startSong?.filePath ||
    (startSong?.url && !/^https?:/i.test(startSong.url))
  );
  // 旋转列表：从点击位置开始，前面的歌排到队尾
  const idx = Math.min(
    Math.max(
      queueSongs.findIndex(
        s => songToTrack(s).id === songToTrack(startSong).id,
      ),
      0,
    ),
    queueSongs.length - 1,
  );
  const ordered = [...queueSongs.slice(idx), ...queueSongs.slice(0, idx)];

  // 首批：解析直链后立即开播
  const firstCount = localStart ? 1 : FIRST;
  const firstBatch = ordered.slice(0, firstCount);
  // 本地起播不调用 resolver，避免榜单等解析器为补 mid/直链发起网络请求。
  const resolvedFirst = localStart ? firstBatch : await resolver(firstBatch);
  const enrichedFirst = await Promise.all(resolvedFirst.map(enrichLocalSong));
  // 已整曲缓存的在线曲目优先用本地文件
  const preferredFirst = await Promise.all(
    enrichedFirst.map(s => preferCachedSong(s, q, offline)),
  );
  const firstTracks = preferredFirst.map(songToTrack).filter(t => !!t.url);
  if (session !== enqueueSession) {
    return false;
  }
  if (!firstTracks.length) {
    return false;
  }
  // 其余歌曲立即以占位入队：本地路径/旧直链可直接播，否则挂占位地址等待替换
  const rest = ordered.slice(firstCount);
  // 本地起播时不解析在线歌曲，但已下载歌曲仍需补全本地封面、歌词和元数据。
  const preparedRest = localStart
    ? await Promise.all(
        rest.map(async song => {
          const isLocal =
            !!song.localPath ||
            !!song.uri ||
            !!song.filePath ||
            (!!song.url && !/^https?:/i.test(song.url));
          if (!isLocal) {
            return song;
          }
          return preferCachedSong(await enrichLocalSong(song), q, offline);
        }),
      )
    : rest;
  pendingMap.clear();
  const pendingTracks = preparedRest.map((s, i) => {
    const key = `pk-${session}-${i}`;
    pendingMap.set(key, {song: s, resolver});
    return {
      ...songToTrack(s),
      url: s.localPath ?? s.uri ?? s.filePath ?? s.url ?? PENDING_URL,
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

  if (!rest.length) {
    return true;
  }

  // 本地歌曲起播时不在后台批量解析在线地址；后续真正切到占位歌曲时再按需解析。
  if (localStart) {
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
        const preferred = await Promise.all(
          enriched.map(s => preferCachedSong(s, q, offline)),
        );
        preferred.forEach((s, j) => {
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
      const queue = (await TrackPlayer.getQueue()) as any[];
      const pendingIndex = new Map<string, number>();
      queue.forEach((t, qi) => {
        if (t.pendingKey) {
          pendingIndex.set(t.pendingKey, qi);
        }
      });
      const active = await TrackPlayer.getActiveTrackIndex();
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
          const qIdx = pendingIndex.get(key) ?? -1;
          if (qIdx < 0) {
            pendingMap.delete(key);
            continue; // 已被优先解析替换或用户手动移出队列
          }
          if (!fresh) {
            // 解析不到地址（VIP/下架）：从队列移除；正在播放的留给缺失跳过逻辑
            if (qIdx !== active) {
              await TrackPlayer.remove(qIdx);
              pendingIndex.forEach((idx2, key2) => {
                if (idx2 > qIdx) {
                  pendingIndex.set(key2, idx2 - 1);
                }
              });
              pendingMap.delete(key);
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
  })();
  return true;
}

export async function togglePlay() {
  const {state} = await TrackPlayer.getPlaybackState();
  if (state === State.Playing) {
    await TrackPlayer.pause();
    return;
  }
  // 续播：当前为在线曲目时先过网络门禁（无网/仅Wi-Fi 拦截、蜂窝流量提醒）
  const tr = await currentTrackForGate();
  if (isTrackOnline(tr) && !(await ensureOnlinePlayback())) {
    return;
  }
  // 有待恢复会话（延迟恢复）：此刻才把队列灌进原生播放器（用户主动播放，允许抢焦点）
  await materializePendingSession();
  await TrackPlayer.play();
}

/**
 * 用户主动续播（前台，可弹窗）：在线曲目先过网络门禁再播放。
 * 供 MiniPlayer 播放键等前台入口调用；通知栏 RemotePlay 走 playbackService 的同步拦截。
 */
export async function resumeUser() {
  const tr = await currentTrackForGate();
  if (isTrackOnline(tr) && !(await ensureOnlinePlayback())) {
    return;
  }
  // 有待恢复会话（延迟恢复）：此刻才把队列灌进原生播放器（用户主动播放，允许抢焦点）
  await materializePendingSession();
  await TrackPlayer.play();
}

/** 用户主动下一曲（前台门禁版）：当前队列为在线内容时先过网络门禁 */
export async function skipToNextUser(mode?: PlayMode) {
  const tr = await currentTrackForGate();
  if (isTrackOnline(tr) && !(await ensureOnlinePlayback())) {
    return;
  }
  await materializePendingSession();
  await skipToNext(mode);
}

/** 用户主动上一曲（前台门禁版）：当前队列为在线内容时先过网络门禁 */
export async function skipToPreviousUser() {
  const tr = await currentTrackForGate();
  if (isTrackOnline(tr) && !(await ensureOnlinePlayback())) {
    return;
  }
  await materializePendingSession();
  await skipToPrevious();
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
  const nextPosition = Math.max(0, position);
  // 冷启动恢复的会话在用户首次点播放前尚未灌入原生播放器。此时如果仍对
  // TrackPlayer.seekTo 调用，定位会落在空队列上；随后 materialize 又按旧快照
  // 加载，表现为进度条在点播放后跳回原位置。先更新快照即可保留用户的定位。
  if (pendingRestore) {
    pendingRestore.position = nextPosition;
    notifyPendingRestore();
    await savePlayPosition(nextPosition);
    return;
  }
  await TrackPlayer.seekTo(nextPosition);
}

/** 插入到当前曲目之后（下一曲播放），必要时先解析直链 */
export async function playNext(song: Song): Promise<boolean> {
  const ok = await setupPlayer();
  if (!ok) {
    return false;
  }
  // Validate downloaded files first so a missing file can fall back online.
  let s = await hydrateDownloadedSong(song);
  if (s.localPath || s.uri || s.filePath) {
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
  // 有待恢复会话（延迟恢复）且尚未落地：直接插入 JS 快照的当前曲目之后（不 materialize、
  // 不抢音频焦点），保持「未播放」；等用户真正点播放时再一起 materialize 进原生队列。
  if (pendingRestore) {
    const at = Math.min(pendingRestore.index + 1, pendingRestore.tracks.length);
    pendingRestore.tracks.splice(at, 0, track);
    notifyPendingRestore();
    return true;
  }
  const queue = await TrackPlayer.getQueue();
  if (!queue.length) {
    await TrackPlayer.add(track);
    await TrackPlayer.play();
    saveQueueSnapshot().catch(() => {});
    return true;
  }
  const current = (await TrackPlayer.getActiveTrackIndex()) ?? 0;
  await TrackPlayer.add(track, current + 1);
  saveQueueSnapshot().catch(() => {});
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
    // load() 会把进度重置到 0：无条件恢复原进度，避免切音质时从头重播
    await TrackPlayer.seekTo(position);
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
      await AsyncStorage.removeItem(K_LAST_QUEUE).catch(() => {});
      notifyQueueSnapshot();
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
    notifyQueueSnapshot();
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
    await waitForNetworkState();
    // 已有待恢复快照（重复调用 / 前后台切换）：不重复读取覆盖
    if (pendingRestore) {
      return true;
    }
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
    // 只刷新当前曲目附近少量在线直链（当前及前后 2 首），其余保留旧 URL，避免冷启动批量请求拖慢恢复。
    const center = Math.min(Math.max(index ?? 0, 0), tracks.length - 1);
    const onlineMids = tracks
      .slice(Math.max(center - 2, 0), Math.min(center + 3, tracks.length))
      .filter(t => t.mid && /^https?:/i.test(t.url))
      .map(t => String(t.mid));
    let fresh: Record<string, string | undefined> = {};
    // 离线时跳过在线重解析：网络请求必然失败且会拖慢冷启动恢复（axios 超时），
    // 已整曲缓存的歌曲下面由 preferCachedSong 换成本地文件照常离线播放、重启仍有效。
    if (onlineMids.length && isConnected()) {
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
    // 已整曲缓存的在线曲目换成本地文件：离线冷启动进入软件也能直接播放已缓存歌曲
    // （否则 restored 仍是过期 http 直链，离线按播放键会被网络门禁拦截）。
    const q = await getPlayQuality();
    const offline = !isConnected();
    const withCache = await Promise.all(
      restored.map(t => preferCachedSong(t as unknown as Song, q, offline)),
    );
    const tracks2 = (withCache as Track[]).filter(t => !!t.url);
    if (!tracks2.length) {
      return false;
    }
    const idx = Math.min(Math.max(index ?? 0, 0), tracks2.length - 1);
    const pos = Number(await AsyncStorage.getItem(K_LAST_POS)) || 0;
    // 延迟恢复：这里「不」调用 TrackPlayer.add/skip/seekTo——那会触发原生 prepare()→READY，
    // 在「允许同时播放」(Mode F) 下 KotlinAudio 会抢占音频焦点、打断其他正在播放的应用。
    // 仅保存 JS 快照，迷你条/播放页据此回退显示上次歌曲；直到用户真正点播放才 materialize
    // 进原生队列（见 materializePendingSession），此时抢焦点、打断他人才是用户预期。
    pendingRestore = {tracks: tracks2, index: idx, position: pos > 1 ? pos : 0};
    notifyPendingRestore();
    return true;
  } catch (e) {
    return false;
  }
}
