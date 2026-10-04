'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { AudioRegistry, parseRange, localAudioResponse, buildApiUrl, requestApi } = require('./core.cjs');

async function fixture(t, metadataReader = async () => ({ title: '测试歌曲', artist: '测试歌手', duration: 123 })) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'xmusic-backend-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, '测试 track.wav');
  await fsp.writeFile(file, Buffer.from('0123456789abcdef'));
  const registry = new AudioRegistry(path.join(directory, 'data'), metadataReader);
  await registry.load();
  return { directory, file, registry };
}

test('import persists opaque tracks, deduplicates files and removes only the library entry', async t => {
  const { directory, file, registry } = await fixture(t);
  const tracks = await registry.importFiles([file, file]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].title, '测试歌曲');
  assert.equal(tracks[0].source, 'local');
  assert.equal(tracks[0].duration, 123);
  assert.equal(Object.hasOwn(tracks[0], 'filePath'), false);
  assert.equal(JSON.stringify(tracks).includes(directory), false);
  assert.match(await registry.resolveUrl(tracks[0].localId), /^xmusic-audio:\/\/track\/[a-f0-9-]+$/);
  const reloaded = new AudioRegistry(path.join(directory, 'data'));
  await reloaded.load();
  assert.deepEqual(reloaded.list(), tracks);
  await reloaded.remove(tracks[0].localId);
  assert.deepEqual(reloaded.list(), []);
  assert.equal((await fsp.stat(file)).isFile(), true);
  await assert.rejects(reloaded.resolveUrl(tracks[0].localId), /找不到/);
  const afterRemoval = new AudioRegistry(path.join(directory, 'data'));
  await afterRemoval.load();
  assert.deepEqual(afterRemoval.list(), []);
});

test('metadata failures use filename and unknown artist without breaking import', async t => {
  const { file, registry } = await fixture(t, async () => { throw new Error('corrupt tag'); });
  const [track] = await registry.importFiles([file]);
  assert.equal(track.title, '测试 track');
  assert.equal(track.artist, '未知歌手');
});

test('the installed metadata parser reads duration from a real PCM WAV file', async t => {
  const { directory, file } = await fixture(t);
  const wave = Buffer.alloc(8044, 128);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(8036, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(8000, 28);
  wave.writeUInt16LE(1, 32);
  wave.writeUInt16LE(8, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(8000, 40);
  await fsp.writeFile(file, wave);
  const registry = new AudioRegistry(path.join(directory, 'real-parser-data'));
  await registry.load();
  const [track] = await registry.importFiles([file]);
  assert.equal(track.duration, 1);
  assert.equal(track.title, '测试 track');
});

test('local FLAC tags supply encyclopedia fields and survive registry reload without exposing file paths', async t => {
  const { directory } = await fixture(t);
  const file = path.join(directory, 'tagged.flac');
  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt16BE(4096, 0);
  streamInfo.writeUInt16BE(4096, 2);
  streamInfo.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n) | 44100n, 10);
  const sizedText = text => {
    const value = Buffer.from(text, 'utf8');
    const size = Buffer.alloc(4);
    size.writeUInt32LE(value.length);
    return Buffer.concat([size, value]);
  };
  const tags = ['TITLE=本地作品', 'ARTIST=本地歌手', 'ALBUM=本地专辑', 'LANGUAGE=eng', 'GENRE=Jazz', 'GENRE=Soul',
    'DATE=2020-01-02', 'RELEASEDATE=2021-03-04', 'LABEL=真实标签', 'COMMENT=文件中的简介'];
  const count = Buffer.alloc(4);
  count.writeUInt32LE(tags.length);
  const comment = Buffer.concat([sizedText('Xmusic test'), count, ...tags.map(sizedText)]);
  const commentHeader = Buffer.alloc(4);
  commentHeader[0] = 0x84;
  commentHeader.writeUIntBE(comment.length, 1, 3);
  await fsp.writeFile(file, Buffer.concat([Buffer.from('fLaC'), Buffer.from([0, 0, 0, 34]), streamInfo, commentHeader, comment]));
  const registry = new AudioRegistry(path.join(directory, 'tag-registry'));
  await registry.load();
  const [track] = await registry.importFiles([file]);
  assert.equal(track.title, '本地作品');
  assert.equal(track.language, 'eng');
  assert.equal(track.genre, 'Jazz / Soul');
  assert.equal(track.releaseDate, '2021-03-04');
  assert.equal(track.recordLabel, '真实标签');
  assert.equal(track.introduction, '文件中的简介');
  assert.equal(JSON.stringify(track).includes(directory), false);
  const reloaded = new AudioRegistry(path.join(directory, 'tag-registry'));
  await reloaded.load();
  assert.deepEqual(reloaded.list(), [track]);
});

test('registered detail fields are bounded strings and absent tags stay absent', async t => {
  const { file, registry } = await fixture(t, async () => ({
    language: { value: '国语' }, genre: 16, releaseDate: '', recordLabel: 'x'.repeat(700), introduction: 'y'.repeat(13000), privateNote: 'not a displayed field',
  }));
  const [track] = await registry.importFiles([file]);
  assert.equal(track.language, undefined);
  assert.equal(track.genre, undefined);
  assert.equal(track.releaseDate, undefined);
  assert.equal(track.recordLabel.length, 500);
  assert.equal(track.introduction.length, 12000);
  assert.equal(track.privateNote, undefined);
});

test('local artwork uses registered opaque cache URLs and keeps library JSON compact', async t => {
  const cover = Buffer.alloc(100000, 42);
  const { directory, file, registry } = await fixture(t, async () => ({
    title: 'Cover song', coverUrl: `data:image/jpeg;base64,${cover.toString('base64')}`,
  }));
  const [track] = await registry.importFiles([file]);
  assert.equal(track.coverUrl, `xmusic-audio://cover/${track.localId}`);
  assert.ok((await fsp.stat(registry.registryPath)).size < 1000);
  const reloaded = new AudioRegistry(path.join(directory, 'data'));
  await reloaded.load();
  assert.equal(reloaded.list()[0].coverUrl, track.coverUrl);
  const response = await localAudioResponse(new Request(track.coverUrl), reloaded);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), cover);
  await reloaded.remove(track.localId);
  const removed = await localAudioResponse(new Request(track.coverUrl), reloaded);
  assert.equal(removed.status, 404);
});

const sidecarPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=', 'base64');

test('folder import returns opaque tracks for nested audio without copying or changing source files', async t => {
  const { directory, file, registry } = await fixture(t);
  const nested = path.join(directory, 'album');
  await fsp.mkdir(nested);
  const second = path.join(nested, 'second.FLAC');
  await fsp.writeFile(second, 'original audio');
  await fsp.writeFile(path.join(nested, 'second.png'), sidecarPng);
  await fsp.writeFile(path.join(nested, 'second.lrc'), '[00:01]lyrics');
  const result = await registry.importFolders([directory, nested]);
  assert.equal(result.tracks.length, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.skippedDirectories, 0);
  assert.equal(JSON.stringify(result).includes(directory), false);
  const paths = await Promise.all(result.tracks.map(track => registry.resolvePath(track.localId)));
  assert.deepEqual(paths.sort(), [file, second].sort());
  assert.equal(await fsp.readFile(second, 'utf8'), 'original audio');
  assert.deepEqual((await fsp.readdir(path.join(directory, 'data'))).sort(), ['artwork', 'audio-library.json']);
  assert.equal(result.tracks.filter(track => track.coverUrl).length, 1);
});

test('downloaded same-stem artwork takes priority and supports covers larger than the previous cache limit', async t => {
  const { file, registry } = await fixture(t, async () => ({ coverUrl: 'data:image/jpeg;base64,AQID' }));
  const sidecar = file.replace(/\.wav$/, '.png');
  const cover = Buffer.concat([sidecarPng, Buffer.alloc(700000)]);
  await fsp.writeFile(sidecar, cover);
  const [track] = await registry.importFiles([file]);
  const response = await localAudioResponse(new Request(track.coverUrl), registry);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), cover);
  assert.ok((await fsp.stat(registry.registryPath)).size < 1000);
  await registry.remove(track.localId);
  assert.deepEqual(await fsp.readFile(sidecar), cover);
});

test('sidecar artwork still imports when tag parsing fails and an invalid sidecar falls back to embedded artwork', async t => {
  const { directory, file, registry } = await fixture(t, async () => { throw new Error('missing tags'); });
  const sidecar = file.replace(/\.wav$/, '.png');
  await fsp.writeFile(sidecar, sidecarPng);
  const [track] = await registry.importFiles([file]);
  assert.ok(track.coverUrl);
  const second = path.join(directory, 'second.mp3');
  await fsp.writeFile(second, 'audio');
  await fsp.writeFile(path.join(directory, 'second.jpg'), 'not an image');
  registry.metadataReader = async () => ({ coverUrl: `data:image/png;base64,${sidecarPng.toString('base64')}` });
  const [embedded] = await registry.importFiles([second]);
  const response = await localAudioResponse(new Request(embedded.coverUrl), registry);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), sidecarPng);
});

test('reimport attaches newly added sidecar covers and repairs a missing cache while preserving track identity', async t => {
  const { directory, file, registry } = await fixture(t);
  const [original] = await registry.importFiles([file]);
  assert.equal(original.coverUrl, undefined);
  await fsp.writeFile(file.replace(/\.wav$/, '.png'), sidecarPng);
  const [refreshed] = await registry.importFiles([file, file]);
  assert.equal(refreshed.localId, original.localId);
  assert.equal(refreshed.title, original.title);
  assert.equal(registry.list().length, 1);
  assert.ok(refreshed.coverUrl);
  const cached = await registry.resolveArtwork(refreshed.localId);
  await fsp.unlink(cached.filePath);
  assert.equal((await localAudioResponse(new Request(refreshed.coverUrl), registry)).status, 404);
  assert.deepEqual(await registry.importFiles([file]), [refreshed]);
  const restored = await localAudioResponse(new Request(refreshed.coverUrl), registry);
  assert.equal(restored.status, 200);
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()), sidecarPng);
  const reloaded = new AudioRegistry(path.join(directory, 'data'));
  await reloaded.load();
  assert.deepEqual(reloaded.list(), [refreshed]);
});

test('failed library saves roll back refreshed covers and remove their newly created cache files', async t => {
  const { directory, file, registry } = await fixture(t);
  const [original] = await registry.importFiles([file]);
  await fsp.writeFile(file.replace(/\.wav$/, '.png'), sidecarPng);
  const savedPath = registry.registryPath;
  registry.registryPath = path.join(directory, 'missing', 'library.json');
  await assert.rejects(registry.importFiles([file]));
  assert.deepEqual(registry.list(), [original]);
  assert.deepEqual(await fsp.readdir(registry.artworkDirectory), []);
  registry.registryPath = savedPath;
  const [refreshed] = await registry.importFiles([file]);
  assert.ok(refreshed.coverUrl);
});

test('an unavailable artwork cache does not prevent the audio from importing', async t => {
  const { directory, file, registry } = await fixture(t);
  const blocker = path.join(directory, 'not-a-directory');
  await fsp.writeFile(blocker, 'untouched');
  registry.artworkDirectory = blocker;
  await fsp.writeFile(file.replace(/\.wav$/, '.png'), sidecarPng);
  const [track] = await registry.importFiles([file]);
  assert.equal(track.coverUrl, undefined);
  assert.equal(await fsp.readFile(blocker, 'utf8'), 'untouched');
  assert.match(await registry.resolveUrl(track.localId), /^xmusic-audio:\/\/track\//);
});

test('associating an existing local file with a download rolls back atomically when saving fails', async t => {
  const {directory, file, registry} = await fixture(t);
  const [track] = await registry.importFiles([file]);
  const identity = {mid: 'download_mid', quality: 'flac'};
  const registryPath = registry.registryPath;
  registry.registryPath = path.join(directory, 'missing', 'library.json');
  await assert.rejects(registry.importDownload(file, identity));
  assert.equal(await registry.resolveDownloadedUrl(identity), undefined);
  assert.deepEqual(registry.list(), [track]);
  registry.registryPath = registryPath;
  assert.equal((await registry.importDownload(file, identity))[0].localId, track.localId);
  assert.equal(await registry.resolveDownloadedUrl(identity), await registry.resolveUrl(track.localId));
  assert.equal(await registry.resolveDownloadedUrl({...identity, quality: '320'}), undefined);
});

test('malformed persisted download associations cannot grant an offline lookup while ordinary local tracks remain readable', async t => {
  const {directory, file, registry} = await fixture(t);
  const [track] = await registry.importFiles([file]);
  const saved = JSON.parse(await fsp.readFile(registry.registryPath, 'utf8'));
  saved.tracks[0].download = {mid: 'valid_mid', quality: 'flac', filePath: 'C:/unregistered.mp3'};
  await fsp.writeFile(registry.registryPath, JSON.stringify(saved));
  const restored = new AudioRegistry(path.join(directory, 'data')); await restored.load();
  assert.equal(await restored.resolveDownloadedUrl({mid: 'valid_mid', quality: 'flac'}), undefined);
  assert.equal(await restored.resolvePath(track.localId), file);
});

test('legacy download associations without a file fingerprint do not silently match changed audio after restart', async t => {
  const {directory, file, registry} = await fixture(t);
  const [track] = await registry.importFiles([file]);
  const saved = JSON.parse(await fsp.readFile(registry.registryPath, 'utf8'));
  saved.tracks[0].download = {mid: 'legacy_mid', quality: 'flac'};
  await fsp.writeFile(registry.registryPath, JSON.stringify(saved));
  const restored = new AudioRegistry(path.join(directory, 'data')); await restored.load();
  assert.equal(await restored.resolveDownloadedUrl({mid: 'legacy_mid', quality: 'flac'}), undefined);
  assert.equal(await restored.resolvePath(track.localId), file);
});

test('unregistered IDs and nonaudio paths cannot resolve files or lyrics', async t => {
  const { directory, registry } = await fixture(t);
  const arbitraryFile = path.join(directory, 'private.txt');
  await fsp.writeFile(arbitraryFile, 'private');
  await assert.rejects(registry.importFiles([arbitraryFile]), /无法导入/);
  for (const id of ['../../private.txt', arbitraryFile, randomUUID(), null, {}]) {
    await assert.rejects(registry.resolveUrl(id), /找不到/);
    await assert.rejects(registry.readLyrics(id), /找不到/);
  }
  assert.deepEqual(registry.list(), []);
});

test('concurrent mutations preserve all imports and rollback when saving fails', async t => {
  const { directory, file, registry } = await fixture(t);
  const secondFile = path.join(directory, 'second.mp3');
  await fsp.writeFile(secondFile, 'audio');
  const imported = await Promise.all([registry.importFiles([file]), registry.importFiles([secondFile])]);
  assert.equal(imported[0].length, 1);
  assert.equal(imported[1].length, 1);
  assert.notEqual(imported[0][0].localId, imported[1][0].localId);
  assert.equal(registry.list().length, 2);
  assert.deepEqual(await registry.importFiles([file]), imported[0]);
  assert.deepEqual(await registry.importFiles([]), []);
  const originalPath = registry.registryPath;
  registry.registryPath = path.join(directory, 'missing-directory', 'library.json');
  const before = registry.list();
  await assert.rejects(registry.remove(before[0].localId));
  assert.deepEqual(registry.list(), before);
  registry.registryPath = originalPath;
  await registry.remove(before[0].localId);
  assert.equal(registry.list().length, 1);
});

test('missing media is surfaced and adjacent UTF-8/UTF-16 lyrics are supported', async t => {
  const { directory, file, registry } = await fixture(t);
  const [track] = await registry.importFiles([file]);
  assert.equal(await registry.readLyrics(track.localId), '');
  const lyricsPath = path.join(directory, '测试 track.lrc');
  await fsp.writeFile(lyricsPath, '\uFEFF[00:00.00]你好');
  assert.equal(await registry.readLyrics(track.localId), '[00:00.00]你好');
  await fsp.writeFile(lyricsPath, Buffer.from('\uFEFF[00:01.00]世界', 'utf16le'));
  assert.equal(await registry.readLyrics(track.localId), '[00:01.00]世界');
  await fsp.writeFile(lyricsPath, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(registry.readLyrics(track.localId), /无法读取/);
  await fsp.unlink(file);
  await assert.rejects(registry.resolveUrl(track.localId), /已移动、删除/);
});

test('damaged saved data is preserved and does not become an empty writable library', async t => {
  const { registry } = await fixture(t);
  await fsp.writeFile(registry.registryPath, '{broken');
  await assert.rejects(registry.load(), /音乐库无法读取/);
  assert.equal(await fsp.readFile(registry.registryPath, 'utf8'), '{broken');
});

test('byte ranges handle seek, suffix, clipping and reject malformed or unsatisfiable ranges', () => {
  assert.deepEqual(parseRange(null, 10), { start: 0, end: 9, partial: false });
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5, partial: true });
  assert.deepEqual(parseRange('bytes=8-', 10), { start: 8, end: 9, partial: true });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9, partial: true });
  assert.deepEqual(parseRange('bytes=-30', 10), { start: 0, end: 9, partial: true });
  assert.deepEqual(parseRange('bytes=2-90', 10), { start: 2, end: 9, partial: true });
  for (const header of ['bytes=10-', 'bytes=3-2', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'items=1-2', 'bytes=9007199254740992-']) {
    assert.equal(parseRange(header, 10), null, header);
  }
  assert.equal(parseRange('bytes=0-', 0), null);
});

test('custom protocol streams registered audio with correct range and HEAD semantics', async t => {
  const { file, registry } = await fixture(t);
  const [track] = await registry.importFiles([file]);
  const url = await registry.resolveUrl(track.localId);
  const whole = await localAudioResponse(new Request(url), registry);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'audio/wav');
  assert.equal(await whole.text(), '0123456789abcdef');
  const partial = await localAudioResponse(new Request(url, { headers: { Range: 'bytes=4-7' } }), registry);
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 4-7/16');
  assert.equal(partial.headers.get('content-length'), '4');
  assert.equal(await partial.text(), '4567');
  const head = await localAudioResponse(new Request(url, { method: 'HEAD' }), registry);
  assert.equal(head.headers.get('content-length'), '16');
  assert.equal(await head.text(), '');
  const invalidRange = await localAudioResponse(new Request(url, { headers: { Range: 'bytes=100-' } }), registry);
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('content-range'), 'bytes */16');
  const unknown = await localAudioResponse(new Request(`xmusic-audio://track/${randomUUID()}`), registry);
  assert.equal(unknown.status, 404);
  const injected = await localAudioResponse(new Request(`${url}?file=C:/private.txt`), registry);
  assert.equal(injected.status, 404);
  const post = await localAudioResponse(new Request(url, { method: 'POST' }), registry);
  assert.equal(post.status, 405);
});

test('API validation allows configured HTTP(S) origins and encodes query values', () => {
  const url = buildApiUrl({ baseUrl: 'https://example.com/music/', path: '/api/search', params: { keyword: 'a&b 音乐', type: 'song', num: 20, page: 1 } });
  assert.equal(url.pathname, '/music/api/search');
  assert.equal(url.searchParams.get('keyword'), 'a&b 音乐');
  assert.equal(url.searchParams.has('b 音乐'), false);
  assert.equal(buildApiUrl({ path: '/api/lyric', params: { id: 123, trans: true } }).protocol, 'https:');
  assert.equal(buildApiUrl({ baseUrl: 'http://127.0.0.1:3000', path: '/api/song/url', params: { mid: 'abc,def', quality: 'flac' } }).port, '3000');
});

test('API validation rejects arbitrary paths, credentials, unsafe schemes and malformed parameters', () => {
  const search = { path: '/api/search', params: { keyword: 'test' } };
  for (const baseUrl of ['file:///C:/secret', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com?token=a', 'https://example.com#hash', '//example.com']) {
    assert.throws(() => buildApiUrl({ ...search, baseUrl }));
  }
  for (const pathName of ['/api/delete', 'https://example.com/api/search', '/api/../search', '__proto__', 'constructor']) {
    assert.throws(() => buildApiUrl({ ...search, path: pathName }));
  }
  for (const params of [{ keyword: '' }, { keyword: {} }, { keyword: 'test', token: 'secret' }, { keyword: 'test', page: true }, { keyword: 'test', num: 101 }]) {
    assert.throws(() => buildApiUrl({ ...search, params }));
  }
  assert.throws(() => buildApiUrl({ path: '/api/song/url', params: { mid: '../file', quality: '320' } }));
  assert.throws(() => buildApiUrl({ path: '/api/lyric', params: { id: true } }));
  assert.throws(() => buildApiUrl({ path: '/api/lyric', params: { mid: 'abc', trans: 'arbitrary' } }));
});

test('song URL resolution bypasses HTTP caches so an expired signature can be replaced', async () => {
  await requestApi({path: '/api/song/url', params: {mid: 'test', quality: 'flac'}}, {fetcher: async (_url, options) => {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Cache-Control'], 'no-cache, no-store');
    return new Response('{"data":{"test":"https://media.example/fresh"}}');
  }});
});

test('song details allow a single mobile mid or positive id while rejecting lists and arbitrary fields', () => {
  assert.equal(buildApiUrl({ path: '/api/song/detail', params: { mid: '0031sbUK1c0Oav' } }).searchParams.get('mid'), '0031sbUK1c0Oav');
  assert.equal(buildApiUrl({ path: '/api/song/detail', params: { id: 123 } }).searchParams.get('id'), '123');
  for (const params of [{}, { mid: 'one,two' }, { mid: '../song' }, { mid: true }, { id: -1 }, { id: true },
    { mid: 'valid', id: 'bad' }, { id: 123, mid: '' }, { mid: 'valid', num: 10 }]) {
    assert.throws(() => buildApiUrl({ path: '/api/song/detail', params }));
  }
});

test('discovery routes validate IDs and pagination while pinning QQ requests to the public host', async () => {
  assert.equal(buildApiUrl({path: '/api/top', params: {}}).pathname, '/api/top');
  assert.equal(buildApiUrl({baseUrl: 'http://localhost:3000/v1', path: '/api/top', params: {id: 26, num: 100}}).pathname, '/v1/api/top');
  assert.equal(buildApiUrl({path: '/api/playlist', params: {id: '1234567890', num: 2000}}).searchParams.get('num'), '2000');
  assert.equal(buildApiUrl({path: '/api/song/detail', params: {id: 123}}).searchParams.get('id'), '123');
  for (const request of [
    {path: '/api/top', params: {id: true}}, {path: '/api/playlist', params: {}},
    {path: '/api/song/detail', params: {id: '../x'}}, {path: '/api/top', params: {num: 101}},
    {path: '/api/playlist', params: {id: 1, num: 2001}},
  ]) assert.throws(() => buildApiUrl(request));
  const pathName = '/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg';
  const params = {format: 'json', inCharset: 'utf8', outCharset: 'utf-8', sortId: 5, categoryId: 10000000, sin: 0, ein: 19, picmid: 1};
  const url = buildApiUrl({path: pathName, baseUrl: 'https://example.com/private', params});
  assert.equal(url.origin, 'https://c.y.qq.com');
  assert.equal(url.pathname, pathName);
  for (const invalid of [{sin: -1}, {ein: 100}, {sin: 20}, {categoryId: 0}, {sortId: true}, {format: 'jsonp'}, {callback: 'run'}]) {
    assert.throws(() => buildApiUrl({path: pathName, params: {...params, ...invalid}}));
  }
  await requestApi({path: pathName, params}, {fetcher: async (target, options) => {
    assert.equal(target.origin, 'https://c.y.qq.com');
    assert.equal(options.headers.Referer, 'https://y.qq.com/');
    assert.equal(options.redirect, 'error');
    return new Response('{"code":0,"data":{"list":[]}}');
  }});
});

test('native API requests parse JSON and expose readable HTTP, malformed response, timeout and size errors', async t => {
  const server = http.createServer((request, response) => {
    const keyword = new URL(request.url, 'http://localhost').searchParams.get('keyword');
    if (keyword === 'timeout') return;
    if (keyword === 'busy') { response.writeHead(429); response.end(); return; }
    if (keyword === 'redirect') { response.writeHead(302, { Location: '/private' }); response.end(); return; }
    if (keyword === 'bad') { response.end('<html>bad gateway</html>'); return; }
    if (keyword === 'huge') { response.end('x'.repeat(4 * 1024 * 1024 + 1)); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: { list: [{ title: keyword }] } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = keyword => ({ baseUrl, path: '/api/search', params: { keyword } });
  assert.deepEqual(await requestApi(request('你好')), { data: { list: [{ title: '你好' }] } });
  await assert.rejects(requestApi(request('busy')), /请求过于频繁/);
  await assert.rejects(requestApi(request('bad')), /数据格式无效/);
  await assert.rejects(requestApi(request('redirect')), /无法连接音乐服务/);
  await assert.rejects(requestApi(request('huge')), /数据过大/);
  await assert.rejects(requestApi(request('timeout'), { timeoutMs: 20 }), /请求超时/);
});

test('403 failures name the actual service and a recovery action without changing sources or exposing its address', async () => {
  const requests = [
    { input: { path: '/api/search', params: { keyword: 'test' } }, source: '内置服务', action: '在设置中配置可用的服务地址' },
    { input: { baseUrl: 'https://private.example/service', path: '/api/top', params: {} }, source: '自定义服务', action: '清空地址恢复内置服务' },
    { input: { baseUrl: 'https://private.example/service', path: '/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg', params: { format: 'json', inCharset: 'utf8', outCharset: 'utf-8' } }, source: 'QQ 歌单服务', action: '请稍后重新加载' },
  ];
  for (const { input, source, action } of requests) {
    let calls = 0;
    let cancelled = false;
    await assert.rejects(requestApi(input, { fetcher: async target => {
      calls += 1;
      assert.equal(target.href, buildApiUrl(input).href);
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 });
    } }), error => {
      assert.match(error.message, /HTTP 403/);
      assert.ok(error.message.includes(source));
      assert.ok(error.message.includes(action));
      assert.equal(error.message.includes('private.example'), false);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  }
});

test('explicit browser challenges and JSON service code 403 remain failures with accurate diagnostics', async () => {
  const input = { path: '/api/top', params: {} };
  let challengeCalls = 0;
  await assert.rejects(requestApi(input, { fetcher: async () => {
    challengeCalls += 1;
    return new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
  } }), /音乐服务要求浏览器验证（HTTP 403，内置服务）/);
  assert.equal(challengeCalls, 1);
  for (const payload of [{ code: 403 }, { code: '403' }, { status: 403 }, { status: '403' }]) {
    await assert.rejects(requestApi(input, { fetcher: async () => new Response(JSON.stringify(payload)) }),
      /音乐服务拒绝访问（服务错误 403，内置服务）/);
  }
  // A song or chart ID is not an API error code.
  assert.deepEqual(await requestApi(input, { fetcher: async () => new Response('{"code":0,"data":{"status":403}}') }),
    { code: 0, data: { status: 403 } });
});

test('only a built-in chart HTTP 403 reads the fixed official API and preserves full chart metadata', async () => {
  for (const params of [{}, { id: '26', num: 50 }]) {
    const data = params.id === undefined ? { group: [{ groupName: '巅峰榜', toplist: [{ topId: 26, title: '热歌榜' }] }] }
      : { data: { song: [{ songId: 123, title: '真实歌曲' }] }, songInfoList: [{ id: 123, mid: 'song123', album: { pmid: 'album123' } }] };
    const calls = [];
    let primaryCancelled = false;
    const result = await requestApi({ path: '/api/top', params }, { fetcher: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return new Response(new ReadableStream({ cancel() { primaryCancelled = true; } }), { status: 403 });
      assert.equal(url.origin, 'https://u.y.qq.com');
      assert.equal(url.pathname, '/cgi-bin/musicu.fcg');
      assert.equal(url.searchParams.get('format'), 'json');
      assert.deepEqual(JSON.parse(url.searchParams.get('data')), {
        comm: { ct: 24, cv: 0 }, req_1: {
          module: 'musicToplist.ToplistInfoServer', method: params.id === undefined ? 'GetAll' : 'GetDetail',
          param: params.id === undefined ? {} : { topId: 26, offset: 0, num: 50, period: '' },
        },
      });
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Referer, 'https://y.qq.com/');
      assert.equal(options.signal, calls[0].options.signal);
      return new Response(JSON.stringify({ code: 0, req_1: { code: 0, data } }));
    } });
    assert.equal(primaryCancelled, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(result, { code: 0, data });
  }
});

test('official chart fallback rejects failed or malformed responses and retains both service failures', async () => {
  for (const fallback of [
    () => new Response('unavailable', { status: 503 }),
    () => new Response(JSON.stringify({ code: 0, req_1: { code: 500, data: { group: [] } } })),
    () => new Response(JSON.stringify({ code: 0, req_1: { code: 0, data: {} } })),
    () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
  ]) {
    let calls = 0;
    await assert.rejects(requestApi({ path: '/api/top', params: {} }, { fetcher: async () => ++calls === 1
      ? new Response(null, { status: 403 }) : fallback() }), error => {
      assert.match(error.message, /HTTP 403，内置服务/);
      assert.match(error.message, /QQ 官方榜单也未能加载/);
      return true;
    });
    assert.equal(calls, 2);
  }
});

test('other HTTP failures and API error codes do not switch chart sources', async () => {
  for (const response of [
    () => new Response(null, { status: 429 }),
    () => new Response(null, { status: 503 }),
    () => new Response(JSON.stringify({ code: 403 })),
  ]) {
    let calls = 0;
    await assert.rejects(requestApi({ path: '/api/top', params: {} }, { fetcher: async () => { calls += 1; return response(); } }));
    assert.equal(calls, 1);
  }
});
