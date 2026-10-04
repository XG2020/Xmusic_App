'use strict';

const { randomUUID } = require('node:crypto');
const { buildApiUrl, requestApi: defaultRequestApi, parseRange } = require('./core.cjs');

const PREFIX_BYTES = 512;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TOKEN_PATH = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPIRED_STATUSES = new Set([401, 403, 404, 410]);
class AudioServiceError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function expiredFailure(error) {
  return new AudioServiceError(`播放地址已失效，已重新解析同音质但仍无法播放，请稍后重试。${error instanceof AudioServiceError ? error.message : ''}`, 'AUDIO_URL_EXPIRED');
}

function tokenId(source) {
  if (typeof source !== 'string' || source.length > 128) return undefined;
  try {
    const url = new URL(source);
    if (url.protocol === 'xmusic-online:' && url.hostname === 'stream' && !url.port && !url.username && !url.password &&
        !url.search && !url.hash && TOKEN_PATH.test(url.pathname)) return url.pathname.slice(1);
  } catch { /* Only opaque, registered desktop sources are accepted. */ }
}

function mediaUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16384) throw new AudioServiceError('音乐服务未提供该音质的播放地址。');
  let url;
  try { url = base ? new URL(value, base) : new URL(value); } catch { throw new AudioServiceError('音乐服务返回的音频地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new AudioServiceError('音乐服务返回的音频地址无效。');
  }
  return url;
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Object.keys(input).some(key => !['mid', 'quality', 'baseUrl'].includes(key)) ||
      typeof input.mid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.mid) || !['flac', '320', '128'].includes(input.quality)) {
    throw new AudioServiceError('歌曲标识或音质无效。');
  }
  const apiInput = {path: '/api/song/url', params: {mid: input.mid, quality: input.quality}, baseUrl: input.baseUrl};
  // Reuse the same custom-service validation as every other native API call.
  buildApiUrl(apiInput);
  return apiInput;
}

function resolvedUrl(payload, mid) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const envelope = object(payload);
  if (envelope.success === false || (envelope.code !== undefined && envelope.code !== null && ![0, '0', 200, '200'].includes(envelope.code)) ||
      (typeof envelope.status === 'number' && envelope.status >= 400) || /^(error|failed|fail)$/i.test(String(envelope.status ?? ''))) {
    throw new AudioServiceError('音乐服务无法提供该音质的播放地址，可能暂无版权或服务不可用。');
  }
  const data = Object.hasOwn(envelope, 'data') ? envelope.data : payload;
  const item = object(data)[mid];
  return mediaUrl(typeof item === 'string' ? item : object(item).url);
}

function sniffMime(bytes) {
  const ascii = (start, end) => bytes.subarray(start, end).toString('ascii');
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (ascii(0, 4) === 'ADIF' || (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0)) return 'audio/aac';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0) return 'audio/mpeg';
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
  throw new AudioServiceError('音频服务器返回了无法识别的音频内容，请尝试其他音质。');
}

function contentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const [start, end, size] = match.slice(1).map(Number);
  return [start, end, size].every(Number.isSafeInteger) && start >= 0 && start <= end && end < size ? {start, end, size} : null;
}

function validRange(value) {
  if (!value) return true;
  if (value.length > 80) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : undefined;
  const end = match[2] ? Number(match[2]) : undefined;
  return (start === undefined || Number.isSafeInteger(start)) && (end === undefined || Number.isSafeInteger(end)) &&
    (start === undefined ? end > 0 : end === undefined || start <= end);
}

function httpFailure(status) {
  const reason = [401, 403].includes(status) ? '音频服务器拒绝访问'
    : [404, 410].includes(status) ? '音频播放地址已失效'
    : status === 429 ? '音频请求过于频繁，请稍后重试' : '音频服务器请求失败';
  return new AudioServiceError(`${reason}（HTTP ${status}）。`, EXPIRED_STATUSES.has(status) ? 'AUDIO_URL_EXPIRED' : undefined);
}

class OnlineAudioService {
  constructor({requestApi = defaultRequestApi, fetcher = fetch, timeoutMs = 15000, idleTimeoutMs = 30000,
    ttlMs = 60 * 60 * 1000, maxEntries = 32, now = Date.now} = {}) {
    this.requestApi = requestApi;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.controllers = new Set();
    this.preparing = null;
    this.disposed = false;
  }

  prune() {
    for (const [id, entry] of this.entries) if (this.now() - entry.usedAt >= this.ttlMs) this.entries.delete(id);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }

  context(signal) {
    if (this.disposed) throw new AudioServiceError('音频服务已关闭，请重启客户端。');
    if (this.controllers.size >= 32) throw new AudioServiceError('音频请求过多，请稍后重试。');
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer;
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, {once: true});
    const arm = milliseconds => {
      clearTimeout(timer);
      if (milliseconds) timer = setTimeout(() => { timedOut = true; abort(); }, milliseconds);
    };
    arm(this.timeoutMs);
    return {controller, arm, timedOut: () => timedOut, cleanup: () => { arm(0); signal?.removeEventListener('abort', abort); this.controllers.delete(controller); },
      failure: error => error instanceof AudioServiceError ? error : new AudioServiceError(timedOut
        ? '音频网络请求超时，请检查网络后重试。' : controller.signal.aborted ? '音频请求已取消。' : '无法连接音频服务器，请检查网络后重试。')};
  }

  async fetchMedia(url, range, context) {
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (context.controller.signal.aborted) throw new AudioServiceError('音频请求已取消。');
      const headers = {Accept: 'audio/*, application/octet-stream;q=0.9', 'Accept-Encoding': 'identity'};
      if (range) headers.Range = range;
      if (url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com')) headers.Referer = 'https://y.qq.com/';
      const response = await this.fetcher(url.href, {method: 'GET', headers, redirect: 'manual', credentials: 'omit', signal: context.controller.signal});
      if (!REDIRECTS.has(response.status)) return response;
      await response.body?.cancel();
      if (redirects === 4) throw new AudioServiceError('音频服务器重定向次数过多。');
      url = mediaUrl(response.headers.get('location'), url);
    }
  }

  async prepare(apiInput, context, retryExpired) {
    let refreshed = false;
    try {
      for (let attempt = 0; ; attempt++) {
        if (context.controller.signal.aborted) throw new AudioServiceError('音频请求已取消。');
        const payload = await this.requestApi(apiInput, {signal: context.controller.signal});
        if (context.controller.signal.aborted) throw new AudioServiceError('音频请求已取消。');
        const url = resolvedUrl(payload, apiInput.params.mid);
        const response = await this.fetchMedia(url, `bytes=0-${PREFIX_BYTES - 1}`, context);
        if (![200, 206].includes(response.status)) {
          await response.body?.cancel();
          if (retryExpired && attempt === 0 && EXPIRED_STATUSES.has(response.status)) { refreshed = true; continue; }
          const failure = httpFailure(response.status);
          throw failure.code === 'AUDIO_URL_EXPIRED' ? expiredFailure(failure) : failure;
        }
        const range = contentRange(response.headers.get('content-range'));
        if (response.status === 206 && (!range || range.start !== 0)) {
          await response.body?.cancel();
          throw new AudioServiceError('音频服务器返回了无效的分段内容。');
        }
        if (!response.body) throw new AudioServiceError('音频服务器返回了空内容。');
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
          while (length < PREFIX_BYTES) {
            const {value, done} = await reader.read();
            if (done) break;
            const bytes = Buffer.from(value.buffer, value.byteOffset, Math.min(value.byteLength, PREFIX_BYTES - length));
            chunks.push(Buffer.from(bytes));
            length += bytes.length;
          }
        } finally { await reader.cancel().catch(() => {}); }
        const mime = sniffMime(Buffer.concat(chunks));
        const contentLength = Number(response.headers.get('content-length'));
        const size = range?.size ?? (Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : undefined);
        return {url, mime, size};
      }
    } catch (error) {
      if (refreshed && (!context.controller.signal.aborted || context.timedOut()) && error?.code !== 'AUDIO_URL_EXPIRED') {
        throw expiredFailure(context.failure(context.timedOut() ? undefined : error));
      }
      throw error;
    }
  }

  // Refresh a failed signed URL once, sharing the work between simultaneous
  // range requests. Each caller keeps its own cancellation; the shared lookup
  // is stopped as soon as no request needs it any more.
  async refresh(entry, failedUrl, caller) {
    if (entry.failure) throw entry.failure;
    if (entry.url !== failedUrl) return;
    if (caller.controller.signal.aborted) throw new AudioServiceError('音频请求已取消。');
    let refresh = entry.refresh;
    if (!refresh) {
      const context = this.context();
      refresh = {context, waiters: 0};
      entry.refresh = refresh;
      refresh.promise = this.prepare(entry.apiInput, context, false).then(source => {
        if (context.controller.signal.aborted || this.disposed) throw new AudioServiceError('音频请求已取消。');
        if (source.mime !== entry.mime || (entry.size !== undefined && source.size !== entry.size)) {
          throw new AudioServiceError('重新解析的音频内容已变化，请重新播放。');
        }
        Object.assign(entry, source);
        entry.failure = undefined;
        entry.lastFailure = undefined;
      }).catch(error => {
        if (context.controller.signal.aborted && !context.timedOut()) throw context.failure(error);
        const failure = error?.code === 'AUDIO_URL_EXPIRED' ? error : expiredFailure(context.failure(context.timedOut() ? undefined : error));
        entry.failure = failure;
        throw failure;
      }).finally(() => {
        context.controller.abort(); context.cleanup();
        if (entry.refresh === refresh) entry.refresh = undefined;
      });
    }
    refresh.waiters++;
    let abort;
    try {
      await Promise.race([refresh.promise, new Promise((_resolve, reject) => {
        abort = () => reject(new AudioServiceError('音频请求已取消。'));
        caller.controller.signal.addEventListener('abort', abort, {once: true});
      })]);
    } catch (error) {
      // The range request's deadline can expire before its shared lookup's
      // deadline. Keep the known expiry reason; a user abort remains cancellable.
      if (caller.timedOut()) throw expiredFailure(caller.failure());
      throw error;
    } finally {
      caller.controller.signal.removeEventListener('abort', abort);
      if (--refresh.waiters === 0) refresh.context.controller.abort();
    }
  }

  failure(source) {
    const id = tokenId(source);
    if (!id) throw new AudioServiceError('音频地址无效。');
    const entry = this.entries.get(id);
    if (!entry) return {code: 'AUDIO_TOKEN_EXPIRED', message: '播放地址缓存已过期，请重新解析。'};
    const failure = entry.failure ?? entry.lastFailure;
    if (failure) return {code: failure.code, message: failure.message};
    return undefined;
  }

  async resolve(input) {
    const apiInput = validateInput(input);
    // There is one playback source selection at a time. Cancel only an older
    // preparation; existing respond() streams (including seeks) have their own
    // lifetime and must remain available until Chromium releases them.
    this.preparing?.controller.abort();
    this.preparing?.cleanup();
    const context = this.context();
    this.preparing = context;
    try {
      // Tokens contain no remote URL. Only this fixed API route can register a
      // stream; the renderer cannot supply media URLs, cookies or headers.
      const source = await this.prepare(apiInput, context, true);
      if (context.controller.signal.aborted || this.disposed) throw new AudioServiceError('音频请求已取消。');
      const id = randomUUID();
      this.prune();
      this.entries.set(id, {...source, apiInput, usedAt: this.now()});
      this.prune();
      return `xmusic-online://stream/${id}`;
    } catch (error) {
      // The API already sanitizes its own diagnostics; preserve those useful
      // service errors without exposing a signed media URL from native fetch.
      if (/^(音乐服务|请求过于频繁|请求超时|无法连接音乐服务|服务返回)/.test(error?.message ?? '')) throw error;
      throw context.failure(error);
    } finally {
      context.controller.abort(); context.cleanup();
      if (this.preparing === context) this.preparing = null;
    }
  }

  async respond(request) {
    let context;
    let response;
    let entry;
    let refreshingExpired = false;
    try {
      const id = tokenId(request.url);
      if (!id) return new Response(null, {status: 404});
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, {status: 405, headers: {Allow: 'GET, HEAD'}});
      this.prune();
      entry = this.entries.get(id);
      if (!entry) return new Response(null, {status: 404});
      entry.usedAt = this.now();
      this.entries.delete(id);
      this.entries.set(id, entry);
      const range = request.headers.get('range');
      if (!validRange(range) || (entry.size !== undefined && !parseRange(range, entry.size))) {
        return new Response(null, {status: 416, headers: entry.size === undefined ? {} : {'Content-Range': `bytes */${entry.size}`}});
      }
      context = this.context(request.signal);
      if (entry.failure) throw entry.failure;
      const failedUrl = entry.url;
      response = await this.fetchMedia(failedUrl, range, context);
      if (EXPIRED_STATUSES.has(response.status)) {
        refreshingExpired = true;
        await response.body?.cancel();
        await this.refresh(entry, failedUrl, context);
        response = await this.fetchMedia(entry.url, range, context);
        if (EXPIRED_STATUSES.has(response.status)) {
          entry.failure = expiredFailure(httpFailure(response.status));
          throw entry.failure;
        }
      }
      if (![200, 206].includes(response.status)) { await response.body?.cancel(); throw httpFailure(response.status); }
      const partial = contentRange(response.headers.get('content-range'));
      if (response.status === 206) {
        const expected = partial && parseRange(range, partial.size);
        if (!partial || (entry.size !== undefined && partial.size !== entry.size) || !expected ||
            partial.start !== expected.start || partial.end > expected.end) {
          throw new AudioServiceError('音频服务器返回了无效的分段内容。');
        }
      }
      const headers = {'Content-Type': entry.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff'};
      const contentLength = response.headers.get('content-length');
      if (contentLength && /^\d+$/.test(contentLength) && Number.isSafeInteger(Number(contentLength))) headers['Content-Length'] = contentLength;
      if (response.status === 206) {
        if (headers['Content-Length'] && Number(headers['Content-Length']) !== partial.end - partial.start + 1) {
          throw new AudioServiceError('音频服务器返回了不完整的分段内容。');
        }
        headers['Content-Length'] = String(partial.end - partial.start + 1);
        headers['Content-Range'] = `bytes ${partial.start}-${partial.end}/${partial.size}`;
      }
      if (request.method === 'HEAD') {
        await response.body?.cancel(); context.controller.abort(); context.cleanup();
        return new Response(null, {status: response.status, headers});
      }
      if (!response.body) throw new AudioServiceError('音频服务器返回了空内容。');
      const reader = response.body.getReader();
      const state = context;
      state.arm(0);
      // Stream with browser backpressure; no full-song buffering or disk cache.
      const body = new ReadableStream({
        pull: async controller => {
          state.arm(this.idleTimeoutMs);
          try {
            const {value, done} = await reader.read();
            state.arm(0);
            if (done) { controller.close(); state.cleanup(); }
            else controller.enqueue(value);
          } catch {
            state.controller.abort(); state.cleanup();
            controller.error(new Error('音频网络传输失败。'));
          }
        },
        cancel: async reason => { state.controller.abort(); state.cleanup(); await reader.cancel(reason).catch(() => {}); },
      });
      return new Response(body, {status: response.status, headers});
    } catch (error) {
      if (entry && refreshingExpired && (!context?.controller.signal.aborted || context?.timedOut())) {
        const failure = error?.code === 'AUDIO_URL_EXPIRED' ? error : expiredFailure(context.failure(context.timedOut() ? undefined : error));
        // The renderer must still recognize an expired-link 502 while another
        // range finishes refreshing. Only a terminal failure blocks streams.
        entry.lastFailure = failure;
        if (!entry.refresh?.waiters) entry.failure = failure;
      }
      await response?.body?.cancel().catch(() => {});
      context?.controller.abort(); context?.cleanup();
      return new Response(null, {status: 502});
    }
  }

  dispose() {
    this.disposed = true;
    this.preparing = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.entries.clear();
  }
}

module.exports = {OnlineAudioService};
