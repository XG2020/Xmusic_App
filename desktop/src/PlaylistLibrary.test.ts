// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import PlaylistLibrary, {AddToPlaylistDialog} from './PlaylistLibrary';
import {usePlaylists, type PlaylistController} from './playlists';
import type {Track} from './types';

const first: Track = {key: 'first', mid: 'first', title: 'First', artist: 'Artist', source: 'online'};
const second: Track = {...first, key: 'second', mid: 'second', title: 'Second'};
let root: Root;
let container: HTMLDivElement;
let trigger: HTMLButtonElement;
let library: PlaylistController;
let visible = false;
const added = vi.fn();
const closed = vi.fn();

function Probe() {
  library = usePlaylists();
  return visible ? createElement(AddToPlaylistDialog, {library, tracks: [first, second], onAdded: added, onClose: () => {
    visible = false;
    closed();
    root.render(createElement(Probe));
  }}) : null;
}

async function render() {await act(async () => root.render(createElement(Probe)));}
async function submit() {await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));}

it('searches created and favorite playlists and exposes song search inside a created playlist', async () => {
  await render();
  await act(async () => {
    const playlist = library.createPlaylist('夜行');
    library.addTracks(playlist.id, [first, second]);
    library.createPlaylist('晨曲');
    library.toggleFavoritePlaylist({id: '101', title: '清晨精选', creatorName: '音乐人'});
  });
  const onPlay = vi.fn(), onOpenOnlinePlaylist = vi.fn();
  await act(async () => root.render(createElement(PlaylistLibrary, {library, onPlay, onOpenOnlinePlaylist,
    onQueue: vi.fn(), onFavorite: vi.fn(), onAddToPlaylist: vi.fn(), favoriteKeys: new Set<string>()})));
  const filter = async (name: string, value: string) => {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', {bubbles: true}));
    });
  };
  await filter('搜索我的歌单', '夜行');
  expect(container.querySelectorAll('.playlist-card-open')).toHaveLength(1);
  expect(container.querySelector('.playlist-card-open')?.textContent).toContain('夜行');
  await act(async () => container.querySelector<HTMLButtonElement>('.discovery-tabs button:nth-child(2)')!.click());
  await filter('搜索我的歌单', '音乐人');
  expect(container.querySelectorAll('.playlist-card-open')).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>('.playlist-card-open')!.click());
  expect(onOpenOnlinePlaylist).toHaveBeenCalledWith(expect.objectContaining({id: '101'}));
  await act(async () => container.querySelector<HTMLButtonElement>('.discovery-tabs button')!.click());
  await filter('搜索我的歌单', '夜行');
  await act(async () => container.querySelector<HTMLButtonElement>('.playlist-card-open')!.click());
  await filter('搜索歌单歌曲', 'second');
  expect([...container.querySelectorAll('.discovery-track-title')].map(item => item.textContent)).toEqual(['Second']);
  await act(async () => container.querySelector<HTMLButtonElement>('.discovery-track-title')!.click());
  expect(onPlay).toHaveBeenLastCalledWith([second], 0);
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  visible = false;
  container = document.createElement('div');
  trigger = document.createElement('button');
  trigger.textContent = '添加到歌单';
  document.body.append(trigger, container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  trigger.remove();
  vi.unstubAllGlobals();
});

it('shows actual added and duplicate counts and restores focus after finishing', async () => {
  await render();
  await act(async () => {library.createPlaylist('散步', [first]);});
  trigger.focus();
  visible = true;
  await render();
  expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
  await submit();
  expect(library.playlists[0].tracks).toHaveLength(2);
  expect(document.querySelector('[role="status"]')?.textContent).toContain('已添加 1 首');
  expect(document.querySelector('[role="status"]')?.textContent).toContain('跳过 1 首重复歌曲');
  expect(added).toHaveBeenCalledWith(expect.stringContaining('散步'), library.playlists[0].id);
  await submit();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('validates and creates a new playlist, and closes on Escape or its backdrop', async () => {
  await render();
  trigger.focus();
  visible = true;
  await render();
  expect(document.activeElement).toBe(document.querySelector('.playlist-name-input'));
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('请输入歌单名称');
  expect(library.playlists).toHaveLength(0);
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('.playlist-name-input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '旅途');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await submit();
  expect(library.playlists[0]).toMatchObject({name: '旅途', tracks: [first, second]});
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  visible = true;
  await render();
  await act(async () => document.querySelector('.playlist-dialog-backdrop')!.dispatchEvent(new Event('pointerdown', {bubbles: true})));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(closed).toHaveBeenCalledTimes(2);
});
