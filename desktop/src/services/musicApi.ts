import { mergeTracks, parseLyrics, parseQrc } from '../lib/music';
import { onDiscoveryCacheClear } from './discoveryCache';
import type { ApiRequest, DesktopBridge, Quality, Track } from '../types';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function number(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const result = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : match;
  });
}

function label(value: unknown): string {
  return decodeEntities(string(value).replace(/<\/?em\b[^>]*>/gi, '')).trim();
}

function httpUrl(value: unknown): string | undefined {
  const candidate = string(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function bridge(): DesktopBridge {
  if (typeof window === 'undefined' || !window.desktop) {
    throw new Error('桌面服务尚未连接，请在 XMusic Windows 客户端中使用此功能。');
  }
  return window.desktop;
}

function responseData(response: unknown): unknown {
  const envelope = object(response);
  const code = envelope.code;
  const status = envelope.status;
  const failed = envelope.success === false
    || (code !== undefined && code !== null && code !== 0 && code !== '0' && code !== 200 && code !== '200')
    || (typeof status === 'number' && status >= 400)
    || (typeof status === 'string' && /^(error|failed|fail)$/i.test(status));
  if (failed) {
    const message = string(envelope.message) || string(envelope.msg)
      || string(envelope.error) || string(object(envelope.error).message);
    throw new Error(message || `音乐服务请求失败${code === undefined ? '' : `（${String(code)}）`}`);
  }
  return Object.prototype.hasOwnProperty.call(envelope, 'data') ? envelope.data : response;
}

async function request(path: ApiRequest['path'], params: ApiRequest['params'], baseUrl?: string): Promise<unknown> {
  try {
    return responseData(await bridge().requestApi({ path, params, baseUrl: baseUrl?.trim() || undefined }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : string(error);
    throw new Error(detail || '无法连接音乐服务，请检查网络和接口地址。');
  }
}

export function normalizeTrack(raw: unknown): Track | undefined {
  const item = object(raw);
  const song = Object.keys(object(item.track_info)).length ? object(item.track_info) : item;
  const mid = string(song.mid) || string(song.songmid) || string(song.songMid);
  const songId = number(song.id ?? song.songId ?? song.songid);
  if (!mid && !songId) return undefined;
  const album = object(song.album);
  const albumMid = string(album.pmid) || string(album.mid) || string(song.albummid) || string(song.albumMid);
  const singers = song.singer ?? song.singers ?? song.artists ?? song.artist;
  const artist = Array.isArray(singers)
    ? singers.map((singer) => label(typeof singer === 'string' ? singer : object(singer).name)).filter(Boolean).join(' / ')
    : label(singers) || label(object(singers).name) || label(song.singerName);
  const coverUrl = httpUrl(song.coverUrl ?? song.cover ?? song.picurl ?? album.coverUrl)
    ?? (albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${encodeURIComponent(albumMid)}.jpg` : undefined);
  const info = object(item.info);
  const wiki = (name: string): string | undefined => {
    const content = object(info[name]).content;
    const value = Array.isArray(content) ? object(content[0]).value : undefined;
    return typeof value === 'string' && value.trim() ? value : undefined;
  };
  const detailLabel = (value: unknown) => label(string(value).replace(/<[^>]*>/g, '')).slice(0, 500) || undefined;
  const introduction = string(wiki('intro') ?? song.introduction).replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n').replace(/<[^>]*>/g, '');
  return {
    key: mid ? `online:${mid}` : `online:id:${songId}`,
    title: label(song.title) || label(song.name) || label(song.songname) || label(song.songName) || '未知歌曲',
    artist: artist || '未知歌手',
    album: label(album.name) || label(album.title) || label(song.album) || label(song.albumname) || undefined,
    duration: number(song.interval ?? song.duration ?? song.durationSeconds),
    language: detailLabel(wiki('lan') ?? song.language),
    genre: detailLabel(wiki('genre') ?? song.genre),
    releaseDate: detailLabel(wiki('pub_time') ?? song.releaseDate ?? album.time_public),
    recordLabel: detailLabel(wiki('company') ?? song.recordLabel),
    introduction: decodeEntities(introduction).trim().slice(0, 12000) || undefined,
    coverUrl,
    mid: mid || undefined,
    songId,
    source: 'online',
  };
}

export async function searchSongsPage(
  keyword: string,
  baseUrl?: string,
  page = 1,
): Promise<{ tracks: Track[]; hasMore: boolean }> {
  const query = keyword.trim();
  if (!query) return { tracks: [], hasMore: false };
  const data = await request('/api/search', {
    keyword: query,
    type: 'song',
    num: 30,
    page: Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1,
  }, baseUrl);
  const result = object(data);
  const list = Array.isArray(data) ? data : result.list ?? result.songs ?? object(result.song).list;
  if (!Array.isArray(list)) throw new Error('音乐服务返回了无法识别的搜索结果，请检查接口地址。');
  return {
    tracks: mergeTracks([], list.map(normalizeTrack).filter((track): track is Track => track !== undefined)),
    // Normalization can discard invalid entries or merge repeated mids on a full page.
    hasMore: list.length >= 30,
  };
}

export async function searchSongs(keyword: string, baseUrl?: string, page = 1): Promise<Track[]> {
  return (await searchSongsPage(keyword, baseUrl, page)).tracks;
}

const songDetailCache = new Map<string, Promise<Track>>();
onDiscoveryCacheClear(() => songDetailCache.clear());

function detailCacheKey(params: ApiRequest['params'], baseUrl?: string): string {
  return JSON.stringify([baseUrl?.trim() || '', params.mid ?? '', params.id ?? 0]);
}

async function cachedSongDetail(params: ApiRequest['params'], baseUrl?: string): Promise<Track> {
  const cacheKey = detailCacheKey(params, baseUrl);
  let pending = songDetailCache.get(cacheKey);
  if (!pending) {
    pending = request('/api/song/detail', params, baseUrl).then(data => {
      const detail = normalizeTrack(data);
      if (!detail) throw new Error('音乐服务返回了无法识别的歌曲信息，请稍后重试。');
      if ((params.mid && detail.mid && params.mid !== detail.mid) ||
          (params.id && detail.songId && Number(params.id) !== detail.songId)) {
        throw new Error('音乐服务返回的歌曲信息不匹配，请稍后重试。');
      }
      return detail;
    });
    songDetailCache.set(cacheKey, pending);
    const requestPromise = pending;
    void pending.catch(() => { if (songDetailCache.get(cacheKey) === requestPromise) songDetailCache.delete(cacheKey); });
    // Bound metadata storage while sharing in-flight lookups from play/queue/favorite actions.
    if (songDetailCache.size > 500) songDetailCache.delete(songDetailCache.keys().next().value!);
  }
  return pending;
}

function withSongDetail(track: Track, detail: Track): Track {
  return {
    ...track,
    mid: detail.mid ?? track.mid,
    songId: detail.songId ?? track.songId,
    title: detail.title !== '未知歌曲' ? detail.title : track.title,
    artist: detail.artist !== '未知歌手' ? detail.artist : track.artist,
    album: detail.album ?? track.album,
    coverUrl: detail.coverUrl ?? track.coverUrl,
    duration: detail.duration ?? track.duration,
    language: detail.language ?? track.language,
    genre: detail.genre ?? track.genre,
    releaseDate: detail.releaseDate ?? track.releaseDate,
    recordLabel: detail.recordLabel ?? track.recordLabel,
    introduction: detail.introduction ?? track.introduction,
  };
}

/** Show only registered local tags; online encyclopedia fields come from the mobile detail API. */
export async function fetchSongDetails(track: Track, baseUrl?: string): Promise<Track> {
  if (track.source === 'local') return track;
  const params: ApiRequest['params'] = track.mid ? { mid: track.mid } : track.songId ? { id: track.songId } : {};
  if (!Object.keys(params).length) throw new Error('该歌曲缺少详情标识，请重新搜索后查看。');
  return withSongDetail(track, await cachedSongDetail(params, baseUrl));
}

/** Chart entries can contain only songId. Resolve them lazily and keep their queue identity. */
export async function resolveTrackById(track: Track, baseUrl?: string): Promise<Track> {
  if (track.source === 'local' || track.mid) return track;
  if (!track.songId || !Number.isFinite(track.songId) || track.songId < 0) throw new Error('该歌曲缺少播放标识，请重新搜索后播放。');
  const params = { id: track.songId };
  const detail = await cachedSongDetail(params, baseUrl);
  if (!detail.mid) {
    songDetailCache.delete(detailCacheKey(params, baseUrl));
    throw new Error('暂时无法获取这首歌的播放标识，请稍后重试。');
  }
  return withSongDetail(track, detail);
}

export async function resolveTrackUrl(track: Track, quality: Quality, baseUrl?: string, options: {skipDownloaded?: boolean; isActive?: () => boolean} = {}): Promise<string> {
  const ensureActive = () => {
    if (options.isActive && !options.isActive()) throw new DOMException('播放请求已取消。', 'AbortError');
  };
  ensureActive();
  if (track.source === 'local') {
    if (!track.localId) throw new Error('本地歌曲缺少文件标识，请重新导入。');
    const url = await bridge().resolveLocalAudio(track.localId);
    if (!url.trim()) throw new Error('本地音频文件不可用，请重新导入。');
    return url;
  }
  track = await resolveTrackById(track, baseUrl);
  ensureActive();
  if (!track.mid) throw new Error('该歌曲缺少播放标识，请重新搜索后播放。');
  const desktop = bridge();
  if (!options.skipDownloaded && typeof desktop.resolveDownloadedAudio === 'function') {
    let downloaded: string | undefined;
    try {
      downloaded = await desktop.resolveDownloadedAudio({mid: track.mid, quality});
    } catch { /* A stale download record can fall back to the online source. */ }
    // A metadata or file check from an old selection must not start a native
    // source request after the newer song has already begun preparing.
    ensureActive();
    // Keep the song's online identity; only the native registry may choose a
    // local path, and missing/moved downloads must not block online playback.
    if (typeof downloaded === 'string' && /^xmusic-audio:\/\/track\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(downloaded)) return downloaded;
  }
  // Native playback refreshes expired signed URLs at this same quality. The
  // player owns format fallback after decoding/network failures.
  const url = await desktop.resolveOnlineAudio({mid: track.mid, quality, baseUrl: baseUrl?.trim() || undefined});
  ensureActive();
  if (typeof url !== 'string' && url?.code === 'AUDIO_URL_EXPIRED' && typeof url.message === 'string') {
    throw Object.assign(new Error(url.message), {code: url.code});
  }
  if (typeof url !== 'string' || !/^xmusic-online:\/\/stream\/[0-9a-f-]+$/i.test(url)) throw new Error('桌面服务返回了无效的音频地址，请重启客户端后重试。');
  return url;
}

function lyricText(data: unknown): string {
  const lyric = typeof data === 'string' ? data : object(data).lyric;
  if (lyric === null || lyric === undefined) return '';
  if (typeof lyric !== 'string') throw new Error('音乐服务返回了无法识别的歌词。');
  // Preserve QRC entities until its XML attribute is extracted by the parser.
  if (parseQrc(lyric).length) return lyric;
  const decoded = decodeEntities(lyric);
  if (/\bLyricContent\s*=|^\s*\[\d+,\d+\]/im.test(decoded)) return '';
  return decoded;
}

export async function fetchLyrics(track: Track, baseUrl?: string): Promise<string> {
  if (track.source === 'local') {
    if (!track.localId) throw new Error('本地歌曲缺少文件标识，请重新导入。');
    return bridge().readLocalLyrics(track.localId);
  }
  const params: ApiRequest['params'] = track.mid ? { mid: track.mid } : track.songId ? { id: track.songId } : {};
  if (!Object.keys(params).length) throw new Error('该歌曲缺少歌词标识，请重新搜索。');
  let preferred = '';
  try {
    preferred = lyricText(await request('/api/lyric', { ...params, qrc: true }, baseUrl));
    // Some songs return LRC even when QRC was requested; it is already usable.
    if (parseLyrics(preferred).length) return preferred;
  } catch { /* Older services may reject QRC while their ordinary LRC route still works. */ }
  try {
    return lyricText(await request('/api/lyric', params, baseUrl)) || preferred;
  } catch (error) {
    if (preferred.trim()) return preferred;
    throw error;
  }
}

export const musicApi = { searchSongs, searchSongsPage, fetchSongDetails, resolveTrackById, resolveTrackUrl, fetchLyrics };
