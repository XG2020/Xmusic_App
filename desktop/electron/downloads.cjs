'use strict';

const fsp = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { buildApiUrl, requestApi } = require('./core.cjs');
const {MAX_COVER_BYTES, validOwnedFile, ownFile, verifyOwnedFile, coverExtension, lyricBuffer} = require('./download-files.cjs');

const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_TASKS = 200;
const QUALITIES = ['128', '320', 'flac'];
const ACTIVE = new Set(['queued', 'resolving', 'downloading']);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_EXTENSIONS = ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus', 'aac', 'webm'];
// FAT/exFAT and some network shares allow ordinary files but cannot create hard links.
const LINK_UNSUPPORTED_ERRORS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function pathIdentity(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
const qualityOrder = quality => quality === 'flac' ? ['flac', '320', '128'] : quality === '320' ? ['320', '128'] : ['128'];
function terminalDownloadError(message) {return Object.assign(new Error(message), {noQualityFallback: true});}

function boundedText(value, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('歌曲信息无效');
  return value.trim() || fallback;
}

function normalizeRequest(input) {
  if (!plainObject(input) || Object.keys(input).some(key => !['track', 'quality', 'baseUrl', 'downloadCover', 'downloadLyrics'].includes(key)) ||
      !plainObject(input.track) || !QUALITIES.includes(input.quality) ||
      ['downloadCover', 'downloadLyrics'].some(key => input[key] !== undefined && typeof input[key] !== 'boolean')) throw new Error('下载参数无效');
  const item = input.track;
  if (item.source !== 'online' || typeof item.mid !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(item.mid)) {
    throw new Error('只能下载有有效歌曲标识的在线音乐');
  }
  const track = {
    key: `online:${item.mid}`, mid: item.mid, source: 'online',
    title: boundedText(item.title, '未知歌曲'), artist: boundedText(item.artist, '未知歌手'),
    album: boundedText(item.album),
  };
  if (item.coverUrl !== undefined && item.coverUrl !== '') track.coverUrl = downloadUrl(item.coverUrl).href;
  const baseUrl = input.baseUrl === undefined ? '' : input.baseUrl;
  // Reuse the restricted service route validator before creating any task or file.
  buildApiUrl({ path: '/api/song/url', params: { mid: track.mid, quality: input.quality }, baseUrl });
  return { track, quality: input.quality, baseUrl, downloadCover: input.downloadCover !== false, downloadLyrics: input.downloadLyrics !== false };
}

function safeFilename(value) {
  let result = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '').trim().replace(/[. ]+$/g, '');
  result = Array.from(result).slice(0, 100).join('').replace(/[. ]+$/g, '');
  if (!result || result === '.' || result === '..') result = '未知歌曲';
  if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(result)) result = `_${result}`;
  return result;
}

function downloadUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) {
    throw terminalDownloadError('音乐服务返回了无效的下载地址');
  }
  let result;
  try { result = new URL(value); } catch { throw terminalDownloadError('音乐服务返回了无效的下载地址'); }
  if (!['http:', 'https:'].includes(result.protocol) || !result.hostname || result.username || result.password || result.hash) {
    throw terminalDownloadError('下载地址只支持不含账户信息的 HTTP 或 HTTPS 链接');
  }
  return result;
}

function responseData(response) {
  const envelope = plainObject(response) ? response : {};
  if (envelope.success === false || (envelope.code !== undefined && envelope.code !== null && ![0, '0', 200, '200'].includes(envelope.code)) ||
      (typeof envelope.status === 'number' && envelope.status >= 400) ||
      (typeof envelope.status === 'string' && /^(error|failed|fail)$/i.test(envelope.status))) {
    throw new Error('音乐服务暂时无法提供下载，请稍后重试');
  }
  return Object.hasOwn(envelope, 'data') ? envelope.data : response;
}

function throwIfAborted(signal) {
  if (signal.aborted) throw new Error('下载已取消');
}

// Some injected service clients do not accept a signal. Cancellation still releases the task immediately.
async function abortable(promise, signal) {
  throwIfAborted(signal);
  let abort;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      abort = () => reject(new Error('下载已取消'));
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

async function resolveDownload(request, { apiRequest = requestApi, signal, qualities = qualityOrder(request.quality) }) {
  for (const quality of qualities) {
    throwIfAborted(signal);
    const data = responseData(await abortable(apiRequest({
      path: '/api/song/url', params: { mid: request.track.mid, quality }, baseUrl: request.baseUrl,
    }, { signal }), signal));
    const item = plainObject(data) ? data[request.track.mid] : undefined;
    const candidate = typeof item === 'string' ? item : plainObject(item) ? item.url : undefined;
    if (candidate !== undefined && candidate !== null && candidate !== '') return { url: downloadUrl(candidate), quality };
  }
  throw new Error('暂时无法获取这首歌的下载地址，可能暂无版权或服务不可用');
}

async function fetchAudio(url, { fetcher = fetch, signal }) {
  let current = downloadUrl(String(url));
  for (let redirect = 0; redirect <= 5; redirect++) {
    throwIfAborted(signal);
    const response = await abortable(fetcher(current, {
      method: 'GET', redirect: 'manual', signal,
      headers: { Accept: 'audio/*,application/octet-stream;q=0.9' },
    }), signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirect === 5) throw new Error('下载地址重定向无效或次数过多');
      current = downloadUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok || response.status === 206) {
      await response.body?.cancel();
      throw new Error(response.status === 429 ? '下载请求过于频繁，请稍后重试' : `下载服务暂时不可用（HTTP ${response.status}）`);
    }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType.startsWith('text/') || /(?:json|html|xml|mpegurl)/.test(contentType)) {
      await response.body?.cancel();
      throw new Error('下载地址返回的不是音频文件');
    }
    if (!response.body) throw new Error('下载服务返回了空内容');
    return response;
  }
  throw new Error('下载地址重定向无效');
}

async function fetchCover(url, {fetcher, signal}) {
  let current = downloadUrl(String(url));
  for (let redirect = 0; redirect <= 5; redirect++) {
    const response = await abortable(fetcher(current, {method: 'GET', redirect: 'manual', signal,
      headers: {Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': 'Mozilla/5.0 Xmusic', Referer: 'https://y.qq.com/'}}), signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirect === 5) throw new Error('封面重定向无效');
      current = downloadUrl(new URL(location, current).href);
      continue;
    }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!response.ok || !response.body || contentType && !['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'].includes(contentType)) {
      await response.body?.cancel(); throw new Error('封面响应无效');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const {value, done} = await abortable(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > MAX_COVER_BYTES) throw new Error('封面超过大小限制');
        chunks.push(Buffer.from(value));
      }
    } finally {await reader.cancel().catch(() => {});}
    const bytes = Buffer.concat(chunks);
    return {bytes, extension: coverExtension(bytes)};
  }
  throw new Error('封面地址无效');
}

function audioExtension(header) {
  if (header.length < 4) throw new Error('音频文件为空或格式不受支持');
  if (header.subarray(0, 4).toString() === 'fLaC') return 'flac';
  if (header.subarray(0, 3).toString() === 'ID3') return 'mp3';
  if (header.length >= 12 && header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WAVE') return 'wav';
  if (header.length >= 12 && header.subarray(4, 8).toString() === 'ftyp') return 'm4a';
  if (header.subarray(0, 4).toString() === 'OggS') return header.includes(Buffer.from('OpusHead')) ? 'opus' : 'ogg';
  if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  if (header[0] === 0xff && (header[1] & 0xf6) === 0xf0) return 'aac';
  if (header[0] === 0xff && (header[1] & 0xe0) === 0xe0 && (header[1] & 0x18) !== 0x08 &&
      (header[1] & 0x06) !== 0 && (header[2] & 0xf0) !== 0xf0 && (header[2] & 0x0c) !== 0x0c) return 'mp3';
  throw new Error('下载地址返回的不是受支持的音频文件');
}

function safeError(error) {
  const message = error instanceof Error ? error.message : '';
  return /^(只能下载|下载|音乐服务|暂时无法|音频文件|所选目录|保存目录)/.test(message) ? message.slice(0, 200) : '下载失败，请检查网络、保存目录权限和剩余空间后重试';
}

class DownloadManager {
  constructor({ dataDirectory, defaultDirectory, chooseDirectory, openDirectory, registry, notify = () => {},
    fetcher = fetch, apiRequest = requestApi, maxBytes = MAX_AUDIO_BYTES, timeoutMs = 15 * 60 * 1000, idleTimeoutMs = 45000 }) {
    if (!path.isAbsolute(dataDirectory) || !path.isAbsolute(defaultDirectory)) throw new Error('下载目录必须是绝对路径');
    this.historyPath = path.join(dataDirectory, 'downloads.json');
    this.directory = path.normalize(defaultDirectory);
    this.chooseDirectory = chooseDirectory;
    this.directoryOpener = openDirectory;
    this.registry = registry;
    this.notify = notify;
    this.fetcher = fetcher;
    this.apiRequest = apiRequest;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.tasks = new Map();
    this.running = new Map();
    this.writeQueue = Promise.resolve();
    this.closed = false;
    this.selectionPending = false;
    this.removing = new Set();
    this.pendingQueue = new Set();
    this.pendingStops = new Map();
    this.removalReceipts = new Map();
  }

  async load() {
    await fsp.mkdir(path.dirname(this.historyPath), { recursive: true });
    let saved;
    try {
      if ((await fsp.stat(this.historyPath)).size > MAX_HISTORY_BYTES) throw new Error('下载记录过大');
      saved = JSON.parse(await fsp.readFile(this.historyPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      // A corrupt download history must not prevent the player from starting.
      await fsp.rename(this.historyPath, `${this.historyPath}.${randomUUID()}.corrupt`).catch(() => {});
      return;
    }
    if (!plainObject(saved) || ![1, 2].includes(saved.version) || !Array.isArray(saved.tasks)) return;
    if (typeof saved.directory === 'string' && saved.directory.length < 4096 && path.isAbsolute(saved.directory) && !saved.directory.includes('\0')) {
      this.directory = path.normalize(saved.directory);
    }
    for (const savedTask of saved.tasks.slice(-MAX_TASKS)) {
      try {
        if (!plainObject(savedTask) || !ID_PATTERN.test(savedTask.id) ||
            !['queued', 'resolving', 'downloading', 'paused', 'completed', 'failed', 'cancelled'].includes(savedTask.status) ||
            typeof savedTask.directory !== 'string' || savedTask.directory.length >= 4096 ||
            !path.isAbsolute(savedTask.directory) || savedTask.directory.includes('\0')) continue;
        const request = normalizeRequest({ track: savedTask.track, quality: savedTask.quality, baseUrl: savedTask.baseUrl,
          downloadCover: savedTask.downloadCover, downloadLyrics: savedTask.downloadLyrics });
        const directory = path.normalize(savedTask.directory);
        const fileName = typeof savedTask.fileName === 'string' && savedTask.fileName.length <= 240 &&
          path.basename(savedTask.fileName) === savedTask.fileName && !/[<>:"/\\|?*\u0000-\u001f]/.test(savedTask.fileName) &&
          FILE_EXTENSIONS.includes(path.extname(savedTask.fileName).slice(1)) ? savedTask.fileName : undefined;
        if (savedTask.status === 'completed' && !fileName) continue;
        const interrupted = ACTIVE.has(savedTask.status);
        const task = {
          ...request, id: savedTask.id, directory, fileName,
          status: interrupted ? 'failed' : savedTask.status,
          receivedBytes: Number.isSafeInteger(savedTask.receivedBytes) && savedTask.receivedBytes >= 0 && savedTask.receivedBytes <= this.maxBytes ? savedTask.receivedBytes : 0,
          ...(QUALITIES.includes(savedTask.actualQuality) ? { actualQuality: savedTask.actualQuality } : {}),
          imported: savedTask.imported === true,
          createdAt: Number.isSafeInteger(savedTask.createdAt) && savedTask.createdAt > 0 ? savedTask.createdAt : Date.now(),
          ...(interrupted ? { error: '下载因上次退出而中断，请重新下载' } : typeof savedTask.error === 'string' ? { error: savedTask.error.slice(0, 200) } : {}),
        };
        const stem = fileName ? path.basename(fileName, path.extname(fileName)) : undefined;
        const ownedKinds = new Set();
        task.ownedFiles = Array.isArray(savedTask.ownedFiles) ? savedTask.ownedFiles.slice(0, 3).filter(file => {
          if (!validOwnedFile(file) || ownedKinds.has(file.kind) ||
              !(file.kind === 'audio' ? file.name === fileName : stem && path.basename(file.name, path.extname(file.name)) === stem)) return false;
          ownedKinds.add(file.kind);
          return true;
        }) : [];
        for (const file of task.ownedFiles) {
          if (file.kind === 'cover') task.coverFileName = file.name;
          if (file.kind === 'lyrics') task.lyricsFileName = file.name;
        }
        if (Array.isArray(savedTask.attachmentWarnings)) task.attachmentWarnings = savedTask.attachmentWarnings.filter(value => typeof value === 'string').slice(0, 2).map(value => value.slice(0, 200));
        this.tasks.set(task.id, task);
        if (interrupted) {
          // Only remove this task's recognizable partial, never an arbitrary persisted path.
          await this.cleanupPartial(task).catch(() => {});
          // Publication and its ownership hash are persisted only after the
          // complete audio stream is on disk. A crash during attachments or the
          // final history write must not discard that already-finished music.
          if (await this.recoverPublishedAudio(task)) continue;
          for (const file of task.ownedFiles) {
            try {const target = await verifyOwnedFile(task.directory, file); if (target) await fsp.unlink(target);} catch { /* Preserve changed files. */ }
          }
          task.ownedFiles = [];
          delete task.fileName; delete task.coverFileName; delete task.lyricsFileName;
        }
      } catch { /* Invalid history entries cannot grant path or network capabilities. */ }
    }
  }

  async recoverPublishedAudio(task) {
    const audio = task.ownedFiles.find(file => file.kind === 'audio' && file.name === task.fileName);
    if (!audio) return false;
    try {if (!await verifyOwnedFile(task.directory, audio)) return false;} catch {return false;}
    const verified = [audio];
    delete task.coverFileName; delete task.lyricsFileName;
    for (const file of task.ownedFiles) {
      if (file === audio) continue;
      try {
        if (!await verifyOwnedFile(task.directory, file)) continue;
        verified.push(file);
        if (file.kind === 'cover') task.coverFileName = file.name;
        if (file.kind === 'lyrics') task.lyricsFileName = file.name;
      } catch { /* Keep changed or unregistered siblings on disk without claiming ownership. */ }
    }
    task.ownedFiles = verified;
    task.status = 'completed';
    task.receivedBytes = task.totalBytes = audio.size;
    delete task.error;
    task.attachmentWarnings = [];
    if (task.downloadCover && !task.coverFileName) task.attachmentWarnings.push('上次退出中断了附件下载：封面未保存，可重新下载补齐。');
    if (task.downloadLyrics && !task.lyricsFileName) task.attachmentWarnings.push('上次退出中断了附件下载：歌词未保存，可重新下载补齐。');
    return true;
  }

  restoreTaskEntries(entries, order) {
    const restored = new Map([...entries, ...this.tasks]);
    this.tasks = new Map([...order.filter(id => restored.has(id)).map(id => [id, restored.get(id)]), ...restored]);
  }

  publicTask(task) {
    const { baseUrl, ownedFiles, ...snapshot } = task;
    return { ...snapshot, track: { ...snapshot.track }, ...(snapshot.attachmentWarnings ? {attachmentWarnings: [...snapshot.attachmentWarnings]} : {}) };
  }

  snapshot() { return { directory: this.directory, tasks: [...this.tasks.values()].reverse().map(task => this.publicTask(task)) }; }

  emit() { try { this.notify(this.snapshot()); } catch { /* Closing a renderer does not interrupt a file write. */ } }

  persist(change) {
    const pending = this.writeQueue.then(async () => {
      let rollback;
      let temporary;
      try {
        // Apply reversible state changes only when this write owns the queue.
        // Earlier writes cannot see a later uncommitted change, and failures
        // roll back before any following write takes its snapshot.
        rollback = change?.();
        const payload = JSON.stringify({ version: 2, directory: this.directory, tasks: [...this.tasks.values()] });
        temporary = `${this.historyPath}.${randomUUID()}.tmp`;
        await fsp.writeFile(temporary, payload, { flag: 'wx', mode: 0o600 });
        await fsp.rename(temporary, this.historyPath);
      } catch (error) {
        rollback?.();
        throw error;
      } finally { if (temporary) await fsp.unlink(temporary).catch(() => {}); }
    });
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  find(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || !this.tasks.has(id)) throw new Error('找不到这个下载任务');
    return this.tasks.get(id);
  }

  async verifiedDirectory(directory, create = false) {
    if (typeof directory !== 'string' || directory.length >= 4096 || !path.isAbsolute(directory) || directory.includes('\0')) {
      throw new Error('保存目录无效，请重新选择文件夹');
    }
    if (create) await fsp.mkdir(directory, { recursive: true });
    const actual = await fsp.realpath(directory);
    if (!(await fsp.stat(actual)).isDirectory()) throw new Error('保存目录不可用，请重新选择文件夹');
    return actual;
  }

  async selectDirectory() {
    if (this.selectionPending || this.closed) return this.snapshot();
    this.selectionPending = true;
    try {
      const selected = await this.chooseDirectory(this.directory);
      if (selected === null || selected === undefined) return this.snapshot();
      if (typeof selected !== 'string' || !path.isAbsolute(selected) || selected.includes('\0')) throw new Error('所选目录无效');
      const directory = await this.verifiedDirectory(selected);
      await this.persist(() => {
        const previous = this.directory;
        this.directory = directory;
        return () => {this.directory = previous;};
      });
      this.emit();
      return this.snapshot();
    } finally { this.selectionPending = false; }
  }

  async start(input) {
    if (this.closed) throw new Error('下载服务正在关闭');
    const request = normalizeRequest(input);
    const existing = [...this.tasks.values()].find(task => (ACTIVE.has(task.status) || task.status === 'paused') && task.track.mid === request.track.mid && task.quality === request.quality);
    if (existing && !this.pendingQueue.has(existing.id)) return this.publicTask(existing);
    let task;
    let created = false;
    try {
      await this.persist(() => {
        if (this.closed) throw new Error('下载服务正在关闭');
        task = [...this.tasks.values()].find(item => (ACTIVE.has(item.status) || item.status === 'paused') && item.track.mid === request.track.mid && item.quality === request.quality);
        if (task) return undefined;
        if ([...this.tasks.values()].filter(item => ACTIVE.has(item.status)).length >= 20) throw new Error('下载队列已满，请等待部分任务完成');
        const order = [...this.tasks.keys()];
        const oldest = this.tasks.size >= MAX_TASKS ? [...this.tasks.values()].find(item => !ACTIVE.has(item.status) && item.status !== 'paused' &&
          !this.running.has(item.id) && !this.removing.has(item.id) && !this.removalReceipts.has(item.id)) : undefined;
        if (this.tasks.size >= MAX_TASKS && !oldest) throw new Error('下载记录已满，请先清理部分任务');
        task = {...request, id: randomUUID(), directory: this.directory, status: 'queued', receivedBytes: 0, imported: false, ownedFiles: [], createdAt: Date.now()};
        if (oldest) this.tasks.delete(oldest.id);
        this.tasks.set(task.id, task);
        this.pendingQueue.add(task.id);
        created = true;
        return () => {
          this.tasks.delete(task.id);
          if (oldest) this.restoreTaskEntries([[oldest.id, oldest]], order);
        };
      });
    } finally {if (created) this.pendingQueue.delete(task.id);}
    this.emit();
    this.pump();
    return this.publicTask(task);
  }

  pump() {
    if (this.closed) return;
    for (const task of this.tasks.values()) {
      if (this.running.size >= 2) break;
      if (task.status !== 'queued' || this.running.has(task.id) || this.pendingQueue.has(task.id) || this.pendingStops.has(task.id) || this.removing.has(task.id)) continue;
      const controller = new AbortController();
      const operation = { controller, promise: undefined, cancelRequested: false, pauseRequested: false };
      this.running.set(task.id, operation);
      operation.promise = this.run(task, operation).finally(() => { this.running.delete(task.id); this.pump(); });
      // run catches operational errors and records them in the task.
      void operation.promise.catch(() => {});
    }
  }

  partialPath(task) { return path.join(task.directory, `.xmusic-${task.id}.part`); }

  async cleanupPartial(task) {
    const actualDirectory = await this.verifiedDirectory(task.directory);
    if (pathIdentity(actualDirectory) !== pathIdentity(task.directory)) return;
    await fsp.unlink(this.partialPath(task)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  async writeCompanion(task, extension, bytes, kind, signal) {
    throwIfAborted(signal);
    if (pathIdentity(await this.verifiedDirectory(task.directory)) !== pathIdentity(task.directory)) throw new Error('保存目录已改变');
    const filePath = path.join(task.directory, `${path.basename(task.fileName, path.extname(task.fileName))}.${extension}`);
    // Never overwrite a sibling created by a different program or download task.
    const handle = await fsp.open(filePath, 'wx', 0o600);
    const created = await handle.stat();
    try {await handle.writeFile(bytes); await handle.sync();}
    catch (error) {
      await handle.close();
      const current = await fsp.lstat(filePath).catch(() => null);
      if (current?.isFile() && current.dev === created.dev && current.ino === created.ino) await fsp.unlink(filePath).catch(() => {});
      throw error;
    }
    await handle.close();
    const owned = await ownFile(filePath, kind, createHash('sha256').update(bytes).digest('hex'));
    task.ownedFiles.push(owned);
    if (kind === 'cover') task.coverFileName = owned.name;
    else task.lyricsFileName = owned.name;
    throwIfAborted(signal);
  }

  async downloadCompanions(task, signal) {
    task.attachmentWarnings = [];
    const attempt = async (label, action) => {
      try {await action(AbortSignal.any([signal, AbortSignal.timeout(30000)]));}
      catch {throwIfAborted(signal); task.attachmentWarnings.push(`${label}未保存：服务未提供有效内容、文件已存在或目录不可写。`);}
    };
    if (task.downloadLyrics) await attempt('歌词', async assetSignal => {
      const data = responseData(await abortable(this.apiRequest({path: '/api/lyric', params: {mid: task.track.mid}, baseUrl: task.baseUrl}, {signal: assetSignal}), assetSignal));
      const bytes = lyricBuffer(data);
      if (!bytes) throw new Error('暂无歌词');
      await this.writeCompanion(task, 'lrc', bytes, 'lyrics', signal);
    });
    if (task.downloadCover) await attempt('封面', async assetSignal => {
      let url = task.track.coverUrl;
      if (!url) {
        const data = responseData(await abortable(this.apiRequest({path: '/api/song/detail', params: {mid: task.track.mid}, baseUrl: task.baseUrl}, {signal: assetSignal}), assetSignal));
        const detail = plainObject(data?.track_info) ? data.track_info : plainObject(data) ? data : {};
        const album = plainObject(detail.album) ? detail.album : {};
        const albumKey = album.pmid || album.mid;
        if (typeof detail.coverUrl === 'string') url = downloadUrl(detail.coverUrl).href;
        else if (typeof albumKey === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(albumKey)) url = `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumKey}.jpg`;
      }
      if (!url) throw new Error('暂无封面');
      const cover = await fetchCover(url, {fetcher: this.fetcher, signal: assetSignal});
      await this.writeCompanion(task, cover.extension, cover.bytes, 'cover', signal);
    });
  }

  async run(task, operation) {
    const { signal } = operation.controller;
    let handle;
    let reader;
    let temporary;
    let finalPath;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; operation.controller.abort(); }, this.timeoutMs);
    let idleTimer;
    let activeAttemptController;
    let attemptTimedOut = false;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {attemptTimedOut = true; activeAttemptController?.abort();}, this.idleTimeoutMs);
    };
    try {
      task.status = 'resolving';
      task.directory = await this.verifiedDirectory(task.directory, true);
      // Save the canonical destination before creating a partial so crash recovery can find it even through a junction.
      await this.persist();
      this.emit();
      const qualities = qualityOrder(task.quality);
      let extension;
      let audioDigest;
      for (const [attemptIndex, quality] of qualities.entries()) {
        throwIfAborted(signal);
        activeAttemptController = new AbortController();
        attemptTimedOut = false;
        const attemptSignal = AbortSignal.any([signal, activeAttemptController.signal]);
        let stage = 'network';
        task.status = 'resolving';
        task.receivedBytes = 0;
        delete task.totalBytes;
        delete task.actualQuality;
        this.emit();
        resetIdle();
        try {
          const resolved = await resolveDownload(task, {apiRequest: this.apiRequest, signal: attemptSignal, qualities: [quality]});
          const response = await fetchAudio(resolved.url, {fetcher: this.fetcher, signal: attemptSignal});
          throwIfAborted(attemptSignal);
          resetIdle();
          reader = response.body.getReader();
          const declared = response.headers.get('content-length');
          const total = declared && /^\d+$/.test(declared) ? Number(declared) : 0;
          if (Number.isSafeInteger(total) && total > 0 && total <= this.maxBytes && !response.headers.get('content-encoding')) task.totalBytes = total;
          const candidatePartial = this.partialPath(task);
          stage = 'file';
          handle = await fsp.open(candidatePartial, 'wx', 0o600);
          temporary = candidatePartial;
          stage = 'network';
          task.status = 'downloading';
          this.emit();
          let header = Buffer.alloc(0);
          const audioHash = createHash('sha256');
          extension = undefined;
          let lastProgress = 0;
          while (true) {
            throwIfAborted(attemptSignal);
            const {value, done} = await abortable(reader.read(), attemptSignal);
            if (done) break;
            resetIdle();
            if (!value?.byteLength) continue;
            task.receivedBytes += value.byteLength;
            if (task.receivedBytes > this.maxBytes) throw terminalDownloadError('音频文件超过下载大小限制');
            if (task.totalBytes && task.receivedBytes > task.totalBytes) delete task.totalBytes;
            if (header.length < 64) header = Buffer.concat([header, Buffer.from(value).subarray(0, 64 - header.length)]);
            if (header.length >= 64 && !extension) extension = audioExtension(header);
            stage = 'file';
            clearTimeout(idleTimer);
            await handle.writeFile(value);
            stage = 'network';
            resetIdle();
            audioHash.update(value);
            if (Date.now() - lastProgress > 150) {lastProgress = Date.now(); this.emit();}
          }
          extension ??= audioExtension(header);
          stage = 'file';
          clearTimeout(idleTimer);
          await handle.sync();
          await handle.close();
          handle = undefined;
          await reader.cancel().catch(() => {});
          reader = undefined;
          throwIfAborted(signal);
          audioDigest = audioHash.digest('hex');
          task.actualQuality = quality;
          break;
        } catch (cause) {
          clearTimeout(idleTimer);
          if (signal.aborted || stage === 'file' || cause?.noQualityFallback) throw cause;
          await reader?.cancel().catch(() => {});
          reader = undefined;
          await handle?.close();
          handle = undefined;
          if (temporary) {
            await fsp.unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});
            temporary = undefined;
          }
          const failure = attemptTimedOut ? new Error('下载超时，请检查网络后重新下载') : cause;
          if (attemptIndex === qualities.length - 1) throw new Error(`下载失败：已尝试 ${qualities.join('、')}；${safeError(failure)}`);
        }
      }
      clearTimeout(idleTimer);
      throwIfAborted(signal);
      // The directory may have been replaced by a junction while the network transfer was pending.
      if (pathIdentity(await this.verifiedDirectory(task.directory)) !== pathIdentity(task.directory)) throw new Error('保存目录已改变，请重新选择文件夹');
      const stem = safeFilename(`${task.track.artist} - ${task.track.title}`);
      for (let suffix = 0; suffix < 1000; suffix++) {
        throwIfAborted(signal);
        const fileName = `${stem}${suffix ? ` (${suffix})` : ''}.${extension}`;
        const candidate = path.join(task.directory, fileName);
        const companionStem = path.basename(fileName, path.extname(fileName));
        const companionExtensions = [...(task.downloadLyrics ? ['lrc'] : []), ...(task.downloadCover ? ['jpg', 'jpeg', 'png', 'webp'] : [])];
        if ((await Promise.all(companionExtensions.map(ext => fsp.lstat(path.join(task.directory, `${companionStem}.${ext}`)).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;})))).some(Boolean)) continue;
        try {
          try {
            // Prefer atomic publication on filesystems that support it.
            await fsp.link(temporary, candidate);
          } catch (error) {
            if (!LINK_UNSUPPORTED_ERRORS.has(error.code)) throw error;
            throwIfAborted(signal);
            // EXCL is essential: another process may create this filename after the failed link.
            // copyFile rolls back a destination it opened if copying fails. Never unlink a candidate
            // on rejection ourselves, because it may instead belong to that other process.
            await fsp.copyFile(temporary, candidate, fsConstants.COPYFILE_EXCL);
          }
          // Only a successful link/copy establishes ownership for cancellation cleanup below.
          finalPath = candidate;
          task.fileName = fileName;
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      if (!finalPath) throw new Error('保存目录中同名文件过多，请更换文件夹');
      throwIfAborted(signal);
      task.ownedFiles = [await ownFile(finalPath, 'audio', audioDigest)];
      await this.persist();
      await this.downloadCompanions(task, signal);
      throwIfAborted(signal);
      task.status = 'completed';
      task.totalBytes = task.receivedBytes;
      task.error = undefined;
      // From here cancellation is a no-op: the fully downloaded file belongs to the user.
      finalPath = undefined;
    } catch (error) {
      task.status = operation.cancelRequested || this.closed ? 'cancelled' : operation.pauseRequested ? 'paused' : 'failed';
      task.error = ['cancelled', 'paused'].includes(task.status) ? undefined : timedOut ? '下载超时，请检查网络后重新下载' : safeError(error);
      task.fileName = undefined;
      delete task.totalBytes;
      for (const owned of task.ownedFiles ?? []) {
        try {const target = await verifyOwnedFile(task.directory, owned); if (target) await fsp.unlink(target);} catch { /* Preserve anything modified outside this task. */ }
      }
      if (finalPath && !(task.ownedFiles ?? []).some(file => file.name === path.basename(finalPath))) await fsp.unlink(finalPath).catch(() => {});
      task.ownedFiles = [];
      delete task.coverFileName; delete task.lyricsFileName; delete task.attachmentWarnings;
    } finally {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      // Cancellation must close the network and file handles before removing the partial file on Windows.
      await reader?.cancel().catch(() => {});
      await handle?.close().catch(() => {});
      if (temporary) await fsp.unlink(temporary).catch(() => {});
      await this.persist().catch(() => {
        if (task.status === 'completed') task.error = '下载文件已保存，但下载记录暂时无法保存；请检查磁盘空间和权限。';
      });
      this.emit();
    }
  }

  async cancel(id) {
    const task = this.find(id);
    if (!ACTIVE.has(task.status) && task.status !== 'paused') return this.publicTask(task);
    const operation = this.running.get(id);
    if (operation) {
      operation.cancelRequested = true;
      operation.controller.abort();
      await operation.promise;
    } else {
      const release = this.holdQueuedTask(id);
      try {
        await this.persist(() => {
          this.find(id);
          if (!ACTIVE.has(task.status) && task.status !== 'paused') return undefined;
          const previous = task.status;
          task.status = 'cancelled';
          return () => {task.status = previous;};
        });
      } finally {release();}
      this.emit();
    }
    return this.publicTask(task);
  }

  async pause(id) {
    const task = this.find(id);
    if (!ACTIVE.has(task.status) || this.removing.has(id)) return this.publicTask(task);
    const operation = this.running.get(id);
    if (operation) {
      operation.pauseRequested = true;
      operation.controller.abort();
      await operation.promise;
    } else {
      const release = this.holdQueuedTask(id);
      try {
        await this.persist(() => {
          this.find(id);
          if (!ACTIVE.has(task.status) || this.removing.has(id)) return undefined;
          const previous = task.status;
          task.status = 'paused';
          return () => {task.status = previous;};
        });
      } finally {release();}
      this.emit();
    }
    return this.publicTask(task);
  }

  async resume(id) {
    const task = this.find(id);
    if (task.status !== 'paused' || this.removing.has(id)) return this.publicTask(task);
    // Like the mobile client, pause closes the transfer and removes the partial.
    // A new signed URL and a complete fresh response avoid concatenating mismatched media.
    return this.requeue(task, task.directory);
  }

  holdQueuedTask(id) {
    this.pendingStops.set(id, (this.pendingStops.get(id) ?? 0) + 1);
    return () => {
      const count = this.pendingStops.get(id) - 1;
      if (count) this.pendingStops.set(id, count);
      else this.pendingStops.delete(id);
      this.pump();
    };
  }

  async retry(id) {
    if (this.closed) throw new Error('下载服务正在关闭');
    const task = this.find(id);
    if (!['failed', 'cancelled'].includes(task.status) || this.removing.has(id)) return this.publicTask(task);
    return this.requeue(task, this.directory);
  }

  async requeue(task, directory) {
    if (this.closed) throw new Error('下载服务正在关闭');
    const operation = this.running.get(task.id);
    if (operation) await operation.promise;
    let result = task;
    try {
      await this.persist(() => {
        if (this.closed) throw new Error('下载服务正在关闭');
        if (this.tasks.get(task.id) !== task) throw new Error('找不到这个下载任务');
        if (!['paused', 'failed', 'cancelled'].includes(task.status) || this.removing.has(task.id)) return undefined;
        const duplicate = [...this.tasks.values()].find(item => item.id !== task.id && (ACTIVE.has(item.status) || item.status === 'paused') && item.track.mid === task.track.mid && item.quality === task.quality);
        if (duplicate) {result = duplicate; return undefined;}
        if ([...this.tasks.values()].filter(item => ACTIVE.has(item.status)).length >= 20) throw new Error('下载队列已满，请等待部分任务完成');
        const previous = {...task};
        this.pendingQueue.add(task.id);
        task.status = 'queued';
        task.directory = directory;
        task.receivedBytes = 0;
        task.imported = false;
        delete task.error; delete task.fileName; delete task.totalBytes; delete task.actualQuality;
        task.ownedFiles = [];
        delete task.coverFileName; delete task.lyricsFileName; delete task.attachmentWarnings;
        return () => {
          for (const key of Object.keys(task)) if (!Object.hasOwn(previous, key)) delete task[key];
          Object.assign(task, previous);
        };
      });
    } finally {this.pendingQueue.delete(task.id);}
    this.emit();
    this.pump();
    return this.publicTask(result);
  }

  async redownload(id) {
    const task = this.find(id);
    if (this.removing.has(id)) throw new Error('下载任务正在删除');
    if (ACTIVE.has(task.status) || task.status === 'paused') return this.publicTask(task);
    return this.start({track: task.track, quality: task.quality, baseUrl: task.baseUrl,
      downloadCover: task.downloadCover, downloadLyrics: task.downloadLyrics});
  }

  async remove(input) {
    if (!plainObject(input) || Object.keys(input).some(key => !['id', 'deleteFiles'].includes(key)) || typeof input.deleteFiles !== 'boolean') throw new Error('下载删除参数无效');
    const task = this.find(input.id);
    if (this.removing.has(task.id)) throw new Error('下载任务正在删除');
    this.removing.add(task.id);
    try {
      await this.cancel(task.id);
      const owned = task.ownedFiles ?? [];
      const removedLocalIds = [...(this.removalReceipts.get(task.id) ?? [])];
      if (input.deleteFiles && task.fileName) {
        if (!owned.some(file => file.kind === 'audio' && file.name === task.fileName)) {
          throw new Error('下载文件缺少安全删除记录，请仅删除记录或在文件夹中手动处理');
        }
        if (pathIdentity(await this.verifiedDirectory(task.directory)) !== pathIdentity(task.directory)) throw new Error('保存目录已改变，未删除文件');
        // Verify every owned sibling before touching any file. Adjacent unowned
        // images/lyrics are never inferred from their names and never deleted.
        const verified = [];
        for (const file of owned) verified.push({file, target: await verifyOwnedFile(task.directory, file)});
        // Remove companions first so a locked sidecar cannot leave a missing
        // audio file behind a still-present library record.
        verified.sort((a, b) => Number(a.file.kind === 'audio') - Number(b.file.kind === 'audio'));
        for (const {file, target} of verified) if (target) {
          const current = await verifyOwnedFile(task.directory, file);
          if (current) await fsp.unlink(current);
        }
        const audioPaths = owned.filter(file => file.kind === 'audio').map(file => path.join(task.directory, file.name));
        removedLocalIds.push(...await this.registry.removePaths(audioPaths));
        if (removedLocalIds.length) this.removalReceipts.set(task.id, [...new Set(removedLocalIds)]);
      }
      await this.persist(() => {
        const order = [...this.tasks.keys()];
        this.tasks.delete(task.id);
        return () => this.restoreTaskEntries([[task.id, task]], order);
      });
      this.removalReceipts.delete(task.id);
      this.emit();
      return {snapshot: this.snapshot(), removedLocalIds};
    } finally {this.removing.delete(task.id); this.pump();}
  }

  async completedPath(task) {
    if (task.status !== 'completed' || !task.fileName) throw new Error('请等待音乐下载完成');
    const filePath = path.join(task.directory, task.fileName);
    const actual = await fsp.realpath(filePath);
    if (pathIdentity(actual) !== pathIdentity(filePath) || !(await fsp.stat(actual)).isFile()) {
      throw new Error('下载文件已移动或改变，请重新下载');
    }
    const owned = task.ownedFiles?.find(file => file.kind === 'audio' && file.name === task.fileName);
    if (owned) await verifyOwnedFile(task.directory, owned);
    return actual;
  }

  async openDirectory(id) {
    const directory = id === undefined ? this.directory : path.dirname(await this.completedPath(this.find(id)));
    const actual = await this.verifiedDirectory(directory, id === undefined);
    await this.directoryOpener(actual);
  }

  async importDownload(id) {
    const task = this.find(id);
    const tracks = await this.registry.importDownload(await this.completedPath(task), {mid: task.track.mid, quality: task.actualQuality ?? task.quality});
    await this.persist(() => {
      if (this.tasks.get(id) !== task) return undefined;
      const previous = task.imported;
      task.imported = true;
      return () => {task.imported = previous;};
    });
    this.emit();
    return tracks;
  }

  async resolveDownloadedAudio(input) {
    if (!plainObject(input) || Object.keys(input).some(key => !['mid', 'quality'].includes(key)) ||
        typeof input.mid !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.mid) || !QUALITIES.includes(input.quality)) {
      throw new Error('本地下载播放参数无效');
    }
    const qualities = [input.quality, ...[...QUALITIES].reverse().filter(quality => quality !== input.quality)];
    const candidates = [...this.tasks.values()].filter(task => task.status === 'completed' && task.track.mid === input.mid)
      .sort((a, b) => b.createdAt - a.createdAt);
    const excludePaths = [];
    for (const quality of qualities) {
      for (const task of candidates) {
        if ((task.actualQuality ?? task.quality) !== quality) continue;
        try {
          if (this.removing.has(task.id)) throw new Error('下载正在删除');
          const filePath = await this.completedPath(task);
          const [track] = await this.registry.importDownload(filePath, {mid: input.mid, quality});
          const url = await this.registry.resolveUrl(track.localId);
          if (!task.imported) {
            await this.persist(() => {
              if (this.tasks.get(task.id) !== task) return undefined;
              const previous = task.imported;
              task.imported = true;
              return () => {task.imported = previous;};
            }).catch(() => {});
            this.emit();
          }
          return url;
        } catch {
          // A rejected task-owned file must not sneak back through an older
          // library association, while another intact download may still work.
          if (task.fileName) excludePaths.push(path.join(task.directory, task.fileName));
        }
      }
      const registered = await this.registry.resolveDownloadedUrl({mid: input.mid, quality}, {excludePaths});
      if (registered) return registered;
    }
    return undefined;
  }

  async clearHistory() {
    await this.persist(() => {
      const order = [...this.tasks.keys()];
      const removed = [];
      for (const [id, task] of this.tasks) if (!ACTIVE.has(task.status) && task.status !== 'paused' &&
          !this.running.has(id) && !this.removing.has(id) && !this.removalReceipts.has(id)) {
        removed.push([id, task]);
        this.tasks.delete(id);
      }
      return () => this.restoreTaskEntries(removed, order);
    });
    this.emit();
    return this.snapshot();
  }

  async dispose() {
    this.closed = true;
    for (const operation of this.running.values()) { operation.cancelRequested = true; operation.controller.abort(); }
    for (const task of this.tasks.values()) if (task.status === 'queued') task.status = 'cancelled';
    await Promise.allSettled([...this.running.values()].map(operation => operation.promise));
    await this.persist().catch(() => {});
    await this.writeQueue;
  }
}

module.exports = { DownloadManager, normalizeRequest, safeFilename, downloadUrl, audioExtension, resolveDownload, MAX_AUDIO_BYTES };
