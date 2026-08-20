import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {BASE_URL, DEFAULT_QUALITY} from '../constants/config';
import {getPlayQuality} from './settings';
import {
  cachedGet,
  cachePeekMany,
  cachePeekStale,
  cachePutMany,
  cacheTouch,
  dropCache,
  clearApiCache,
} from './cache';
import {isFavPlaylist} from './store';
import type {Playlist, Song} from '../types/music';

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
});

// ===== 开发者模式：自定义 API 接口 =====

const CUSTOM_API_KEY = 'custom_api_url';

// 启动时应用已保存的自定义接口（有则覆盖内置地址），此后所有请求走该接口
AsyncStorage.getItem(CUSTOM_API_KEY)
  .then(url => {
    if (url) {
      api.defaults.baseURL = url;
    }
  })
  .catch(() => {});

/** 当前自定义接口地址（空串表示使用内置接口，内置地址不对外暴露） */
export async function getCustomApiUrl(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(CUSTOM_API_KEY)) ?? '';
  } catch (e) {
    return '';
  }
}

/**
 * 保存自定义接口（开发者模式）；传空恢复内置接口。
 * 立即生效并清空接口缓存，避免新旧接口数据混用。
 */
export async function setCustomApiUrl(url: string) {
  const clean = url.trim().replace(/\/+$/, '');
  if (clean) {
    await AsyncStorage.setItem(CUSTOM_API_KEY, clean);
    api.defaults.baseURL = clean;
  } else {
    await AsyncStorage.removeItem(CUSTOM_API_KEY);
    api.defaults.baseURL = BASE_URL;
  }
  await clearApiCache().catch(() => {});
}

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

/** 简易延时（getSongUrls 空直链重试的退避用） */
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function search(keyword: string, type: 'song' | 'singer' | 'album' | 'playlist' = 'song', num = 20, page = 1) {
  return cachedGet(`search:${type}:${keyword}:${num}:${page}`, TTL_SEARCH, async () => {
    const {data} = await api.get('/api/search', {params: {keyword, type, num, page}});
    return data?.data?.list as Song[] | Playlist[] | any[];
  });
}

/** 歌单搜索结果摘要（搜索/歌单广场列表项） */
export type PlaylistInfo = {
  dissid: number | string;
  title: string;
  coverUrl?: string;
  songCount?: number;
  listenNum?: number;
  creatorName?: string;
  introduction?: string;
};

/** 搜索歌单（type=playlist），实测返回字段：dissid/dissname/logo/songnum/listennum/nickname/description */
export async function searchPlaylists(
  keyword: string,
  num = 20,
  page = 1,
): Promise<PlaylistInfo[]> {
  const list = ((await search(keyword, 'playlist', num, page)) ?? []) as any[];
  const stripEm = (s: any) => String(s ?? '').replace(/<\/?em>/g, '');
  return list
    .map(p => ({
      dissid: p.dissid ?? p.tid ?? p.id,
      title: stripEm(p.dissname ?? p.title ?? p.name),
      coverUrl: httpsUrl(
        p.logo ?? p.imgurl ?? p.imgUrl ?? p.cover ?? p.picurl ?? p.pic,
      ),
      songCount: p.songnum ?? p.song_count ?? p.songCount,
      listenNum: p.listennum ?? p.listenNum ?? p.access_num ?? p.playNum,
      creatorName:
        stripEm(p.nickname ?? p.creator?.name ?? p.creator?.nick) || undefined,
      introduction:
        stripEm(p.description ?? p.introduction ?? p.desc)
          .replace(/\s+/g, ' ')
          .trim() || undefined,
    }))
    .filter(p => p.dissid && p.title) as PlaylistInfo[];
}

// ===== 歌单分类（QQ 官网歌单广场公开接口，直连 c.y.qq.com，与第三方 API 无关） =====

export type PlaylistCategory = {id: number; name: string};
export type PlaylistCategoryGroup = {group: string; items: PlaylistCategory[]};

const QQ_HEADERS = {Referer: 'https://y.qq.com/'};
const QQ_FCG_PARAMS = {format: 'json', inCharset: 'utf8', outCharset: 'utf-8'};

/** 官网歌单分类配置（语种/流派/主题/心情/场景），变化极少长缓存 */
export async function getPlaylistCategories(): Promise<PlaylistCategoryGroup[]> {
  return cachedGet('plCategories', TTL_DETAIL, async () => {
    const {data} = await axios.get(
      'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg',
      {params: QQ_FCG_PARAMS, headers: QQ_HEADERS, timeout: 15000},
    );
    const cats: any[] = data?.data?.categories ?? [];
    return cats
      .map(c => ({
        group: String(c.categoryGroupName ?? ''),
        items: (c.items ?? []).map((i: any) => ({
          id: i.categoryId,
          // 分类名里的实体转义（如 R&#38;B → R&B）
          name: String(i.categoryName ?? '').replace(/&#38;/g, '&'),
        })),
      }))
      .filter(g => g.group && g.items.length) as PlaylistCategoryGroup[];
  });
}

/** 「全部」分类 id（官网热门歌单） */
export const CATEGORY_ALL_ID = 10000000;

/** 按分类取官网歌单广场数据（sin/ein 区间分页），返回列表与总数 */
export async function getPlaylistsByCategory(
  categoryId: number,
  num = 20,
  page = 1,
): Promise<{list: PlaylistInfo[]; total: number}> {
  const sin = (page - 1) * num;
  return cachedGet(`plByCat:${categoryId}:${num}:${page}`, TTL_PLAYLIST, async () => {
    const {data} = await axios.get(
      'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg',
      {
        params: {
          ...QQ_FCG_PARAMS,
          sortId: 5,
          categoryId,
          sin,
          ein: sin + num - 1,
          picmid: 1,
        },
        headers: QQ_HEADERS,
        timeout: 15000,
      },
    );
    const d = data?.data ?? {};
    const list = ((d.list ?? []) as any[])
      .map(p => ({
        dissid: p.dissid,
        title: String(p.dissname ?? ''),
        coverUrl: httpsUrl(p.imgurl),
        listenNum: p.listennum,
        creatorName: p.creator?.name || undefined,
        introduction:
          String(p.introduction ?? '')
            .replace(/\s+/g, ' ')
            .trim() || undefined,
      }))
      .filter(p => p.dissid && p.title) as PlaylistInfo[];
    return {list, total: d.sum ?? 0};
  });
}

/**
 * 批量取播放直链，按 mid+音质粒度缓存（持久化，重启后仍有效）：
 * 重复播同一歌单/重启恢复队列时命中缓存直接用，只请求未命中的 mid。
 * force=true 绕过缓存全量重取（播放失败重解析时用）。
 * 接口偶发对部分 mid 返回空直链（并非真的无版权/下架），会误判为「不可播放」导致
 * 无法点击播放；当前单次请求只接受非空直链，后续播放时可按需强制刷新。
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
  // 对未命中的 mid 请求直链；仅请求一轮，不再对空直链重试。
  const fresh: Record<string, string> = {};
  let pending = misses;
  const MAX_ATTEMPTS = 1;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length; attempt++) {
    try {
      const {data} = await api.get('/api/song/url', {
        params: {mid: pending.join(','), quality},
      });
      const map = (data?.data ?? {}) as Record<string, string>;
      for (const mid of pending) {
        if (map[mid]) {
          fresh[mid] = map[mid];
        }
      }
    } catch (e) {}
    pending = pending.filter(mid => !fresh[mid]);
  }
  cachePutMany(
    Object.keys(fresh).map(mid => [keyOf(mid), fresh[mid]] as [string, string]),
    TTL_SONG_URL,
  );
  return Object.assign(result, fresh);
}

/** 按用户设置的播放音质批量取播放链接（服务端不可用时自动降级） */
export async function getPreferredSongUrls(mids: string[], force = false) {
  const quality = await getPlayQuality();
  // API 文档未规定 mid 参数长度上限；按 50 首拆分，避免大歌单请求超过 URL/网关限制。
  if (mids.length <= 50) {
    return getSongUrls(mids, quality, force);
  }
  const unique = [...new Set(mids.filter(Boolean))];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += 50) {
    batches.push(unique.slice(i, i + 50));
  }
  const results = await Promise.all(
    batches.map(batch => getSongUrls(batch, quality, force).catch(() => ({}))),
  );
  return Object.assign({}, ...results);
}

/** 分批解析歌曲播放直链（每批 50 个 mid，避免 URL 过长），保留本地歌曲 */
export async function resolveSongUrls(songs: Song[]): Promise<Song[]> {
  // 已经有本地文件的歌曲无需请求在线直链；离线歌单播放时避免无意义的网络等待。
  const mids = songs
    .filter(s => !s.localPath && !s.uri && !s.filePath)
    .map(s => s.mid!)
    .filter(Boolean);
  const urlMap: Record<string, string> = {};
  // 多批并行请求，大幅提升导入时检测可播放性的速度
  const tasks: Promise<Record<string, string>>[] = [];
  for (let i = 0; i < mids.length; i += 50) {
    tasks.push(
      getPreferredSongUrls(mids.slice(i, i + 50)).catch(() => ({})),
    );
  }
  const results = await Promise.all(tasks);
  for (const r of results) {
    Object.assign(urlMap, r);
  }
  return songs
    .map(s => ({...s, url: (s.mid && urlMap[s.mid]) || s.url}))
    .filter(s => !!s.url || !!s.localPath || !!s.uri || !!s.filePath);
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
  // 查询参数式（...?id=123）与路径式（.../playlist/123）两种落地页格式
  const m = s.match(/[?&]id=(\d+)/) ?? s.match(/\/playlist\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/**
 * 解析歌单 ID（支持分享短链）：直接解析不出时，把输入里的链接
 * （如 https://c6.y.qq.com/base/fcgi-bin/u?__=xxx）请求一次跟随重定向，
 * 用最终落地页地址再解析；落地页地址也没有时从页面内容里找 disstid
 */
export async function resolvePlaylistId(
  input: string,
): Promise<number | undefined> {
  const direct = parsePlaylistId(input);
  if (direct) {
    return direct;
  }
  // 分享文本常混着文案，抠出第一个链接
  const urlMatch = input.match(/https?:\/\/[^\s，。"'<>]+/i);
  if (!urlMatch) {
    return undefined;
  }
  // fetch 无内置超时，短链服务偶发不响应时用 AbortController 兜底
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(urlMatch[0], {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      },
      signal: controller.signal,
    });
    // fetch 自动跟随 302，res.url 即最终落地页地址
    const fromUrl = parsePlaylistId(res.url ?? '');
    if (fromUrl) {
      return fromUrl;
    }
    const html = await res.text();
    const m =
      html.match(/\bdisstid[=:"']+(\d{4,})/i) ?? html.match(/[?&]id=(\d{4,})/);
    return m ? Number(m[1]) : undefined;
  } catch (e) {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 歌单：兼容 QQ 原始结构（dirinfo/songlist）与文档结构（name/songs） */
async function requestPlaylist(id: number, num = 2000): Promise<Playlist> {
  const {data} = await api.get('/api/playlist', {params: {id, num}});
  const d = data?.data ?? {};
  const rawSongs: any[] = d.songlist ?? d.songs ?? [];
  const info = d.dirinfo ?? {};
  const countRaw =
    info.songnum ??
    info.song_count ??
    info.songCount ??
    d.songnum ??
    d.song_count ??
    d.songCount ??
    d.total;
  const songCount = Number(countRaw);
  return {
    id: info.id ?? d.id ?? id,
    name: info.title ?? d.name ?? '',
    coverUrl: httpsUrl(info.picurl),
    songCount:
      Number.isFinite(songCount) && songCount > 0 ? songCount : undefined,
    songs: rawSongs.map(s => normalizeSong(s)),
  } as Playlist;
}

export async function getPlaylist(id: number): Promise<Playlist> {
  // 收藏的歌单用 7 天长缓存（秒开、弱网可用），普通歌单 30 分钟；
  // 「同步更新」走 getPlaylistFresh 绕过缓存拉最新
  const faved = await isFavPlaylist(id).catch(() => false);
  return cachedGet(
    `playlist:${id}:full`,
    faved ? TTL_DETAIL : TTL_PLAYLIST,
    () => requestPlaylist(id, 2000),
  );
}

/** 导入/同步专用拉取：绕过旧缓存，单次请求并保留服务端总数供界面提示。 */
export async function getPlaylistStable(id: number): Promise<Playlist> {
  const faved = await isFavPlaylist(id).catch(() => false);
  const result = await requestPlaylist(id, 2000);
  cachePutMany(
    [[`playlist:${id}:full`, result]],
    faved ? TTL_DETAIL : TTL_PLAYLIST,
  );
  return result;
}

/** 离线打开收藏歌单时读取最近一次成功缓存，即使缓存 TTL 已过期也可用。 */
export async function getCachedPlaylist(
  id: number | string,
): Promise<Playlist | undefined> {
  return cachePeekStale<Playlist>(`playlist:${id}:full`);
}

/** 收藏歌单时调用：把已缓存的歌单内容续期为长缓存（无缓存时不做事） */
export function pinPlaylistCache(id: number | string) {
  cacheTouch(`playlist:${id}:full`, TTL_DETAIL);
}

/** 绕过缓存拉取最新歌单内容（收藏/导入歌单「同步更新」用） */
export async function getPlaylistFresh(id: number): Promise<Playlist> {
  dropCache(`playlist:${id}:full`);
  return getPlaylistStable(id);
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

/** 不展示的榜单（按标题屏蔽，如海外方接口下架/内容质量差的榜单） */
const HIDDEN_RANK_TITLES = new Set(['Global-K Chart']);

/** 榜单列表（/api/top 不带 id，返回分组的所有榜单）；force 丢弃缓存强制重拉 */
export async function getTopGroups(force?: boolean): Promise<RankInfo[]> {
  if (force) {
    dropCache('topGroups');
  }
  const ranks = await cachedGet('topGroups', TTL_TOP, async () => {
    const {data} = await api.get('/api/top');
    const groups: any[] = data?.data?.group ?? [];
    const list: RankInfo[] = [];
    for (const g of groups) {
      for (const t of g?.toplist ?? []) {
        const song0 = t?.song?.[0];
        list.push({
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
    return list;
  });
  // 屏蔽过滤放在缓存之外：命中旧缓存的数据同样生效
  return ranks.filter(r => !HIDDEN_RANK_TITLES.has(r.title));
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
          setMidCache(t.id, full); // 顺带填充 id->mid 缓存，播放时免二次请求
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
const MID_CACHE_LIMIT = 1000;
const midCache = new Map<number, Song>();

function setMidCache(id: number, song: Song) {
  midCache.delete(id);
  midCache.set(id, song);
  while (midCache.size > MID_CACHE_LIMIT) {
    const oldest = midCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    midCache.delete(oldest);
  }
}

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
    setMidCache(id, song);
    return song;
  } catch (e) {
    return undefined;
  }
}
