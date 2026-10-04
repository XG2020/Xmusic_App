// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import App from './App';
import {fetchLyrics, normalizeTrack, resolveTrackById, resolveTrackUrl, searchSongsPage} from './services/musicApi';
import type {DesktopBridge, DesktopPreferences, Track} from './types';
import type {PlaylistState} from './playlists';

// Exercise the real page, player, playlist and preference hooks. Only external
// music requests, Electron IPC and the browser audio host are substituted.
vi.mock('./services/musicApi', () => ({
  fetchLyrics: vi.fn(), searchSongsPage: vi.fn(), resolveTrackById: vi.fn(),
  resolveTrackUrl: vi.fn(), fetchSongDetails: vi.fn(), normalizeTrack: vi.fn(),
}));

const first: Track = {key: 'online:first', mid: 'first', title: '晚风', artist: '歌手甲', source: 'online'};
const second: Track = {...first, key: 'online:second', mid: 'second', title: '归途', artist: '歌手乙'};
const third: Track = {...first, key: 'online:third', mid: 'third', title: '星河', artist: '歌手丙'};

class FakeAudio {
  static latest: FakeAudio;
  src = '';
  currentTime = 0;
  duration = NaN;
  paused = true;
  ended = false;
  error = null;
  onplay: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  onpause: (() => void) | null = null;
  constructor() {FakeAudio.latest = this;}
  play = vi.fn(async () => {
    this.paused = false; this.ended = false;
    this.onplay?.(); this.onplaying?.();
  });
  pause = vi.fn(() => {
    const wasPaused = this.paused;
    this.paused = true;
    if (!wasPaused) this.onpause?.();
  });
  load() {this.currentTime = 0; this.duration = NaN; this.ended = false;}
  getAttribute(name: string) {return name === 'src' ? this.src || null : null;}
  removeAttribute(name: string) {if (name === 'src') this.src = '';}
}

let root: Root;
let container: HTMLDivElement;
let preferences: DesktopPreferences;
let preferenceListener: ((value: DesktopPreferences) => void) | undefined;
const setPreferences = vi.fn<DesktopBridge['setPreferences']>();
const requestApi = vi.fn<DesktopBridge['requestApi']>();

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(element =>
    element.getAttribute('aria-label') === label || element.textContent?.trim() === label);
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}
async function click(label: string, scope: ParentNode = document) {await act(async () => button(label, scope).click());}
async function navigate(label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('.sidebar .nav-item')]
    .find(element => element.textContent?.trim().startsWith(label));
  if (!result) throw new Error(`Navigation not found: ${label}`);
  await act(async () => result.click());
}
async function render() {await act(async () => root.render(createElement(App)));}
async function search() {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="搜索在线音乐"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '夜晚');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await act(async () => container.querySelector('.global-search')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(searchSongsPage).toHaveBeenLastCalledWith('夜晚', '', 1);
  expect(container.querySelector('[role="table"][aria-label="探索音乐"]')).not.toBeNull();
}
async function selectTrack(track: Track) {
  await act(async () => container.querySelector<HTMLInputElement>(`input[aria-label="选择 ${track.title}"]`)!.click());
}
function focusBody() {document.body.tabIndex = -1; document.body.focus();}
async function key(options: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', {...options, bubbles: true, cancelable: true});
  await act(async () => document.activeElement!.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  preferences = {closeAction: 'ask', shortcutsEnabled: true};
  preferenceListener = undefined;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {callback(0); return 1;});
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.mocked(fetchLyrics).mockResolvedValue('');
  vi.mocked(searchSongsPage).mockResolvedValue({tracks: [first, second, third], hasMore: false});
  vi.mocked(resolveTrackById).mockImplementation(async track => track);
  vi.mocked(resolveTrackUrl).mockImplementation(async track => `https://audio.example/${track.mid}.mp3`);
  setPreferences.mockImplementation(async patch => {
    preferences = {...preferences, ...patch};
    preferenceListener?.(preferences);
    return preferences;
  });
  requestApi.mockRejectedValue(new Error('Unexpected network request in App regression'));
  window.desktop = {
    getLocalTracks: async () => [], getVersion: async () => '0.3.0', requestApi,
    getDownloads: async () => ({directory: '', tasks: []}), onDownloadsChanged: () => () => {},
    startDownload: vi.fn(),
    getPreferences: async () => preferences, setPreferences,
    onPreferencesChanged(listener: (value: DesktopPreferences) => void) {preferenceListener = listener; return () => {preferenceListener = undefined;};},
    getDesktopLyricsState: async () => ({visible: false, locked: false}),
    onDesktopLyricsState: () => () => {}, onDesktopPlaybackCommand: () => () => {}, updateDesktopLyrics: () => {},
    getClosePrompt: async () => null, onClosePrompt: () => () => {},
  } as unknown as DesktopBridge;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); delete window.desktop;
  document.body.removeAttribute('tabindex');
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-background-image');
  vi.unstubAllGlobals();
});

it('clears all recent history even when filtered without changing favorites, queue or playback', async () => {
  localStorage.setItem('xmusic:recent', JSON.stringify([first, second]));
  localStorage.setItem('xmusic:favorites', JSON.stringify([first]));
  localStorage.setItem('xmusic:queue', JSON.stringify([first]));
  localStorage.setItem('xmusic:current', JSON.stringify(first.key));
  await render(); await navigate('最近播放');
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="筛选当前列表"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, first.title);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await click('清空最近播放');
  expect(JSON.parse(localStorage.getItem('xmusic:recent')!)).toEqual([]);
  expect(JSON.parse(localStorage.getItem('xmusic:favorites')!)).toEqual([first]);
  expect(JSON.parse(localStorage.getItem('xmusic:queue')!)).toEqual([first]);
  expect(button('清空最近播放').disabled).toBe(true);
  expect(FakeAudio.latest.play).not.toHaveBeenCalled();
});

it('imports folders through the native bridge and refreshes a duplicate local track cover immediately', async () => {
  const local: Track = {key: 'local:song', localId: 'song', title: '本地歌曲', artist: '本地歌手', source: 'local'};
  window.desktop!.getLocalTracks = async () => [local];
  const importFolders = vi.fn(async () => ({tracks: [{...local, coverUrl: 'xmusic-audio://cover/song'}], truncated: false, scannedEntries: 2, skippedDirectories: 0}));
  window.desktop!.importAudioFolders = importFolders;
  await render(); await click('导入文件夹');
  expect(importFolders).toHaveBeenCalledOnce();
  expect(container.querySelector('img[src="xmusic-audio://cover/song"]')).not.toBeNull();
  expect(container.querySelectorAll('.discovery-track-row:not(.discovery-track-head)')).toHaveLength(1);
});

it('synchronizes tray favorites, volume and queue commands with the real player state', async () => {
  let command!: Parameters<DesktopBridge['onTrayPlayerCommand']>[0];
  const update = vi.fn();
  window.desktop!.onTrayPlayerCommand = listener => {command = listener; return () => {};};
  window.desktop!.updateTrayPlayer = update;
  localStorage.setItem('xmusic:queue', JSON.stringify([first]));
  localStorage.setItem('xmusic:current', JSON.stringify(first.key));
  await render();
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({title: first.title, favorite: false, hasTrack: true, hasQueue: true}));
  await act(async () => command({action: 'favorite'}));
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({favorite: true}));
  await act(async () => command({action: 'volume', value: .28}));
  expect(FakeAudio.latest).toHaveProperty('volume', .28);
  await act(async () => command({action: 'mute'}));
  expect(FakeAudio.latest).toHaveProperty('volume', 0);
  await act(async () => command({action: 'queue'}));
  expect(container.querySelector('[aria-label="播放队列"]')).not.toBeNull();
});

it('retries the same local cover URL after a folder reimport repairs its cache', async () => {
  const local: Track = {key: 'local:repair', localId: 'repair', title: '封面修复', artist: '本地歌手', source: 'local', coverUrl: 'xmusic-audio://cover/repair'};
  window.desktop!.getLocalTracks = async () => [local];
  window.desktop!.importAudioFolders = async () => ({tracks: [{...local}], truncated: false, scannedEntries: 2, skippedDirectories: 0});
  await render();
  const image = container.querySelector<HTMLImageElement>('.track-section img')!;
  await act(async () => image.dispatchEvent(new Event('error')));
  expect(container.querySelector('.track-section img')).toBeNull();
  await click('导入文件夹');
  expect(container.querySelector('.track-section img')?.getAttribute('src')).toBe(local.coverUrl);
});

it('accepts a native library update without a late startup snapshot erasing the newly registered download', async () => {
  const local: Track = {key: 'local:download', localId: 'download', title: '已下载的音乐', artist: '本地歌手', source: 'local'};
  let finish!: (tracks: Track[]) => void;
  let publish!: (tracks: Track[]) => void;
  window.desktop!.getLocalTracks = () => new Promise(resolve => {finish = resolve;});
  window.desktop!.onLocalTracksChanged = listener => {publish = listener; return () => {};};
  await render();
  await act(async () => publish([local]));
  await act(async () => finish([]));
  expect(container.querySelector('.discovery-track-title')?.textContent).toBe(local.title);
});

it('search results support selecting several songs, queueing them and saving the same selection to a playlist', async () => {
  const saved: PlaylistState = {version: 1, playlists: [{id: 'commute', name: '路上', tracks: [], createdAt: 1, updatedAt: 1}], favoritePlaylists: []};
  localStorage.setItem('xmusic:playlistLibrary', JSON.stringify(saved));
  await render(); await search();
  await click('批量操作'); await selectTrack(first); await selectTrack(second);
  expect(container.querySelector('.discovery-batch-toolbar')?.textContent ?? container.textContent).toContain('已选 2 首');
  await click('加入队列');
  await click('播放队列，2 首');
  const queue = container.querySelector('[aria-label="播放队列"]')!;
  expect([...queue.querySelectorAll('.queue-item strong')].map(element => element.textContent)).toEqual([first.title, second.title]);
  expect(FakeAudio.latest.play).not.toHaveBeenCalled();
  await click('收起面板');
  await click('添加到歌单');
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')!;
  expect(dialog.textContent).toContain('已选择 2 首歌曲');
  expect(dialog.textContent).toContain('路上');
  await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain('已添加 2 首');
  const updated = JSON.parse(localStorage.getItem('xmusic:playlistLibrary')!) as PlaylistState;
  expect(updated.playlists[0].tracks.map(track => track.key)).toEqual([first.key, second.key]);
  expect(requestApi).not.toHaveBeenCalled();
});

it('searches playlists, opens their playable detail, favorites them and returns to cached search results', async () => {
  requestApi.mockImplementation(async request => {
    if (request.path === '/api/search') return {data: {list: [{dissid: '927001', dissname: '<em>夜晚</em>精选', nickname: '收藏家', songnum: 2, listennum: 12500}]}};
    if (request.path === '/api/playlist') return {data: {name: '夜晚精选', songs: [first, second]}};
    throw new Error(`Unexpected request ${request.path}`);
  });
  vi.mocked(normalizeTrack).mockImplementation(value => value as Track);
  await render(); await search();
  await click('歌单');
  expect(requestApi).toHaveBeenCalledWith({path: '/api/search', params: {keyword: '夜晚', type: 'playlist', num: 20, page: 1}, baseUrl: undefined});
  expect(container.textContent).toContain('1 张歌单');
  expect(container.textContent).toContain('收藏家');
  expect(container.textContent).toContain('2 首歌曲');
  expect(container.querySelector('.discovery-playlist-card')?.textContent).toContain('1.3万');
  expect(container.querySelector('.list-tools')?.textContent).not.toContain('播放全部');
  await click('打开歌单 夜晚精选');
  expect(container.querySelector('.discovery-playlist-detail')).not.toBeNull();
  expect(container.querySelector('.discovery-track-title')?.textContent).toBe(first.title);
  await click('收藏歌单');
  const saved = JSON.parse(localStorage.getItem('xmusic:playlistLibrary')!) as PlaylistState;
  expect(saved.favoritePlaylists).toMatchObject([{id: '927001', title: '夜晚精选', creatorName: '收藏家'}]);
  await click(`加入队列 ${first.title}`);
  expect(button('播放队列，1 首')).toBeDefined();
  await click('返回搜索结果');
  expect(container.querySelector('.discovery-playlist-card')?.textContent).toContain('夜晚精选');
  await click('歌曲');
  expect(container.querySelector('.discovery-track-title')?.textContent).toBe(first.title);
  await click('歌单');
  expect(requestApi.mock.calls.filter(([request]) => request.path === '/api/search')).toHaveLength(1);
  expect(searchSongsPage).toHaveBeenCalledTimes(1);
});

it('retries playlist search against the submitted keyword after the input draft changes', async () => {
  requestApi.mockRejectedValueOnce(new Error('搜索服务暂不可用'));
  await render(); await search(); await click('歌单');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('搜索服务暂不可用');
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="搜索在线音乐"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '草稿尚未提交');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  requestApi.mockResolvedValueOnce({data: {list: [{dissid: '927002', dissname: '夜晚恢复'}]}});
  await click('重试');
  expect(requestApi.mock.lastCall?.[0].params).toMatchObject({keyword: '夜晚', type: 'playlist', page: 1});
  expect(container.querySelector('.discovery-playlist-card')?.textContent).toContain('夜晚恢复');
});

it('uses the same ListPlus and ListEnd action icons on favorites and actual search results', async () => {
  localStorage.setItem('xmusic:favorites', JSON.stringify([first, second]));
  await render(); await navigate('我喜欢的音乐');
  expect(container.querySelector('[role="table"][aria-label="我喜欢的音乐"]')).not.toBeNull();
  const favoritePlaylist = button(`添加到歌单 ${first.title}`).querySelector('svg.lucide-list-plus');
  const favoriteQueue = button(`加入队列 ${first.title}`).querySelector('svg.lucide-list-end');
  expect(favoritePlaylist).not.toBeNull(); expect(favoriteQueue).not.toBeNull();
  const playlistIcon = favoritePlaylist!.outerHTML;
  const queueIcon = favoriteQueue!.outerHTML;
  await search();
  expect(button(`添加到歌单 ${first.title}`).querySelector('svg')!.outerHTML).toBe(playlistIcon);
  expect(button(`加入队列 ${first.title}`).querySelector('svg')!.outerHTML).toBe(queueIcon);
});

it('keeps the custom API hidden until five version clicks and the correct developer key', async () => {
  const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable: true, value() {this.setAttribute('open', '');}});
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable: true, value() {this.removeAttribute('open');}});
  try {
    await render(); await navigate('设置');
    expect(container.querySelector('#api-url')).toBeNull();
    const version = container.querySelector<HTMLButtonElement>('.version-access')!;
    for (let count = 0; count < 4; count++) await act(async () => version.click());
    expect(document.querySelector('.developer-dialog')).toBeNull();
    await act(async () => version.click());
    const dialog = document.querySelector<HTMLDialogElement>('.developer-dialog')!;
    const input = dialog.querySelector('input')!;
    const enterKey = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    };
    await enterKey('wrong');
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('密钥不正确');
    expect(container.querySelector('#api-url')).toBeNull();
    await enterKey('XG2020');
    expect(container.querySelector('#api-url')).not.toBeNull();
    expect(document.querySelector('.developer-dialog')).toBeNull();
    expect(container.querySelector('.author-link')?.getAttribute('href')).toBe('https://github.com/XG2020/Xmusic_App');
  } finally {
    if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow); else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose); else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  }
});

it('honors the actual settings shortcut switch for Ctrl+F and Space, including a saved disabled preference', async () => {
  preferences.shortcutsEnabled = false;
  localStorage.setItem('xmusic:queue', JSON.stringify([first]));
  localStorage.setItem('xmusic:current', JSON.stringify(first.key));
  await render(); await navigate('设置');
  const toggle = () => button('启用快捷键');
  const searchInput = container.querySelector<HTMLInputElement>('[aria-label="搜索在线音乐"]')!;
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  focusBody();
  expect((await key({key: 'f', code: 'KeyF', ctrlKey: true})).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(document.body);
  expect((await key({key: ' ', code: 'Space'})).defaultPrevented).toBe(false);
  expect(FakeAudio.latest.play).not.toHaveBeenCalled();
  await click('启用快捷键');
  expect(setPreferences).toHaveBeenLastCalledWith({shortcutsEnabled: true});
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  focusBody();
  expect((await key({key: 'f', code: 'KeyF', ctrlKey: true})).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(searchInput);
  focusBody();
  expect((await key({key: ' ', code: 'Space'})).defaultPrevented).toBe(true);
  expect(FakeAudio.latest.play).toHaveBeenCalledOnce();
  expect(FakeAudio.latest.paused).toBe(false);
  await click('启用快捷键');
  expect(setPreferences).toHaveBeenLastCalledWith({shortcutsEnabled: false});
  focusBody();
  expect((await key({key: 'f', code: 'KeyF', ctrlKey: true})).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(document.body);
  expect((await key({key: ' ', code: 'Space'})).defaultPrevented).toBe(false);
  expect(FakeAudio.latest.paused).toBe(false);
});
