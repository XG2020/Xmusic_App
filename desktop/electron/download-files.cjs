'use strict';

const fsp = require('node:fs/promises');
const {createReadStream} = require('node:fs');
const {createHash} = require('node:crypto');
const path = require('node:path');

const MAX_COVER_BYTES = 8 * 1024 * 1024;
const MAX_LYRIC_BYTES = 2 * 1024 * 1024;
const extensions = {audio: ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus', 'aac', 'webm'], cover: ['jpg', 'png', 'webp'], lyrics: ['lrc']};
const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;

function validOwnedFile(value) {
  return value && typeof value === 'object' && typeof value.name === 'string' && value.name.length <= 240 &&
    path.basename(value.name) === value.name && !/[<>:"/\\|?*\u0000-\u001f]/.test(value.name) &&
    Object.hasOwn(extensions, value.kind) && extensions[value.kind].includes(path.extname(value.name).slice(1)) &&
    Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 512 * 1024 * 1024 &&
    typeof value.dev === 'string' && /^\d+$/.test(value.dev) && typeof value.ino === 'string' && /^\d+$/.test(value.ino) &&
    typeof value.mtimeMs === 'number' && Number.isFinite(value.mtimeMs) && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);
}

async function fileHash(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function ownFile(filePath, kind, sha256) {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('下载文件已改变，无法记录文件身份');
  return {name: path.basename(filePath), kind, size: stat.size, dev: String(stat.dev), ino: String(stat.ino), mtimeMs: stat.mtimeMs,
    sha256: sha256 ?? await fileHash(filePath)};
}

async function verifyOwnedFile(directory, file) {
  if (!validOwnedFile(file)) throw new Error('下载文件缺少安全删除记录，请仅删除记录或在文件夹中手动处理');
  const target = path.join(directory, file.name);
  let stat;
  try {stat = await fsp.lstat(target);} catch (error) {if (error.code === 'ENOENT') return null; throw error;}
  if (!stat.isFile() || stat.isSymbolicLink() || identity(await fsp.realpath(target)) !== identity(target) ||
      stat.size !== file.size || String(stat.dev) !== file.dev || String(stat.ino) !== file.ino ||
      stat.mtimeMs !== file.mtimeMs || await fileHash(target) !== file.sha256) {
    throw new Error('下载文件已被替换或修改，未删除任何文件；请仅删除记录或在文件夹中手动处理');
  }
  return target;
}

function coverExtension(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString() === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width && height && width * height <= 40000000) return 'png';
  }
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'jpg';
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' &&
      bytes.readUInt32LE(4) + 8 === bytes.length && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString())) return 'webp';
  throw new Error('封面响应不是支持的 JPG、PNG 或 WebP 图片');
}

function lyricBuffer(data) {
  const value = typeof data === 'string' ? data : data?.lyric;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.includes('\0') || /<!doctype\b|<html\b|<script\b/i.test(value)) throw new Error('歌词格式无效');
  const text = value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"})[entity]);
  if (/<!doctype\b|<html\b|<script\b/i.test(text)) throw new Error('歌词格式无效');
  const bytes = Buffer.from(text.trim(), 'utf8');
  if (bytes.length > MAX_LYRIC_BYTES) throw new Error('歌词超过大小限制');
  return bytes.length ? bytes : null;
}

module.exports = {MAX_COVER_BYTES, MAX_LYRIC_BYTES, validOwnedFile, ownFile, verifyOwnedFile, coverExtension, lyricBuffer};
