'use strict';

const fsp = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { MAX_COVER_BYTES, coverExtension } = require('./download-files.cjs');

const MAX_IMPORT_FILES = 1000;
const MAX_SCAN_ENTRIES = 20000;
const MAX_SCAN_DEPTH = 16;
const COVER_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;

// Stream entries instead of reading an unbounded directory into memory. Canonical
// paths and lstat checks also prevent junctions/symlinks from extending a scan.
async function scanAudioFolders(directoryPaths, audioExtensions, {
  maxFiles = MAX_IMPORT_FILES, maxEntries = MAX_SCAN_ENTRIES, maxDepth = MAX_SCAN_DEPTH,
} = {}) {
  if (!Array.isArray(directoryPaths) || directoryPaths.length > MAX_IMPORT_FILES ||
      directoryPaths.some(value => typeof value !== 'string' || !path.isAbsolute(value))) {
    throw new Error('请选择有效的本地音乐文件夹');
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0 || maxFiles > MAX_IMPORT_FILES ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > MAX_SCAN_ENTRIES ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_SCAN_DEPTH) {
    throw new Error('本地音乐扫描限制无效');
  }
  const result = { filePaths: [], truncated: false, scannedEntries: 0, skippedDirectories: 0 };
  const visitedDirectories = new Set();
  const visitedFiles = new Set();
  let readableRoots = 0;
  let stopped = false;
  for (const selectedPath of directoryPaths) {
    if (stopped) break;
    let root;
    try {
      const stat = await fsp.lstat(selectedPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Not a directory');
      root = await fsp.realpath(selectedPath);
      readableRoots += 1;
    } catch {
      result.skippedDirectories += 1;
      continue;
    }
    const pending = [{ directory: root, depth: 0 }];
    while (pending.length && !stopped) {
      const { directory, depth } = pending.pop();
      if (visitedDirectories.has(identity(directory))) continue;
      let handle;
      try {
        const stat = await fsp.lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory() || identity(await fsp.realpath(directory)) !== identity(directory)) {
          throw new Error('Directory path changed');
        }
        handle = await fsp.opendir(directory, { bufferSize: 32 });
        visitedDirectories.add(identity(directory));
        while (true) {
          // One bounded lookahead distinguishes an exactly full directory from
          // a scan that omitted entries because it reached the global limit.
          const entry = await handle.read();
          if (!entry) break;
          if (result.scannedEntries >= maxEntries) {
            result.truncated = stopped = true;
            break;
          }
          result.scannedEntries += 1;
          if (entry.isSymbolicLink()) continue;
          const child = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (depth < maxDepth) pending.push({ directory: child, depth: depth + 1 });
            else { result.truncated = true; result.skippedDirectories += 1; }
          } else if (entry.isFile() && audioExtensions.includes(path.extname(entry.name).slice(1).toLowerCase())) {
            const childStat = await fsp.lstat(child).catch(() => null);
            if (!childStat?.isFile() || childStat.isSymbolicLink() || childStat.size === 0 || visitedFiles.has(identity(child))) continue;
            if (identity(await fsp.realpath(child).catch(() => '')) !== identity(child)) continue;
            if (result.filePaths.length >= maxFiles) {
              result.truncated = stopped = true;
              break;
            }
            visitedFiles.add(identity(child));
            result.filePaths.push(child);
          }
        }
      } catch {
        result.skippedDirectories += 1;
      } finally {
        await handle?.close().catch(() => {});
      }
    }
  }
  if (directoryPaths.length && !readableRoots) throw new Error('所选文件夹无法读取，请检查文件夹和访问权限');
  return result;
}

// Only inspect fixed same-stem names, never enumerate an unrelated cover folder.
// Downloads already validate these formats and use this same byte limit.
async function readSidecarArtwork(audioPath) {
  if (typeof audioPath !== 'string' || !path.isAbsolute(audioPath)) return null;
  const stem = path.join(path.dirname(audioPath), path.basename(audioPath, path.extname(audioPath)));
  const extensions = process.platform === 'win32' ? ['jpg', 'jpeg', 'png', 'webp']
    : ['jpg', 'jpeg', 'png', 'webp', 'JPG', 'JPEG', 'PNG', 'WEBP'];
  for (const suffix of extensions) {
    const coverPath = `${stem}.${suffix}`;
    let handle;
    try {
      const initial = await fsp.lstat(coverPath);
      if (!initial.isFile() || initial.isSymbolicLink() || initial.size <= 0 || initial.size > MAX_COVER_BYTES ||
          identity(await fsp.realpath(coverPath)) !== identity(coverPath)) continue;
      handle = await fsp.open(coverPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_COVER_BYTES || stat.dev !== initial.dev || stat.ino !== initial.ino ||
          identity(await fsp.realpath(coverPath)) !== identity(coverPath)) continue;
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size) continue;
      const data = bytes.subarray(0, offset);
      const mime = COVER_MIME[coverExtension(data)];
      return { data, mime };
    } catch {
      // Bad/missing artwork must never prevent the audio itself from importing.
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return null;
}

module.exports = { MAX_IMPORT_FILES, MAX_SCAN_ENTRIES, MAX_SCAN_DEPTH, scanAudioFolders, readSidecarArtwork };
