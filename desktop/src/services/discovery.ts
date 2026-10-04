import { mergeTracks } from '../lib/music';
import { normalizeTrack, resolveTrackById } from './musicApi';
import { cachedDiscovery, discoveryServiceKey, DISCOVERY_TTL } from './discoveryCache';
import { parsePlaylistId } from './playlistId';
import type { ApiRequest, Track } from '../types';

export { parsePlaylistId } from './playlistId';

type JsonObject = Record<string, unknown>;

export interface RankInfo {
  id: number;
  title: string;
  group: string;
  period?: string;
  listenNum?: number;
  coverUrl?: string;
  top3: { title: string; artist: string }[];
}

export interface PlaylistInfo {
  id: string;
  title: string;
  coverUrl?: string;
  songCount?: number;
  listenNum?: number;
  creatorName?: string;
  introduction?: string;
}

export interface PlaylistCategory { id: number; name: string }
export interface PlaylistCategoryGroup { name: string; items: PlaylistCategory[] }
export interface PlaylistPage { list: PlaylistInfo[]; total?: number; hasMore: boolean }
export interface PlaylistDetail extends PlaylistInfo { tracks: Track[] }

export const CATEGORY_ALL: PlaylistCategory = { id: 10000000, name: '全部' };
export const PLAYLIST_PAGE_SIZE = 20;
const QQ_PARAMS = { format: 'json', inCharset: 'utf8', outCharset: 'utf-8' };

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function label(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(value).replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  }).replace(/\s+/g, ' ').trim();
}

function number(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const result = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function imageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.replace(/^http:\/\//i, 'https://'));
    return url.protocol === 'https:' ? url.href : undefined;
  } catch { return undefined; }
}

async function request(path: ApiRequest['path'], params: ApiRequest['params'], baseUrl?: string): Promise<unknown> {
  if (typeof window === 'undefined' || !window.desktop) {
    throw new Error('桌面服务尚未连接，请在 Xmusic Windows 客户端中使用此功能。');
  }
  const response = await window.desktop.requestApi({ path, params, baseUrl: baseUrl?.trim() || undefined });
  const envelope = object(response);
  const code = envelope.code;
  if (envelope.success === false || (code != null && ![0, '0', 200, '200'].includes(code as number | string))
      || (typeof envelope.status === 'number' && envelope.status >= 400)
      || (typeof envelope.status === 'string' && /^(error|failed|fail)$/i.test(envelope.status))) {
    throw new Error(label(envelope.message ?? envelope.msg ?? object(envelope.error).message ?? envelope.error) || '音乐服务暂时不可用，请稍后重试。');
  }
  return Object.prototype.hasOwnProperty.call(envelope, 'data') ? envelope.data : response;
}

function requiredList(value: unknown, kind: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`音乐服务返回了无法识别的${kind}，请稍后重试。`);
  return value;
}

function optionalFields(value: JsonObject, strings: string[], numbers: string[] = []): boolean {
  return strings.every(key => value[key] === undefined || typeof value[key] === 'string') &&
    numbers.every(key => value[key] === undefined || (typeof value[key] === 'number' && number(value[key]) !== undefined));
}

function cachedRanks(value: unknown): value is RankInfo[] {
  return Array.isArray(value) && value.every(raw => {
    const item = object(raw);
    return typeof item.id === 'number' && item.id > 0 && typeof item.title === 'string' && typeof item.group === 'string' &&
      optionalFields(item, ['period', 'coverUrl'], ['listenNum']) && Array.isArray(item.top3) &&
      item.top3.every(song => typeof object(song).title === 'string' && typeof object(song).artist === 'string');
  });
}

function cachedTracks(value: unknown): value is Track[] {
  return Array.isArray(value) && value.every(raw => {
    const item = object(raw);
    return typeof item.key === 'string' && typeof item.title === 'string' && typeof item.artist === 'string' && item.source === 'online' &&
      optionalFields(item, ['album', 'coverUrl', 'mid', 'language', 'genre', 'releaseDate', 'recordLabel', 'introduction'], ['duration', 'songId']);
  });
}

function cachedPlaylist(value: unknown): value is PlaylistInfo {
  const item = object(value);
  return typeof item.id === 'string' && /^\d+$/.test(item.id) && typeof item.title === 'string' &&
    optionalFields(item, ['coverUrl', 'creatorName', 'introduction'], ['songCount', 'listenNum']);
}

function cachedCategories(value: unknown): value is PlaylistCategoryGroup[] {
  return Array.isArray(value) && value.every(raw => {
    const group = object(raw);
    return typeof group.name === 'string' && Array.isArray(group.items) && group.items.every(rawItem => {
      const item = object(rawItem);
      return typeof item.id === 'number' && item.id > 0 && typeof item.name === 'string';
    });
  });
}

/** Shares the mobile app's grouped QQ charts, including its unavailable-chart filter. */
export function getRanks(baseUrl?: string): Promise<RankInfo[]> {
  return cachedDiscovery(['ranks', discoveryServiceKey(baseUrl)], DISCOVERY_TTL.ranks, () => loadRanks(baseUrl), cachedRanks);
}

async function loadRanks(baseUrl?: string): Promise<RankInfo[]> {
  const data = object(await request('/api/top', {}, baseUrl));
  const groups = requiredList(data.group, '榜单列表');
  const seen = new Set<number>();
  return groups.flatMap(rawGroup => {
    const group = object(rawGroup);
    return (Array.isArray(group.toplist) ? group.toplist : []).flatMap(raw => {
      const item = object(raw);
      const id = number(item.topId ?? item.id);
      const title = label(item.title ?? item.name);
      if (!id || !title || title === 'Global-K Chart' || seen.has(id)) return [];
      seen.add(id);
      const previews = Array.isArray(item.song) ? item.song : [];
      return [{
        id, title, group: label(group.groupName ?? group.title ?? group.name),
        period: label(item.period) || undefined,
        listenNum: number(item.listenNum),
        coverUrl: imageUrl(item.frontPicUrl ?? item.headPicUrl ?? object(previews[0]).cover),
        top3: previews.slice(0, 3).map(song => ({ title: label(object(song).title), artist: label(object(song).singerName) })),
      }];
    });
  });
}

/** Complete track_info supplements abbreviated chart entries with playable mids and covers. */
export function getRankTracks(id: number, baseUrl?: string): Promise<Track[]> {
  return cachedDiscovery(['rank-tracks', discoveryServiceKey(baseUrl), id], DISCOVERY_TTL.rankTracks, () => loadRankTracks(id, baseUrl), cachedTracks);
}

async function loadRankTracks(id: number, baseUrl?: string): Promise<Track[]> {
  const data = object(await request('/api/top', { id, num: 100 }, baseUrl));
  const nested = object(data.data);
  const detail = Object.keys(nested).length ? nested : data;
  const infoList = data.songInfoList ?? detail.songInfoList;
  const infoMap = new Map<number, JsonObject>();
  if (Array.isArray(infoList)) {
    for (const raw of infoList) {
      const item = object(raw);
      const full = Object.keys(object(item.track_info)).length ? object(item.track_info) : item;
      const songId = number(full.id ?? full.songId);
      if (songId) infoMap.set(songId, full);
    }
  }
  const songs = requiredList(detail.song ?? detail.songs ?? detail.list ?? infoList, '榜单歌曲');
  const tracks = songs.map(raw => {
    const item = object(raw);
    const brief = Object.keys(object(item.track_info)).length ? object(item.track_info) : item;
    const songId = number(brief.songId ?? brief.id);
    const full: JsonObject = songId ? infoMap.get(songId) ?? {} : {};
    return normalizeTrack({
      ...full, ...brief,
      id: songId,
      mid: brief.mid || full.mid,
      title: brief.title || brief.name || full.title || full.name,
      singer: Array.isArray(brief.singer) && brief.singer.length ? brief.singer : full.singer,
      album: brief.album ?? full.album ?? (brief.albumMid ? { mid: brief.albumMid } : undefined),
      interval: brief.interval ?? full.interval,
      coverUrl: imageUrl(brief.coverUrl ?? brief.cover) ?? imageUrl(full.coverUrl ?? full.cover),
    });
  }).filter((track): track is Track => track !== undefined);
  return mergeTracks([], tracks);
}

/** These two fixed QQ endpoints are also used by the mobile playlist square. */
export function getPlaylistCategories(): Promise<PlaylistCategoryGroup[]> {
  return cachedDiscovery(['categories', 'qq-public'], DISCOVERY_TTL.categories, loadPlaylistCategories, cachedCategories);
}

async function loadPlaylistCategories(): Promise<PlaylistCategoryGroup[]> {
  const data = object(await request('/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg', QQ_PARAMS));
  const seen = new Set<number>([CATEGORY_ALL.id]);
  return requiredList(data.categories, '歌单分类').flatMap(raw => {
    const group = object(raw);
    const name = label(group.categoryGroupName ?? group.name);
    const items = (Array.isArray(group.items) ? group.items : []).flatMap(rawItem => {
      const item = object(rawItem);
      const id = number(item.categoryId ?? item.id);
      const title = label(item.categoryName ?? item.name);
      if (!id || !title || seen.has(id)) return [];
      seen.add(id);
      return [{ id, name: title }];
    });
    return name && items.length ? [{ name, items }] : [];
  });
}

function normalizePlaylist(raw: unknown): PlaylistInfo | undefined {
  const item = object(raw);
  const id = label(item.dissid ?? item.tid ?? item.id);
  const title = label(item.dissname ?? item.title ?? item.name);
  if (!/^\d+$/.test(id) || !title) return undefined;
  return {
    id, title,
    coverUrl: imageUrl(item.logo ?? item.imgurl ?? item.imgUrl ?? item.cover ?? item.picurl ?? item.pic ?? item.coverUrl),
    songCount: number(item.songnum ?? item.song_count ?? item.songCount),
    listenNum: number(item.listennum ?? item.listenNum ?? item.access_num ?? item.playNum),
    creatorName: label(item.nickname ?? object(item.creator).name ?? object(item.creator).nick) || undefined,
    introduction: label(item.introduction ?? item.description ?? item.desc) || undefined,
  };
}

/** Match mobile search (type=playlist), keeping raw page size for filtered/duplicate items. */
export async function searchPlaylistsPage(keyword: string, baseUrl?: string, page = 1): Promise<PlaylistPage> {
  const query = keyword.trim();
  if (!query) return { list: [], hasMore: false };
  const safePage = Number.isFinite(page) ? Math.min(1000, Math.max(1, Math.floor(page))) : 1;
  const data = await request('/api/search', { keyword: query, type: 'playlist', num: PLAYLIST_PAGE_SIZE, page: safePage }, baseUrl);
  const result = object(data);
  const nested = object(result.playlist);
  const rawList = requiredList(Array.isArray(data) ? data : result.list ?? result.playlists ?? nested.list, '歌单搜索结果');
  const seen = new Set<string>();
  const list = rawList.map(normalizePlaylist).filter((item): item is PlaylistInfo => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const total = number(result.total ?? result.sum ?? nested.total);
  const offset = (safePage - 1) * PLAYLIST_PAGE_SIZE;
  return { list, total, hasMore: safePage < 1000 && rawList.length > 0 &&
    (total === undefined ? rawList.length >= PLAYLIST_PAGE_SIZE : offset + rawList.length < total) };
}

export function getCategoryPlaylists(categoryId: number, page = 1): Promise<PlaylistPage> {
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  return cachedDiscovery(['category-playlists', 'qq-public', categoryId, safePage], DISCOVERY_TTL.playlists,
    () => loadCategoryPlaylists(categoryId, safePage), (value): value is PlaylistPage => {
      const result = object(value);
      return Array.isArray(result.list) && result.list.every(cachedPlaylist) && typeof result.hasMore === 'boolean' && optionalFields(result, [], ['total']);
    });
}

async function loadCategoryPlaylists(categoryId: number, page: number): Promise<PlaylistPage> {
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  const sin = (safePage - 1) * PLAYLIST_PAGE_SIZE;
  const data = object(await request('/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg', {
    ...QQ_PARAMS, sortId: 5, categoryId, sin, ein: sin + PLAYLIST_PAGE_SIZE - 1, picmid: 1,
  }));
  const rawList = requiredList(data.list, '分类歌单');
  const seen = new Set<string>();
  const list = rawList.map(normalizePlaylist).filter((item): item is PlaylistInfo => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const total = number(data.sum ?? data.total);
  return { list, total, hasMore: rawList.length > 0 && (total === undefined ? rawList.length >= PLAYLIST_PAGE_SIZE : sin + rawList.length < total) };
}

export function getPlaylist(id: string, baseUrl?: string): Promise<PlaylistDetail> {
  return cachedDiscovery(['playlist', discoveryServiceKey(baseUrl), id], DISCOVERY_TTL.playlistDetail,
    () => loadPlaylist(id, baseUrl), (value): value is PlaylistDetail => cachedPlaylist(value) && cachedTracks(object(value).tracks));
}

/** Imports always read the current source rather than a previously browsed playlist snapshot. */
export function getPlaylistForImport(id: string, baseUrl?: string): Promise<PlaylistDetail> {
  return loadPlaylist(id, baseUrl);
}

export async function resolvePlaylistId(input: string): Promise<string | undefined> {
  const direct = parsePlaylistId(input);
  if (direct) return direct;
  if (!input.trim() || input.length > 4096) return undefined;
  if (typeof window === 'undefined' || !window.desktop?.resolvePlaylistId) {
    throw new Error('桌面服务尚未连接，请在 Xmusic Windows 客户端中解析分享链接。');
  }
  const resolved = await window.desktop.resolvePlaylistId(input);
  return resolved ? parsePlaylistId(resolved) : undefined;
}

async function loadPlaylist(id: string, baseUrl?: string): Promise<PlaylistDetail> {
  if (!/^\d{1,20}$/.test(id) || !parsePlaylistId(id)) throw new Error('请输入有效的 QQ 音乐歌单 ID。');
  const data = object(await request('/api/playlist', { id, num: 2000 }, baseUrl));
  const info = object(data.dirinfo);
  const songs = requiredList(data.songlist ?? data.songs, '歌单歌曲');
  const summary = normalizePlaylist({ ...data, ...info, id, title: info.title ?? data.name ?? data.title }) ?? { id, title: '歌单' };
  return {
    ...summary,
    id,
    songCount: number(info.songnum ?? info.song_count ?? info.songCount ?? data.songnum ?? data.song_count ?? data.songCount ?? data.total),
    tracks: mergeTracks([], songs.map(normalizeTrack).filter((track): track is Track => track !== undefined)),
  };
}

/** Resolve bulk actions without flooding song-detail endpoints; retain selection order and individual failures. */
export async function resolveDiscoveryTracks(
  tracks: Track[],
  baseUrl?: string,
  onProgress?: (completed: number, total: number) => void,
  isActive: () => boolean = () => true,
): Promise<{ tracks: Track[]; failed: { track: Track; error: string }[] }> {
  const resolved: (Track | undefined)[] = Array(tracks.length);
  const failed: ({ track: Track; error: string } | undefined)[] = Array(tracks.length);
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (cursor < tracks.length && isActive()) {
      const index = cursor++;
      const track = tracks[index];
      try { resolved[index] = await resolveTrackById(track, baseUrl); }
      catch (error) { failed[index] = { track, error: error instanceof Error ? error.message : '歌曲信息获取失败' }; }
      completed += 1;
      if (isActive()) onProgress?.(completed, tracks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, tracks.length) }, worker));
  return {
    tracks: resolved.filter((track): track is Track => track !== undefined),
    failed: failed.filter((item): item is { track: Track; error: string } => item !== undefined),
  };
}
