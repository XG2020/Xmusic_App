import {useEffect, useState} from 'react';
import {InteractionManager} from 'react-native';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Song} from '../types/music';

const RECENT_KEY = 'recent_songs';
const FAV_KEY = 'fav_songs';
const MAX_RECENT = 100;
const DOWNLOADED_SONGS_KEY = 'downloaded_songs_v1';

// 最近播放变更通知：任意页面通过 useRecentSongs 实时感知
const recentListeners = new Set<() => void>();

function notifyRecent() {
  recentListeners.forEach(l => l());
}

async function readList(key: string): Promise<Song[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Song[]) : [];
  } catch (e) {
    return [];
  }
}

export function songKey(s: Song) {
  return s.mid ?? s.localPath ?? `${s.id ?? s.title}`;
}

export async function getRecentSongs(): Promise<Song[]> {
  return readList(RECENT_KEY);
}

// 待写入的最近播放：切歌瞬间 UI/音频最忙，不在此时做全量读写盘，
// 先入队，延到交互/动画结束后合并落盘（短时间内多次切歌只写一次）
let pendingRecent: Song[] = [];
let recentFlushScheduled = false;

async function flushRecent() {
  const batch = pendingRecent;
  pendingRecent = [];
  recentFlushScheduled = false;
  if (!batch.length) {
    return;
  }
  try {
    const old = await readList(RECENT_KEY);
    const merged = [
      ...batch,
      ...old.filter(o => !batch.some(s => songKey(s) === songKey(o))),
    ];
    await AsyncStorage.setItem(
      RECENT_KEY,
      JSON.stringify(merged.slice(0, MAX_RECENT)),
    );
  } catch (e) {}
  notifyRecent();
}

export async function addRecentSongs(songs: Song[]) {
  // 新播放的排前，去掉队内旧的重复项
  pendingRecent = [
    ...songs,
    ...pendingRecent.filter(o => !songs.some(s => songKey(s) === songKey(o))),
  ];
  if (recentFlushScheduled) {
    return;
  }
  recentFlushScheduled = true;
  InteractionManager.runAfterInteractions(() => {
    flushRecent();
  });
}

/** 清空最近播放记录 */
export async function clearRecentSongs() {
  pendingRecent = [];
  await AsyncStorage.removeItem(RECENT_KEY).catch(() => {});
  notifyRecent();
}

/** Hook：订阅最近播放列表，播放/清空后实时刷新 */
export function useRecentSongs(): Song[] {
  const [list, setList] = useState<Song[]>([]);
  useEffect(() => {
    const load = () => {
      getRecentSongs().then(setList);
    };
    load();
    recentListeners.add(load);
    return () => {
      recentListeners.delete(load);
    };
  }, []);
  return list;
}

type DownloadedSongIndex = Record<string, string>;

function downloadMatchKey(song: Pick<Song, 'mid' | 'title' | 'singer'>): string {
  if (song.mid) return `mid:${song.mid}`;
  const artist = song.singer?.map(x => x.name).join(' / ') ?? '';
  return `title:${song.title}|artist:${artist}`;
}

async function readDownloadedIndex(): Promise<DownloadedSongIndex> {
  try {
    const raw = await AsyncStorage.getItem(DOWNLOADED_SONGS_KEY);
    return raw ? (JSON.parse(raw) as DownloadedSongIndex) : {};
  } catch (e) { return {}; }
}

export async function getDownloadedSongPath(song: Song): Promise<string | undefined> {
  const index = await readDownloadedIndex();
  const indexed = index[downloadMatchKey(song)];
  if (indexed) {
    return indexed;
  }
  // 兼容升级前已经完成的下载：旧记录没有独立索引，但任务 id 以 mid 开头。
  try {
    const raw = await AsyncStorage.getItem('download_history');
    const history = raw ? (JSON.parse(raw) as Array<{id?: string; title?: string; path?: string; status?: string}>) : [];
    const hit = history.find(item =>
      item.status === 'done' &&
      !!item.path &&
      (song.mid ? item.id?.startsWith(`${song.mid}:`) : item.title === song.title),
    );
    return hit?.path;
  } catch (e) {
    return undefined;
  }
}

export async function markSongDownloaded(song: Song, path: string): Promise<void> {
  if (!path) return;
  const index = await readDownloadedIndex();
  index[downloadMatchKey(song)] = path;
  await AsyncStorage.setItem(DOWNLOADED_SONGS_KEY, JSON.stringify(index)).catch(() => {});
  const [fav, playlists] = await Promise.all([readList(FAV_KEY), readLocalPlaylistsRaw()]);
  const sameSong = (a: Song, b: Song) => a.mid && b.mid ? a.mid === b.mid : downloadMatchKey(a) === downloadMatchKey(b);
  let favChanged = false;
  const nextFav = fav.map(item => {
    if (sameSong(item, song) && item.localPath !== path) { favChanged = true; return {...item, localPath: path, unplayable: undefined}; }
    return item;
  });
  let playlistChanged = false;
  const nextPlaylists = playlists.map(pl => {
    let changed = false;
    const nextSongs = pl.songs.map(item => {
      if (sameSong(item, song) && item.localPath !== path) { changed = true; playlistChanged = true; return {...item, localPath: path, unplayable: undefined}; }
      return item;
    });
    return changed ? {...pl, songs: nextSongs} : pl;
  });
  if (favChanged) await AsyncStorage.setItem(FAV_KEY, JSON.stringify(nextFav)).catch(() => {});
  if (playlistChanged) await AsyncStorage.setItem(PLAYLISTS_KEY, JSON.stringify(nextPlaylists)).catch(() => {});
}

async function indexedLocalPathExists(path: string): Promise<boolean> {
  if (path.startsWith('content://')) {
    // content:// 的最终存在性由播放服务通过 ContentResolver 校验。
    return true;
  }
  return RNFS.exists(path.replace(/^file:\/\//i, '')).catch(() => false);
}

export async function hydrateDownloadedSong(song: Song): Promise<Song> {
  if (song.localPath || song.uri) return song;
  const path = await getDownloadedSongPath(song);
  if (!path || !(await indexedLocalPathExists(path))) {
    return song;
  }
  return {...song, localPath: path, unplayable: undefined};
}

export async function getFavSongs(): Promise<Song[]> {
  const songs = await readList(FAV_KEY);
  return Promise.all(songs.map(hydrateDownloadedSong));
}

export async function isFav(song: Song): Promise<boolean> {
  const list = await readList(FAV_KEY);
  return list.some(s => songKey(s) === songKey(song));
}

export async function toggleFav(song: Song): Promise<boolean> {
  const list = await readList(FAV_KEY);
  const exists = list.some(s => songKey(s) === songKey(song));
  const next = exists
    ? list.filter(s => songKey(s) !== songKey(song))
    : [song, ...list];
  await AsyncStorage.setItem(FAV_KEY, JSON.stringify(next));
  return !exists;
}

/** 批量合并到"我喜欢"（去重），返回新增数量 */
export async function addFavSongs(songs: Song[]): Promise<number> {
  const list = await readList(FAV_KEY);
  const fresh = songs.filter(s => !list.some(o => songKey(o) === songKey(s)));
  if (fresh.length) {
    await AsyncStorage.setItem(FAV_KEY, JSON.stringify([...fresh, ...list]));
  }
  return fresh.length;
}

// ===== 本地歌单（歌单导入落地为本地歌单） =====

export type LocalPlaylist = {
  id: string;
  name: string;
  coverUrl?: string;
  songs: Song[];
  createdAt: number;
  /** 来源 QQ 歌单 dissid（导入的歌单记录来源，用于同步更新） */
  sourceId?: number | string;
};

const PLAYLISTS_KEY = 'local_playlists';

export async function getLocalPlaylists(): Promise<LocalPlaylist[]> {
  const list = await readLocalPlaylistsRaw();
  return Promise.all(
    list.map(async pl => ({
      ...pl,
      songs: await Promise.all(pl.songs.map(hydrateDownloadedSong)),
    })),
  );
}

async function readLocalPlaylistsRaw(): Promise<LocalPlaylist[]> {
  try {
    const raw = await AsyncStorage.getItem(PLAYLISTS_KEY);
    return raw ? (JSON.parse(raw) as LocalPlaylist[]) : [];
  } catch (e) {
    return [];
  }
}

export async function createLocalPlaylist(
  name: string,
  songs: Song[],
  coverUrl?: string,
  sourceId?: number | string,
): Promise<LocalPlaylist[]> {
  const list = await getLocalPlaylists();
  const pl: LocalPlaylist = {
    id: `pl_${Date.now()}`,
    name: name || '未命名歌单',
    coverUrl,
    songs,
    createdAt: Date.now(),
    sourceId,
  };
  const next = [pl, ...list];
  await AsyncStorage.setItem(PLAYLISTS_KEY, JSON.stringify(next));
  return next;
}

/** 用来源歌单最新内容整体替换本地歌单（同步更新），返回替换后的歌单 */
export async function replaceLocalPlaylistSongs(
  id: string,
  songs: Song[],
  coverUrl?: string,
): Promise<LocalPlaylist | undefined> {
  const list = await getLocalPlaylists();
  const pl = list.find(p => p.id === id);
  if (!pl) {
    return undefined;
  }
  pl.songs = songs;
  if (coverUrl) {
    pl.coverUrl = coverUrl;
  }
  await AsyncStorage.setItem(PLAYLISTS_KEY, JSON.stringify(list));
  return pl;
}

export async function removeLocalPlaylist(id: string): Promise<LocalPlaylist[]> {
  const next = (await getLocalPlaylists()).filter(p => p.id !== id);
  await AsyncStorage.setItem(PLAYLISTS_KEY, JSON.stringify(next));
  return next;
}

/** 重命名本地歌单 */
export async function renameLocalPlaylist(
  id: string,
  name: string,
): Promise<LocalPlaylist[]> {
  const list = await getLocalPlaylists();
  const pl = list.find(p => p.id === id);
  if (pl && name.trim()) {
    pl.name = name.trim();
    await AsyncStorage.setItem(PLAYLISTS_KEY, JSON.stringify(list));
  }
  return list;
}

export async function getLocalPlaylist(id: string): Promise<LocalPlaylist | undefined> {
  return (await getLocalPlaylists()).find(p => p.id === id);
}

/** 添加歌曲到本地歌单（按 songKey 去重），返回新增数量 */
export async function addSongsToPlaylist(id: string, songs: Song[]): Promise<number> {
  const list = await getLocalPlaylists();
  const pl = list.find(p => p.id === id);
  if (!pl) {
    return 0;
  }
  const fresh = songs.filter(s => !pl.songs.some(o => songKey(o) === songKey(s)));
  if (fresh.length) {
    pl.songs = [...pl.songs, ...fresh];
    await AsyncStorage.setItem(PLAYLISTS_KEY, JSON.stringify(list));
  }
  return fresh.length;
}

/** 将歌单（含"我喜欢"）中指定歌曲标记为不可播放（VIP/下架），列表灰显 */
export async function markSongsUnplayable(plId: string, keys: string[]) {
  if (!keys.length) {
    return;
  }
  const keySet = new Set(keys);
  if (plId === '__fav__') {
    const list = await readList(FAV_KEY);
    let changed = false;
    for (const s of list) {
      if (keySet.has(songKey(s)) && !s.unplayable) {
        s.unplayable = true;
        changed = true;
      }
    }
    if (changed) {
      await AsyncStorage.setItem(FAV_KEY, JSON.stringify(list));
    }
    return;
  }
  const list = await getLocalPlaylists();
  const pl = list.find(p => p.id === plId);
  if (!pl) {
    return;
  }
  let changed = false;
  for (const s of pl.songs) {
    if (keySet.has(songKey(s)) && !s.unplayable) {
      s.unplayable = true;
      changed = true;
    }
  }
  if (changed) {
    await AsyncStorage.setItem(PLAYLISTS_KEY, JSON.stringify(list));
  }
}

/**
 * 重新检测后整体刷新"我喜欢"里每首歌的可播放状态：
 * playableKeys 为能正常解析出直链（或本地文件）的歌曲 songKey 集合，
 * 不在其中的在线歌曲标记为不可播放（灰显），在其中的清除标记（恢复可播）。
 * 本地歌曲恒可播放，不受在线解析结果影响。返回更新后的列表。
 */
export async function refreshFavPlayable(
  playableKeys: string[],
): Promise<Song[]> {
  const list = await readList(FAV_KEY);
  const playable = new Set(playableKeys);
  let changed = false;
  const next = list.map(s => {
    const shouldUnplayable = s.localPath ? false : !playable.has(songKey(s));
    if (!!s.unplayable !== shouldUnplayable) {
      changed = true;
      return {...s, unplayable: shouldUnplayable || undefined};
    }
    return s;
  });
  if (changed) {
    await AsyncStorage.setItem(FAV_KEY, JSON.stringify(next));
  }
  return next;
}

/** 从本地歌单移除歌曲，返回更新后的歌单 */
export async function removeSongFromPlaylist(
  id: string,
  song: Song,
): Promise<LocalPlaylist | undefined> {
  const list = await getLocalPlaylists();
  const pl = list.find(p => p.id === id);
  if (!pl) {
    return undefined;
  }
  pl.songs = pl.songs.filter(s => songKey(s) !== songKey(song));
  await AsyncStorage.setItem(PLAYLISTS_KEY, JSON.stringify(list));
  return pl;
}

// ===== 收藏的在线歌单（只存摘要，进入时按 dissid 在线加载歌曲） =====

export type FavPlaylist = {
  /** QQ 歌单 dissid */
  id: number | string;
  name: string;
  coverUrl?: string;
  songCount?: number;
  createdAt: number;
};

const FAV_PLS_KEY = 'fav_playlists';

// 收藏变更通知：收藏发生在歌单页/搜索页，「我的」页需实时感知
const favPlListeners = new Set<() => void>();

/** 订阅收藏歌单变更，返回取消订阅函数 */
export function subscribeFavPlaylists(l: () => void) {
  favPlListeners.add(l);
  return () => {
    favPlListeners.delete(l);
  };
}

export async function getFavPlaylists(): Promise<FavPlaylist[]> {
  try {
    const raw = await AsyncStorage.getItem(FAV_PLS_KEY);
    return raw ? (JSON.parse(raw) as FavPlaylist[]) : [];
  } catch (e) {
    return [];
  }
}

export async function isFavPlaylist(id: number | string): Promise<boolean> {
  return (await getFavPlaylists()).some(p => String(p.id) === String(id));
}

/** 收藏 / 取消收藏在线歌单，返回操作后是否为已收藏 */
export async function toggleFavPlaylist(
  pl: Omit<FavPlaylist, 'createdAt'>,
): Promise<boolean> {
  const list = await getFavPlaylists();
  const exists = list.some(p => String(p.id) === String(pl.id));
  const next = exists
    ? list.filter(p => String(p.id) !== String(pl.id))
    : [{...pl, createdAt: Date.now()}, ...list];
  await AsyncStorage.setItem(FAV_PLS_KEY, JSON.stringify(next));
  favPlListeners.forEach(l => l());
  return !exists;
}

/** 同步收藏歌单摘要（名称/封面/歌曲数跟随原歌单最新内容） */
export async function updateFavPlaylistMeta(
  id: number | string,
  patch: Partial<Omit<FavPlaylist, 'id' | 'createdAt'>>,
) {
  const list = await getFavPlaylists();
  const pl = list.find(p => String(p.id) === String(id));
  if (!pl) {
    return;
  }
  Object.assign(pl, patch);
  await AsyncStorage.setItem(FAV_PLS_KEY, JSON.stringify(list));
  favPlListeners.forEach(l => l());
}

/** Hook：收藏歌单 id 集合（收藏/取消实时刷新），用于列表行收藏态展示 */
export function useFavPlaylistIds(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const load = () => {
      getFavPlaylists().then(list =>
        setIds(new Set(list.map(p => String(p.id)))),
      );
    };
    load();
    return subscribeFavPlaylists(load);
  }, []);
  return ids;
}

