import {useEffect, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Song} from '../types/music';

const RECENT_KEY = 'recent_songs';
const FAV_KEY = 'fav_songs';
const MAX_RECENT = 100;

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

export async function addRecentSongs(songs: Song[]) {
  const old = await readList(RECENT_KEY);
  const merged = [...songs, ...old.filter(o => !songs.some(s => songKey(s) === songKey(o)))];
  await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(merged.slice(0, MAX_RECENT)));
  notifyRecent();
}

/** 清空最近播放记录 */
export async function clearRecentSongs() {
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

export async function getFavSongs(): Promise<Song[]> {
  return readList(FAV_KEY);
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
};

const PLAYLISTS_KEY = 'local_playlists';

export async function getLocalPlaylists(): Promise<LocalPlaylist[]> {
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
): Promise<LocalPlaylist[]> {
  const list = await getLocalPlaylists();
  const pl: LocalPlaylist = {
    id: `pl_${Date.now()}`,
    name: name || '未命名歌单',
    coverUrl,
    songs,
    createdAt: Date.now(),
  };
  const next = [pl, ...list];
  await AsyncStorage.setItem(PLAYLISTS_KEY, JSON.stringify(next));
  return next;
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

