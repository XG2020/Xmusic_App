import axios from 'axios';
import {BASE_URL, DEFAULT_QUALITY} from '../constants/config';
import {getPlayQuality} from './settings';
import {cachedGet, cachePeekMany, cachePutMany} from './cache';
import type {Playlist, Song} from '../types/music';

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
});

// 缓存时长（直链有时效，短 TTL 缓存 + 播放失败强制重解析兜底）
const MIN = 60_000;
const TTL_SEARCH = 10 * MIN;
const TTL_TOP = 30 * MIN;
const TTL_PLAYLIST = 30 * MIN;
const TTL_DETAIL = 7 * 24 * 60 * MIN;
const TTL_LYRIC = 7 * 24 * 60 * MIN;
const TTL_SONG_URL = 60 * MIN;

/** 图片直链统一转 https（安卓默认禁明文流量，http 封面会被拦截不显示） */
function httpsUrl(url?: string) {
  return url ? url.replace(/^http:\/\//i, 'https://') : undefined;
}

export async function search(keyword: string, type: 'song' | 'singer' | 'album' | 'playlist' = 'song', num = 20, page = 1) {
  return cachedGet(`search:${type}:${keyword}:${num}:${page}`, TTL_SEARCH, async () => {
    const {data} = await api.get('/api/search', {params: {keyword, type, num, page}});
    return data?.data?.list as Song[] | Playlist[] | any[];
  });
}

/**
 * 批量取播放直链，按 mid+音质粒度缓存（持久化，重启后仍有效）：
 * 重复播同一歌单/重启恢复队列时命中缓存直接用，只请求未命中的 mid。
 * force=true 绕过缓存全量重取（播放失败重解析时用）。
 */
export async function getSongUrls(
  mids: string[],
  quality = DEFAULT_QUALITY,
  force = false,
) {
  const keyOf = (mid: string) => `surl:${quality}:${mid}`;
  const result: Record<string, string> = {};
  let misses = mids;
  if (!force) {
    const hit = await cachePeekMany<string>(mids.map(keyOf));
    misses = mids.filter(mid => {
      const v = hit.get(keyOf(mid));
      if (v) {
        result[mid] = v;
        return false;
      }
      return true;
    });
    if (!misses.length) {
      return result;
    }
  }
  const {data} = await api.get('/api/song/url', {params: {mid: misses.join(','), quality}});
  const freshMap = (data?.data ?? {}) as Record<string, string>;
  cachePutMany(
    misses.filter(mid => freshMap[mid]).map(mid => [keyOf(mid), freshMap[mid]]),
    TTL_SONG_URL,
  );
  return Object.assign(result, freshMap);
}

/** 按用户设置的播放音质批量取播放链接（服务端不可用时自动降级） */
export async function getPreferredSongUrls(mids: string[], force = false) {
  const quality = await getPlayQuality();
  return getSongUrls(mids, quality, force);
}

/** 分批解析歌曲播放直链（每批 50 个 mid，避免 URL 过长），保留本地歌曲 */
export async function resolveSongUrls(songs: Song[]): Promise<Song[]> {
  const mids = songs.map(s => s.mid!).filter(Boolean);
  const urlMap: Record<string, string> = {};
  for (let i = 0; i < mids.length; i += 50) {
    try {
      Object.assign(urlMap, await getPreferredSongUrls(mids.slice(i, i + 50)));
    } catch (e) {
      // 单批失败跳过
    }
  }
  return songs
    .map(s => ({...s, url: (s.mid && urlMap[s.mid]) || s.url}))
    .filter(s => !!s.url || !!s.localPath);
}

export async function getSongDetail(params: {mid?: string; id?: number}) {
  return cachedGet(`detail:${params.mid ?? params.id}`, TTL_DETAIL, async () => {
    const {data} = await api.get('/api/song/detail', {params});
    return data?.data;
  });
}

/**
 * 封面直链（y.gtimg.cn 官方 CDN，无需经过 API 302）
 * 优先 pmid（含版本号），其次专辑 mid
 */
export function albumCoverUrl(album?: {mid?: string; pmid?: string}, size = 300) {
  const key = album?.pmid || album?.mid;
  if (!key) {
    return undefined;
  }
  return `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${key}.jpg`;
}

/** 给歌曲补充封面直链（不覆盖已有的 coverUrl） */
export function withCover(song: Song, size = 300): Song {
  return song.coverUrl ? song : {...song, coverUrl: albumCoverUrl(song.album, size)};
}

export async function getLyric(options: {mid?: string; id?: number; qrc?: boolean; trans?: boolean; roma?: boolean}) {
  const key = `lyric:${options.mid ?? options.id}:${options.qrc ? 1 : 0}:${options.trans ? 1 : 0}:${options.roma ? 1 : 0}`;
  return cachedGet(key, TTL_LYRIC, async () => {
    const {data} = await api.get('/api/lyric', {params: options});
    return data?.data as {lyric?: string; trans?: string; roma?: string};
  });
}

export async function getAlbum(mid: string) {
  return cachedGet(`album:${mid}`, TTL_DETAIL, async () => {
    const {data} = await api.get('/api/album', {params: {mid}});
    return data?.data;
  });
}

/** 从 QQ 音乐歌单分享链接或纯数字中提取歌单 ID */
export function parsePlaylistId(input: string): number | undefined {
  const s = input.trim();
  if (/^\d+$/.test(s)) {
    return Number(s);
  }
  const m = s.match(/[?&]id=(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** 歌单：兼容 QQ 原始结构（dirinfo/songlist）与文档结构（name/songs） */
export async function getPlaylist(id: number): Promise<Playlist> {
  // num 显式传大值：服务端默认只返回 100 首，导入大歌单会被截断
  return cachedGet(`playlist:${id}:full`, TTL_PLAYLIST, async () => {
    const {data} = await api.get('/api/playlist', {params: {id, num: 2000}});
    const d = data?.data ?? {};
    const rawSongs: any[] = d.songlist ?? d.songs ?? [];
    return {
      id: d.dirinfo?.id ?? d.id ?? id,
      name: d.dirinfo?.title ?? d.name ?? '',
      coverUrl: httpsUrl(d.dirinfo?.picurl),
      songs: rawSongs.map(s => normalizeSong(s)),
    } as Playlist;
  });
}

export async function getSinger(mid: string) {
  return cachedGet(`singer:${mid}`, TTL_DETAIL, async () => {
    const {data} = await api.get('/api/singer', {params: {mid}});
    return data?.data;
  });
}

export type RankInfo = {
  topId: number;
  title: string;
  period?: string;
  listenNum?: number;
  coverUrl?: string;
  top3?: {title: string; singerName: string}[];
};

/** 榜单列表（/api/top 不带 id，返回分组的所有榜单） */
export async function getTopGroups(): Promise<RankInfo[]> {
  return cachedGet('topGroups', TTL_TOP, async () => {
    const {data} = await api.get('/api/top');
    const groups: any[] = data?.data?.group ?? [];
    const ranks: RankInfo[] = [];
    for (const g of groups) {
      for (const t of g?.toplist ?? []) {
        const song0 = t?.song?.[0];
        ranks.push({
          topId: t.topId,
          title: t.title,
          period: t.period,
          listenNum: t.listenNum,
          coverUrl: httpsUrl(t.frontPicUrl ?? t.headPicUrl ?? song0?.cover),
          top3: (t?.song ?? []).slice(0, 3).map((s: any) => ({
            title: s.title,
            singerName: s.singerName,
          })),
        });
      }
    }
    return ranks;
  });
}

/** 指定榜单歌曲（返回结构为 data.data.song，字段是 songId/singerName/cover） */
export async function getTopSongs(id: number, num = 50): Promise<Song[]> {
  return cachedGet(`top2:${id}:${num}`, TTL_TOP, async () => {
    const {data} = await api.get('/api/top', {params: {id, num}});
    const d = data?.data?.data ?? data?.data ?? {};
    const rawSongs: any[] = d.song ?? d.songs ?? d.list ?? [];
    // 部分榜单（如巅峰潮流榜）简版 song 里 cover/albumMid 全为空，
    // 但响应同级带完整 track_info 的 songInfoList，可取 mid 与专辑 pmid 拼封面
    const infoList: any[] = data?.data?.songInfoList ?? d.songInfoList ?? [];
    const infoMap = new Map<number, Song>();
    for (const t of infoList) {
      if (t?.id) {
        const full = normalizeSong(t);
        infoMap.set(t.id, full);
        if (full.mid) {
          midCache.set(t.id, full); // 顺带填充 id->mid 缓存，播放时免二次请求
        }
      }
    }
    return rawSongs.map(s => {
      const full = infoMap.get(s.songId);
      return {
        id: s.songId,
        mid: full?.mid,
        title: s.title,
        singer: s.singerName
          ? [{mid: s.singerMid, name: s.singerName}]
          : full?.singer,
        album: full?.album ?? (s.albumMid ? {mid: s.albumMid} : undefined),
        interval: full?.interval,
        // cover 字段缺失时用完整信息里的专辑封面兜底
        coverUrl:
          httpsUrl(s.cover) ??
          full?.coverUrl ??
          albumCoverUrl({mid: s.albumMid}),
      };
    }) as Song[];
  });
}

/** 将 QQ 原始 song 结构规整为内部 Song */
export function normalizeSong(s: any): Song {
  return {
    mid: s.mid,
    id: s.id ?? s.songId,
    title: s.title ?? s.name,
    singer: (s.singer ?? []).map((x: any) => ({mid: x.mid, name: x.name})),
    album: s.album ? {mid: s.album.mid, pmid: s.album.pmid, name: s.album.name} : undefined,
    interval: s.interval,
    coverUrl: albumCoverUrl(s.album),
  };
}

// id -> mid 解析缓存（榜单歌曲只有 songId）
const midCache = new Map<number, Song>();

/** 通过歌曲 id 获取完整信息（含 mid），带缓存 */
export async function resolveSongById(id: number): Promise<Song | undefined> {
  if (midCache.has(id)) {
    return midCache.get(id);
  }
  try {
    const d = await getSongDetail({id});
    const t = d?.track_info ?? d;
    if (!t?.mid) {
      return undefined;
    }
    const song = normalizeSong(t);
    midCache.set(id, song);
    return song;
  } catch (e) {
    return undefined;
  }
}
