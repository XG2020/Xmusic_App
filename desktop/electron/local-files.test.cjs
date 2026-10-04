'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MAX_COVER_BYTES } = require('./download-files.cjs');
const { scanAudioFolders, readSidecarArtwork } = require('./local-files.cjs');

const extensions = ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus', 'aac', 'webm'];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'xmusic-local-files-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'music');
  await fsp.mkdir(root);
  return { directory, root };
}

test('folder scans recurse, deduplicate overlapping selections, and skip empty and nonaudio files', async t => {
  const { root } = await fixture(t);
  const nested = path.join(root, '专辑');
  await fsp.mkdir(nested);
  const files = [path.join(root, 'song.MP3'), path.join(nested, 'another.flac')];
  for (const file of files) await fsp.writeFile(file, 'audio');
  await fsp.writeFile(path.join(root, 'song.jpg'), png);
  await fsp.writeFile(path.join(nested, 'song.lrc'), 'lyrics');
  await fsp.writeFile(path.join(root, 'empty.wav'), '');
  const result = await scanAudioFolders([root, nested, root], extensions);
  assert.deepEqual(result.filePaths.sort(), files.sort());
  assert.equal(result.truncated, false);
  assert.equal(result.skippedDirectories, 0);
  assert.equal(result.scannedEntries, 6);
});

test('folder scans report bounded file, entry and depth limits without falsely marking an exact limit', async t => {
  const { root } = await fixture(t);
  await fsp.writeFile(path.join(root, 'one.mp3'), 'audio');
  const exact = await scanAudioFolders([root], extensions, { maxFiles: 1, maxEntries: 1 });
  assert.equal(exact.filePaths.length, 1);
  assert.equal(exact.truncated, false);
  await fsp.writeFile(path.join(root, 'two.flac'), 'audio');
  const capped = await scanAudioFolders([root], extensions, { maxFiles: 1 });
  assert.equal(capped.filePaths.length, 1);
  assert.equal(capped.truncated, true);
  const entries = await scanAudioFolders([root], extensions, { maxEntries: 1 });
  assert.equal(entries.scannedEntries, 1);
  assert.equal(entries.truncated, true);
  const nested = path.join(root, 'nested');
  await fsp.mkdir(nested);
  await fsp.writeFile(path.join(nested, 'three.wav'), 'audio');
  const depth = await scanAudioFolders([root], extensions, { maxDepth: 0 });
  assert.equal(depth.filePaths.length, 2);
  assert.equal(depth.truncated, true);
  assert.equal(depth.skippedDirectories, 1);
});

test('folder scans reject invalid roots and keep readable roots when another selection disappears', async t => {
  const { directory, root } = await fixture(t);
  const missing = path.join(directory, 'missing');
  await fsp.writeFile(path.join(root, 'one.mp3'), 'audio');
  for (const roots of [null, ['relative'], [42], Array(1001).fill(root)]) {
    await assert.rejects(scanAudioFolders(roots, extensions), /有效/);
  }
  await assert.rejects(scanAudioFolders([missing], extensions), /无法读取/);
  const result = await scanAudioFolders([missing, root], extensions);
  assert.equal(result.filePaths.length, 1);
  assert.equal(result.skippedDirectories, 1);
  assert.deepEqual(await scanAudioFolders([], extensions), { filePaths: [], truncated: false, scannedEntries: 0, skippedDirectories: 0 });
  for (const limits of [{ maxFiles: Infinity }, { maxFiles: 1001 }, { maxEntries: -1 }, { maxDepth: 17 }]) {
    await assert.rejects(scanAudioFolders([root], extensions, limits), /限制无效/);
  }
});

test('folder scans do not follow junctions or symlinks outside a selected folder or into a loop', async t => {
  const { directory, root } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'private.mp3'), 'audio');
  const local = path.join(root, 'local.mp3');
  await fsp.writeFile(local, 'audio');
  const link = path.join(root, 'linked');
  try {
    await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await fsp.symlink(root, path.join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Directory links are unavailable on this host');
    throw error;
  }
  const result = await scanAudioFolders([root], extensions);
  assert.deepEqual(result.filePaths, [local]);
  assert.equal(result.truncated, false);
  await assert.rejects(scanAudioFolders([link], extensions), /无法读取/);
});

test('same-stem cover names support JPG, JPEG, PNG and WebP suffixes and detect the actual image type', async t => {
  const { root } = await fixture(t);
  const audio = path.join(root, '歌手 - 歌曲.flac');
  const stem = path.join(root, '歌手 - 歌曲');
  for (const suffix of ['jpg', 'jpeg', 'png', 'webp', 'JPG', 'PNG', 'WEBP']) {
    const cover = `${stem}.${suffix}`;
    await fsp.writeFile(cover, png);
    assert.deepEqual(await readSidecarArtwork(audio), { data: png, mime: 'image/png' });
    await fsp.unlink(cover);
  }
  assert.equal(await readSidecarArtwork(audio), null);
  assert.equal(await readSidecarArtwork('relative.mp3'), null);
});

test('bad, empty and oversized sidecar covers are ignored while another supported sidecar can still load', async t => {
  const { root } = await fixture(t);
  const audio = path.join(root, 'song.mp3');
  await fsp.writeFile(path.join(root, 'song.jpg'), '<html>not an image</html>');
  await fsp.writeFile(path.join(root, 'song.jpeg'), '');
  const oversized = path.join(root, 'song.png');
  const handle = await fsp.open(oversized, 'w');
  await handle.truncate(MAX_COVER_BYTES + 1);
  await handle.close();
  assert.equal(await readSidecarArtwork(audio), null);
  await fsp.writeFile(path.join(root, 'song.webp'), png);
  assert.deepEqual(await readSidecarArtwork(audio), { data: png, mime: 'image/png' });
  await fsp.writeFile(path.join(root, 'unrelated.png'), png);
  assert.equal(await readSidecarArtwork(path.join(root, 'other.mp3')), null);
});

test('cover reads reject symlinks and noncanonical parent paths', async t => {
  const { directory, root } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'song.png'), png);
  const linkedDirectory = path.join(root, 'linked');
  try {
    await fsp.symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Directory links are unavailable on this host');
    throw error;
  }
  assert.equal(await readSidecarArtwork(path.join(linkedDirectory, 'song.mp3')), null);
  if (process.platform !== 'win32') {
    await fsp.symlink(path.join(outside, 'song.png'), path.join(root, 'song.png'));
    assert.equal(await readSidecarArtwork(path.join(root, 'song.mp3')), null);
  }
});
