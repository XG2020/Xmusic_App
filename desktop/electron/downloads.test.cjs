'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { AudioRegistry, requestApi, localAudioResponse } = require('./core.cjs');
const { DownloadManager, normalizeRequest, safeFilename, downloadUrl, audioExtension } = require('./downloads.cjs');
const {coverExtension, lyricBuffer} = require('./download-files.cjs');

const track = { key: 'online:test_mid', source: 'online', mid: 'test_mid', title: '测试歌曲', artist: '测试歌手' };
const request = { track, quality: 'flac', baseUrl: 'https://music.example.test', downloadCover: false, downloadLyrics: false };

function wave() {
  const result = Buffer.alloc(8044, 128);
  result.write('RIFF', 0);
  result.writeUInt32LE(8036, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(8000, 24);
  result.writeUInt32LE(8000, 28);
  result.writeUInt16LE(1, 32);
  result.writeUInt16LE(8, 34);
  result.write('data', 36);
  result.writeUInt32LE(8000, 40);
  return result;
}

async function fixture(t, overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xmusic-download-test-'));
  const dataDirectory = path.join(root, 'data');
  const defaultDirectory = path.join(root, 'downloads');
  const selectedDirectory = path.join(root, 'selected');
  await fsp.mkdir(selectedDirectory);
  const registry = new AudioRegistry(dataDirectory);
  await registry.load();
  const events = [];
  const listeners = new Set();
  const opened = [];
  const options = {
    dataDirectory, defaultDirectory, registry,
    chooseDirectory: async () => selectedDirectory,
    openDirectory: async directory => { opened.push(directory); },
    notify: snapshot => { events.push(snapshot); for (const listener of listeners) listener(snapshot); },
    apiRequest: async input => ({ code: 200, data: { [input.params.mid]: 'https://cdn.example.test/signed?file=wrong.exe' } }),
    fetcher: async () => new Response(wave(), { headers: { 'content-type': 'application/octet-stream' } }),
    ...overrides,
  };
  const manager = new DownloadManager(options);
  await manager.load();
  t.after(async () => {
    await manager.dispose();
    const actual = path.resolve(root);
    assert.ok(actual.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fsp.rm(actual, { recursive: true, force: true });
  });
  function until(predicate) {
    const current = manager.snapshot();
    if (predicate(current)) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('Timed out waiting for download state')); }, 5000);
      const listener = next => {
        if (!predicate(next)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(next);
      };
      listeners.add(listener);
    });
  }
  async function finished(id) {
    return (await until(snapshot => snapshot.tasks.some(item => item.id === id && ['completed', 'failed', 'cancelled'].includes(item.status))))
      .tasks.find(item => item.id === id);
  }
  return { root, manager, registry, options, until, finished, events, opened, selectedDirectory, defaultDirectory };
}

test('download IPC input and HTTP URLs reject arbitrary paths, batches, credentials and unsupported schemes', () => {
  assert.equal(normalizeRequest(request).track.key, 'online:test_mid');
  const defaults = normalizeRequest({track, quality: 'flac'});
  assert.equal(defaults.downloadCover, true); assert.equal(defaults.downloadLyrics, true);
  for (const input of [
    null, [], { ...request, path: 'C:\\private.txt' }, { ...request, url: 'https://untrusted.test' },
    { ...request, quality: '999' }, { ...request, baseUrl: 'file:///private' },
    { ...request, track: { ...track, source: 'local' } }, { ...request, track: { ...track, mid: 'one,two' } },
    { ...request, track: { ...track, title: 'a'.repeat(501) } }, { ...request, track: { ...track, artist: 'a\0b' } },
    {...request, downloadCover: 'true'}, {...request, downloadLyrics: 1}, {...request, track: {...track, coverUrl: 'file:///private.png'}},
  ]) assert.throws(() => normalizeRequest(input));
  for (const url of ['file:///c:/private', 'data:audio/wav,x', 'https://user:pass@host.test/a', 'https://host.test/a#b', ' http://host.test', 'https://host.test/a\nb']) {
    assert.throws(() => downloadUrl(url));
  }
  assert.equal(downloadUrl('https://host.test/a?token=123').protocol, 'https:');
});

test('Windows file names are bounded, traversal-safe and do not create devices or alternate streams', () => {
  assert.equal(safeFilename('CON.mp3'), '_CON.mp3');
  assert.equal(safeFilename('LPT¹'), '_LPT¹');
  assert.equal(safeFilename('NUL'), '_NUL');
  assert.equal(safeFilename('..'), '未知歌曲');
  assert.equal(safeFilename('song.mp3:secret'), 'song.mp3_secret');
  assert.doesNotMatch(safeFilename('../x\\y<>|?*"'), /[<>:"/\\|?*]/);
  assert.ok(Array.from(safeFilename('🎵'.repeat(200))).length <= 100);
});

test('format detection derives safe extensions from audio data and rejects error documents', () => {
  assert.equal(audioExtension(wave()), 'wav');
  assert.equal(audioExtension(Buffer.from('fLaC0000')), 'flac');
  assert.equal(audioExtension(Buffer.from('ID300000')), 'mp3');
  assert.equal(audioExtension(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'mp3');
  assert.equal(audioExtension(Buffer.from([0xff, 0xf1, 0x50, 0x80])), 'aac');
  assert.equal(audioExtension(Buffer.from('0000ftypM4A ')), 'm4a');
  assert.throws(() => audioExtension(Buffer.from('<!DOCTYPE html>error')));
  assert.throws(() => audioExtension(Buffer.alloc(0)));
});

test('downloads stream with quality fallback, ignore dishonest size hints, preserve collisions and import a playable local file', async t => {
  const qualities = [];
  const { manager, registry, options, finished, events, opened, defaultDirectory } = await fixture(t, {
    apiRequest: async input => {
      qualities.push(input.params.quality);
      return { code: 200, data: { test_mid: input.params.quality === 'flac' ? null : { url: 'https://cdn.example.test/audio.flac' } } };
    },
    fetcher: async () => new Response(wave(), { headers: { 'content-length': '2', 'content-type': 'audio/flac' } }),
  });
  await fsp.mkdir(defaultDirectory);
  const existingPath = path.join(defaultDirectory, '测试歌手 - 测试歌曲.wav');
  await fsp.writeFile(existingPath, 'original user file');
  const task = await manager.start(request);
  const done = await finished(task.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(qualities, ['flac', '320']);
  assert.equal(done.actualQuality, '320');
  assert.equal(done.fileName, '测试歌手 - 测试歌曲 (1).wav');
  assert.equal(done.receivedBytes, wave().length);
  assert.equal(done.totalBytes, wave().length);
  assert.ok(events.some(snapshot => snapshot.tasks.some(item => item.status === 'downloading' && item.receivedBytes > 2 && !item.totalBytes)));
  assert.equal(await fsp.readFile(existingPath, 'utf8'), 'original user file');
  assert.deepEqual(await fsp.readFile(path.join(done.directory, done.fileName)), wave());
  assert.equal((await fsp.readdir(defaultDirectory)).some(name => name.endsWith('.part')), false);
  assert.equal(JSON.stringify(manager.snapshot()).includes('music.example.test'), false);
  assert.equal(JSON.stringify(manager.snapshot()).includes('cdn.example.test'), false);
  const local = await manager.importDownload(task.id);
  assert.equal(local.length, 1);
  assert.equal(local[0].source, 'local');
  assert.equal(local[0].duration, 1);
  assert.equal(registry.list().length, 1);
  assert.equal(manager.snapshot().tasks[0].imported, true);
  assert.equal((await manager.importDownload(task.id))[0].key, local[0].key);
  await manager.openDirectory(task.id);
  assert.deepEqual(opened, [done.directory]);
  const reloaded = new DownloadManager(options);
  await reloaded.load();
  assert.equal(reloaded.snapshot().tasks[0].fileName, done.fileName);
  assert.equal(reloaded.snapshot().tasks[0].imported, true);
  await reloaded.dispose();
  await manager.clearHistory();
  assert.equal(manager.snapshot().tasks.length, 0);
  assert.deepEqual(await fsp.readFile(path.join(done.directory, done.fileName)), wave());
});

test('native HTTP download follows valid redirects and reports progress without Content-Length', async t => {
  let followups = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/audio' }); res.end(); return; }
    followups++;
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.write(wave().subarray(0, 100));
    setTimeout(() => res.end(wave().subarray(100)), 30);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { manager, finished, events } = await fixture(t, {
    fetcher: fetch,
    apiRequest: async () => ({ data: { test_mid: `http://127.0.0.1:${server.address().port}/start` } }),
  });
  const task = await manager.start(request);
  const done = await finished(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(followups, 1);
  assert.equal(done.receivedBytes, wave().length);
  assert.ok(events.some(snapshot => snapshot.tasks[0]?.status === 'downloading' && snapshot.tasks[0].receivedBytes > 0 && !snapshot.tasks[0].totalBytes));
});

test('filesystems without hard links save using an exclusive copy and preserve existing names', async t => {
  let unsupportedCode;
  t.mock.method(fsp, 'link', async () => { throw Object.assign(new Error('Hard links unavailable'), { code: unsupportedCode }); });
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM']) {
    unsupportedCode = code;
    const { manager, finished, defaultDirectory } = await fixture(t);
    await fsp.mkdir(defaultDirectory);
    const original = path.join(defaultDirectory, '测试歌手 - 测试歌曲.wav');
    await fsp.writeFile(original, 'preserve original');
    const task = await manager.start(request);
    const done = await finished(task.id);
    assert.equal(done.status, 'completed', code);
    assert.equal(done.fileName, '测试歌手 - 测试歌曲 (1).wav');
    assert.equal(await fsp.readFile(original, 'utf8'), 'preserve original');
    assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.fileName)), wave());
    assert.equal((await fsp.readdir(defaultDirectory)).some(name => name.endsWith('.part')), false);
  }
});

test('exclusive copy retries a numbered name when another process wins the filename race', async t => {
  const actualCopyFile = fsp.copyFile;
  let copies = 0;
  let original;
  t.mock.method(fsp, 'link', async () => { throw Object.assign(new Error('Unsupported'), { code: 'ENOTSUP' }); });
  t.mock.method(fsp, 'copyFile', async (source, destination, flags) => {
    assert.equal(flags, fsConstants.COPYFILE_EXCL);
    if (++copies === 1) {
      original = destination;
      await fsp.writeFile(destination, 'another process wrote this', { flag: 'wx' });
    }
    return actualCopyFile(source, destination, flags);
  });
  const { manager, finished, defaultDirectory } = await fixture(t);
  const task = await manager.start(request);
  const done = await finished(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(copies, 2);
  assert.equal(done.fileName, '测试歌手 - 测试歌曲 (1).wav');
  assert.equal(await fsp.readFile(original, 'utf8'), 'another process wrote this');
  assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.fileName)), wave());
});

test('cancelling during fallback copy removes only the task-owned destination and partial', async t => {
  const actualCopyFile = fsp.copyFile;
  let reportCopy;
  let finishCopy;
  const copied = new Promise(resolve => { reportCopy = resolve; });
  const copyGate = new Promise(resolve => { finishCopy = resolve; });
  t.mock.method(fsp, 'link', async () => { throw Object.assign(new Error('Unsupported'), { code: 'ENOTSUP' }); });
  t.mock.method(fsp, 'copyFile', async (source, destination, flags) => {
    await actualCopyFile(source, destination, flags);
    reportCopy();
    await copyGate;
  });
  const { manager, defaultDirectory } = await fixture(t);
  await fsp.mkdir(defaultDirectory);
  const originalName = '测试歌手 - 测试歌曲.wav';
  await fsp.writeFile(path.join(defaultDirectory, originalName), 'existing file');
  const task = await manager.start(request);
  await copied;
  assert.equal(manager.snapshot().tasks[0].status, 'downloading');
  const cancelled = manager.cancel(task.id);
  finishCopy();
  assert.equal((await cancelled).status, 'cancelled');
  assert.deepEqual(await fsp.readdir(defaultDirectory), [originalName]);
  assert.equal(await fsp.readFile(path.join(defaultDirectory, originalName), 'utf8'), 'existing file');
});

test('copy rejection never deletes an unowned destination and removes the download partial', async t => {
  let destinationPath;
  t.mock.method(fsp, 'link', async () => { throw Object.assign(new Error('Unsupported'), { code: 'ENOTSUP' }); });
  t.mock.method(fsp, 'copyFile', async (_source, destination) => {
    destinationPath = destination;
    await fsp.writeFile(destination, 'unrelated owner', { flag: 'wx' });
    throw Object.assign(new Error('Access denied before destination opened'), { code: 'EACCES' });
  });
  const { manager, finished, defaultDirectory } = await fixture(t);
  const task = await manager.start(request);
  assert.equal((await finished(task.id)).status, 'failed');
  assert.equal(await fsp.readFile(destinationPath, 'utf8'), 'unrelated owner');
  assert.deepEqual(await fsp.readdir(defaultDirectory), [path.basename(destinationPath)]);
});

test('ordinary hard-link permission and disk failures do not trigger a copy fallback', async t => {
  let failureCode;
  let copies = 0;
  t.mock.method(fsp, 'link', async () => { throw Object.assign(new Error('Filesystem failure'), { code: failureCode }); });
  t.mock.method(fsp, 'copyFile', async () => { copies++; });
  for (const code of ['EACCES', 'ENOSPC', 'ENOENT']) {
    failureCode = code;
    const { manager, finished, defaultDirectory } = await fixture(t);
    const task = await manager.start(request);
    assert.equal((await finished(task.id)).status, 'failed');
    assert.deepEqual(await fsp.readdir(defaultDirectory), []);
  }
  assert.equal(copies, 0);
});

test('cancel aborts a stalled stream, removes the partial and never publishes a completed file', async t => {
  let streamCancelled = false;
  const { manager, until, defaultDirectory } = await fixture(t, {
    fetcher: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(wave().subarray(0, 100)); },
      cancel() { streamCancelled = true; },
    })),
  });
  const task = await manager.start(request);
  await until(snapshot => snapshot.tasks[0]?.receivedBytes === 100);
  assert.equal((await fsp.readdir(defaultDirectory)).some(name => name.endsWith('.part')), true);
  const cancelled = await manager.cancel(task.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(streamCancelled, true);
  assert.deepEqual(await fsp.readdir(defaultDirectory), []);
  await assert.rejects(manager.importDownload(task.id), /等待/);
  await assert.rejects(manager.cancel('../../elsewhere'), /找不到/);
});

test('failed download retries a fresh resolved URL into the newly selected directory', async t => {
  let resolution = 0;
  const urls = [];
  const { manager, finished, selectedDirectory, defaultDirectory } = await fixture(t, {
    apiRequest: async () => ({ data: { test_mid: `https://cdn.example.test/audio?attempt=${++resolution}` } }),
    fetcher: async url => {
      urls.push(String(url));
      return resolution === 1 ? new Response('<html>not music</html>', { headers: { 'content-type': 'text/html' } }) : new Response(wave());
    },
  });
  const task = await manager.start({...request, quality: '128'});
  const failed = await finished(task.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /不是音频/);
  assert.deepEqual(await fsp.readdir(defaultDirectory), []);
  await manager.selectDirectory();
  await manager.retry(task.id);
  const done = await finished(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.directory, await fsp.realpath(selectedDirectory));
  assert.equal(resolution, 2);
  assert.notEqual(urls[0], urls[1]);
});

test('actual streamed byte limits apply even when Content-Length is absent or false', async t => {
  for (const contentLength of [undefined, '1', '99999999999999']) {
    const { manager, finished, defaultDirectory } = await fixture(t, {
      maxBytes: 128,
      fetcher: async () => new Response(wave(), { headers: contentLength ? { 'content-length': contentLength } : {} }),
    });
    const task = await manager.start(request);
    const failed = await finished(task.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /大小限制/);
    assert.deepEqual(await fsp.readdir(defaultDirectory), []);
  }
});

test('redirects to non-HTTP addresses or credentials are rejected before following them', async t => {
  for (const location of ['file:///C:/private.txt', 'https://user:secret@cdn.example.test/audio']) {
    let fetchCount = 0;
    const { manager, finished, defaultDirectory } = await fixture(t, {
      fetcher: async () => { fetchCount++; return new Response(null, { status: 302, headers: { location } }); },
    });
    const task = await manager.start(request);
    assert.equal((await finished(task.id)).status, 'failed');
    assert.equal(fetchCount, 1);
    assert.deepEqual(await fsp.readdir(defaultDirectory), []);
  }
});

test('download queue limits concurrency and cancels waiting tasks without touching the network', async t => {
  let resolutions = 0;
  let bothStarted;
  const ready = new Promise(resolve => { bothStarted = resolve; });
  const { manager, until } = await fixture(t, {
    apiRequest: async () => { resolutions++; if (resolutions === 2) bothStarted(); return new Promise(() => {}); },
  });
  const first = await manager.start(request);
  const duplicate = await manager.start(request);
  assert.equal(duplicate.id, first.id);
  await manager.start({ ...request, track: { ...track, mid: 'second' } });
  const waiting = await manager.start({ ...request, track: { ...track, mid: 'third' } });
  await until(snapshot => snapshot.tasks.filter(task => task.status === 'resolving').length === 2);
  await ready;
  assert.equal(resolutions, 2);
  assert.equal(manager.snapshot().tasks.find(task => task.id === waiting.id).status, 'queued');
  assert.equal((await manager.cancel(waiting.id)).status, 'cancelled');
  await manager.dispose();
  assert.equal(resolutions, 2);
  assert.ok(manager.snapshot().tasks.every(task => task.status === 'cancelled'));
});

test('stalled connections fail on timeout with all temporary data removed', async t => {
  const { manager, finished, defaultDirectory } = await fixture(t, {
    idleTimeoutMs: 30,
    fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(wave().subarray(0, 100)); } })),
  });
  const task = await manager.start(request);
  const failed = await finished(task.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /超时/);
  assert.deepEqual(await fsp.readdir(defaultDirectory), []);
});

test('cancelling while resolving aborts the native service HTTP request immediately', { timeout: 3000 }, async t => {
  let reportRequest;
  let reportClosed;
  const requested = new Promise(resolve => { reportRequest = resolve; });
  const closed = new Promise(resolve => { reportClosed = resolve; });
  const server = http.createServer((_req, res) => {
    res.on('close', reportClosed);
    reportRequest();
    // Keep the resolver request open until the downloader cancels it.
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { manager, defaultDirectory } = await fixture(t, { apiRequest: requestApi });
  const task = await manager.start({ ...request, baseUrl: `http://127.0.0.1:${server.address().port}` });
  await requested;
  assert.equal((await manager.cancel(task.id)).status, 'cancelled');
  await closed;
  assert.deepEqual(await fsp.readdir(defaultDirectory), []);
});

test('interrupted history removes only its own partial and preserves unrelated files', async t => {
  const { manager, options, defaultDirectory } = await fixture(t);
  await fsp.mkdir(defaultDirectory);
  const interruptedId = randomUUID();
  const ownPartial = path.join(defaultDirectory, `.xmusic-${interruptedId}.part`);
  const unrelated = path.join(defaultDirectory, '.unrelated.part');
  await fsp.writeFile(ownPartial, 'partial');
  await fsp.writeFile(unrelated, 'preserve');
  await fsp.writeFile(path.join(options.dataDirectory, 'downloads.json'), JSON.stringify({
    version: 1, directory: defaultDirectory,
    tasks: [{ ...request, id: interruptedId, directory: defaultDirectory, status: 'downloading', receivedBytes: 7, createdAt: Date.now() }],
  }));
  await manager.load();
  assert.equal(manager.snapshot().tasks[0].status, 'failed');
  assert.match(manager.snapshot().tasks[0].error, /中断/);
  assert.deepEqual(await fsp.readdir(defaultDirectory), ['.unrelated.part']);
  assert.equal(await fsp.readFile(unrelated, 'utf8'), 'preserve');
});

test('pause aborts the transfer, survives restart and resumes with a fresh full download', async t => {
  let fetches = 0, lookups = 0, stopped = false;
  const {manager, options, until, finished, defaultDirectory} = await fixture(t, {
    apiRequest: async input => {lookups++; return {data: {[input.params.mid]: `https://cdn.example.test/audio?attempt=${lookups}`}};},
    fetcher: async (_url, options) => {
      fetches++;
      assert.equal(options.headers.Range, undefined, 'resuming is explicitly a new full download');
      if (fetches > 1) return new Response(wave());
      return new Response(new ReadableStream({start(controller) {controller.enqueue(wave().subarray(0, 100));}, cancel() {stopped = true;}}));
    },
  });
  const task = await manager.start(request);
  await until(snapshot => snapshot.tasks[0]?.receivedBytes === 100);
  const paused = await manager.pause(task.id);
  assert.equal(paused.status, 'paused'); assert.equal(paused.receivedBytes, 100);
  assert.equal(stopped, true); assert.deepEqual(await fsp.readdir(defaultDirectory), []);
  await manager.clearHistory();
  assert.equal(manager.snapshot().tasks[0].status, 'paused');
  await manager.dispose();
  const restored = new DownloadManager(options);
  await restored.load();
  assert.equal(restored.snapshot().tasks[0].status, 'paused');
  const resumed = await restored.resume(task.id);
  assert.equal(resumed.receivedBytes, 0);
  const done = await finished(task.id);
  assert.equal(done.status, 'completed'); assert.equal(lookups, 2); assert.equal(fetches, 2);
  assert.deepEqual(await fsp.readFile(path.join(done.directory, done.fileName)), wave());
  await restored.dispose();
});

test('queued pause prevents network work and paused cancellation remains a real terminal transition', async t => {
  let lookups = 0;
  const {manager, until} = await fixture(t, {apiRequest: async () => {lookups++; return new Promise(() => {});}});
  await manager.start(request); await manager.start({...request, track: {...track, mid: 'second'}});
  const waiting = await manager.start({...request, track: {...track, mid: 'third'}});
  await until(snapshot => snapshot.tasks.filter(task => task.status === 'resolving').length === 2);
  assert.equal((await manager.pause(waiting.id)).status, 'paused');
  assert.equal(lookups, 2);
  assert.equal((await manager.cancel(waiting.id)).status, 'cancelled');
  await manager.clearHistory();
  assert.equal(manager.snapshot().tasks.some(task => task.id === waiting.id), false);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=', 'base64');
const withCompanions = {...request, downloadCover: true, downloadLyrics: true};
function companionServices(overrides = {}) {
  return {
    apiRequest: async input => input.path === '/api/lyric' ? {data: {lyric: '[00:01.00]晚风 &amp; 星河'}}
      : input.path === '/api/song/detail' ? {data: {track_info: {album: {pmid: 'album_123'}}}}
      : {data: {[input.params.mid]: 'https://cdn.example.test/audio'}},
    fetcher: async url => String(url).includes('y.gtimg.cn') || String(url).includes('/cover')
      ? new Response(png, {headers: {'content-type': 'image/png'}}) : new Response(wave()),
    ...overrides,
  };
}

test('companion validation rejects truncated image signatures, oversized PNG dimensions and error documents disguised as lyrics', () => {
  assert.equal(coverExtension(png), 'png');
  for (const value of [png.subarray(0, 8), Buffer.from([255, 216, 255]), Buffer.from('RIFF0000WEBP')]) assert.throws(() => coverExtension(value));
  const giant = Buffer.from(png); giant.writeUInt32BE(10000, 16); giant.writeUInt32BE(10000, 20);
  assert.throws(() => coverExtension(giant));
  for (const lyric of ['<html>403 Forbidden</html>', '&lt;script&gt;error&lt;/script&gt;', '\0invalid', {lyric: []}]) assert.throws(() => lyricBuffer(lyric));
});

test('crash recovery keeps verified complete audio and companions together with an adjacent user sidecar', async t => {
  const {manager, options, finished, defaultDirectory} = await fixture(t, companionServices());
  const task = await manager.start(withCompanions); const done = await finished(task.id);
  const userFile = path.join(defaultDirectory, path.basename(done.fileName, '.wav') + '.jpg');
  await fsp.writeFile(userFile, 'user sidecar');
  const saved = JSON.parse(await fsp.readFile(manager.historyPath, 'utf8'));
  saved.tasks[0].status = 'downloading';
  await fsp.writeFile(manager.historyPath, JSON.stringify(saved));
  const recovered = new DownloadManager(options); await recovered.load();
  assert.equal(recovered.snapshot().tasks[0].status, 'completed');
  assert.equal(recovered.snapshot().tasks[0].fileName, done.fileName);
  assert.deepEqual((await fsp.readdir(defaultDirectory)).sort(), [done.fileName, done.coverFileName, done.lyricsFileName, path.basename(userFile)].sort());
  assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.fileName)), wave());
  assert.equal(await fsp.readFile(userFile, 'utf8'), 'user sidecar');
  await recovered.dispose();
});

test('a failed final history write never makes a completed audio file disappear on the next launch', async t => {
  const {manager, options, finished, defaultDirectory} = await fixture(t);
  const rename = fsp.rename;
  let failed = false;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (!failed && to === manager.historyPath && manager.snapshot().tasks.some(task => task.status === 'completed')) {
      failed = true;
      throw Object.assign(new Error('simulated history disk full'), {code: 'ENOSPC'});
    }
    return rename(from, to);
  });
  const task = await manager.start(request);
  const done = await finished(task.id);
  assert.equal(failed, true);
  assert.equal(done.status, 'completed');
  assert.match(done.error, /文件已保存.*记录/);
  const persisted = JSON.parse(await fsp.readFile(manager.historyPath, 'utf8')).tasks[0];
  assert.equal(persisted.status, 'downloading');
  const recovered = new DownloadManager(options);
  await recovered.load();
  assert.equal(recovered.snapshot().tasks[0].status, 'completed');
  assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.fileName)), wave());
  const [local] = await recovered.importDownload(task.id);
  assert.ok(local.localId);
  await recovered.dispose();
});

test('recovery preserves fully downloaded audio when exit interrupts companion requests', async t => {
  let lyricsStarted;
  const started = new Promise(resolve => {lyricsStarted = resolve;});
  const {manager, options, defaultDirectory} = await fixture(t, companionServices({apiRequest: async input => {
    if (input.path === '/api/lyric') {lyricsStarted(); return new Promise(() => {});}
    return {data: {[input.params.mid]: 'https://cdn.example.test/audio'}};
  }}));
  const task = await manager.start(withCompanions);
  await started;
  const saved = JSON.parse(await fsp.readFile(manager.historyPath, 'utf8'));
  const savedTask = saved.tasks[0];
  // Preserve the on-disk state a fresh process would see, then release the live
  // stream and put the published audio back to reproduce an abrupt exit.
  const audioPath = path.join(defaultDirectory, savedTask.fileName);
  const published = await fsp.readFile(audioPath);
  const stat = await fsp.stat(audioPath);
  await manager.pause(task.id);
  await fsp.writeFile(audioPath, published);
  const {ownFile} = require('./download-files.cjs');
  savedTask.ownedFiles = [await ownFile(audioPath, 'audio')];
  assert.equal(stat.size, published.length);
  await fsp.writeFile(manager.historyPath, JSON.stringify(saved));
  const recovered = new DownloadManager(options);
  await recovered.load();
  const restored = recovered.snapshot().tasks[0];
  assert.equal(restored.status, 'completed');
  assert.equal(restored.attachmentWarnings.length, 2);
  assert.match(restored.attachmentWarnings.join(' '), /退出.*附件|附件.*退出/);
  assert.deepEqual(await fsp.readFile(audioPath), published);
  assert.deepEqual((await recovered.remove({id: task.id, deleteFiles: true})).snapshot.tasks, []);
  await recovered.dispose();
});

test('a failed retry history save rolls back to a retryable failed task and a later retry downloads normally', async t => {
  const {manager, root, finished} = await fixture(t, {fetcher: async () => new Response(null, {status: 503})});
  const task = await manager.start({...request, quality: '128'});
  assert.equal((await finished(task.id)).status, 'failed');
  const before = manager.snapshot();
  const historyPath = manager.historyPath;
  manager.historyPath = path.join(root, 'missing', 'downloads.json');
  await assert.rejects(manager.retry(task.id));
  assert.deepEqual(manager.snapshot(), before);
  manager.historyPath = historyPath;
  manager.fetcher = async () => new Response(wave());
  await manager.retry(task.id);
  assert.equal((await finished(task.id)).status, 'completed');
});

test('a failed resume history save retains the paused state and a later resume starts a fresh download', async t => {
  const {manager, root, until, finished} = await fixture(t, {fetcher: async () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(wave().subarray(0, 100));},
  }))});
  const task = await manager.start(request);
  await until(snapshot => snapshot.tasks[0]?.receivedBytes === 100);
  await manager.pause(task.id);
  const before = manager.snapshot();
  const historyPath = manager.historyPath;
  manager.historyPath = path.join(root, 'missing', 'downloads.json');
  await assert.rejects(manager.resume(task.id));
  assert.deepEqual(manager.snapshot(), before);
  manager.historyPath = historyPath;
  manager.fetcher = async () => new Response(wave());
  await manager.resume(task.id);
  assert.equal((await finished(task.id)).status, 'completed');
});

test('failed directory changes and history removal preserve the prior visible records and all music files', async t => {
  const {manager, root, finished, defaultDirectory, selectedDirectory} = await fixture(t);
  const first = await manager.start(request); const done = await finished(first.id);
  const second = await manager.start({...request, track: {...track, mid: 'another'}}); await finished(second.id);
  const before = manager.snapshot();
  const historyPath = manager.historyPath;
  manager.historyPath = path.join(root, 'missing', 'downloads.json');
  await assert.rejects(manager.selectDirectory());
  assert.deepEqual(manager.snapshot(), before);
  await assert.rejects(manager.remove({id: first.id, deleteFiles: false}));
  assert.deepEqual(manager.snapshot(), before);
  await assert.rejects(manager.clearHistory());
  assert.deepEqual(manager.snapshot(), before);
  assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.fileName)), wave());
  manager.historyPath = historyPath;
  await manager.selectDirectory();
  assert.equal(manager.snapshot().directory, selectedDirectory);
  assert.equal((await manager.clearHistory()).tasks.length, 0);
  assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.fileName)), wave());
});

test('file deletion can be retried after a history save failure and still reports removed library identities', async t => {
  const {manager, registry, root, finished, defaultDirectory} = await fixture(t, companionServices());
  const task = await manager.start(withCompanions); await finished(task.id);
  const [local] = await manager.importDownload(task.id);
  const historyPath = manager.historyPath;
  manager.historyPath = path.join(root, 'missing', 'downloads.json');
  await assert.rejects(manager.remove({id: task.id, deleteFiles: true}));
  assert.equal(manager.snapshot().tasks[0]?.id, task.id);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(await fsp.readdir(defaultDirectory), []);
  manager.historyPath = historyPath;
  // Clearing other finished history must not discard the still-needed deletion receipt.
  await manager.clearHistory();
  assert.equal(manager.snapshot().tasks[0]?.id, task.id);
  const retry = await manager.remove({id: task.id, deleteFiles: false});
  assert.deepEqual(retry.removedLocalIds, [local.localId]);
  assert.deepEqual(retry.snapshot.tasks, []);
});

test('another queue pump cannot start a new task while its initial history save is pending or rejected', async t => {
  let requests = 0;
  const {manager, finished} = await fixture(t, {apiRequest: async input => {
    requests += 1;
    return {data: {[input.params.mid]: 'https://cdn.example.test/audio'}};
  }});
  let rejectWrite;
  const heldWrite = new Promise((_resolve, reject) => {rejectWrite = reject;});
  const persist = manager.persist;
  let hold = true;
  t.mock.method(manager, 'persist', async function(...args) {
    if (hold) {hold = false; await heldWrite;}
    return persist.apply(this, args);
  });
  const starting = manager.start(request);
  const rejected = assert.rejects(starting, /disk unavailable/);
  manager.pump(); // A concurrently finishing download also calls pump.
  assert.equal(manager.running.size, 0);
  assert.equal(requests, 0);
  rejectWrite(new Error('disk unavailable'));
  await rejected;
  assert.equal(manager.snapshot().tasks.length, 0);
  const task = await manager.start(request);
  assert.equal((await finished(task.id)).status, 'completed');
  assert.equal(requests, 1);
});

test('history pruning is rolled back if starting a new download cannot be saved', async t => {
  const {manager, root, finished, defaultDirectory} = await fixture(t);
  const task = await manager.start(request); const done = await finished(task.id);
  const original = manager.find(task.id);
  for (let index = 1; index < 200; index++) {
    const id = randomUUID();
    manager.tasks.set(id, {...original, id, track: {...original.track, mid: `history_${index}`}});
  }
  await manager.persist();
  const before = manager.snapshot();
  const historyPath = manager.historyPath;
  manager.historyPath = path.join(root, 'missing', 'downloads.json');
  await assert.rejects(manager.start(request));
  assert.deepEqual(manager.snapshot(), before);
  assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.fileName)), wave());
  manager.historyPath = historyPath;
});

test('a later queued history write includes the rollback of a failed concurrent state change', {timeout: 10000}, async t => {
  for (const action of ['clear', 'remove', 'start']) await t.test(action, async t => {
    const {manager, options, finished, selectedDirectory, defaultDirectory} = await fixture(t);
    const first = await manager.start(request); const done = await finished(first.id);
    await manager.running.get(first.id)?.promise;
    const before = manager.snapshot().tasks;
    const rename = fsp.rename;
    const persist = manager.persist;
    let rejectFirst;
    let enteredFirst;
    let queuedSecond;
    const firstEntered = new Promise(resolve => {enteredFirst = resolve;});
    const secondQueued = new Promise(resolve => {queuedSecond = resolve;});
    let renameCount = 0;
    let persistCount = 0;
    t.mock.method(fsp, 'rename', async (from, to) => {
      if (to === manager.historyPath && ++renameCount === 1) {
        enteredFirst();
        await new Promise((_resolve, reject) => {rejectFirst = reject;});
      }
      return rename(from, to);
    });
    t.mock.method(manager, 'persist', function(...args) {
      const pending = persist.apply(this, args);
      if (++persistCount === 2) queuedSecond();
      return pending;
    });
    const firstOperation = action === 'clear' ? manager.clearHistory()
      : action === 'remove' ? manager.remove({id: first.id, deleteFiles: false})
      : manager.start({...request, track: {...track, mid: 'concurrent_second'}});
    const rejected = assert.rejects(firstOperation, /simulated history failure/);
    await firstEntered;
    const directoryChange = manager.selectDirectory();
    await secondQueued;
    rejectFirst(Object.assign(new Error('simulated history failure'), {code: 'EIO'}));
    await rejected;
    await directoryChange;
    assert.deepEqual(manager.snapshot().tasks, before);
    assert.equal(manager.snapshot().directory, selectedDirectory);
    const saved = JSON.parse(await fsp.readFile(manager.historyPath, 'utf8'));
    assert.deepEqual(saved.tasks.map(task => task.id), [first.id]);
    assert.equal(saved.directory, selectedDirectory);
    assert.equal(saved.tasks[0].ownedFiles[0].kind, 'audio');
    const restored = new DownloadManager(options); await restored.load();
    assert.deepEqual(restored.snapshot().tasks.map(task => task.id), [first.id]);
    assert.equal(restored.snapshot().directory, selectedDirectory);
    assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.fileName)), wave());
    await restored.dispose();
  });
});

test('an earlier successful save never commits a later change whose own save fails', {timeout: 10000}, async t => {
  for (const action of ['clear', 'remove', 'start']) await t.test(action, async t => {
    const {manager, options, finished, selectedDirectory, defaultDirectory} = await fixture(t);
    const first = await manager.start(request); const done = await finished(first.id);
    await manager.running.get(first.id)?.promise;
    const before = manager.snapshot().tasks;
    let release;
    manager.writeQueue = new Promise(resolve => {release = resolve;});
    const rename = fsp.rename;
    const persist = manager.persist;
    let firstQueued;
    let secondQueued;
    const queuedFirst = new Promise(resolve => {firstQueued = resolve;});
    const queuedSecond = new Promise(resolve => {secondQueued = resolve;});
    let renameCount = 0;
    let persistCount = 0;
    t.mock.method(fsp, 'rename', async (from, to) => {
      if (to === manager.historyPath && ++renameCount === 2) throw Object.assign(new Error('simulated second history failure'), {code: 'EIO'});
      return rename(from, to);
    });
    t.mock.method(manager, 'persist', function(...args) {
      const pending = persist.apply(this, args);
      persistCount += 1;
      if (persistCount === 1) firstQueued();
      if (persistCount === 2) secondQueued();
      return pending;
    });
    const directoryChange = manager.selectDirectory();
    await queuedFirst;
    const secondOperation = action === 'clear' ? manager.clearHistory()
      : action === 'remove' ? manager.remove({id: first.id, deleteFiles: false})
      : manager.start({...request, track: {...track, mid: 'concurrent_second'}});
    const rejected = assert.rejects(secondOperation, /simulated second history failure/);
    await queuedSecond;
    release();
    await directoryChange;
    await rejected;
    assert.deepEqual(manager.snapshot().tasks, before);
    const saved = JSON.parse(await fsp.readFile(manager.historyPath, 'utf8'));
    assert.deepEqual(saved.tasks.map(task => task.id), [first.id]);
    assert.equal(saved.directory, selectedDirectory);
    assert.equal(saved.tasks[0].ownedFiles[0].kind, 'audio');
    const restored = new DownloadManager(options); await restored.load();
    assert.deepEqual(restored.snapshot().tasks.map(task => task.id), [first.id]);
    assert.equal(restored.snapshot().directory, selectedDirectory);
    assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.fileName)), wave());
    await restored.dispose();
  });
});

test('concurrent starts deduplicate inside the transaction before a stalled download begins', async t => {
  let requests = 0;
  const {manager, until} = await fixture(t, {fetcher: async () => {
    requests += 1;
    return new Response(new ReadableStream({start(controller) {controller.enqueue(wave().subarray(0, 100));}}));
  }});
  let release;
  manager.writeQueue = new Promise(resolve => {release = resolve;});
  const first = manager.start(request);
  const second = manager.start(request);
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.id, two.id);
  assert.equal(manager.snapshot().tasks.length, 1);
  await until(snapshot => snapshot.tasks[0]?.receivedBytes === 100);
  assert.equal(requests, 1);
  await manager.cancel(one.id);
});

test('a second start cannot return an uncommitted task that disappears when the first save fails', async t => {
  const {manager, finished} = await fixture(t);
  const rename = fsp.rename;
  let releaseFailure;
  let entered;
  const firstEntered = new Promise(resolve => {entered = resolve;});
  let writes = 0;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === manager.historyPath && ++writes === 1) {
      entered();
      await new Promise((_resolve, reject) => {releaseFailure = reject;});
    }
    return rename(from, to);
  });
  const first = assert.rejects(manager.start(request), /initial write failed/);
  await firstEntered;
  const uncommittedId = manager.snapshot().tasks[0].id;
  const second = manager.start(request);
  releaseFailure(new Error('initial write failed'));
  await first;
  const committed = await second;
  assert.notEqual(committed.id, uncommittedId);
  assert.equal(manager.snapshot().tasks[0].id, committed.id);
  assert.equal((await finished(committed.id)).status, 'completed');
});

test('queued cancellation, pause and removal block a competing pump while their history change waits', async t => {
  for (const action of ['cancel', 'pause', 'remove']) await t.test(action, async t => {
    let requests = 0;
    const {manager} = await fixture(t, {fetcher: async () => {requests += 1; return new Response(wave());}});
    const pump = manager.pump;
    manager.pump = () => {};
    const task = await manager.start(request);
    manager.pump = pump;
    assert.equal(manager.snapshot().tasks[0].status, 'queued');
    let release;
    manager.writeQueue = new Promise(resolve => {release = resolve;});
    const stopping = action === 'remove' ? manager.remove({id: task.id, deleteFiles: false}) : manager[action](task.id);
    manager.pump();
    release();
    await stopping;
    await Promise.all([...manager.running.values()].map(operation => operation.promise));
    assert.equal(requests, 0);
    assert.equal(manager.running.size, 0);
    if (action === 'remove') assert.deepEqual(manager.snapshot().tasks, []);
    else assert.equal(manager.snapshot().tasks[0].status, action === 'pause' ? 'paused' : 'cancelled');
    assert.equal(manager.pendingStops.size, 0);
  });
});

test('a failed queued removal releases its pump guard so the original download can continue', async t => {
  const {manager, finished} = await fixture(t);
  const pump = manager.pump;
  manager.pump = () => {};
  const task = await manager.start(request);
  manager.pump = pump;
  const rename = fsp.rename;
  let failed = false;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (!failed && to === manager.historyPath) {
      failed = true;
      throw new Error('cannot save removal');
    }
    return rename(from, to);
  });
  await assert.rejects(manager.remove({id: task.id, deleteFiles: false}), /cannot save removal/);
  assert.equal(manager.removing.size, 0);
  assert.equal(manager.pendingStops.size, 0);
  assert.equal((await finished(task.id)).status, 'completed');
});

test('a retry queued after history clearing cannot resurrect or execute a removed task', async t => {
  const {manager, finished} = await fixture(t, {fetcher: async () => new Response(null, {status: 503})});
  const task = await manager.start({...request, quality: '128'}); await finished(task.id);
  await manager.running.get(task.id)?.promise;
  let release;
  manager.writeQueue = new Promise(resolve => {release = resolve;});
  const clearing = manager.clearHistory();
  const retry = assert.rejects(manager.retry(task.id), /找不到/);
  release();
  await clearing;
  await retry;
  assert.equal(manager.running.size, 0);
  assert.deepEqual(manager.snapshot().tasks, []);
  assert.deepEqual(JSON.parse(await fsp.readFile(manager.historyPath, 'utf8')).tasks, []);
});

test('an import flag save failure rolls back the flag while preserving the local song for an idempotent retry', async t => {
  const {manager, registry, root, finished, events} = await fixture(t);
  const task = await manager.start(request); await finished(task.id);
  await manager.running.get(task.id)?.promise;
  const historyPath = manager.historyPath;
  manager.historyPath = path.join(root, 'missing', 'downloads.json');
  await assert.rejects(manager.importDownload(task.id));
  assert.equal(manager.snapshot().tasks[0].imported, false);
  assert.equal(events.at(-1).tasks[0].imported, false);
  const [local] = registry.list();
  assert.ok(local.localId);
  manager.historyPath = historyPath;
  const [again] = await manager.importDownload(task.id);
  assert.equal(again.localId, local.localId);
  assert.equal(registry.list().length, 1);
  assert.equal(manager.snapshot().tasks[0].imported, true);
  assert.equal(events.at(-1).tasks[0].imported, true);
  assert.equal(JSON.parse(await fsp.readFile(manager.historyPath, 'utf8')).tasks[0].imported, true);
});

test('online identities resolve completed downloads through opaque local URLs and deletion removes that association', async t => {
  const {manager, registry, finished, defaultDirectory} = await fixture(t);
  const task = await manager.start(request); const done = await finished(task.id);
  assert.deepEqual(registry.list(), []);
  manager.apiRequest = manager.fetcher = async () => {throw new Error('network must not be used for local resolution');};
  const url = await manager.resolveDownloadedAudio({mid: track.mid, quality: '320'});
  assert.match(url, /^xmusic-audio:\/\/track\/[a-f0-9-]+$/);
  assert.equal(url.includes(defaultDirectory), false);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].download, undefined);
  assert.equal(manager.snapshot().tasks[0].imported, true);
  const response = await localAudioResponse(new Request(url), registry);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wave());
  assert.equal(await registry.resolvePath(url.split('/').at(-1)), path.join(defaultDirectory, done.fileName));
  await manager.remove({id: task.id, deleteFiles: true});
  assert.equal(await manager.resolveDownloadedAudio({mid: track.mid, quality: '320'}), undefined);
});

test('download playback prefers the requested quality and otherwise chooses the highest available local quality', async t => {
  const {manager, registry, finished, defaultDirectory} = await fixture(t);
  const lossless = await manager.start(request); const high = await finished(lossless.id);
  const standard = await manager.start({...request, quality: '128'}); const low = await finished(standard.id);
  const resolvePath = async quality => registry.resolvePath((await manager.resolveDownloadedAudio({mid: track.mid, quality})).split('/').at(-1));
  assert.equal(await resolvePath('320'), path.join(defaultDirectory, high.fileName));
  assert.equal(await resolvePath('128'), path.join(defaultDirectory, low.fileName));
  const preferred = await manager.start({...request, quality: '320'}); const middle = await finished(preferred.id);
  assert.equal(await resolvePath('320'), path.join(defaultDirectory, middle.fileName));
  await fsp.unlink(path.join(defaultDirectory, middle.fileName));
  assert.equal(await resolvePath('320'), path.join(defaultDirectory, high.fileName));
});

test('missing and replaced downloads cannot be replayed through stale library associations', async t => {
  const {manager, finished, defaultDirectory} = await fixture(t);
  const task = await manager.start(request); const done = await finished(task.id);
  assert.ok(await manager.resolveDownloadedAudio({mid: track.mid, quality: 'flac'}));
  const filePath = path.join(defaultDirectory, done.fileName);
  const replacement = Buffer.from(wave()); replacement[100] ^= 255;
  await fsp.writeFile(filePath, replacement);
  assert.equal(await manager.resolveDownloadedAudio({mid: track.mid, quality: 'flac'}), undefined);
  assert.deepEqual(await fsp.readFile(filePath), replacement);
  await fsp.unlink(filePath);
  assert.equal(await manager.resolveDownloadedAudio({mid: track.mid, quality: '320'}), undefined);
});

test('registered download identity survives clearing history and restarting for offline favorites and playlists', async t => {
  const {manager, registry, options, finished} = await fixture(t);
  const task = await manager.start(request); await finished(task.id);
  const [local] = await manager.importDownload(task.id);
  const expectedUrl = await registry.resolveUrl(local.localId);
  await manager.clearHistory();
  const restoredRegistry = new AudioRegistry(options.dataDirectory); await restoredRegistry.load();
  const restored = new DownloadManager({...options, registry: restoredRegistry,
    apiRequest: async () => {throw new Error('offline');}, fetcher: async () => {throw new Error('offline');}});
  await restored.load();
  assert.deepEqual(restored.snapshot().tasks, []);
  assert.equal(await restored.resolveDownloadedAudio({mid: track.mid, quality: '320'}), expectedUrl);
  const response = await localAudioResponse(new Request(expectedUrl), restoredRegistry);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wave());
  await restoredRegistry.remove(local.localId);
  assert.equal(await restored.resolveDownloadedAudio({mid: track.mid, quality: 'flac'}), undefined);
  await restored.dispose();
});

test('clearing history and restarting cannot make a replaced or edited local file impersonate the original online song', async t => {
  const {manager, registry, options, finished, defaultDirectory} = await fixture(t);
  const task = await manager.start(request); const done = await finished(task.id);
  const [local] = await manager.importDownload(task.id);
  await manager.clearHistory();
  const filePath = path.join(defaultDirectory, done.fileName);
  const replacement = Buffer.from(wave()); replacement[200] ^= 255;
  await fsp.writeFile(filePath, replacement);
  const restoredRegistry = new AudioRegistry(options.dataDirectory); await restoredRegistry.load();
  const restored = new DownloadManager({...options, registry: restoredRegistry}); await restored.load();
  assert.equal(await restored.resolveDownloadedAudio({mid: track.mid, quality: '320'}), undefined);
  assert.deepEqual(await fsp.readFile(filePath), replacement);
  // The user's ordinary local-library entry is retained; only automatic online
  // identity matching is denied after its verified file content changes.
  assert.equal(restoredRegistry.list()[0].localId, local.localId);
  assert.equal(await registry.resolvePath(local.localId), filePath);
  await restored.dispose();
});

test('offline playback input accepts only a bounded song mid and supported quality without path capabilities', async t => {
  const {manager, registry} = await fixture(t);
  for (const input of [null, [], {}, {mid: '../song', quality: '320'}, {mid: track.mid, quality: 'lossless'},
    {mid: track.mid, quality: '320', filePath: 'C:/private.mp3'}, {mid: track.mid, quality: '320', songId: 123},
    {mid: 'a'.repeat(201), quality: '128'}, {mid: 123, quality: '320'}]) {
    await assert.rejects(manager.resolveDownloadedAudio(input), /参数无效/);
  }
  assert.equal(await manager.resolveDownloadedAudio({mid: 'not_downloaded', quality: '128'}), undefined);
  assert.deepEqual(registry.list(), []);
});

test('enabled companions share the actual collision-safe basename and verified deletion cleans registry references only for owned files', async t => {
  const {manager, registry, finished, defaultDirectory, options} = await fixture(t, companionServices());
  await fsp.mkdir(defaultDirectory);
  const unrelated = path.join(defaultDirectory, '测试歌手 - 测试歌曲.lrc');
  await fsp.writeFile(unrelated, 'user lyrics');
  const started = await manager.start(withCompanions);
  const done = await finished(started.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.fileName, '测试歌手 - 测试歌曲 (1).wav');
  assert.equal(done.coverFileName, '测试歌手 - 测试歌曲 (1).png');
  assert.equal(done.lyricsFileName, '测试歌手 - 测试歌曲 (1).lrc');
  assert.deepEqual(done.attachmentWarnings, []);
  assert.equal(done.ownedFiles, undefined);
  assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.coverFileName)), png);
  assert.equal(await fsp.readFile(path.join(defaultDirectory, done.lyricsFileName), 'utf8'), '[00:01.00]晚风 & 星河');
  const [local] = await manager.importDownload(started.id);
  assert.equal(registry.list().length, 1);
  const extra = path.join(defaultDirectory, '测试歌手 - 测试歌曲 (1).jpg');
  await fsp.writeFile(extra, 'user cover added later');
  const restarted = new DownloadManager(options);
  await restarted.load();
  const removed = await restarted.remove({id: started.id, deleteFiles: true});
  assert.deepEqual(removed.removedLocalIds, [local.localId]);
  assert.deepEqual(removed.snapshot.tasks, []); assert.deepEqual(registry.list(), []);
  assert.equal(await fsp.readFile(unrelated, 'utf8'), 'user lyrics');
  assert.equal(await fsp.readFile(extra, 'utf8'), 'user cover added later');
  assert.deepEqual((await fsp.readdir(defaultDirectory)).sort(), [path.basename(unrelated), path.basename(extra)].sort());
  const reloadedRegistry = new AudioRegistry(options.dataDirectory); await reloadedRegistry.load();
  assert.deepEqual(reloadedRegistry.list(), []);
  await restarted.dispose();
});

test('disabled attachment options make no lyric/detail/cover request while a direct validated cover avoids the detail lookup', async t => {
  const requests = [], covers = [];
  const service = companionServices();
  const {manager, finished} = await fixture(t, companionServices({
    apiRequest: async input => {requests.push(input.path); return service.apiRequest(input);},
    fetcher: async (url, options) => {covers.push(String(url)); return service.fetcher(url, options);},
  }));
  const plain = await manager.start(request); await finished(plain.id);
  assert.deepEqual(requests, ['/api/song/url']); assert.equal(covers.length, 1);
  requests.length = 0; covers.length = 0;
  const covered = await manager.start({...withCompanions, downloadLyrics: false, track: {...track, coverUrl: 'https://cdn.example.test/cover'}});
  const done = await finished(covered.id);
  assert.equal(done.status, 'completed'); assert.ok(done.coverFileName); assert.equal(done.lyricsFileName, undefined);
  assert.deepEqual(requests, ['/api/song/url']);
  assert.ok(covers.includes('https://cdn.example.test/cover'));
});

test('invalid or oversized companions report warnings without leaving a partial attachment or discarding audio', async t => {
  for (const badCover of [Buffer.from('<svg><script>bad</script></svg>'), Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)])]) {
    const {manager, finished, defaultDirectory} = await fixture(t, companionServices({
      apiRequest: async input => input.path === '/api/lyric' ? {data: {lyric: 'x'.repeat(2 * 1024 * 1024 + 1)}}
        : {data: {[input.params.mid]: 'https://cdn.example.test/audio'}},
      fetcher: async url => String(url).includes('/cover') ? new Response(badCover, {headers: {'content-type': 'image/png'}}) : new Response(wave()),
    }));
    const task = await manager.start({...withCompanions, track: {...track, coverUrl: 'https://cdn.example.test/cover'}});
    const done = await finished(task.id);
    assert.equal(done.status, 'completed'); assert.equal(done.attachmentWarnings.length, 2);
    assert.equal(done.coverFileName, undefined); assert.equal(done.lyricsFileName, undefined);
    assert.deepEqual(await fsp.readdir(defaultDirectory), [done.fileName]);
  }
});

test('pausing while attachments load removes the published audio and resumes as an ordinary fresh download', async t => {
  let lyricStarted;
  const started = new Promise(resolve => {lyricStarted = resolve;});
  const {manager, defaultDirectory} = await fixture(t, companionServices({apiRequest: async input => {
    if (input.path === '/api/lyric') {lyricStarted(); return new Promise(() => {});}
    return {data: {[input.params.mid]: 'https://cdn.example.test/audio'}};
  }}));
  const task = await manager.start(withCompanions);
  await started;
  assert.ok((await fsp.readdir(defaultDirectory)).some(name => name.endsWith('.wav')));
  assert.equal((await manager.pause(task.id)).status, 'paused');
  assert.deepEqual(await fsp.readdir(defaultDirectory), []);
  assert.equal((await manager.cancel(task.id)).status, 'cancelled');
});

test('physical deletion rejects modified audio or replaced companions before deleting any remaining task file', async t => {
  for (const kind of ['audio', 'cover']) {
    const {manager, registry, finished, defaultDirectory} = await fixture(t, companionServices());
    const task = await manager.start(withCompanions); const done = await finished(task.id);
    const local = await manager.importDownload(task.id);
    const changed = path.join(defaultDirectory, kind === 'audio' ? done.fileName : done.coverFileName);
    await fsp.unlink(changed); await fsp.writeFile(changed, 'replacement owned by user');
    const before = (await fsp.readdir(defaultDirectory)).sort();
    await assert.rejects(manager.remove({id: task.id, deleteFiles: true}), /替换或修改/);
    assert.deepEqual((await fsp.readdir(defaultDirectory)).sort(), before);
    assert.equal(await fsp.readFile(changed, 'utf8'), 'replacement owned by user');
    assert.equal(registry.list()[0].localId, local[0].localId);
    assert.equal(manager.snapshot().tasks.length, 1);
  }
});

test('record-only deletion preserves audio, all companions and imported library tracks', async t => {
  const {manager, registry, finished, defaultDirectory} = await fixture(t, companionServices());
  const task = await manager.start(withCompanions); await finished(task.id); await manager.importDownload(task.id);
  const before = (await fsp.readdir(defaultDirectory)).sort();
  const result = await manager.remove({id: task.id, deleteFiles: false});
  assert.deepEqual(result.removedLocalIds, []); assert.deepEqual(result.snapshot.tasks, []);
  assert.deepEqual((await fsp.readdir(defaultDirectory)).sort(), before); assert.equal(registry.list().length, 1);
});

test('legacy records cannot authorize file deletion, but missing files from verified downloads still remove stale library associations', async t => {
  const {manager, registry, finished, options, defaultDirectory} = await fixture(t);
  const first = await manager.start(request); const done = await finished(first.id);
  const [local] = await manager.importDownload(first.id);
  await fsp.unlink(path.join(defaultDirectory, done.fileName));
  assert.deepEqual((await manager.remove({id: first.id, deleteFiles: true})).removedLocalIds, [local.localId]);
  assert.equal(registry.list().length, 0);
  const second = await manager.start(request); const again = await finished(second.id);
  const history = JSON.parse(await fsp.readFile(manager.historyPath, 'utf8'));
  history.version = 1; history.tasks.forEach(task => {delete task.ownedFiles;});
  await fsp.writeFile(manager.historyPath, JSON.stringify(history));
  const legacy = new DownloadManager(options); await legacy.load();
  await assert.rejects(legacy.remove({id: second.id, deleteFiles: true}), /安全删除记录/);
  await legacy.remove({id: second.id, deleteFiles: false});
  assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, again.fileName)), wave());
  await legacy.dispose();
});

test('deleting an active task aborts the stream and accepts only its opaque id and explicit file-deletion boolean', async t => {
  let stopped = false;
  const {manager, until, defaultDirectory} = await fixture(t, {fetcher: async () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(wave().subarray(0, 100));}, cancel() {stopped = true;},
  }))});
  const task = await manager.start(request);
  await until(snapshot => snapshot.tasks[0]?.receivedBytes === 100);
  for (const input of [{id: task.id}, {id: task.id, deleteFiles: 'yes'}, {id: task.id, deleteFiles: true, path: '/private'}, {id: '../private', deleteFiles: true}]) {
    await assert.rejects(manager.remove(input));
  }
  const removed = await manager.remove({id: task.id, deleteFiles: true});
  assert.equal(stopped, true); assert.deepEqual(removed.snapshot.tasks, []); assert.deepEqual(await fsp.readdir(defaultDirectory), []);
});

test('redownload creates an independent task and collision-safe files while preserving the previous completed download', async t => {
  const {manager, finished, defaultDirectory} = await fixture(t, companionServices());
  const first = await manager.start(withCompanions); const original = await finished(first.id);
  const second = await manager.redownload(first.id); const repeated = await finished(second.id);
  assert.notEqual(first.id, second.id); assert.notEqual(original.fileName, repeated.fileName);
  assert.equal(manager.snapshot().tasks.length, 2);
  assert.equal(repeated.downloadCover, true); assert.equal(repeated.downloadLyrics, true);
  await manager.remove({id: second.id, deleteFiles: true});
  assert.deepEqual((await fsp.readdir(defaultDirectory)).sort(), [original.fileName, original.coverFileName, original.lyricsFileName].sort());
});

test('actual HTTP 403 and HTML responses fall through every quality to a valid complete audio stream', async t => {
  const urls = [], qualities = [];
  const server = http.createServer((req, res) => {
    urls.push(req.url);
    if (req.url === '/flac') {res.writeHead(403); res.end('Forbidden');}
    else if (req.url === '/320') {res.writeHead(200, {'Content-Type': 'text/html'}); res.end('<html>not audio</html>');}
    else {res.writeHead(200, {'Content-Type': 'audio/wav'}); res.end(wave());}
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const {manager, finished, defaultDirectory} = await fixture(t, {fetcher: fetch, apiRequest: async input => {
    qualities.push(input.params.quality);
    return {data: {[input.params.mid]: `http://127.0.0.1:${server.address().port}/${input.params.quality}`}};
  }});
  const task = await manager.start(request); const done = await finished(task.id);
  assert.equal(done.status, 'completed'); assert.equal(done.quality, 'flac'); assert.equal(done.actualQuality, '128');
  assert.deepEqual(qualities, ['flac', '320', '128']); assert.deepEqual(urls, ['/flac', '/320', '/128']);
  assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.fileName)), wave());
  assert.deepEqual(await fsp.readdir(defaultDirectory), [done.fileName]);
});

test('invalid audio bytes are removed before the lower-quality attempt and never prepended to its file', async t => {
  const qualities = [];
  let currentDirectory;
  const {manager, finished, defaultDirectory} = await fixture(t, {
    apiRequest: async input => {qualities.push(input.params.quality); return {data: {[input.params.mid]: `https://cdn.example.test/${input.params.quality}`}};},
    fetcher: async url => {
      if (String(url).endsWith('/flac')) return new Response(Buffer.from('<html>an error page masquerading as binary</html>'), {headers: {'content-type': 'application/octet-stream'}});
      assert.deepEqual(await fsp.readdir(currentDirectory), [], 'failed bytes must be removed before opening the next response');
      return new Response(wave());
    },
  });
  currentDirectory = defaultDirectory;
  const task = await manager.start(request); const done = await finished(task.id);
  assert.equal(done.status, 'completed'); assert.equal(done.actualQuality, '320');
  assert.deepEqual(qualities, ['flac', '320']); assert.equal(done.receivedBytes, wave().length);
  assert.deepEqual(await fsp.readFile(path.join(defaultDirectory, done.fileName)), wave());
});

test('all available qualities failing leaves no file and never tries a higher quality than the preference', async t => {
  for (const preferred of ['320', '128']) {
    const qualities = [];
    const {manager, finished, defaultDirectory} = await fixture(t, {
      apiRequest: async input => {qualities.push(input.params.quality); return {data: {[input.params.mid]: 'https://cdn.example.test/audio'}};},
      fetcher: async () => new Response('failed', {status: 503}),
    });
    const task = await manager.start({...request, quality: preferred}); const failed = await finished(task.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.quality, preferred); assert.equal(failed.actualQuality, undefined);
    assert.deepEqual(qualities, preferred === '320' ? ['320', '128'] : ['128']);
    assert.match(failed.error, /128/); assert.deepEqual(await fsp.readdir(defaultDirectory), []);
  }
});

test('a failed resolver request also retries the next quality with a newly requested URL', async t => {
  const qualities = [];
  const {manager, finished} = await fixture(t, {apiRequest: async input => {
    qualities.push(input.params.quality);
    if (input.params.quality === 'flac') throw new Error('The high-quality resolver returned HTTP 500');
    return {data: {[input.params.mid]: 'https://cdn.example.test/available'}};
  }});
  const task = await manager.start(request); const done = await finished(task.id);
  assert.equal(done.status, 'completed'); assert.equal(done.actualQuality, '320');
  assert.deepEqual(qualities, ['flac', '320']);
});

test('pause and cancel during a lower-quality stream stop fallback before requesting another quality', async t => {
  for (const action of ['pause', 'cancel']) {
    const qualities = [];
    let stopped = false;
    const {manager, until, defaultDirectory} = await fixture(t, {
      apiRequest: async input => {qualities.push(input.params.quality); return {data: {[input.params.mid]: `https://cdn.example.test/${input.params.quality}`}};},
      fetcher: async url => String(url).endsWith('/flac') ? new Response('Forbidden', {status: 403})
        : new Response(new ReadableStream({start(controller) {controller.enqueue(wave().subarray(0, 100));}, cancel() {stopped = true;}})),
    });
    const task = await manager.start(request);
    await until(snapshot => snapshot.tasks[0]?.receivedBytes === 100);
    const result = await manager[action](task.id);
    assert.equal(result.status, action === 'pause' ? 'paused' : 'cancelled');
    assert.equal(stopped, true); assert.deepEqual(qualities, ['flac', '320']);
    assert.deepEqual(await fsp.readdir(defaultDirectory), []);
  }
});

test('disk write setup failures do not retry the network at lower qualities', async t => {
  const open = fsp.open;
  t.mock.method(fsp, 'open', async (filePath, ...args) => {
    if (String(filePath).endsWith('.part')) throw Object.assign(new Error('Disk full'), {code: 'ENOSPC'});
    return open(filePath, ...args);
  });
  const qualities = [];
  const {manager, finished, defaultDirectory} = await fixture(t, {apiRequest: async input => {
    qualities.push(input.params.quality); return {data: {[input.params.mid]: 'https://cdn.example.test/audio'}};
  }});
  const task = await manager.start(request); assert.equal((await finished(task.id)).status, 'failed');
  assert.deepEqual(qualities, ['flac']); assert.deepEqual(await fsp.readdir(defaultDirectory), []);
});

test('attachment failures do not downgrade audio that was already downloaded successfully', async t => {
  const qualities = [];
  const {manager, finished} = await fixture(t, companionServices({apiRequest: async input => {
    if (input.path !== '/api/song/url') throw new Error('Companion service unavailable');
    qualities.push(input.params.quality); return {data: {[input.params.mid]: 'https://cdn.example.test/audio'}};
  }}));
  const task = await manager.start(withCompanions); const done = await finished(task.id);
  assert.equal(done.status, 'completed'); assert.equal(done.actualQuality, 'flac');
  assert.equal(done.attachmentWarnings.length, 2); assert.deepEqual(qualities, ['flac']);
});
