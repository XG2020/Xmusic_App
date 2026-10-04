import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATEGORY_ALL, getCategoryPlaylists, getPlaylist, getPlaylistForImport, getPlaylistCategories, getRanks, getRankTracks, parsePlaylistId, resolvePlaylistId, resolveDiscoveryTracks, searchPlaylistsPage } from './discovery';
import type { DesktopBridge, Track } from '../types';
import { clearDiscoveryCache, DISCOVERY_CACHE_KEY, DISCOVERY_TTL, getDiscoveryCacheStats } from './discoveryCache';

const requestApi = vi.fn<DesktopBridge['requestApi']>();
beforeEach(() => {
  vi.resetAllMocks();
  clearDiscoveryCache();
  vi.stubGlobal('window', { desktop: { requestApi } });
});
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

describe('mobile discovery sources', () => {
  it('searches playlists using mobile parameters and normalizes highlighted QQ metadata', async () => {
    requestApi.mockResolvedValueOnce({code: 0, data: {list: [
      {dissid: '90071992547409931', dissname: '<em>夜晚</em> &amp; 风', logo: 'http://example.com/cover.jpg', songnum: '30', listennum: '45000', nickname: '<em>创建者</em>', description: '轻松 &amp; 自在'},
      {tid: 321, title: '兼容字段', imgUrl: 'https://example.com/other.jpg', songCount: 0, playNum: '10', creator: {nick: '作者'}},
      {dissid: '90071992547409931', dissname: '重复'}, {dissid: 'invalid', dissname: '无效 ID'},
    ], total: '4'}});
    const result = await searchPlaylistsPage(' 夜晚 ', ' https://music.example ');
    expect(requestApi).toHaveBeenCalledWith({path: '/api/search', params: {keyword: '夜晚', type: 'playlist', num: 20, page: 1}, baseUrl: 'https://music.example'});
    expect(result).toEqual({list: [
      {id: '90071992547409931', title: '夜晚 & 风', coverUrl: 'https://example.com/cover.jpg', songCount: 30, listenNum: 45000, creatorName: '创建者', introduction: '轻松 & 自在'},
      {id: '321', title: '兼容字段', coverUrl: 'https://example.com/other.jpg', songCount: 0, listenNum: 10, creatorName: '作者', introduction: undefined},
    ], total: 4, hasMore: false});
  });

  it('pages playlist searches using raw items, totals and a bounded service page', async () => {
    const repeated = Array.from({length: 20}, () => ({dissid: '100', dissname: '重复歌单'}));
    requestApi.mockResolvedValueOnce({data: {list: repeated}});
    expect(await searchPlaylistsPage('夜晚', undefined, 2)).toMatchObject({list: [{id: '100'}], hasMore: true});
    expect(requestApi.mock.calls[0][0].params.page).toBe(2);
    requestApi.mockResolvedValueOnce({data: {playlist: {list: repeated, total: 40}}});
    expect(await searchPlaylistsPage('夜晚', undefined, 2)).toMatchObject({hasMore: false});
    requestApi.mockResolvedValueOnce({data: {list: [], total: 100}});
    expect(await searchPlaylistsPage('夜晚', undefined, 3)).toMatchObject({hasMore: false});
    requestApi.mockResolvedValueOnce({data: repeated});
    expect(await searchPlaylistsPage('夜晚', undefined, 10000)).toMatchObject({hasMore: false});
    expect(requestApi.mock.lastCall?.[0].params.page).toBe(1000);
  });

  it('does not request blank playlist searches and surfaces malformed responses and service errors', async () => {
    expect(await searchPlaylistsPage('  ')).toEqual({list: [], hasMore: false});
    expect(requestApi).not.toHaveBeenCalled();
    requestApi.mockResolvedValueOnce({data: {}});
    await expect(searchPlaylistsPage('夜晚')).rejects.toThrow('无法识别的歌单搜索结果');
    requestApi.mockResolvedValueOnce({code: 500, message: '搜索服务维护中'});
    await expect(searchPlaylistsPage('夜晚')).rejects.toThrow('搜索服务维护中');
  });

  it('recognizes QQ playlist IDs and links and delegates share redirects to the desktop bridge', async () => {
    for (const [input, expected] of [
      [' 0012345 ', '12345'], ['9007199254740993123', '9007199254740993123'],
      ['歌单分享 https://y.qq.com/n/ryqq/playlist/12345，来听听', '12345'],
      ['https://y.qq.com/n2/m/detail/taoge/index.html?id=12345', '12345'],
      ['https://c.y.qq.com/playlist?x=1&amp;disstid=12345', '12345'],
      ['（https://y.qq.com/#/playlist/12345）', '12345'],
    ]) expect(parsePlaylistId(input)).toBe(expected);
    for (const input of ['0', '-1', '1'.repeat(21), 'https://example.com/?id=12345',
      'https://y.qq.com.evil.example/playlist/12345', 'https://user:pass@y.qq.com/playlist/12345',
      'https://y.qq.com:4000/playlist/12345', 'https://y.qq.com/playlist/12345extra']) expect(parsePlaylistId(input)).toBeUndefined();
    const nativeResolve = vi.fn().mockResolvedValue('12345');
    vi.stubGlobal('window', {desktop: {requestApi, resolvePlaylistId: nativeResolve}});
    expect(await resolvePlaylistId('12345')).toBe('12345');
    expect(nativeResolve).not.toHaveBeenCalled();
    const share = '来听听 https://c6.y.qq.com/base/fcgi-bin/u?__=short';
    expect(await resolvePlaylistId(share)).toBe('12345');
    expect(nativeResolve).toHaveBeenCalledWith(share);
    nativeResolve.mockResolvedValueOnce('invalid');
    expect(await resolvePlaylistId(share)).toBeUndefined();
  });

  it('imports fresh playlist contents and preserves the source total for partial-result feedback', async () => {
    requestApi.mockResolvedValueOnce({data: {name: '旧歌单', songs: [{mid: 'old', title: '旧歌曲'}]}});
    await getPlaylist('12345');
    requestApi.mockResolvedValueOnce({data: {name: '新歌单', total: 1500, songs: [{mid: 'new', title: '新歌曲'}]}});
    expect(await getPlaylistForImport('12345')).toMatchObject({id: '12345', title: '新歌单', songCount: 1500, tracks: [{mid: 'new'}]});
    expect(requestApi).toHaveBeenCalledTimes(2);
    await expect(getPlaylistForImport('not-an-id')).rejects.toThrow('有效的 QQ 音乐歌单 ID');
    expect(requestApi).toHaveBeenCalledTimes(2);
  });

  it('flattens official charts, normalizes previews and filters unavailable or duplicate charts', async () => {
    requestApi.mockResolvedValue({ code: 0, data: { group: [
      { groupName: '官方榜', toplist: [
        { topId: 26, title: '热歌榜', period: '2026-10-02', listenNum: 123456, frontPicUrl: 'http://example.com/rank.jpg', song: [{ title: '你 &amp; 我', singerName: '歌手' }] },
        { topId: 99, title: 'Global-K Chart' }, { topId: 26, title: '重复' }, { title: '无标识' },
      ] },
      { groupName: '特色榜', toplist: [{ topId: 27, title: '新歌榜', song: [{ cover: 'https://example.com/fallback.jpg' }] }] },
    ] } });
    const ranks = await getRanks(' https://music.example/ ');
    expect(requestApi).toHaveBeenCalledWith({ path: '/api/top', params: {}, baseUrl: 'https://music.example/' });
    expect(ranks).toHaveLength(2);
    expect(ranks[0]).toMatchObject({ id: 26, title: '热歌榜', group: '官方榜', coverUrl: 'https://example.com/rank.jpg', top3: [{ title: '你 & 我', artist: '歌手' }] });
    expect(ranks[1].coverUrl).toBe('https://example.com/fallback.jpg');
  });

  it('joins chart songInfoList metadata so abbreviated entries have mids and album art', async () => {
    requestApi.mockResolvedValue({ code: 0, data: {
      data: { song: [{ songId: 11, title: '榜单标题', singerName: '甲', cover: '', albumMid: '' }, { songId: 12, title: '待补全', singerName: '乙' }] },
      songInfoList: [{ id: 11, mid: 'song11', title: '完整标题', singer: [{ name: '甲' }], album: { pmid: 'album11', name: '专辑' }, interval: 199 }],
    } });
    const tracks = await getRankTracks(26);
    expect(requestApi).toHaveBeenCalledWith({ path: '/api/top', params: { id: 26, num: 100 }, baseUrl: undefined });
    expect(tracks[0]).toMatchObject({ key: 'online:song11', mid: 'song11', songId: 11, title: '榜单标题', artist: '甲', album: '专辑', duration: 199 });
    expect(tracks[0].coverUrl).toBe('https://y.gtimg.cn/music/photo_new/T002R300x300M000album11.jpg');
    expect(tracks[1]).toMatchObject({ key: 'online:id:12', songId: 12, title: '待补全', artist: '乙' });
  });

  it('supports direct song lists and full track_info-only chart responses', async () => {
    requestApi.mockResolvedValueOnce({ data: { songs: [{ mid: 'direct', title: '直出', artist: '歌手' }] } });
    expect(await getRankTracks(26)).toMatchObject([{ mid: 'direct', title: '直出' }]);
    clearDiscoveryCache();
    requestApi.mockResolvedValueOnce({ data: { songInfoList: [{ track_info: { id: 3, mid: 'full', title: '完整', album: { mid: 'album' } } }] } });
    expect(await getRankTracks(26)).toMatchObject([{ mid: 'full', songId: 3, title: '完整' }]);
  });

  it('normalizes grouped category labels and removes duplicate category ids', async () => {
    requestApi.mockResolvedValue({ code: 0, data: { categories: [
      { categoryGroupName: '流派', items: [{ categoryId: 6, categoryName: 'R&#38;B' }, { categoryId: 7, categoryName: '流行' }] },
      { categoryGroupName: '其他', items: [{ categoryId: 6, categoryName: '重复' }, { categoryId: CATEGORY_ALL.id, categoryName: '全部' }] },
    ] } });
    expect(await getPlaylistCategories()).toEqual([{ name: '流派', items: [{ id: 6, name: 'R&B' }, { id: 7, name: '流行' }] }]);
    expect(requestApi.mock.calls[0][0]).toEqual({
      path: '/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg', baseUrl: undefined,
      params: { format: 'json', inCharset: 'utf8', outCharset: 'utf-8' },
    });
  });

  it('uses inclusive mobile category paging and retains paging after filtered items', async () => {
    const list = Array.from({ length: 20 }, (_, index) => ({ dissid: String(index + 100), dissname: `歌单 ${index}`, imgurl: 'http://example.com/list.jpg', listennum: '34000', creator: { name: '创建者' } }));
    list[19] = list[0];
    requestApi.mockResolvedValue({ data: { list, sum: 60 } });
    const response = await getCategoryPlaylists(7, 2);
    expect(requestApi.mock.calls[0][0]).toMatchObject({ path: '/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg', params: { categoryId: 7, sortId: 5, sin: 20, ein: 39, picmid: 1 } });
    expect(response.list).toHaveLength(19);
    expect(response).toMatchObject({ total: 60, hasMore: true });
    expect(response.list[0]).toMatchObject({ id: '100', title: '歌单 0', coverUrl: 'https://example.com/list.jpg', listenNum: 34000, creatorName: '创建者' });
  });

  it('recognizes empty category pages and unavailable totals without endless paging', async () => {
    requestApi.mockResolvedValueOnce({ data: { list: [], sum: 200 } });
    expect(await getCategoryPlaylists(CATEGORY_ALL.id)).toEqual({ list: [], total: 200, hasMore: false });
    clearDiscoveryCache();
    requestApi.mockResolvedValueOnce({ data: { list: [{ dissid: '123', dissname: '尾页' }] } });
    expect(await getCategoryPlaylists(CATEGORY_ALL.id)).toMatchObject({ hasMore: false });
  });

  it('loads QQ and documented playlist structures, deduplicating valid songs', async () => {
    requestApi.mockResolvedValueOnce({ data: {
      dirinfo: { id: 123, title: '夜晚 &amp; 雨', picurl: 'http://example.com/cover.jpg', songnum: 2 },
      songlist: [{ mid: 'one', title: '第一首', singer: [{ name: '歌手' }] }, { mid: 'one', title: '重复' }, { title: '无标识' }],
    } });
    const playlist = await getPlaylist('123', 'https://music.example');
    expect(requestApi).toHaveBeenCalledWith({ path: '/api/playlist', params: { id: '123', num: 2000 }, baseUrl: 'https://music.example' });
    expect(playlist).toMatchObject({ id: '123', title: '夜晚 & 雨', coverUrl: 'https://example.com/cover.jpg', songCount: 2 });
    expect(playlist.tracks).toHaveLength(1);
    requestApi.mockResolvedValueOnce({ data: { name: '文档格式', songs: [{ mid: 'two', title: '第二首' }] } });
    expect(await getPlaylist('456')).toMatchObject({ id: '456', title: '文档格式', tracks: [{ mid: 'two' }] });
  });

  it('shows actual API errors and rejects malformed successful payloads', async () => {
    requestApi.mockResolvedValueOnce({ code: 500, message: '音乐服务维护中' });
    await expect(getRanks()).rejects.toThrow('音乐服务维护中');
    requestApi.mockResolvedValueOnce({ success: false, error: { message: '分类暂时不可用' } });
    await expect(getPlaylistCategories()).rejects.toThrow('分类暂时不可用');
    requestApi.mockResolvedValueOnce({ data: {} });
    await expect(getRankTracks(26)).rejects.toThrow('无法识别的榜单歌曲');
    requestApi.mockResolvedValueOnce({ data: {} });
    await expect(getCategoryPlaylists(7)).rejects.toThrow('无法识别的分类歌单');
    requestApi.mockResolvedValueOnce({ data: {} });
    await expect(getPlaylist('123')).rejects.toThrow('无法识别的歌单歌曲');
  });

  it('retains native 403 diagnostics and only retries the same official source when requested again', async () => {
    const message = '音乐服务拒绝访问（HTTP 403，内置服务）。请稍后重新加载；若持续失败，可在设置中配置可用的服务地址。';
    requestApi.mockRejectedValueOnce(new Error(message));
    await expect(getRanks()).rejects.toThrow(message);
    expect(requestApi).toHaveBeenCalledTimes(1);
    requestApi.mockResolvedValueOnce({ code: 0, data: { group: [{ groupName: '官方榜', toplist: [{ topId: 26, title: '热歌榜' }] }] } });
    expect(await getRanks()).toMatchObject([{ id: 26, title: '热歌榜' }]);
    expect(requestApi.mock.calls.map(([request]) => request)).toEqual([
      { path: '/api/top', params: {}, baseUrl: undefined },
      { path: '/api/top', params: {}, baseUrl: undefined },
    ]);
  });

  it('bounds bulk metadata requests to four, preserves selection order and retains individual failures', async () => {
    const tracks: Track[] = Array.from({ length: 9 }, (_, index) => ({ key: `online:id:${1001 + index}`, songId: 1001 + index, title: `歌曲 ${index}`, artist: '歌手', source: 'online' }));
    let concurrent = 0;
    let maximum = 0;
    requestApi.mockImplementation(async request => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      await new Promise(resolve => setTimeout(resolve, Number(request.params.id) % 3));
      concurrent -= 1;
      if (request.params.id === 1003) throw new Error('这首暂不可用');
      return { data: { track_info: { id: request.params.id, mid: `mid${request.params.id}`, title: '已补全' } } };
    });
    const progress = vi.fn();
    const result = await resolveDiscoveryTracks(tracks, 'https://batch.example', progress);
    expect(maximum).toBe(4);
    expect(result.tracks.map(item => item.key)).toEqual(tracks.filter(item => item.songId !== 1003).map(item => item.key));
    expect(result.tracks.every(item => !!item.mid)).toBe(true);
    expect(result.failed).toEqual([{ track: tracks[2], error: '这首暂不可用' }]);
    expect(progress).toHaveBeenLastCalledWith(9, 9);
  });

  it('stops scheduling a bulk action once its view is no longer active', async () => {
    const tracks: Track[] = Array.from({ length: 8 }, (_, index) => ({ key: `online:id:${2001 + index}`, songId: 2001 + index, title: '歌曲', artist: '歌手', source: 'online' }));
    let active = true;
    requestApi.mockImplementation(async request => {
      await Promise.resolve();
      active = false;
      return { data: { mid: `mid${request.params.id}` } };
    });
    await resolveDiscoveryTracks(tracks, 'https://cancel.example', undefined, () => active);
    expect(requestApi).toHaveBeenCalledTimes(4);
  });
});

describe('discovery browsing cache integration', () => {
  it('shares concurrent chart reads and isolates service addresses and chart IDs', async () => {
    requestApi.mockImplementation(async request => request.params.id
      ? {data: {songInfoList: [{mid: `song-${request.params.id}`, id: request.params.id, title: '榜单歌曲'}]}}
      : {data: {group: [{groupName: '榜单', toplist: [{topId: 26, title: '热歌榜'}]}]}});
    await Promise.all([getRanks(), getRanks(), getRanks()]);
    expect(requestApi).toHaveBeenCalledTimes(1);
    await getRanks();
    await getRanks('https://custom.example');
    await getRankTracks(26);
    await getRankTracks(26);
    await getRankTracks(27);
    await getRankTracks(26, 'https://custom.example');
    expect(requestApi).toHaveBeenCalledTimes(5);
    expect(getDiscoveryCacheStats().entries).toBe(5);
  });

  it('isolates playlist IDs and service addresses and public category/page selections', async () => {
    requestApi.mockImplementation(async request => {
      if (request.path === '/api/playlist') return {data: {name: `歌单${request.params.id}`, songs: [{mid: `song${request.params.id}`, title: '歌曲'}]}};
      if (request.path.includes('tag_conf')) return {data: {categories: [{name: '语种', items: [{categoryId: 1, categoryName: '国语'}]}]}};
      return {data: {list: [{dissid: '100', dissname: `分类${request.params.categoryId} 页${request.params.sin}`}], sum: 30}};
    });
    await Promise.all([getPlaylist('100'), getPlaylist('100')]);
    await getPlaylist('101');
    await getPlaylist('100', 'https://other.example');
    await getPlaylistCategories();
    await getPlaylistCategories();
    await getCategoryPlaylists(1, 1);
    await getCategoryPlaylists(1, 0);
    await getCategoryPlaylists(1, 2);
    await getCategoryPlaylists(2, 1);
    expect(requestApi).toHaveBeenCalledTimes(7);
    expect(requestApi.mock.calls.filter(([request]) => request.path === '/api/playlist')).toHaveLength(3);
    expect(requestApi.mock.calls.filter(([request]) => request.path.includes('_by_tag')).map(([request]) => [request.params.categoryId, request.params.sin])).toEqual([[1, 0], [1, 20], [2, 0]]);
  });

  it('uses ten-minute charts, fifteen-minute playlist details and twenty-four-hour categories', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    requestApi.mockImplementation(async request => request.path === '/api/top'
      ? {data: {group: []}} : request.path === '/api/playlist' ? {data: {name: '歌单', songs: []}} : {data: {categories: []}});
    await getRanks();
    await getPlaylistCategories();
    await getPlaylist('123');
    vi.setSystemTime(now + DISCOVERY_TTL.ranks - 1);
    await getRanks();
    expect(requestApi).toHaveBeenCalledTimes(3);
    vi.setSystemTime(now + DISCOVERY_TTL.ranks);
    await getRanks();
    await getPlaylistCategories();
    await getPlaylist('123');
    expect(requestApi).toHaveBeenCalledTimes(4);
    vi.setSystemTime(now + DISCOVERY_TTL.playlistDetail - 1);
    await getPlaylist('123');
    expect(requestApi).toHaveBeenCalledTimes(4);
    vi.setSystemTime(now + DISCOVERY_TTL.playlistDetail);
    await getPlaylist('123');
    expect(requestApi).toHaveBeenCalledTimes(5);
    vi.setSystemTime(now + DISCOVERY_TTL.categories);
    await getPlaylistCategories();
    expect(requestApi).toHaveBeenCalledTimes(6);
  });

  it('persists normalized metadata without audio URLs and fetches again after clearing', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key)});
    requestApi.mockResolvedValue({data: {name: '缓存歌单', songs: [{mid: 'one', title: '歌曲', url: 'https://audio.example/temporary.mp3', album: {mid: 'album'}}]}});
    await getPlaylist('333');
    const saved = values.get(DISCOVERY_CACHE_KEY)!;
    expect(saved).toContain('缓存歌单');
    expect(saved).toContain('y.gtimg.cn');
    expect(saved).not.toContain('temporary.mp3');
    expect(saved).not.toContain('data:image');
    clearDiscoveryCache();
    expect(values.has(DISCOVERY_CACHE_KEY)).toBe(false);
    await getPlaylist('333');
    expect(requestApi).toHaveBeenCalledTimes(2);
  });
});
