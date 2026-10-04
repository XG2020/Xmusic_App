import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge, Track } from '../types';
import { musicApi } from './musicApi';
import { parseLyrics } from '../lib/music';
import { clearDiscoveryCache } from './discoveryCache';

const online: Track = { key: 'online:abc', mid: 'abc', title: 'Song', artist: 'Singer', source: 'online' };
const local: Track = { key: 'local:file-id', localId: 'file-id', title: 'Local', artist: 'Singer', source: 'local' };
const requestApi = vi.fn<DesktopBridge['requestApi']>();
const resolveLocalAudio = vi.fn<DesktopBridge['resolveLocalAudio']>();
const resolveOnlineAudio = vi.fn<DesktopBridge['resolveOnlineAudio']>();
const readLocalLyrics = vi.fn<DesktopBridge['readLocalLyrics']>();

beforeEach(() => {
  vi.resetAllMocks();
  clearDiscoveryCache();
  vi.stubGlobal('window', { desktop: { requestApi, resolveLocalAudio, resolveOnlineAudio, readLocalLyrics } });
  resolveOnlineAudio.mockResolvedValue('xmusic-online://stream/12345678-1234-1234-1234-123456789abc');
});
afterEach(() => vi.unstubAllGlobals());

describe('search', () => {
  it('normalizes QQ field aliases, covers, entities and duplicate mids without retaining stream URLs', async () => {
    requestApi.mockResolvedValue({ code: 0, data: { list: [
      { songmid: 'abc', songid: '123', songname: '<em>你</em> &amp; 我', singer: [{ name: '甲' }, { name: '乙' }], album: { name: 'Album', pmid: 'pmid1' }, interval: '180', url: 'https://example.com/expired.mp3' },
      { mid: 'abc', title: 'Duplicate' },
      { mid: 'def', name: 'Other', artist: 'Solo', albumname: '旧专辑', albummid: 'album2' },
      { title: 'No identity' },
      null,
    ] } });
    const result = await musicApi.searchSongs('  搜索  ', ' https://music.example/ ', 2);
    expect(requestApi).toHaveBeenCalledWith({
      path: '/api/search', baseUrl: 'https://music.example/', params: { keyword: '搜索', type: 'song', num: 30, page: 2 },
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ key: 'online:abc', title: '你 & 我', artist: '甲 / 乙', album: 'Album', duration: 180, songId: 123, source: 'online' });
    expect(result[0].coverUrl).toBe('https://y.gtimg.cn/music/photo_new/T002R300x300M000pmid1.jpg');
    expect(result[0]).not.toHaveProperty('url');
    expect(result[1]).toMatchObject({ mid: 'def', artist: 'Solo', album: '旧专辑' });
  });

  it('returns empty searches without network calls, and recognizes empty service lists', async () => {
    expect(await musicApi.searchSongs('   ')).toEqual([]);
    expect(requestApi).not.toHaveBeenCalled();
    requestApi.mockResolvedValue({ code: 200, data: { list: [] } });
    expect(await musicApi.searchSongs('test', undefined, 0)).toEqual([]);
    expect(requestApi.mock.calls[0][0].params.page).toBe(1);
  });

  it('keeps the next page available when a full result page contains duplicate or invalid songs', async () => {
    const list = Array.from({ length: 30 }, (_, index) => ({ mid: `song${index}`, title: `Song ${index}` }));
    list[29] = list[0];
    requestApi.mockResolvedValueOnce({ data: { list } });
    const firstPage = await musicApi.searchSongsPage('test');
    expect(firstPage.tracks).toHaveLength(29);
    expect(firstPage.hasMore).toBe(true);
    requestApi.mockResolvedValueOnce({ data: { list: [{ title: 'No identity' }, { mid: 'last', title: 'Last' }] } });
    const lastPage = await musicApi.searchSongsPage('test', undefined, 2);
    expect(lastPage.tracks).toHaveLength(1);
    expect(lastPage.hasMore).toBe(false);
  });

  it('surfaces service errors, malformed responses and network failures', async () => {
    requestApi.mockResolvedValueOnce({ code: 500, message: '服务维护中', data: { list: [] } });
    await expect(musicApi.searchSongs('test')).rejects.toThrow('服务维护中');
    requestApi.mockResolvedValueOnce({ success: false, error: { message: '需要登录' } });
    await expect(musicApi.searchSongs('test')).rejects.toThrow('需要登录');
    requestApi.mockResolvedValueOnce({ data: { unexpected: true } });
    await expect(musicApi.searchSongs('test')).rejects.toThrow('无法识别的搜索结果');
    requestApi.mockRejectedValueOnce(new Error('连接超时'));
    await expect(musicApi.searchSongs('test')).rejects.toThrow('连接超时');
  });

  it('explains when the renderer is opened without the desktop bridge', async () => {
    vi.stubGlobal('window', {});
    await expect(musicApi.searchSongs('test')).rejects.toThrow('Windows 客户端');
  });
});

describe('playback URLs', () => {
  it('plays a verified downloaded copy without network access or changing the online song identity', async () => {
    const downloadedUrl = 'xmusic-audio://track/12345678-1234-4234-8234-123456789abc';
    const resolveDownloadedAudio = vi.fn().mockResolvedValue(downloadedUrl);
    vi.stubGlobal('window', {desktop: {requestApi, resolveOnlineAudio, resolveDownloadedAudio}});
    const original = {...online};
    expect(await musicApi.resolveTrackUrl(online, 'flac', 'https://music.example')).toBe(downloadedUrl);
    expect(resolveDownloadedAudio).toHaveBeenCalledWith({mid: 'abc', quality: 'flac'});
    expect(requestApi).not.toHaveBeenCalled();
    expect(resolveOnlineAudio).not.toHaveBeenCalled();
    expect(online).toEqual(original);
  });

  it('falls back online for missing, inaccessible or invalid download records and supports older bridges', async () => {
    const resolveDownloadedAudio = vi.fn().mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('下载文件不存在')).mockResolvedValueOnce('file:///private/music.mp3')
      .mockResolvedValueOnce('xmusic-audio://track/12345678-1234-4234-8234-123456789abc?path=private');
    vi.stubGlobal('window', {desktop: {requestApi, resolveOnlineAudio, resolveDownloadedAudio}});
    for (let index = 0; index < 4; index++) expect(await musicApi.resolveTrackUrl(online, '320')).toMatch(/^xmusic-online:/);
    expect(resolveDownloadedAudio).toHaveBeenCalledTimes(4);
    expect(resolveOnlineAudio).toHaveBeenCalledTimes(4);
    vi.stubGlobal('window', {desktop: {requestApi, resolveOnlineAudio}});
    expect(await musicApi.resolveTrackUrl(online, '320')).toMatch(/^xmusic-online:/);
  });

  it('allows the player to bypass a downloaded source after an actual decoder or local read failure', async () => {
    const resolveDownloadedAudio = vi.fn().mockResolvedValue('xmusic-audio://track/12345678-1234-4234-8234-123456789abc');
    vi.stubGlobal('window', {desktop: {requestApi, resolveOnlineAudio, resolveDownloadedAudio}});
    expect(await musicApi.resolveTrackUrl(online, 'flac', undefined, {skipDownloaded: true})).toMatch(/^xmusic-online:/);
    expect(resolveDownloadedAudio).not.toHaveBeenCalled();
    expect(resolveOnlineAudio).toHaveBeenCalledWith({mid: 'abc', quality: 'flac', baseUrl: undefined});
  });

  it.each(['metadata', 'download'] as const)('does not start an obsolete online request after a delayed %s lookup', async stage => {
    let active = true;
    let reached!: () => void;
    let release!: (value: unknown) => void;
    const entered = new Promise<void>(resolve => {reached = resolve;});
    const delayed = () => {reached(); return new Promise(resolve => {release = resolve;});};
    const resolveDownloadedAudio = vi.fn().mockResolvedValue(undefined);
    if (stage === 'metadata') requestApi.mockImplementationOnce(delayed);
    else resolveDownloadedAudio.mockImplementationOnce(delayed);
    vi.stubGlobal('window', {desktop: {requestApi, resolveOnlineAudio, resolveDownloadedAudio}});
    const oldTrack: Track = stage === 'metadata' ? {...online, mid: undefined, songId: 710} : {...online, mid: 'old-song'};
    const old = musicApi.resolveTrackUrl(oldTrack, 'flac', undefined, {isActive: () => active});
    await entered;
    active = false;
    expect(await musicApi.resolveTrackUrl(online, '320')).toMatch(/^xmusic-online:/);
    const cancelled = expect(old).rejects.toMatchObject({name: 'AbortError'});
    release(stage === 'metadata' ? {data: {track_info: {id: 710, mid: 'old-song'}}} : undefined);
    await cancelled;
    expect(resolveOnlineAudio).toHaveBeenCalledTimes(1);
    expect(resolveOnlineAudio).toHaveBeenLastCalledWith({mid: 'abc', quality: '320', baseUrl: undefined});
  });

  it('discards native URL preparation that finishes after the playback request was cancelled', async () => {
    let active = true;
    let release!: (value: string) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => {started = resolve;});
    resolveOnlineAudio.mockImplementationOnce(() => {started(); return new Promise(resolve => {release = resolve;});});
    const pending = musicApi.resolveTrackUrl(online, 'flac', undefined, {isActive: () => active});
    await entered;
    active = false;
    const cancelled = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    release('xmusic-online://stream/12345678-1234-1234-1234-123456789abc');
    await cancelled;
    expect(resolveOnlineAudio).toHaveBeenCalledTimes(1);
  });

  it('rebuilds expiry codes from plain bridge data instead of relying on custom Error properties across contextBridge', async () => {
    resolveOnlineAudio.mockResolvedValueOnce({code: 'AUDIO_URL_EXPIRED', message: '播放地址已失效，已重新解析同音质但仍无法播放。'});
    await expect(musicApi.resolveTrackUrl(online, 'flac')).rejects.toMatchObject({
      code: 'AUDIO_URL_EXPIRED', message: '播放地址已失效，已重新解析同音质但仍无法播放。',
    });
    expect(resolveOnlineAudio).toHaveBeenCalledTimes(1);
  });

  it('resolves id-only chart tracks lazily, shares metadata lookups and preserves the original key', async () => {
    const chartTrack: Track = {...online, key: 'online:id:501', mid: undefined, songId: 501};
    requestApi.mockImplementation(async request => request.path === '/api/song/detail'
      ? {data: {track_info: {mid: 'resolved501', id: 501, name: '完整歌曲名', singer: [{name: '歌手'}], interval: 180}}}
      : {data: {resolved501: 'https://audio.example/chart.mp3'}});
    const [first, second] = await Promise.all([musicApi.resolveTrackById(chartTrack), musicApi.resolveTrackById(chartTrack)]);
    expect(first).toMatchObject({key: chartTrack.key, mid: 'resolved501', title: '完整歌曲名', artist: '歌手', duration: 180});
    expect(second).toEqual(first);
    expect(chartTrack.mid).toBeUndefined();
    expect(requestApi).toHaveBeenCalledTimes(1);
    await expect(musicApi.resolveTrackUrl(chartTrack, '128')).resolves.toMatch(/^xmusic-online:/);
    expect(resolveOnlineAudio).toHaveBeenCalledWith({mid: 'resolved501', quality: '128', baseUrl: undefined});
    expect(requestApi.mock.calls.filter(([request]) => request.path === '/api/song/detail')).toHaveLength(1);
    await musicApi.resolveTrackById(chartTrack, 'https://another.example');
    expect(requestApi.mock.calls.filter(([request]) => request.path === '/api/song/detail')).toHaveLength(2);
  });

  it('retries failed chart metadata lookups and skips resolution for local or complete tracks', async () => {
    const chartTrack: Track = {...online, key: 'online:id:502', mid: undefined, songId: 502};
    requestApi.mockRejectedValueOnce(new Error('详情暂不可用'));
    await expect(musicApi.resolveTrackById(chartTrack)).rejects.toThrow('详情暂不可用');
    requestApi.mockResolvedValueOnce({data: {track_info: {mid: 'resolved502'}}});
    expect(await musicApi.resolveTrackById(chartTrack)).toMatchObject({key: chartTrack.key, mid: 'resolved502', title: 'Song', artist: 'Singer'});
    expect(await musicApi.resolveTrackById(online)).toBe(online);
    expect(await musicApi.resolveTrackById(local)).toBe(local);
    expect(requestApi).toHaveBeenCalledTimes(2);
  });

  it('resolves only the requested quality through the native bridge and re-resolves every playback', async () => {
    await expect(musicApi.resolveTrackUrl(online, 'flac', ' https://music.example/ ')).resolves.toMatch(/^xmusic-online:/);
    expect(resolveOnlineAudio).toHaveBeenCalledWith({mid: 'abc', quality: 'flac', baseUrl: 'https://music.example/'});
    resolveOnlineAudio.mockResolvedValueOnce('xmusic-online://stream/22345678-1234-1234-1234-123456789abc');
    await expect(musicApi.resolveTrackUrl(online, '128')).resolves.toContain('/22345678');
    expect(resolveOnlineAudio.mock.calls.map(([request]) => request.quality)).toEqual(['flac', '128']);
    expect(requestApi).not.toHaveBeenCalled();
    expect(online).not.toHaveProperty('url');
  });

  it('rejects arbitrary renderer URLs and preserves native network/service errors for the player to retry', async () => {
    resolveOnlineAudio.mockResolvedValueOnce('https://audio.example/unregistered.mp3');
    await expect(musicApi.resolveTrackUrl(online, '128')).rejects.toThrow('无效的音频地址');
    resolveOnlineAudio.mockRejectedValueOnce(new Error('网络断开'));
    await expect(musicApi.resolveTrackUrl(online, 'flac')).rejects.toThrow('网络断开');
    resolveOnlineAudio.mockRejectedValueOnce(new Error('无访问权限'));
    await expect(musicApi.resolveTrackUrl(online, 'flac')).rejects.toThrow('无访问权限');
    expect(resolveOnlineAudio).toHaveBeenCalledTimes(3);
    expect(requestApi).not.toHaveBeenCalled();
  });

  it('resolves local files exclusively through their registered identifier', async () => {
    resolveLocalAudio.mockResolvedValue('xmusic-local://audio/file-id');
    await expect(musicApi.resolveTrackUrl(local, 'flac')).resolves.toBe('xmusic-local://audio/file-id');
    expect(resolveLocalAudio).toHaveBeenCalledWith('file-id');
    expect(resolveOnlineAudio).not.toHaveBeenCalled();
    expect(requestApi).not.toHaveBeenCalled();
    resolveLocalAudio.mockRejectedValueOnce(new Error('文件不存在'));
    await expect(musicApi.resolveTrackUrl(local, '128')).rejects.toThrow('文件不存在');
    await expect(musicApi.resolveTrackUrl({ ...online, mid: undefined }, '128')).rejects.toThrow('播放标识');
  });
});

describe('song encyclopedia details', () => {
  it('clears disposable song-detail lookups together with browsing data without reviving an old in-flight value', async () => {
    const track = {...online, mid: 'clear-details'};
    let resolveOld!: (value: unknown) => void;
    requestApi.mockReturnValueOnce(new Promise(resolve => {resolveOld = resolve;}));
    const old = musicApi.fetchSongDetails(track);
    clearDiscoveryCache();
    requestApi.mockResolvedValueOnce({data: {track_info: {mid: 'clear-details', title: '新详情'}}});
    expect(await musicApi.fetchSongDetails(track)).toMatchObject({title: '新详情'});
    resolveOld({data: {track_info: {mid: 'clear-details', title: '旧详情'}}});
    expect(await old).toMatchObject({title: '旧详情'});
    expect(await musicApi.fetchSongDetails(track)).toMatchObject({title: '新详情'});
    expect(requestApi).toHaveBeenCalledTimes(2);
  });

  it('loads the mobile detail fields by mid, preserves identity and renders only supplied metadata', async () => {
    const track = { ...online, mid: 'wiki-song', key: 'original-chart-key', songId: 801 };
    requestApi.mockResolvedValue({ code: 0, data: {
      track_info: { id: 801, mid: 'wiki-song', title: '歌曲 &amp; 名', singer: [{ name: '歌手甲' }, { name: '歌手乙' }], album: { name: '真实专辑', time_public: '2024-01-01' }, interval: 245 },
      info: {
        lan: { content: [{ value: '国语' }] }, genre: { content: [{ value: 'R&amp;B' }] },
        pub_time: { content: [{ value: '2026-09-29' }] }, company: { content: [{ value: '真实唱片公司' }] },
        intro: { content: [{ value: '<p>第一段 &amp; 音乐</p>第二段<br>第三行' }] },
      },
    } });
    const detail = await musicApi.fetchSongDetails(track, ' https://details.example/ ');
    expect(requestApi).toHaveBeenCalledWith({ path: '/api/song/detail', params: { mid: 'wiki-song' }, baseUrl: 'https://details.example/' });
    expect(detail).toMatchObject({ key: 'original-chart-key', source: 'online', title: '歌曲 & 名', artist: '歌手甲 / 歌手乙', album: '真实专辑',
      duration: 245, language: '国语', genre: 'R&B', releaseDate: '2026-09-29', recordLabel: '真实唱片公司', introduction: '第一段 & 音乐\n\n第二段\n第三行' });
    expect(track.title).toBe('Song');
    await musicApi.fetchSongDetails(track, 'https://details.example/');
    expect(requestApi).toHaveBeenCalledTimes(1);
    await musicApi.fetchSongDetails(track, 'https://other-details.example');
    expect(requestApi).toHaveBeenCalledTimes(2);
  });

  it('uses id-only detail lookup, retains actual album dates and does not guess numeric genre/language codes', async () => {
    requestApi.mockResolvedValue({ data: { track_info: { id: 802, mid: 'wiki-id802', title: '实际歌名', lan: 0, genre: 16,
      album: { time_public: '2025-10-01' } }, info: { lan: { content: [] }, genre: { content: [{ value: 16 }] }, pub_time: { content: [{ value: '' }] } } } });
    const detail = await musicApi.fetchSongDetails({ ...online, mid: undefined, songId: 802, album: '已知专辑' });
    expect(requestApi.mock.calls[0][0].params).toEqual({ id: 802 });
    expect(detail).toMatchObject({ album: '已知专辑', releaseDate: '2025-10-01' });
    expect(detail.language).toBeUndefined();
    expect(detail.genre).toBeUndefined();
    expect(detail.recordLabel).toBeUndefined();
    expect(detail.introduction).toBeUndefined();
  });

  it('uses registered local tags without contacting an online service, even if a local track retains a mid', async () => {
    const track = { ...local, mid: 'downloaded-song', language: 'eng', genre: 'Jazz', releaseDate: '2020', recordLabel: 'Local Label', introduction: '文件内的备注' };
    expect(await musicApi.fetchSongDetails(track)).toBe(track);
    expect(requestApi).not.toHaveBeenCalled();
  });

  it('rejects mismatched/malformed detail responses and allows retry after failure', async () => {
    const track = { ...online, mid: 'wiki-retry' };
    requestApi.mockResolvedValueOnce({ data: { track_info: { mid: 'unrelated-song', title: '不相关' } } });
    await expect(musicApi.fetchSongDetails(track)).rejects.toThrow('不匹配');
    requestApi.mockResolvedValueOnce({ data: { info: { intro: { content: [{ value: '没有歌曲身份' }] } } } });
    await expect(musicApi.fetchSongDetails(track)).rejects.toThrow('无法识别');
    requestApi.mockRejectedValueOnce(new Error('服务暂时不可用'));
    await expect(musicApi.fetchSongDetails(track)).rejects.toThrow('服务暂时不可用');
    requestApi.mockResolvedValueOnce({ data: { track_info: { mid: 'wiki-retry', title: '恢复后的歌曲' } } });
    expect(await musicApi.fetchSongDetails(track)).toMatchObject({ title: '恢复后的歌曲' });
    expect(requestApi).toHaveBeenCalledTimes(4);
    await expect(musicApi.fetchSongDetails({ ...online, mid: undefined })).rejects.toThrow('缺少详情标识');
    expect(requestApi).toHaveBeenCalledTimes(4);
  });
});

describe('lyrics', () => {
  it('loads and decodes online lyrics and supports id-only lookup', async () => {
    requestApi.mockResolvedValue({ data: { lyric: '[00:01]你 &amp; 我&#10;[00:02]&#x4f60;' } });
    expect(await musicApi.fetchLyrics(online)).toBe('[00:01]你 & 我\n[00:02]你');
    expect(requestApi.mock.calls[0][0]).toMatchObject({ path: '/api/lyric', params: { mid: 'abc', qrc: true } });
    await musicApi.fetchLyrics({ ...online, mid: undefined, songId: 123 });
    expect(requestApi.mock.calls[1][0].params).toEqual({ id: 123, qrc: true });
  });

  it('distinguishes no lyrics from a service failure', async () => {
    requestApi.mockResolvedValue({ data: {} });
    expect(await musicApi.fetchLyrics(online)).toBe('');
    requestApi.mockResolvedValue({ code: -1, msg: '歌词服务不可用' });
    await expect(musicApi.fetchLyrics(online)).rejects.toThrow('歌词服务不可用');
  });

  it('keeps QRC timing and entities and avoids a second request when word lyrics are available', async () => {
    const qrc = '<Lyric_1 LyricContent="[1000,1500]&quot;你&quot;(1000,500) &amp; 我(2000,500)"/>';
    requestApi.mockResolvedValue({data: {lyric: qrc}});
    const raw = await musicApi.fetchLyrics(online);
    expect(parseLyrics(raw)[0]).toMatchObject({text: '"你" & 我', words: [{start: 1, dur: 0.5, text: '"你"'}, {start: 2, dur: 0.5, text: ' & 我'}]});
    expect(requestApi).toHaveBeenCalledTimes(1);
  });

  it('retries ordinary LRC when QRC is unsupported, malformed or empty', async () => {
    for (const preferred of [{code: 400, msg: '不支持 qrc'}, {data: {lyric: '<Lyric_1 LyricContent="[1000,1000]坏歌词"/>'}}, {data: {}}]) {
      requestApi.mockResolvedValueOnce(preferred).mockResolvedValueOnce({data: {lyric: '[00:01]普通歌词'}});
      expect(await musicApi.fetchLyrics(online)).toBe('[00:01]普通歌词');
      expect(requestApi.mock.calls.at(-2)![0].params).toEqual({mid: 'abc', qrc: true});
      expect(requestApi.mock.calls.at(-1)![0].params).toEqual({mid: 'abc'});
    }
  });

  it('reads local sidecar lyrics without calling the online service', async () => {
    readLocalLyrics.mockResolvedValue('[00:01]本地歌词');
    expect(await musicApi.fetchLyrics(local)).toBe('[00:01]本地歌词');
    expect(readLocalLyrics).toHaveBeenCalledWith('file-id');
    expect(requestApi).not.toHaveBeenCalled();
  });
});
