// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExploreMusic, { DiscoveryTrackList } from './ExploreMusic';
import { CATEGORY_ALL, getCategoryPlaylists, getPlaylist, getPlaylistCategories, getRanks, getRankTracks, resolveDiscoveryTracks, type PlaylistPage } from './services/discovery';
import { resolveTrackById } from './services/musicApi';
import type { Track } from './types';

vi.mock('./services/discovery', () => ({
  CATEGORY_ALL: { id: 10000000, name: '全部' },
  getRanks: vi.fn(), getRankTracks: vi.fn(), getPlaylistCategories: vi.fn(), getCategoryPlaylists: vi.fn(), getPlaylist: vi.fn(), resolveDiscoveryTracks: vi.fn(),
}));
vi.mock('./services/musicApi', () => ({ resolveTrackById: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const track = (id: string): Track => ({ key: `online:${id}`, mid: id, title: `歌曲 ${id}`, artist: '歌手', source: 'online' });
const pageOf = (id: string, hasMore = false): PlaylistPage => ({ list: [{ id, title: `歌单 ${id}` }], hasMore });
let root: Root;
let container: HTMLDivElement;
const onPlay = vi.fn();
const onQueue = vi.fn();
const onFavorite = vi.fn();
const onDownload = vi.fn();
const onAddToPlaylist = vi.fn();
const onTogglePlaylistFavorite = vi.fn();
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === label || element.textContent?.trim() === label);
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function render(baseUrl?: string) {
  await act(async () => { root.render(createElement(ExploreMusic, { baseUrl, onPlay, onQueue, onFavorite, onDownload, favoriteKeys: new Set<string>() })); });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(getRanks).mockResolvedValue([{ id: 26, title: '热歌榜', group: '官方榜', top3: [] }, { id: 27, title: '新歌榜', group: '官方榜', top3: [] }]);
  vi.mocked(getRankTracks).mockResolvedValue([track('chart')]);
  vi.mocked(getPlaylistCategories).mockResolvedValue([{ name: '语种', items: [{ id: 1, name: '华语' }, { id: 2, name: '欧美' }] }]);
  vi.mocked(getCategoryPlaylists).mockResolvedValue(pageOf('100'));
  vi.mocked(getPlaylist).mockResolvedValue({ id: '100', title: '歌单 100', tracks: [track('playlist')] });
  vi.mocked(resolveTrackById).mockImplementation(async value => value);
  vi.mocked(resolveDiscoveryTracks).mockImplementation(async tracks => ({ tracks, failed: [] }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('discovery browsing', () => {
  it('filters playlist songs locally and limits playback and bulk operations to visible results', async () => {
    const tracks = [
      {...track('a'), title: '夜空', artist: '歌手甲', album: '远行'},
      {...track('b'), title: '晨风', artist: 'Singer B', album: '日光'},
      {...track('c'), title: '夜航', artist: 'Singer C', album: '远行'},
    ];
    await act(async () => root.render(createElement(DiscoveryTrackList, {tracks, searchable: true, onPlay, onQueue, onFavorite, favoriteKeys: new Set<string>()})));
    const filter = async (value: string) => {
      await act(async () => {
        const input = container.querySelector<HTMLInputElement>('[aria-label="搜索歌单歌曲"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', {bubbles: true}));
      });
    };
    const titles = () => [...container.querySelectorAll('.discovery-track-title')].map(item => item.textContent);
    await filter('ＳＩＮＧＥＲ　Ｂ');
    expect(titles()).toEqual(['晨风']);
    await click('晨风');
    expect(onPlay).toHaveBeenLastCalledWith([tracks[1]], 0);
    await filter('远行');
    expect(titles()).toEqual(['夜空', '夜航']);
    await click('批量操作');
    await act(async () => (container.querySelector('.discovery-select-all input') as HTMLInputElement).click());
    await click('加入队列');
    expect(onQueue.mock.calls.map(([song]) => song.key)).toEqual([tracks[0].key, tracks[2].key]);
    await filter('不存在');
    expect(titles()).toEqual([]);
    expect(container.textContent).toContain('没有找到匹配的歌曲');
    expect(container.textContent).toContain('已选 0 首');
    await click('清空歌单歌曲搜索');
    expect(titles()).toEqual(['夜空', '晨风', '夜航']);
    expect(getPlaylist).not.toHaveBeenCalled();
  });

  it('opens the mobile song actions on right-click without playing and copies the song name', async () => {
    const tracks = [track('context')];
    const onPlayNext = vi.fn();
    const copyText = vi.fn().mockResolvedValue(undefined);
    const previousBridge = window.desktop;
    window.desktop = {copyText} as unknown as NonNullable<Window['desktop']>;
    try {
      await act(async () => root.render(createElement(DiscoveryTrackList, {tracks, onPlay, onPlayNext, onQueue, onFavorite, onDownload, onAddToPlaylist, favoriteKeys: new Set<string>()})));
      const openMenu = async () => {
        await act(async () => container.querySelector('.discovery-track-row:not(.discovery-track-head)')!.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 120, clientY: 90})));
      };
      const choose = async (label: string) => {
        const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === label);
        expect(option).toBeDefined();
        await act(async () => option!.click());
      };
      await openMenu();
      expect(onPlay).not.toHaveBeenCalled();
      expect(document.querySelector('[role="menu"]')?.textContent).toContain('添加到歌单…');
      await choose('下一曲播放');
      expect(onPlayNext).toHaveBeenCalledWith(tracks[0]);
      await openMenu();
      await choose('复制歌名');
      expect(copyText).toHaveBeenCalledWith('歌曲 context - 歌手');
      await openMenu();
      await choose('批量操作');
      expect((container.querySelector('.discovery-track-select') as HTMLInputElement).checked).toBe(true);
    } finally {window.desktop = previousBridge;}
  });

  it('opens mobile chart cards and plays the selected list through the player callback', async () => {
    await render();
    expect(container.textContent).toContain('官方榜单');
    expect(container.textContent).toContain('热门歌单');
    await click('打开榜单 热歌榜');
    await click('播放全部');
    expect(onPlay).toHaveBeenCalledWith([track('chart')], 0);
    await click('加入队列 歌曲 chart');
    expect(onQueue).toHaveBeenCalledWith(track('chart'));
  });

  it('ignores a slow chart response after switching chart capsules', async () => {
    const old = deferred<Track[]>();
    vi.mocked(getRankTracks).mockImplementation(id => id === 26 ? old.promise : Promise.resolve([track('new')]));
    await render();
    await click('排行榜');
    await click('新歌榜');
    expect(container.textContent).toContain('歌曲 new');
    await act(async () => old.resolve([track('old')]));
    expect(container.textContent).not.toContain('歌曲 old');
    await click('播放全部');
    expect(onPlay).toHaveBeenCalledWith([track('new')], 0);
  });

  it('does not append an earlier category page after selecting a different category', async () => {
    const old = deferred<PlaylistPage>();
    vi.mocked(getCategoryPlaylists).mockImplementation((categoryId, page) => categoryId === 1 && page === 2 ? old.promise : Promise.resolve(pageOf(String(categoryId), categoryId === 1)));
    await render();
    await click('歌单');
    await click('华语');
    await click('加载更多歌单');
    await click('欧美');
    expect(button('打开歌单 歌单 2')).toBeTruthy();
    await act(async () => old.resolve(pageOf('obsolete')));
    expect(container.textContent).not.toContain('歌单 obsolete');
    expect(container.textContent).not.toContain(`歌单 ${CATEGORY_ALL.id}`);
  });

  it('opens playlist songs, surfaces failures and retries without losing the selected playlist', async () => {
    vi.mocked(getPlaylist).mockRejectedValueOnce(new Error('歌单加载超时'));
    await render();
    await click('打开歌单 歌单 100');
    expect(container.textContent).toContain('歌单加载超时');
    expect(button('播放全部').disabled).toBe(true);
    await click('重新加载');
    await click('播放全部');
    expect(onPlay).toHaveBeenCalledWith([track('playlist')], 0);
    await click('返回歌单');
    expect(container.textContent).toContain('官方榜单');
  });

  it('resolves id-only tracks before download, and does not issue the action after a failed lookup', async () => {
    const idOnly: Track = { key: 'online:id:123', songId: 123, title: '待补全', artist: '歌手', source: 'online' };
    vi.mocked(getRankTracks).mockResolvedValue([idOnly]);
    vi.mocked(resolveTrackById).mockRejectedValueOnce(new Error('歌曲信息获取失败'));
    await render();
    await click('排行榜');
    await click('下载 待补全');
    expect(onDownload).not.toHaveBeenCalled();
    expect(container.textContent).toContain('歌曲信息获取失败');
    vi.mocked(resolveTrackById).mockResolvedValueOnce({ ...idOnly, mid: 'resolved' });
    await click('重试');
    expect(onDownload).toHaveBeenCalledWith({ ...idOnly, mid: 'resolved' });
  });

  it('discards an old API response after the music service changes', async () => {
    const old = deferred<Track[]>();
    vi.mocked(getRankTracks).mockImplementation((_id, baseUrl) => baseUrl === 'https://old.example' ? old.promise : Promise.resolve([track('updated')]));
    await render('https://old.example');
    await click('排行榜');
    await render('https://new.example');
    await act(async () => old.resolve([track('stale')]));
    expect(container.textContent).toContain('歌曲 updated');
    expect(container.textContent).not.toContain('歌曲 stale');
  });

  it('opens an externally selected favorite playlist and saves its metadata without song contents', async () => {
    const opened = vi.fn();
    await act(async () => root.render(createElement(ExploreMusic, {
      onPlay, onQueue, onFavorite, favoriteKeys: new Set<string>(), favoritePlaylistIds: new Set(['100']), onTogglePlaylistFavorite,
      playlistToOpen: { id: '100', title: '歌单 100', creatorName: '创建者' }, onPlaylistOpened: opened,
    })));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('歌曲 playlist');
    await click('取消收藏歌单');
    expect(onTogglePlaylistFavorite).toHaveBeenCalledWith(expect.objectContaining({ id: '100', title: '歌单 100', creatorName: '创建者', songCount: 1 }));
    expect(onTogglePlaylistFavorite.mock.calls[0][0]).not.toHaveProperty('tracks');
  });

  it('plays only selected songs and batches adding to a self-created playlist', async () => {
    const tracks = [track('first'), track('second')];
    await act(async () => root.render(createElement(DiscoveryTrackList, { tracks, onPlay, onQueue, onFavorite, onDownload, onAddToPlaylist, favoriteKeys: new Set<string>() })));
    await click('批量操作');
    await act(async () => (container.querySelector('input[aria-label="选择 歌曲 second"]') as HTMLInputElement).click());
    await click('播放');
    expect(onPlay).toHaveBeenCalledWith([tracks[1]], 0);
    expect(resolveDiscoveryTracks).not.toHaveBeenCalled();
    await click('添加到歌单');
    expect(onAddToPlaylist).toHaveBeenCalledWith([tracks[1]]);
    await act(async () => (container.querySelector('.discovery-select-all input') as HTMLInputElement).click());
    await click('下载');
    expect(onDownload.mock.calls.map(([song]) => song.key)).toEqual(tracks.map(song => song.key));
  });

  it('keeps existing favorites and retries only the failed part of a batch action', async () => {
    const tracks = [track('existing'), track('ok'), track('retry')];
    vi.mocked(resolveDiscoveryTracks).mockResolvedValueOnce({ tracks: [tracks[1]], failed: [{ track: tracks[2], error: '网络断开' }] });
    await act(async () => root.render(createElement(DiscoveryTrackList, { tracks, onPlay, onQueue, onFavorite, favoriteKeys: new Set([tracks[0].key]) })));
    await click('批量操作');
    await act(async () => (container.querySelector('.discovery-select-all input') as HTMLInputElement).click());
    await click('喜欢');
    expect(vi.mocked(resolveDiscoveryTracks).mock.calls[0][0]).toEqual([tracks[1], tracks[2]]);
    expect(onFavorite).toHaveBeenCalledWith(tracks[1]);
    expect(container.textContent).toContain('1 首歌曲未完成');
    await click('重试');
    expect(vi.mocked(resolveDiscoveryTracks).mock.calls[1][0]).toEqual([tracks[2]]);
    expect(onFavorite.mock.calls.map(([song]) => song.key)).toEqual([tracks[1].key, tracks[2].key]);
  });

  it('supports removing selected songs from a self-created playlist', async () => {
    const tracks = [track('one'), track('two')];
    const onRemoveTracks = vi.fn();
    await act(async () => root.render(createElement(DiscoveryTrackList, { tracks, onPlay, onQueue, onFavorite, onRemoveTracks, favoriteKeys: new Set<string>() })));
    await click('批量操作');
    await act(async () => (container.querySelector('input[aria-label="选择 歌曲 two"]') as HTMLInputElement).click());
    await click('移出歌单');
    expect(onRemoveTracks).toHaveBeenCalledWith([tracks[1]]);
    expect(container.textContent).toContain('已选 0 首');
  });

  it('awaits downloads sequentially and reports only created tasks as successful', async () => {
    const tracks = [track('created'), track('full'), track('later')];
    let concurrent = 0;
    let maximum = 0;
    onDownload.mockImplementation(async song => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      if (song.key === tracks[1].key) throw new Error('下载队列已满');
    });
    await act(async () => root.render(createElement(DiscoveryTrackList, { tracks, onPlay, onQueue, onFavorite, onDownload, favoriteKeys: new Set<string>() })));
    await click('批量操作');
    await act(async () => (container.querySelector('.discovery-select-all input') as HTMLInputElement).click());
    await click('下载');
    expect(maximum).toBe(1);
    expect(onDownload.mock.calls.map(([song]) => song.key)).toEqual(tracks.map(song => song.key));
    expect(container.textContent).toContain('2 首歌曲已加入下载队列');
    expect(container.textContent).toContain('1 首歌曲未完成：下载队列已满');
    expect(container.textContent).toContain('已选 1 首');
    onDownload.mockResolvedValue(undefined);
    await click('重试');
    expect(onDownload.mock.calls.slice(3).map(([song]) => song.key)).toEqual([tracks[1].key]);
    expect(container.textContent).toContain('1 首歌曲已加入下载队列');
    expect(container.textContent).not.toContain('下载队列已满');
  });

  it.each(['下载', '加入队列', '喜欢'])('finishes a requested batch %s after changing pages during lookup', async label => {
    const tracks = [track('background-one'), track('background-two'), track('background-three')];
    const lookup = deferred<{tracks: Track[]; failed: []}>();
    const onAddFavorites = vi.fn();
    vi.mocked(resolveDiscoveryTracks).mockReturnValueOnce(lookup.promise);
    await act(async () => root.render(createElement(DiscoveryTrackList, {tracks, onPlay, onQueue, onFavorite, onAddFavorites, onDownload, favoriteKeys: new Set<string>()})));
    await click('批量操作');
    await act(async () => (container.querySelector('.discovery-select-all input') as HTMLInputElement).click());
    await click(label);
    await act(async () => root.render(createElement('div', null, '另一页面')));
    expect(vi.mocked(resolveDiscoveryTracks).mock.calls[0][3]?.()).toBe(true);
    await act(async () => {lookup.resolve({tracks, failed: []}); await lookup.promise;});
    if (label === '喜欢') {
      expect(onAddFavorites).toHaveBeenCalledWith(tracks);
      expect(onFavorite).not.toHaveBeenCalled();
    } else expect((label === '下载' ? onDownload : onQueue).mock.calls.map(([song]) => song.key)).toEqual(tracks.map(song => song.key));
    expect(container.textContent).toBe('另一页面');
  });

  it('submits the remaining downloads after leaving while the first task is being created', async () => {
    const tracks = [track('first-task'), track('second-task'), track('third-task')];
    const firstCreated = deferred<void>();
    onDownload.mockReturnValueOnce(firstCreated.promise);
    await act(async () => root.render(createElement(DiscoveryTrackList, {tracks, onPlay, onQueue, onFavorite, onDownload, favoriteKeys: new Set<string>()})));
    await click('批量操作');
    await act(async () => (container.querySelector('.discovery-select-all input') as HTMLInputElement).click());
    await click('下载');
    expect(onDownload).toHaveBeenCalledTimes(1);
    await act(async () => root.render(createElement('div', null, '下载管理')));
    await act(async () => {firstCreated.resolve(); await firstCreated.promise;});
    expect(onDownload.mock.calls.map(([song]) => song.key)).toEqual(tracks.map(song => song.key));
  });

  it.each([true, false])('never toggles off a song liked from the player during batch lookup (bulk callback: %s)', async bulkCallback => {
    const tracks = [track('liked-while-waiting'), track('still-new')];
    const lookup = deferred<{tracks: Track[]; failed: []}>();
    vi.mocked(resolveDiscoveryTracks).mockReturnValueOnce(lookup.promise);
    const saved = new Set<string>();
    const onAddFavorites = bulkCallback ? vi.fn((incoming: Track[]) => incoming.forEach(song => saved.add(song.key))) : undefined;
    onFavorite.mockImplementation(song => {if (saved.has(song.key)) saved.delete(song.key); else saved.add(song.key);});
    const props = {tracks, onPlay, onQueue, onFavorite, onAddFavorites, favoriteKeys: new Set<string>()};
    await act(async () => root.render(createElement(DiscoveryTrackList, props)));
    await click('批量操作');
    await act(async () => (container.querySelector('.discovery-select-all input') as HTMLInputElement).click());
    await click('喜欢');
    // The bottom player can still add a favorite while the list is waiting.
    saved.add(tracks[0].key);
    await act(async () => root.render(createElement(DiscoveryTrackList, {...props, favoriteKeys: new Set(saved)})));
    await act(async () => {lookup.resolve({tracks, failed: []}); await lookup.promise;});
    expect([...saved]).toEqual(tracks.map(song => song.key));
    if (bulkCallback) expect(onFavorite).not.toHaveBeenCalled();
    else expect(onFavorite.mock.calls.map(([song]) => song.key)).toEqual([tracks[1].key]);
  });

  it('does not reopen a playlist picker after its source page is dismissed', async () => {
    const tracks = [track('picker')];
    const lookup = deferred<{tracks: Track[]; failed: []}>();
    vi.mocked(resolveDiscoveryTracks).mockReturnValueOnce(lookup.promise);
    await act(async () => root.render(createElement(DiscoveryTrackList, {tracks, onPlay, onQueue, onFavorite, onAddToPlaylist, favoriteKeys: new Set<string>()})));
    await click('批量操作');
    await act(async () => (container.querySelector('.discovery-select-all input') as HTMLInputElement).click());
    await click('添加到歌单');
    await act(async () => root.render(createElement('div', null, '另一页面')));
    expect(vi.mocked(resolveDiscoveryTracks).mock.calls[0][3]?.()).toBe(false);
    await act(async () => {lookup.resolve({tracks, failed: []}); await lookup.promise;});
    expect(onAddToPlaylist).not.toHaveBeenCalled();
  });

  it('surfaces and retries a rejected single download callback', async () => {
    onDownload.mockRejectedValueOnce(new Error('下载队列已满'));
    await render();
    await click('排行榜');
    await click('下载 歌曲 chart');
    expect(container.textContent).toContain('下载队列已满');
    onDownload.mockResolvedValue(undefined);
    await click('重试');
    expect(onDownload).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('下载队列已满');
  });
});
