'use strict';

const MAX_INPUT_LENGTH = 4096;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function cleanId(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return undefined;
  return value.replace(/^0+/, '') || undefined;
}

function qqUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
        !(url.hostname === 'y.qq.com' || url.hostname.endsWith('.y.qq.com'))) return undefined;
    url.protocol = 'https:';
    return url;
  } catch { return undefined; }
}

function urlsInText(input) {
  return [...input.matchAll(/https?:\/\/[^\s，。"'<>【】]+/gi)]
    .map(match => qqUrl(match[0].replace(/[)\]）}、；;！!]+$/, '').replace(/&amp;/gi, '&'))).filter(Boolean);
}

function idFromUrl(url) {
  const hashSearch = new URLSearchParams(url.hash.split('?')[1]);
  for (const key of ['id', 'disstid', 'dissid', 'playlistid']) {
    const id = cleanId(url.searchParams.get(key) ?? hashSearch.get(key));
    if (id) return id;
  }
  return cleanId(`${url.pathname}${url.hash}`.match(/\/(?:playlist|taoge)\/(\d{1,20})(?:[/?#]|$)/i)?.[1]);
}

function parsePlaylistId(input) {
  if (typeof input !== 'string' || input.length > MAX_INPUT_LENGTH) return undefined;
  return cleanId(input.trim()) ?? urlsInText(input).map(idFromUrl).find(Boolean);
}

async function readPage(response, signal) {
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_PAGE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('分享页面过大，请直接输入歌单 ID。');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, {once: true});
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const {done, value} = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAGE_BYTES) throw new Error('分享页面过大，请直接输入歌单 ID。');
      chunks.push(Buffer.from(value));
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Resolve only public QQ Music pages; validate every redirect before issuing another request. */
async function resolvePlaylistId(input, {fetchImpl = globalThis.fetch, timeoutMs = 10000} = {}) {
  if (typeof input !== 'string' || !input.trim() || input.length > MAX_INPUT_LENGTH) return undefined;
  const direct = parsePlaylistId(input);
  if (direct) return direct;
  let url = urlsInText(input)[0];
  if (!url) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const visited = new Set();
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      if (visited.has(url.href)) throw new Error('QQ 音乐分享链接重定向异常，请使用完整歌单链接或 ID。');
      visited.add(url.href);
      const response = await fetchImpl(url.href, {
        redirect: 'manual', signal: controller.signal,
        headers: {Accept: 'text/html,application/xhtml+xml', Referer: 'https://y.qq.com/',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'},
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const next = qqUrl(response.headers.get('location'), url);
        await response.body?.cancel().catch(() => {});
        if (!next) throw new Error('分享链接没有跳转到 QQ 音乐，请使用完整歌单链接或 ID。');
        const id = idFromUrl(next);
        if (id) return id;
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`QQ 音乐分享链接暂时无法访问（HTTP ${response.status}），请稍后重试或直接输入歌单 ID。`);
      }
      const html = (await readPage(response, controller.signal)).replace(/&amp;/gi, '&').replace(/\\\//g, '/');
      const id = cleanId(html.match(/\b(?:disstid|dissid|playlistid)["']?\s*[:=]\s*["']?(\d{1,20})(?!\d)/i)?.[1]);
      return id ?? parsePlaylistId(html.slice(0, MAX_INPUT_LENGTH)) ?? urlsInText(html).map(idFromUrl).find(Boolean);
    }
    throw new Error('QQ 音乐分享链接跳转次数过多，请使用完整歌单链接或 ID。');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('分享链接解析超时，请重试或直接输入歌单 ID。');
    if (error instanceof TypeError) throw new Error('无法连接 QQ 音乐，请检查网络后重试。');
    throw error;
  } finally { clearTimeout(timer); }
}

module.exports = {parsePlaylistId, resolvePlaylistId};
