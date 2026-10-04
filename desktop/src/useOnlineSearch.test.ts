// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {searchSongsPage} from './services/musicApi';
import {searchPlaylistsPage} from './services/discovery';
import {useOnlineSearch} from './useOnlineSearch';

vi.mock('./services/musicApi', () => ({searchSongsPage: vi.fn()}));
vi.mock('./services/discovery', () => ({searchPlaylistsPage: vi.fn()}));

let root: Root;
let container: HTMLDivElement;
let search: ReturnType<typeof useOnlineSearch>;
function Harness({baseUrl = ''}: {baseUrl?: string}) {search = useOnlineSearch(baseUrl); return null;}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const songPage = {tracks: [{key: 'online:song', mid: 'song', title: '夜晚', artist: '歌手', source: 'online' as const}], hasMore: true};
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(searchSongsPage).mockResolvedValue(songPage);
  vi.mocked(searchPlaylistsPage).mockResolvedValue({list: [{id: '100', title: '夜晚歌单'}], hasMore: true});
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();});

it('loads categories lazily, preserves their pages, and deduplicates playlist pagination', async () => {
  await act(async () => {await search.search(' 夜晚 ');});
  expect(searchPlaylistsPage).not.toHaveBeenCalled();
  await act(async () => {await search.switchType('playlist');});
  expect(searchPlaylistsPage).toHaveBeenLastCalledWith('夜晚', '', 1);
  vi.mocked(searchPlaylistsPage).mockResolvedValueOnce({list: [{id: '100', title: '重复'}, {id: '101', title: '第二页'}], hasMore: false});
  await act(async () => {await search.loadMore();});
  expect(search.playlists.map(item => item.id)).toEqual(['100', '101']);
  expect(search.page).toBe(2);
  await act(async () => {await search.switchType('song');});
  expect(search.tracks).toEqual(songPage.tracks);
  expect(search.page).toBe(1);
  expect(search.hasMore).toBe(true);
  await act(async () => {await search.switchType('playlist');});
  expect(search.page).toBe(2);
  expect(search.hasMore).toBe(false);
  expect(searchSongsPage).toHaveBeenCalledTimes(1);
  expect(searchPlaylistsPage).toHaveBeenCalledTimes(2);
});

it('keeps a successfully empty category cached when switching tabs', async () => {
  vi.mocked(searchPlaylistsPage).mockResolvedValue({list: [], hasMore: false});
  await act(async () => {await search.search('空'); await search.switchType('playlist');});
  await act(async () => {await search.switchType('song'); await search.switchType('playlist');});
  expect(searchPlaylistsPage).toHaveBeenCalledTimes(1);
  expect(search).toMatchObject({playlists: [], loaded: true, loading: false, error: ''});
});

it('ignores a late result after switching category and reloads its unfinished first page', async () => {
  const old = deferred<typeof songPage>();
  vi.mocked(searchSongsPage).mockReturnValueOnce(old.promise);
  await act(async () => {void search.search('夜晚');});
  await act(async () => {await search.switchType('playlist');});
  await act(async () => old.resolve(songPage));
  expect(search.type).toBe('playlist');
  expect(search.playlists[0].id).toBe('100');
  expect(search.loading).toBe(false);
  await act(async () => {await search.switchType('song');});
  expect(searchSongsPage).toHaveBeenCalledTimes(2);
});

it('discards old query results and late errors, including pending pagination', async () => {
  await act(async () => {await search.search('夜晚'); await search.switchType('playlist');});
  const old = deferred<Awaited<ReturnType<typeof searchPlaylistsPage>>>();
  vi.mocked(searchPlaylistsPage).mockReturnValueOnce(old.promise);
  await act(async () => {void search.loadMore();});
  vi.mocked(searchPlaylistsPage).mockResolvedValueOnce({list: [{id: '200', title: '白天歌单'}], hasMore: false});
  await act(async () => {await search.search('白天');});
  await act(async () => old.reject(new Error('过期请求错误')));
  expect(search).toMatchObject({query: '白天', error: '', page: 1, loading: false});
  expect(search.playlists.map(item => item.id)).toEqual(['200']);
  await act(async () => {await search.switchType('song');});
  expect(searchSongsPage).toHaveBeenLastCalledWith('白天', '', 1);
});

it('retries the failed page using the submitted query and prevents overlapping pagination', async () => {
  await act(async () => {await search.search('夜晚'); await search.switchType('playlist');});
  const second = deferred<Awaited<ReturnType<typeof searchPlaylistsPage>>>();
  vi.mocked(searchPlaylistsPage).mockReturnValueOnce(second.promise);
  await act(async () => {void search.loadMore(); void search.loadMore();});
  expect(searchPlaylistsPage).toHaveBeenCalledTimes(2);
  await act(async () => second.reject(new Error('网络断开')));
  expect(search).toMatchObject({page: 1, error: '网络断开', loading: false});
  expect(search.playlists).toHaveLength(1);
  await act(async () => {await search.retry();});
  expect(searchPlaylistsPage).toHaveBeenLastCalledWith('夜晚', '', 2);
  expect(search.error).toBe('');
});

it('resets both categories and invalidates pending requests when the service changes or exploration opens', async () => {
  const pending = deferred<typeof songPage>();
  vi.mocked(searchSongsPage).mockReturnValueOnce(pending.promise);
  await act(async () => {void search.search('夜晚');});
  await act(async () => root.render(createElement(Harness, {baseUrl: 'https://new.example'})));
  await act(async () => pending.resolve(songPage));
  expect(search).toMatchObject({query: '', tracks: [], loading: false});
  await act(async () => {await search.search('新搜索');});
  expect(searchSongsPage).toHaveBeenLastCalledWith('新搜索', 'https://new.example', 1);
  await act(async () => search.reset());
  expect(search).toMatchObject({query: '', tracks: [], playlists: [], loaded: false});
});
