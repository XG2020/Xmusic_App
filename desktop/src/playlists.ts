import {useCallback, useMemo, useRef} from 'react';
import {isTracks, useStoredState} from './state';
import type {PlaylistInfo} from './services/discovery';
import type {Track} from './types';

export const MAX_PLAYLIST_TRACKS = 1000;
const MAX_PLAYLISTS = 500;

export interface LocalPlaylist {
  id: string;
  name: string;
  tracks: Track[];
  createdAt: number;
  updatedAt: number;
}

export interface SavedPlaylist extends PlaylistInfo { savedAt: number }
export interface PlaylistAddResult { added: number; duplicates: number; limitReached: boolean }
export interface PlaylistState {
  version: 1;
  playlists: LocalPlaylist[];
  favoritePlaylists: SavedPlaylist[];
}

export interface PlaylistController {
  playlists: LocalPlaylist[];
  favoritePlaylists: SavedPlaylist[];
  favoritePlaylistIds: Set<string>;
  createPlaylist(name: string, tracks?: Track[]): LocalPlaylist;
  renamePlaylist(id: string, name: string): void;
  deletePlaylist(id: string): void;
  addTracks(id: string, tracks: Track[]): PlaylistAddResult;
  removeTracks(id: string, keys: string[]): void;
  toggleFavoritePlaylist(playlist: PlaylistInfo): void;
  updateFavoritePlaylist(playlist: PlaylistInfo): void;
}

const EMPTY_STATE: PlaylistState = {version: 1, playlists: [], favoritePlaylists: []};
const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPlaylistInfo(value: unknown): value is PlaylistInfo {
  if (!record(value) || !text(value.id, 100) || !text(value.title, 500)) return false;
  if (!['coverUrl', 'creatorName', 'introduction'].every(key => value[key] === undefined || (typeof value[key] === 'string' && value[key].length <= 20000))) return false;
  return ['songCount', 'listenNum'].every(key => value[key] === undefined || finiteTime(value[key]));
}

/** Validate persisted records before rendering or handing their tracks to playback. */
export function isPlaylistState(value: unknown): value is PlaylistState {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.playlists) || !Array.isArray(value.favoritePlaylists)) return false;
  if (value.playlists.length > MAX_PLAYLISTS || value.favoritePlaylists.length > MAX_PLAYLISTS) return false;
  if (!value.playlists.every(item => record(item) && text(item.id, 100) && text(item.name, 80)
    && finiteTime(item.createdAt) && finiteTime(item.updatedAt) && isTracks(item.tracks) && item.tracks.length <= MAX_PLAYLIST_TRACKS)) return false;
  if (!value.favoritePlaylists.every(item => isPlaylistInfo(item) && finiteTime((item as SavedPlaylist).savedAt))) return false;
  return new Set(value.playlists.map(item => item.id)).size === value.playlists.length
    && new Set(value.favoritePlaylists.map(item => item.id)).size === value.favoritePlaylists.length;
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('请输入歌单名称。');
  if (trimmed.length > 80) throw new Error('歌单名称最多 80 个字。');
  return trimmed;
}

/** Match stable keys and provider IDs, including the same song opened from search and a chart. */
function uniqueTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter(track => {
    const ids = [`key:${track.key}`];
    if (track.source === 'online') {
      if (track.mid) ids.push(`mid:${track.mid}`);
      if (track.songId) ids.push(`id:${track.songId}`);
    } else if (track.localId) ids.push(`local:${track.localId}`);
    const duplicate = ids.some(id => seen.has(id));
    ids.forEach(id => seen.add(id));
    return !duplicate;
  });
}

function checkedTracks(tracks: Track[]): Track[] {
  if (!isTracks(tracks)) throw new Error('歌曲信息不完整，请重新添加。');
  // Store stable metadata only; expiring stream URLs and arbitrary API fields do not belong in a playlist.
  return tracks.map(({key, title, artist, album, duration, coverUrl, mid, songId, localId, source}) =>
    ({key, title, artist, album, duration, coverUrl, mid, songId, localId, source}));
}

function playlistMetadata(playlist: PlaylistInfo): PlaylistInfo {
  if (!isPlaylistInfo(playlist)) throw new Error('歌单信息不完整，请重新打开歌单。');
  const {id, title, coverUrl, songCount, listenNum, creatorName, introduction} = playlist;
  return {id: id.trim(), title: title.trim(), coverUrl, songCount, listenNum, creatorName, introduction};
}

export function usePlaylists(): PlaylistController {
  const [state, setState] = useStoredState<PlaylistState>('playlistLibrary', EMPTY_STATE, isPlaylistState);
  const latest = useRef(state);
  latest.current = state;
  const update = useCallback((change: (previous: PlaylistState) => PlaylistState) => {
    const next = change(latest.current);
    latest.current = next;
    setState(next);
  }, [setState]);

  const createPlaylist = useCallback((name: string, tracks: Track[] = []) => {
    const now = Date.now();
    const playlist: LocalPlaylist = {
      id: `playlist:${globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`}`,
      name: cleanName(name),
      tracks: uniqueTracks(checkedTracks(tracks)).slice(0, MAX_PLAYLIST_TRACKS),
      createdAt: now,
      updatedAt: now,
    };
    update(previous => {
      if (previous.playlists.length >= MAX_PLAYLISTS) throw new Error(`最多可创建 ${MAX_PLAYLISTS} 个歌单。`);
      return {...previous, playlists: [playlist, ...previous.playlists]};
    });
    return playlist;
  }, [update]);

  const renamePlaylist = useCallback((id: string, name: string) => {
    const nextName = cleanName(name);
    update(previous => ({...previous, playlists: previous.playlists.map(playlist => playlist.id === id ? {...playlist, name: nextName, updatedAt: Date.now()} : playlist)}));
  }, [update]);

  const deletePlaylist = useCallback((id: string) => {
    update(previous => ({...previous, playlists: previous.playlists.filter(playlist => playlist.id !== id)}));
  }, [update]);

  const addTracks = useCallback((id: string, tracks: Track[]): PlaylistAddResult => {
    const incoming = checkedTracks(tracks);
    let result: PlaylistAddResult = {added: 0, duplicates: 0, limitReached: false};
    update(previous => {
      const target = previous.playlists.find(playlist => playlist.id === id);
      if (!target) throw new Error('这个歌单已被删除，请选择其他歌单。');
      const merged = uniqueTracks([...target.tracks, ...incoming]);
      const added = Math.max(0, Math.min(MAX_PLAYLIST_TRACKS, merged.length) - target.tracks.length);
      result = {added, duplicates: target.tracks.length + incoming.length - merged.length, limitReached: merged.length > MAX_PLAYLIST_TRACKS};
      if (!added) return previous;
      return {...previous, playlists: previous.playlists.map(playlist => playlist.id === id ? {...playlist, tracks: merged.slice(0, MAX_PLAYLIST_TRACKS), updatedAt: Date.now()} : playlist)};
    });
    return result;
  }, [update]);

  const removeTracks = useCallback((id: string, keys: string[]) => {
    const removed = new Set(keys);
    update(previous => ({...previous, playlists: previous.playlists.map(playlist => playlist.id === id ? {...playlist, tracks: playlist.tracks.filter(track => !removed.has(track.key)), updatedAt: Date.now()} : playlist)}));
  }, [update]);

  const toggleFavoritePlaylist = useCallback((playlist: PlaylistInfo) => {
    const metadata = playlistMetadata(playlist);
    update(previous => {
      if (previous.favoritePlaylists.some(item => item.id === metadata.id)) {
        return {...previous, favoritePlaylists: previous.favoritePlaylists.filter(item => item.id !== metadata.id)};
      }
      if (previous.favoritePlaylists.length >= MAX_PLAYLISTS) throw new Error(`最多可收藏 ${MAX_PLAYLISTS} 个歌单。`);
      return {...previous, favoritePlaylists: [{...metadata, savedAt: Date.now()}, ...previous.favoritePlaylists]};
    });
  }, [update]);

  const updateFavoritePlaylist = useCallback((playlist: PlaylistInfo) => {
    const metadata = playlistMetadata(playlist);
    update(previous => ({...previous, favoritePlaylists: previous.favoritePlaylists.map(item => item.id === metadata.id ? {...item, ...metadata, savedAt: item.savedAt} : item)}));
  }, [update]);

  const favoritePlaylistIds = useMemo(() => new Set(state.favoritePlaylists.map(playlist => playlist.id)), [state.favoritePlaylists]);
  return {playlists: state.playlists, favoritePlaylists: state.favoritePlaylists, favoritePlaylistIds,
    createPlaylist, renamePlaylist, deletePlaylist, addTracks, removeTracks, toggleFavoritePlaylist, updateFavoritePlaylist};
}
