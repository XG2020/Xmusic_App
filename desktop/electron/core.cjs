'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { MAX_COVER_BYTES, ownFile, validOwnedFile, verifyOwnedFile } = require('./download-files.cjs');
const { MAX_IMPORT_FILES, scanAudioFolders, readSidecarArtwork } = require('./local-files.cjs');

const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus', 'aac', 'webm'];
const MIME_TYPES = {
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', m4a: 'audio/mp4',
  ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', webm: 'audio/webm',
};
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LYRICS_BYTES = 2 * 1024 * 1024;
const MAX_API_BYTES = 4 * 1024 * 1024;
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DOWNLOAD_QUALITIES = ['128', '320', 'flac'];
// The built-in origin stays out of source. Tests and private builds inject an HTTPS
// origin with no credentials, query, fragment, or required path through this variable.
const DEFAULT_BASE_URL = process.env.XMUSIC_BUILTIN_BASE_URL || '';
const QQ_CATEGORY_PATH = '/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg';
const QQ_PLAYLIST_PATH = '/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg';
const QQ_TOP_PATH = '/cgi-bin/musicu.fcg';
const isQqDiscoveryPath = route => route === QQ_CATEGORY_PATH || route === QQ_PLAYLIST_PATH;

function extension(filePath) {
  return path.extname(filePath).slice(1).toLowerCase();
}

function pathIdentity(filePath) {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value.trim().slice(0, 500) || fallback : fallback;
}

function downloadIdentity(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !['mid', 'quality'].includes(key)) ||
      typeof value.mid !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.mid) || !DOWNLOAD_QUALITIES.includes(value.quality)) return undefined;
  return {mid: value.mid, quality: value.quality};
}

function storedDownloadIdentity(value, filePath) {
  if (!plainObject(value) || Object.keys(value).some(key => !['mid', 'quality', 'file'].includes(key))) return undefined;
  const identity = downloadIdentity({mid: value.mid, quality: value.quality});
  if (!identity || !validOwnedFile(value.file) || value.file.kind !== 'audio' || value.file.name !== path.basename(filePath)) return undefined;
  const {name, kind, size, dev, ino, mtimeMs, sha256} = value.file;
  return {...identity, file: {name, kind, size, dev, ino, mtimeMs, sha256}};
}

function sanitizeMetadata(metadata, filePath) {
  const result = {
    title: cleanText(metadata?.title, path.basename(filePath, path.extname(filePath))),
    artist: cleanText(metadata?.artist, '未知歌手'),
    album: cleanText(metadata?.album),
  };
  if (Number.isFinite(metadata?.duration) && metadata.duration > 0) {
    result.duration = metadata.duration;
  }
  for (const field of ['language', 'genre', 'releaseDate', 'recordLabel']) {
    const value = cleanText(metadata?.[field]);
    if (value) result[field] = value;
  }
  if (typeof metadata?.introduction === 'string' && metadata.introduction.trim()) {
    result.introduction = metadata.introduction.trim().slice(0, 12000);
  }
  if (typeof metadata?.coverUrl === 'string' && metadata.coverUrl.length <= 750000 &&
      /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(metadata.coverUrl)) {
    result.coverUrl = metadata.coverUrl;
  }
  return result;
}

async function loadMetadata(filePath) {
  const { parseFile } = await import('music-metadata');
  const { common, format } = await parseFile(filePath, { duration: false });
  const metadata = {
    title: common.title, artist: common.artist, album: common.album, duration: format.duration,
    language: common.language, genre: common.genre?.join(' / '),
    releaseDate: common.releasedate || common.date || (common.year ? String(common.year) : undefined),
    recordLabel: common.label?.join(' / '),
    introduction: common.comment?.map(comment => comment.text).filter(Boolean).join('\n\n'),
  };
  const cover = common.picture?.find(picture => ['image/jpeg', 'image/png', 'image/webp'].includes(picture.format));
  if (cover && cover.data.length <= 512000) {
    metadata.coverUrl = `data:${cover.format};base64,${Buffer.from(cover.data).toString('base64')}`;
  }
  return metadata;
}

class AudioRegistry {
  constructor(dataDirectory, metadataReader = loadMetadata) {
    this.registryPath = path.join(dataDirectory, 'audio-library.json');
    this.artworkDirectory = path.join(dataDirectory, 'artwork');
    this.records = new Map();
    this.metadataReader = metadataReader;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await fsp.mkdir(path.dirname(this.registryPath), { recursive: true });
    let source;
    try {
      const size = (await fsp.stat(this.registryPath)).size;
      if (size > 32 * 1024 * 1024) throw new Error('本地音乐库过大，无法载入');
      source = JSON.parse(await fsp.readFile(this.registryPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      // Preserve damaged data for recovery instead of silently overwriting it.
      throw new Error('本地音乐库无法读取，请检查 audio-library.json 文件', { cause: error });
    }
    if (!source || source.version !== 1 || !Array.isArray(source.tracks)) {
      throw new Error('本地音乐库格式不受支持');
    }
    for (const record of source.tracks) {
      if (!record || !ID_PATTERN.test(record.id) || typeof record.filePath !== 'string' ||
          !path.isAbsolute(record.filePath) || !AUDIO_EXTENSIONS.includes(extension(record.filePath))) continue;
      this.records.set(record.id, {
        id: record.id,
        filePath: path.normalize(record.filePath),
        metadata: sanitizeMetadata(record.metadata, record.filePath),
        ...(storedDownloadIdentity(record.download, record.filePath) ? {download: storedDownloadIdentity(record.download, record.filePath)} : {}),
        ...(COVER_TYPES.includes(record.coverType) ? { coverType: record.coverType } : {}),
      });
    }
  }

  list() {
    return [...this.records.values()].map(record => ({
      ...record.metadata, key: `local:${record.id}`, localId: record.id, source: 'local',
      ...(record.coverType ? { coverUrl: `xmusic-audio://cover/${record.id}` } : {}),
    }));
  }

  find(localId) {
    if (typeof localId !== 'string' || !ID_PATTERN.test(localId) || !this.records.has(localId)) {
      throw new Error('找不到这首本地音乐，请重新导入');
    }
    return this.records.get(localId);
  }

  async importFiles(filePaths, {download} = {}) {
    if (!Array.isArray(filePaths) || filePaths.length > MAX_IMPORT_FILES) throw new Error('每次最多导入 1000 个音频文件');
    // Mutations are serialized so overlapping imports/removals cannot lose a save.
    return this.mutate(async createdArtwork => {
      const failures = [];
      const selectedIds = new Set();
      const recordsByPath = new Map([...this.records.values()].map(record => [pathIdentity(record.filePath), record]));
      for (const selectedPath of filePaths) {
        try {
          if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath) ||
              !AUDIO_EXTENSIONS.includes(extension(selectedPath))) throw new Error('不支持的音频格式');
          const filePath = await fsp.realpath(selectedPath);
          if (!AUDIO_EXTENSIONS.includes(extension(filePath))) throw new Error('不支持的音频格式');
          const stat = await fsp.stat(filePath);
          if (!stat.isFile() || stat.size === 0) throw new Error('文件不可用');
          const existing = recordsByPath.get(pathIdentity(filePath));
          if (existing) {
            if (selectedIds.has(existing.id)) continue;
            // Reimporting a download can attach artwork saved after the first
            // import, or restore a missing cache file without changing track IDs.
            const hasArtwork = existing.coverType && await this.resolveArtwork(existing.id).then(() => true, () => false);
            if (!hasArtwork) {
              const metadata = await this.metadataReader(filePath).catch(() => ({}));
              const coverType = await this.cacheArtwork(existing.id, filePath,
                sanitizeMetadata({ ...existing.metadata, ...metadata }, filePath), createdArtwork);
              if (coverType) {
                const refreshedMetadata = { ...existing.metadata };
                delete refreshedMetadata.coverUrl;
                const refreshed = { ...existing, metadata: refreshedMetadata, coverType };
                this.records.set(existing.id, refreshed);
                recordsByPath.set(pathIdentity(filePath), refreshed);
              }
            }
            if (download) {
              const associated = {...this.records.get(existing.id), download};
              this.records.set(existing.id, associated);
              recordsByPath.set(pathIdentity(filePath), associated);
            }
            selectedIds.add(existing.id);
            continue;
          }
          // A malformed or tagless file can still be played by the platform decoder.
          const metadata = await this.metadataReader(filePath).catch(() => ({}));
          const id = randomUUID();
          const safeMetadata = sanitizeMetadata(metadata, filePath);
          const coverType = await this.cacheArtwork(id, filePath, safeMetadata, createdArtwork);
          delete safeMetadata.coverUrl;
          const record = { id, filePath, metadata: safeMetadata, ...(coverType ? { coverType } : {}), ...(download ? {download} : {}) };
          this.records.set(id, record);
          recordsByPath.set(pathIdentity(filePath), record);
          selectedIds.add(id);
        } catch (error) {
          failures.push(error);
        }
      }
      if (filePaths.length && failures.length === filePaths.length) throw new Error('所选文件无法导入，请检查格式和文件权限');
      return this.list().filter(track => selectedIds.has(track.localId));
    });
  }

  async remove(localId) {
    return this.mutate(async () => {
      this.find(localId);
      this.records.delete(localId);
    });
  }

  async importFolders(directoryPaths) {
    const { filePaths, ...scan } = await scanAudioFolders(directoryPaths, AUDIO_EXTENSIONS);
    return { tracks: await this.importFiles(filePaths), ...scan };
  }

  async importDownload(filePath, identity) {
    const download = downloadIdentity(identity);
    if (!download) throw new Error('下载歌曲关联无效');
    const canonicalPath = await fsp.realpath(filePath);
    const file = await ownFile(canonicalPath, 'audio');
    return this.importFiles([canonicalPath], {download: {...download, file}});
  }

  async resolveDownloadedUrl(identity, {excludePaths = []} = {}) {
    const download = downloadIdentity(identity);
    if (!download) throw new Error('下载歌曲关联无效');
    const excluded = new Set(excludePaths.map(pathIdentity));
    for (const record of [...this.records.values()].reverse()) {
      if (record.download?.mid !== download.mid || record.download?.quality !== download.quality || excluded.has(pathIdentity(record.filePath))) continue;
      try {
        // Download history may have been cleared, so retain the original file
        // identity and content hash with this association as well.
        if (!storedDownloadIdentity(record.download, record.filePath)) continue;
        if (await verifyOwnedFile(path.dirname(record.filePath), record.download.file)) return `xmusic-audio://track/${record.id}`;
      } catch { /* Missing or redirected media does not prevent online playback. */ }
    }
    return undefined;
  }

  async cacheArtwork(id, filePath, metadata, createdArtwork) {
    let handle;
    const cachePath = path.join(this.artworkDirectory, `${id}.bin`);
    try {
      let artwork = await readSidecarArtwork(filePath);
      if (!artwork && metadata.coverUrl) {
        const [prefix, encoded] = metadata.coverUrl.split(',');
        artwork = { data: Buffer.from(encoded, 'base64'), mime: prefix.slice(5, prefix.indexOf(';')) };
      }
      if (!artwork) return undefined;
      await fsp.mkdir(this.artworkDirectory, { recursive: true });
      // Never replace an existing cache entry or follow a planted symlink.
      handle = await fsp.open(cachePath, 'wx', 0o600);
      createdArtwork.add(cachePath);
      await handle.writeFile(artwork.data);
      return artwork.mime;
    } catch {
      if (handle) {
        await handle.close().catch(() => {});
        handle = undefined;
        await fsp.unlink(cachePath).catch(() => {});
        createdArtwork.delete(cachePath);
      }
      // Unreadable artwork must not prevent an otherwise valid audio import.
      return undefined;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  // Called only by native download deletion after it has validated task-owned paths.
  async removePaths(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.some(filePath => typeof filePath !== 'string' || !path.isAbsolute(filePath))) {
      throw new Error('本地音乐路径无效');
    }
    const paths = new Set(filePaths.map(filePath => pathIdentity(path.normalize(filePath))));
    return this.mutate(async () => {
      const removed = [];
      for (const [id, record] of this.records) if (paths.has(pathIdentity(record.filePath))) {
        this.records.delete(id);
        removed.push(id);
      }
      return removed;
    });
  }

  mutate(operation) {
    const pending = this.writeQueue.then(async () => {
      const previous = new Map(this.records);
      const createdArtwork = new Set();
      try {
        const result = await operation(createdArtwork);
        const temporaryPath = `${this.registryPath}.${randomUUID()}.tmp`;
        try {
          await fsp.writeFile(temporaryPath, JSON.stringify({ version: 1, tracks: [...this.records.values()] }), { flag: 'wx', mode: 0o600 });
          await fsp.rename(temporaryPath, this.registryPath);
        } finally {
          await fsp.unlink(temporaryPath).catch(() => {});
        }
        for (const record of previous.values()) {
          if (record.coverType && !this.records.has(record.id)) {
            await fsp.unlink(path.join(this.artworkDirectory, `${record.id}.bin`)).catch(() => {});
          }
        }
        return result;
      } catch (error) {
        for (const cachePath of createdArtwork) await fsp.unlink(cachePath).catch(() => {});
        this.records = previous;
        throw error;
      }
    });
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async resolvePath(localId) {
    const record = this.find(localId);
    try {
      const actualPath = await fsp.realpath(record.filePath);
      if (pathIdentity(actualPath) !== pathIdentity(record.filePath) || !(await fsp.stat(actualPath)).isFile()) {
        throw new Error('文件路径已改变');
      }
      return actualPath;
    } catch (error) {
      throw new Error('音频文件已移动、删除或无法读取，请重新导入', { cause: error });
    }
  }

  async resolveUrl(localId) {
    await this.resolvePath(localId);
    return `xmusic-audio://track/${localId}`;
  }

  async resolveArtwork(localId) {
    const record = this.find(localId);
    if (!record.coverType) throw new Error('没有本地封面');
    const coverPath = path.join(this.artworkDirectory, `${record.id}.bin`);
    const actualPath = await fsp.realpath(coverPath);
    if (pathIdentity(actualPath) !== pathIdentity(coverPath)) throw new Error('封面路径无效');
    const stat = await fsp.stat(actualPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_COVER_BYTES) throw new Error('封面文件无效');
    return { filePath: actualPath, mime: record.coverType };
  }

  async readLyrics(localId) {
    const filePath = await this.resolvePath(localId);
    const lyricsPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.lrc`);
    let handle;
    try {
      const realLyricsPath = await fsp.realpath(lyricsPath);
      // An adjacent symlink must not expose an unrelated text file.
      if (pathIdentity(realLyricsPath) !== pathIdentity(lyricsPath)) throw new Error('歌词路径无效');
      handle = await fsp.open(realLyricsPath, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_LYRICS_BYTES) throw new Error('歌词文件过大或不可读取');
      const buffer = Buffer.alloc(MAX_LYRICS_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_LYRICS_BYTES) throw new Error('歌词文件过大');
      const bytes = buffer.subarray(0, bytesRead);
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
      return new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, '');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw new Error('无法读取同名 LRC 歌词文件', { cause: error });
    } finally {
      await handle?.close();
    }
  }
}

function parseRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid audio size');
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end, partial: true };
}

async function localAudioResponse(request, registry) {
  let handle;
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'xmusic-audio:' || !['track', 'cover'].includes(url.hostname) || url.port || url.username ||
        url.password || url.search || url.hash || !/^\/[0-9a-f-]+$/i.test(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    const localId = url.pathname.slice(1);
    const { filePath, mime } = url.hostname === 'cover' ? await registry.resolveArtwork(localId) :
      { filePath: await registry.resolvePath(localId) };
    handle = await fsp.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Not an audio file');
    const range = parseRange(request.headers.get('range'), stat.size);
    if (!range) {
      await handle.close();
      handle = undefined;
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}`, 'Accept-Ranges': 'bytes' } });
    }
    const headers = {
      'Content-Type': mime || MIME_TYPES[extension(filePath)] || 'application/octet-stream',
      'Content-Length': String(Math.max(0, range.end - range.start + 1)),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    };
    if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    if (request.method === 'HEAD' || stat.size === 0) {
      await handle.close();
      handle = undefined;
      return new Response(null, { status: range.partial ? 206 : 200, headers });
    }
    const stream = handle.createReadStream({ start: range.start, end: range.end, autoClose: true });
    handle = undefined; // The response stream now owns the descriptor, including cancellation.
    return new Response(Readable.toWeb(stream), { status: range.partial ? 206 : 200, headers });
  } catch {
    await handle?.close().catch(() => {});
    return new Response('Audio unavailable', { status: 404 });
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function buildApiUrl(input) {
  const routes = {
    '/api/search': ['keyword', 'type', 'num', 'page'],
    '/api/song/url': ['mid', 'quality'],
    '/api/song/detail': ['id', 'mid'],
    '/api/lyric': ['mid', 'id', 'qrc', 'trans', 'roma'],
    '/api/top': ['id', 'num'],
    '/api/playlist': ['id', 'num'],
    [QQ_CATEGORY_PATH]: ['format', 'inCharset', 'outCharset'],
    [QQ_PLAYLIST_PATH]: ['format', 'inCharset', 'outCharset', 'sortId', 'categoryId', 'sin', 'ein', 'picmid'],
  };
  if (!plainObject(input) || typeof input.path !== 'string' || !Object.hasOwn(routes, input.path) ||
      !plainObject(input.params)) throw new Error('接口请求参数无效');
  const base = isQqDiscoveryPath(input.path) ? 'https://c.y.qq.com'
    : input.baseUrl === undefined || input.baseUrl === '' ? DEFAULT_BASE_URL : input.baseUrl;
  if (typeof base !== 'string' || base.length > 2048) throw new Error('请输入有效的服务地址');
  let url;
  try { url = new URL(base); } catch { throw new Error('请输入完整的 HTTP 或 HTTPS 服务地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址仅支持不含账户、查询参数的 HTTP 或 HTTPS 地址');
  }
  if (Object.keys(input.params).length > routes[input.path].length) throw new Error('接口请求参数无效');
  for (const [key, value] of Object.entries(input.params)) {
    if (!routes[input.path].includes(key) || !['string', 'number', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value)) || String(value).length > 2048) {
      throw new Error('接口请求参数无效');
    }
  }
  const params = input.params;
  if (input.path === '/api/search') {
    if (typeof params.keyword !== 'string' || !params.keyword.trim() || params.keyword.length > 200 ||
        (params.type !== undefined && !['song', 'singer', 'album', 'playlist'].includes(params.type))) throw new Error('搜索关键词或类型无效');
    for (const [key, maximum] of [['num', 100], ['page', 1000]]) {
      if (params[key] !== undefined && (!positiveInteger(params[key]) || Number(params[key]) > maximum)) throw new Error('搜索页码或数量无效');
    }
  }
  if (input.path === '/api/song/url' && (!validMid(params.mid) || (params.quality !== undefined && !['128', '320', 'flac'].includes(params.quality)))) {
    throw new Error('歌曲标识或音质无效');
  }

  if (input.path === '/api/song/detail') {
    const singleMid = value => validMid(value) && !value.includes(',');
    if ((!singleMid(params.mid) && !positiveInteger(params.id)) ||
        (params.mid !== undefined && !singleMid(params.mid)) ||
        (params.id !== undefined && !positiveInteger(params.id))) throw new Error('歌曲详情标识无效');
  }
  if (['/api/top', '/api/playlist'].includes(input.path)) {
    if ((input.path !== '/api/top' || params.id !== undefined) && !positiveInteger(params.id)) throw new Error('榜单、歌单或歌曲标识无效');
    const maximum = input.path === '/api/playlist' ? 2000 : 100;
    if (params.num !== undefined && (!positiveInteger(params.num) || Number(params.num) > maximum)) throw new Error('歌曲数量无效');
  }
  if (isQqDiscoveryPath(input.path)) {
    for (const [key, expected] of [['format', 'json'], ['inCharset', 'utf8'], ['outCharset', 'utf-8']]) {
      if (params[key] !== expected) throw new Error('歌单分类请求参数无效');
    }
    if (input.path === QQ_PLAYLIST_PATH) {
      const index = value => ['string', 'number'].includes(typeof value) && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
      if (!positiveInteger(params.categoryId) || Number(params.sortId) !== 5 || typeof params.sortId === 'boolean' ||
          Number(params.picmid) !== 1 || typeof params.picmid === 'boolean' ||
          !index(params.sin) || !index(params.ein) || Number(params.ein) < Number(params.sin) ||
          Number(params.ein) - Number(params.sin) >= 100 || Number(params.ein) > 100000) throw new Error('歌单分类或分页无效');
    }
  }
  if (input.path === '/api/lyric') {
    if ((!validMid(params.mid) && !positiveInteger(params.id)) ||
        (params.mid !== undefined && !validMid(params.mid)) ||
        (params.id !== undefined && !positiveInteger(params.id))) throw new Error('歌词歌曲标识无效');
    for (const key of ['qrc', 'trans', 'roma']) {
      if (params[key] !== undefined && ![true, false, 0, 1, 'true', 'false', '0', '1'].includes(params[key])) throw new Error('歌词请求参数无效');
    }
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}${input.path}`;
  url.search = '';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

function validMid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/.test(value) && value.length <= 2048;
}

function positiveInteger(value) {
  return ['string', 'number'].includes(typeof value) && /^[0-9]+$/.test(String(value)) &&
    Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function forbiddenApiMessage(input, code, browserChallenge = false) {
  const qq = isQqDiscoveryPath(input.path) || input.path === QQ_TOP_PATH;
  const custom = !qq && input.baseUrl !== undefined && input.baseUrl !== '';
  const source = input.path === QQ_TOP_PATH ? 'QQ 榜单服务' : qq ? 'QQ 歌单服务' : custom ? '自定义服务' : '内置服务';
  const action = qq ? '请稍后重新加载。'
    : custom ? '请检查设置中的服务地址与服务端访问限制，或清空地址恢复内置服务。'
    : '请稍后重新加载；若持续失败，可在设置中配置可用的服务地址。';
  const reason = browserChallenge ? '音乐服务要求浏览器验证' : '音乐服务拒绝访问';
  // Identify the configured source without echoing a private host or query into the UI.
  return `${reason}（${code}，${source}）。${action}`;
}

function officialTopUrl(params) {
  const detail = params.id !== undefined;
  const url = new URL(`https://u.y.qq.com${QQ_TOP_PATH}`);
  url.searchParams.set('format', 'json');
  // This URL is constructed only from /api/top parameters already validated by buildApiUrl.
  // The renderer cannot choose an official host, module, method, or arbitrary JSON parameters.
  url.searchParams.set('data', JSON.stringify({
    comm: { ct: 24, cv: 0 },
    req_1: {
      module: 'musicToplist.ToplistInfoServer', method: detail ? 'GetDetail' : 'GetAll',
      param: detail ? { topId: Number(params.id), offset: 0, num: Number(params.num ?? 100), period: '' } : {},
    },
  }));
  return url;
}

function officialTopData(payload, params) {
  const result = plainObject(payload) && plainObject(payload.req_1) ? payload.req_1 : {};
  const data = result.data;
  if (![0, '0'].includes(payload?.code) || ![0, '0'].includes(result.code)) {
    throw new Error('音乐服务返回了失败的 QQ 官方榜单响应');
  }
  if (!plainObject(data) || (params.id === undefined ? !Array.isArray(data.group)
    : !plainObject(data.data) || !Array.isArray(data.data.song) || !Array.isArray(data.songInfoList))) {
    throw new Error('音乐服务返回了无法识别的 QQ 官方榜单');
  }
  return { code: 0, data };
}

async function readApiResponse(response, input) {
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 403) {
      throw new Error(forbiddenApiMessage(input, 'HTTP 403', response.headers.get('cf-mitigated') === 'challenge'));
    }
    throw new Error(response.status === 429 ? '请求过于频繁，请稍后重试' : `音乐服务暂时不可用（HTTP ${response.status}）`);
  }
  if (Number(response.headers.get('content-length')) > MAX_API_BYTES) {
    await response.body?.cancel();
    throw new Error('服务返回的数据过大');
  }
  if (!response.body) throw new Error('音乐服务返回了空内容');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_API_BYTES) {
      await reader.cancel();
      throw new Error('服务返回的数据过大');
    }
    chunks.push(Buffer.from(value));
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('音乐服务返回的数据格式无效'); }
  if (plainObject(payload) && [payload.code, payload.status].some(value => value === 403 || value === '403')) {
    throw new Error(forbiddenApiMessage(input, '服务错误 403'));
  }
  return payload;
}

async function requestApi(input, { fetcher = fetch, timeoutMs = 15000, signal } = {}) {
  const url = buildApiUrl(input);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const options = {
      method: 'GET', redirect: 'error', signal: controller.signal,
      ...(input.path === '/api/song/url' ? {cache: 'no-store'} : {}),
      headers: { Accept: 'application/json', ...(isQqDiscoveryPath(input.path) ? { Referer: 'https://y.qq.com/' } : {}),
        ...(input.path === '/api/song/url' ? {'Cache-Control': 'no-cache, no-store'} : {}) },
    };
    const response = await fetcher(url, options);
    const builtInTop = input.path === '/api/top' && (input.baseUrl === undefined || input.baseUrl === '');
    if (builtInTop && response.status === 403 && response.headers.get('cf-mitigated') !== 'challenge') {
      await response.body?.cancel();
      try {
        // QQ's public chart API is independent of the built-in proxy, and returns the same
        // grouped charts / songInfoList format. Use it once, within the original deadline.
        const official = await fetcher(officialTopUrl(input.params), {
          ...options, headers: { Accept: 'application/json', Referer: 'https://y.qq.com/' },
        });
        return officialTopData(await readApiResponse(official, { path: QQ_TOP_PATH }), input.params);
      } catch (error) {
        const detail = /^(请求过于频繁|音乐服务|服务返回)/.test(error.message) ? error.message : '无法连接 QQ 官方榜单';
        throw new Error(`${forbiddenApiMessage(input, 'HTTP 403')} QQ 官方榜单也未能加载：${detail}`, { cause: error });
      }
    }
    return await readApiResponse(response, input);
  } catch (error) {
    if (signal?.aborted) throw new Error('请求已取消');
    if (controller.signal.aborted) throw new Error('请求超时，请检查网络或服务地址');
    if (/^(请求过于频繁|音乐服务|服务返回)/.test(error.message)) throw error;
    throw new Error('无法连接音乐服务，请检查网络或服务地址', { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = { AUDIO_EXTENSIONS, AudioRegistry, parseRange, localAudioResponse, buildApiUrl, requestApi };
