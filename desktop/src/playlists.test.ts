// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {isPlaylistState, MAX_PLAYLIST_TRACKS, usePlaylists, type PlaylistController, type LocalPlaylist} from './playlists';
import type {Track} from './types';

const first: Track = {key: 'online:first', mid: 'first', songId: 11, title: 'First', artist: 'Artist', source: 'online'};
const second: Track = {key: 'online:second', mid: 'second', songId: 22, title: 'Second', artist: 'Artist', source: 'online'};
let root: Root;
let container: HTMLDivElement;
let library: PlaylistController;

async function mount() {
  root = createRoot(container);
  function Probe() {library = usePlaylists(); return null;}
  await act(async () => root.render(createElement(Probe)));
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('personal playlist storage', () => {
  it('creates, renames, deduplicates, removes and persists playlists without losing batched updates', async () => {
    await mount();
    let target!: LocalPlaylist;
    let other!: LocalPlaylist;
    await act(async () => {
      target = library.createPlaylist('  夜间歌单  ', [first, {...first, key: 'online:id:11'}]);
      other = library.createPlaylist('另外一张');
    });
    expect(library.playlists).toHaveLength(2);
    expect(target.name).toBe('夜间歌单');
    expect(target.tracks).toHaveLength(1);
    await act(async () => {
      expect(library.addTracks(target.id, [first, second, second])).toEqual({added: 1, duplicates: 2, limitReached: false});
      library.renamePlaylist(target.id, '  散步时听  ');
      library.removeTracks(target.id, [first.key]);
    });
    expect(library.playlists.find(item => item.id === target.id)).toMatchObject({name: '散步时听', tracks: [second]});
    expect(isPlaylistState(JSON.parse(localStorage.getItem('xmusic:playlistLibrary')!))).toBe(true);
    await act(async () => root.unmount());
    await mount();
    expect(library.playlists.find(item => item.id === target.id)?.tracks).toEqual([second]);
    await act(async () => library.deletePlaylist(other.id));
    expect(library.playlists.map(item => item.id)).toEqual([target.id]);
  });

  it('keeps favorites as metadata, updates their summary and cancels them independently of local playlists', async () => {
    await mount();
    const info = {id: '12345', title: '网络歌单', songCount: 20, coverUrl: 'https://example.com/cover.jpg', tracks: [first]};
    await act(async () => {library.createPlaylist('我的歌单', [first]); library.toggleFavoritePlaylist(info);});
    expect(library.favoritePlaylistIds.has('12345')).toBe(true);
    expect(library.favoritePlaylists[0]).not.toHaveProperty('tracks');
    const savedAt = library.favoritePlaylists[0].savedAt;
    await act(async () => library.updateFavoritePlaylist({...info, title: '新的标题', songCount: 21}));
    expect(library.favoritePlaylists[0]).toMatchObject({title: '新的标题', songCount: 21, savedAt});
    await act(async () => root.unmount());
    await mount();
    expect(library.favoritePlaylistIds.has('12345')).toBe(true);
    await act(async () => library.toggleFavoritePlaylist(info));
    expect(library.favoritePlaylists).toEqual([]);
    expect(library.playlists[0].tracks).toEqual([first]);
  });

  it('rejects malformed storage and validates names and removed targets without creating unusable records', async () => {
    localStorage.setItem('xmusic:playlistLibrary', JSON.stringify({version: 1, playlists: [{id: 'bad', name: 'Bad', tracks: 'wrong', createdAt: 0, updatedAt: 0}], favoritePlaylists: []}));
    await mount();
    expect(library.playlists).toEqual([]);
    expect(() => library.createPlaylist('   ')).toThrow('请输入歌单名称');
    expect(() => library.createPlaylist('x'.repeat(81))).toThrow('最多 80');
    expect(() => library.addTracks('deleted', [first])).toThrow('已被删除');
    expect(isPlaylistState({version: 1, playlists: [], favoritePlaylists: [{id: '1', title: '坏数据', savedAt: -1}]})).toBe(false);
    expect(library.playlists).toEqual([]);
  });

  it('caps song count and reports duplicates separately from songs that exceed capacity', async () => {
    await mount();
    const initial = Array.from({length: MAX_PLAYLIST_TRACKS - 1}, (_, index) => ({...first, key: `song:${index}`, mid: `mid${index}`, songId: 100 + index}));
    let target!: LocalPlaylist;
    await act(async () => {target = library.createPlaylist('长歌单', initial);});
    await act(async () => {
      expect(library.addTracks(target.id, [initial[0], first, second])).toEqual({added: 1, duplicates: 1, limitReached: true});
    });
    expect(library.playlists[0].tracks).toHaveLength(MAX_PLAYLIST_TRACKS);
    expect(library.playlists[0].tracks.at(-1)?.key).toBe(first.key);
  });

  it('enforces capacity for direct creation and repeated additions, including duplicates in a full playlist', async () => {
    await mount();
    const tracks = Array.from({length: MAX_PLAYLIST_TRACKS + 2}, (_, index) => ({...first, key: `large:${index}`, mid: `large${index}`, songId: index + 1000}));
    let target!: LocalPlaylist;
    await act(async () => {target = library.createPlaylist('直接创建', [tracks[0], ...tracks]);});
    expect(target.tracks).toHaveLength(MAX_PLAYLIST_TRACKS);
    await act(async () => {
      expect(library.addTracks(target.id, [tracks[0]])).toEqual({added: 0, duplicates: 1, limitReached: false});
      expect(library.addTracks(target.id, [tracks[1000], tracks[1001]])).toEqual({added: 0, duplicates: 0, limitReached: true});
      library.removeTracks(target.id, [tracks[0].key]);
      expect(library.addTracks(target.id, [tracks[1000], tracks[1001]])).toEqual({added: 1, duplicates: 0, limitReached: true});
    });
    expect(library.playlists[0].tracks).toHaveLength(MAX_PLAYLIST_TRACKS);
    expect(library.playlists[0].tracks.at(-1)?.mid).toBe('large1000');
    expect(isPlaylistState(JSON.parse(localStorage.getItem('xmusic:playlistLibrary')!))).toBe(true);
  });
});
