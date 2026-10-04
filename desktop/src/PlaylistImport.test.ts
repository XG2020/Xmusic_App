// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import PlaylistLibrary, {ImportPlaylistDialog} from './PlaylistLibrary';
import {MAX_PLAYLIST_TRACKS, usePlaylists, type PlaylistController} from './playlists';
import type {DesktopBridge, Track} from './types';

let root: Root;
let container: HTMLDivElement;
let trigger: HTMLButtonElement;
let library: PlaylistController;
let visible: boolean;
let initialPlaylistId: string | undefined;
const onAdded = vi.fn();
const requestApi = vi.fn<DesktopBridge['requestApi']>();
const resolvePlaylistId = vi.fn<DesktopBridge['resolvePlaylistId']>();
const rawSong = (index: number) => ({mid: `song${index}`, title: `歌曲 ${index}`, singer: [{name: '歌手'}]});
const track = (index: number): Track => ({key: `online:song${index}`, mid: `song${index}`, title: `歌曲 ${index}`, artist: '歌手', source: 'online'});

function Probe() {
  library = usePlaylists();
  return visible ? createElement(ImportPlaylistDialog, {library, initialPlaylistId, baseUrl: 'https://music.example', onAdded,
    onClose: () => {visible = false; root.render(createElement(Probe));}}) : null;
}
async function render() {await act(async () => root.render(createElement(Probe)));}
async function submit() {await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));}
async function fill(value: string) {
  await act(async () => {
    const input = document.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
async function button(text: string) {
  await act(async () => [...document.querySelectorAll('button')].find(item => item.textContent === text)!.click());
}

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.desktop = {requestApi, resolvePlaylistId} as unknown as DesktopBridge;
  visible = false;
  initialPlaylistId = undefined;
  container = document.createElement('div');
  trigger = document.createElement('button');
  trigger.textContent = '打开导入';
  document.body.append(trigger, container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  trigger.remove();
  delete window.desktop;
  vi.unstubAllGlobals();
});

it('previews a shared QQ playlist then creates a persistent local playlist capped at 1000 tracks', async () => {
  resolvePlaylistId.mockResolvedValue('12345');
  requestApi.mockResolvedValue({data: {name: '周末散步', total: 1200, songs: Array.from({length: 1002}, (_, index) => rawSong(index))}});
  visible = true;
  await render();
  expect(document.activeElement?.tagName).toBe('TEXTAREA');
  await fill('分享歌单 https://c6.y.qq.com/base/fcgi-bin/u?__=short');
  await submit();
  expect(requestApi).toHaveBeenCalledWith({path: '/api/playlist', params: {id: '12345', num: 2000}, baseUrl: 'https://music.example'});
  expect(document.querySelector('.playlist-import-preview')?.textContent).toContain('周末散步');
  expect(document.querySelector('.playlist-import-count-note')?.textContent).toContain('源歌单约 1200 首，本次获取 1002 首');
  expect(document.querySelector<HTMLInputElement>('.playlist-name-input')?.value).toBe('周末散步');
  expect(library.playlists).toHaveLength(0);
  await submit();
  expect(library.playlists).toHaveLength(1);
  expect(library.playlists[0].tracks).toHaveLength(MAX_PLAYLIST_TRACKS);
  expect(document.querySelector('.playlist-add-success')?.textContent).toContain('另有 2 首未添加');
  expect(onAdded).toHaveBeenCalledWith(expect.stringContaining('已添加 1000 首'), library.playlists[0].id);
  expect(JSON.parse(localStorage.getItem('xmusic:playlistLibrary')!).playlists[0].tracks).toHaveLength(MAX_PLAYLIST_TRACKS);
  await submit();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('merges into the selected existing playlist with accurate duplicate and capacity feedback', async () => {
  await render();
  await act(async () => {initialPlaylistId = library.createPlaylist('快满了', Array.from({length: 999}, (_, index) => track(index))).id;});
  visible = true;
  await render();
  requestApi.mockResolvedValue({data: {name: '导入来源', songs: [rawSong(0), rawSong(999), rawSong(1000)]}});
  await fill('12345');
  await submit();
  expect(resolvePlaylistId).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe(initialPlaylistId);
  await submit();
  expect(library.playlists).toHaveLength(1);
  expect(library.playlists[0].tracks).toHaveLength(1000);
  expect(library.playlists[0].tracks.at(-1)?.mid).toBe('song999');
  expect(document.querySelector('.playlist-add-success')?.textContent).toContain('已添加 1 首');
  expect(document.querySelector('.playlist-add-success')?.textContent).toContain('跳过 1 首重复歌曲');
  expect(document.querySelector('.playlist-add-success')?.textContent).toContain('另有 1 首未添加');
});

it('keeps failed or empty imports editable and never creates an empty destination', async () => {
  visible = true;
  await render();
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('请粘贴');
  requestApi.mockRejectedValueOnce(new Error('源歌单暂时无法访问'));
  await fill('12345');
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('源歌单暂时无法访问');
  requestApi.mockResolvedValueOnce({data: {name: '空歌单', songs: []}});
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('歌单为空');
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
  expect(library.playlists).toHaveLength(0);
});

it('cancels a pending share resolution and ignores its late result without fetching or importing', async () => {
  let finish!: (id: string) => void;
  resolvePlaylistId.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  trigger.focus();
  visible = true;
  await render();
  await fill('https://c6.y.qq.com/base/fcgi-bin/u?__=short');
  await submit();
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  await button('取消');
  expect(document.activeElement).toBe(trigger);
  await act(async () => finish('12345'));
  expect(requestApi).not.toHaveBeenCalled();
  expect(library.playlists).toHaveLength(0);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('opens import from the library and preselects the current playlist from its detail page', async () => {
  function LibraryProbe() {
    library = usePlaylists();
    return createElement(PlaylistLibrary, {library, onPlay: vi.fn(), onQueue: vi.fn(), onFavorite: vi.fn(),
      onAddToPlaylist: vi.fn(), onOpenOnlinePlaylist: vi.fn(), favoriteKeys: new Set<string>()});
  }
  await act(async () => root.render(createElement(LibraryProbe)));
  await button('导入 QQ 歌单');
  expect(document.querySelector('textarea')).not.toBeNull();
  await button('取消');
  await act(async () => library.createPlaylist('我的目标'));
  await act(async () => container.querySelector<HTMLButtonElement>('.playlist-card-open')!.click());
  await button('导入歌曲');
  requestApi.mockResolvedValueOnce({data: {name: '来源', songs: [rawSong(0)]}});
  await fill('12345');
  await submit();
  expect(document.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe(library.playlists[0].id);
});
