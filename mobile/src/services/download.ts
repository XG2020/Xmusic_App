import RNFS from 'react-native-fs';
import {NativeModules} from 'react-native';
import {getDefaultDownloadDir, getDownloadDir} from './settings';
import type {Song} from '../types/music';
/** 校验本地音频是否仍存在；SAF content:// URI 通过原生 ContentResolver 校验。 */
export async function localSongFileExists(path: string): Promise<boolean> {
  if (!path) {
    return false;
  }
  if (!path.startsWith('content://')) {
    return RNFS.exists(path.replace(/^file:\/\//i, '')).catch(() => false);
  }
  if (NativeModules.LocalMusic?.fileExists) {
    try {
      return !!(await NativeModules.LocalMusic.fileExists(path));
    } catch (e) {
      return false;
    }
  }
  return true;
}

/** 图片下载请求头：腾讯 CDN 部分节点会拒绝无 UA 的请求（403） */
export const IMAGE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  Referer: 'https://y.qq.com/',
};

/**
 * 探测目录是否可写：分区存储下公共目录（/storage/emulated/0/...）存在且可读，
 * 但 File API 直接写入会被系统拒绝（无 SAF/存储管理权限），用临时文件实测验证。
 * 用于设置下载路径时预检与下载前兜底。
 */
export async function canWriteDir(dir: string): Promise<boolean> {
  try {
    const probe = `${dir}/.wtest_${Date.now()}`;
    await RNFS.writeFile(probe, '');
    await RNFS.unlink(probe);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * SAF 授权目录（content:// tree URI）：RNFS 无法读写，需走原生接口（LocalMusic）
 */
export function isTreeUri(dir: string): boolean {
  return dir.startsWith('content://');
}

/** 解析实际下载目录（用户自定义优先，默认 Download/Xmusic），并确保存在 */
export async function resolveDownloadDir(): Promise<string> {
  const custom = await getDownloadDir();
  const defaultDir = getDefaultDownloadDir();
  // SAF 授权目录：由原生 ContentResolver 负责写入（无需/无法用 RNFS 探测）
  if (isTreeUri(custom)) {
    return custom;
  }
  const dir = custom || defaultDir;
  try {
    const exists = await RNFS.exists(dir);
    if (!exists) {
      await RNFS.mkdir(dir);
    }
  } catch (e) {
    // 目录创建失败（分区存储限制/目录已失效）：
    // 自定义目录回退默认 Download/Xmusic，默认目录再失败则回退应用私有目录
    if (custom) {
      return defaultDir;
    }
    return RNFS.DocumentDirectoryPath;
  }
  // 可写性探测：目录存在但分区存储拒绝写入时，自定义目录先回退默认目录，
  // 默认目录再回退私有目录，避免任务直接失败
  if (!(await canWriteDir(dir))) {
    if (custom) {
      return defaultDir;
    }
    return RNFS.DocumentDirectoryPath;
  }
  return dir;
}

export async function downloadToAppDir(url: string, filename: string) {
  // 固定下载到应用私有目录：不跟随自定义目录（SAF 授权目录为 content:// URI，
  // RNFS 无法写入，且该函数语义即“应用内文件”，如更新包暂存）
  const dir = RNFS.DocumentDirectoryPath;
  const dest = `${dir}/${filename}`;
  const ret = await RNFS.downloadFile({fromUrl: url, toFile: dest}).promise;
  if (ret.statusCode >= 200 && ret.statusCode < 300) {
    return dest;
  }
  throw new Error(`下载失败: ${ret.statusCode}`);
}

/** 本应用下载文件名中的音质后缀，如 "歌名 [SQ 无损].flac" */
export const QUALITY_TAG_RE =
  /\s*\[(标准|HQ 高品质|SQ 无损|臻品音质|臻品全景声|臻品母带)\]$/;

function isDocumentUri(path: string): boolean {
  return path.startsWith('content://') && path.includes('/document/');
}

function decodeLeafName(path: string): string {
  let name = path.slice(path.lastIndexOf('/') + 1);
  try {
    name = decodeURIComponent(name);
  } catch (e) {
    // 普通路径/未编码文本保持原样
  }
  return name.slice(name.lastIndexOf('/') + 1);
}

function companionStemFromPath(audioPath: string): string {
  return decodeLeafName(audioPath)
    .replace(/\.[^.]+$/, '')
    .replace(QUALITY_TAG_RE, '');
}

/** 附件基础名：去扩展名与音质后缀，同一首歌不同音质共用歌词/封面/元数据 */
function companionBase(audioPath: string): string {
  return audioPath.replace(/\.[^.]+$/, '').replace(QUALITY_TAG_RE, '');
}

/**
 * 私有附件目录：自定义下载目录在公共存储（如 Music）时，分区存储会拒绝
 * 写入 .jpg/.lrc/.json 等非音频文件，附件回退保存到这里，读取时二次查找
 */
const COMPANION_FALLBACK_DIR = `${RNFS.DocumentDirectoryPath}/companions`;

/** 回退附件基础名：按音频文件名（不含目录）映射到私有附件目录 */
function fallbackCompanionBase(audioPath: string): string {
  return `${COMPANION_FALLBACK_DIR}/${companionStemFromPath(audioPath)}`;
}

async function ensureFallbackDir() {
  try {
    if (!(await RNFS.exists(COMPANION_FALLBACK_DIR))) {
      await RNFS.mkdir(COMPANION_FALLBACK_DIR);
    }
  } catch (e) {
    // 创建失败由后续写入报错兜底
  }
}

/** 下载封面到指定路径，成功（2xx 且非空文件）返回 true，失败清理残留 */
async function downloadCoverTo(
  coverUrl: string,
  coverPath: string,
): Promise<boolean> {
  try {
    const ret = await RNFS.downloadFile({
      fromUrl: coverUrl,
      toFile: coverPath,
      headers: IMAGE_HEADERS,
    }).promise;
    // RNFS 在 4xx/5xx 时也会把错误响应体写入文件，必须校验状态码与文件大小，
    // 残留的坏 .jpg 会让本地播放显示不出封面（且挡住元数据线上封面兜底）
    const stat = await RNFS.stat(coverPath).catch(() => null);
    if (
      ret.statusCode >= 200 &&
      ret.statusCode < 300 &&
      stat &&
      Number(stat.size) > 0
    ) {
      return true;
    }
    await RNFS.unlink(coverPath).catch(() => {});
  } catch (e) {
    // 失败不留下半截文件
    await RNFS.unlink(coverPath).catch(() => {});
  }
  return false;
}

async function findSafSiblingFile(
  audioPath: string,
  fileName: string,
): Promise<string | null> {
  if (!isDocumentUri(audioPath) || !NativeModules.LocalMusic?.findSiblingFile) {
    return null;
  }
  try {
    const ret = await NativeModules.LocalMusic.findSiblingFile(audioPath, fileName);
    return typeof ret === 'string' && ret ? ret : null;
  } catch (e) {
    return null;
  }
}

async function readSafTextCompanion(
  audioPath: string,
  fileName: string,
): Promise<string | null> {
  if (!NativeModules.LocalMusic?.readTextFile) {
    return null;
  }
  const uri = await findSafSiblingFile(audioPath, fileName);
  if (!uri) {
    return null;
  }
  try {
    const text = await NativeModules.LocalMusic.readTextFile(uri);
    return typeof text === 'string' ? text : null;
  } catch (e) {
    return null;
  }
}

/**
 * 附带下载封面（同名 .jpg）、歌词（同名 .lrc）与元数据（同名 .json），
 * 任一失败不影响主文件。返回实际成功的附件类型列表。
 */
export async function downloadCompanions(
  audioPath: string,
  opts: {coverUrl?: string; lyric?: string; song?: Song; folderUri?: string},
): Promise<string[]> {
  const stem = companionStemFromPath(audioPath);
  const coverName = `${stem}.jpg`;
  const lyricName = `${stem}.lrc`;
  const metaName = `${stem}.json`;
  const base = companionBase(audioPath);
  const fbBase = fallbackCompanionBase(audioPath);
  const done: string[] = [];
  const useSafDir =
    !!opts.folderUri &&
    isTreeUri(opts.folderUri) &&
    !!NativeModules.LocalMusic?.writeTextFile;
  if (useSafDir) {
    if (
      opts.coverUrl &&
      /^https?:/i.test(opts.coverUrl) &&
      NativeModules.LocalMusic?.downloadFile
    ) {
      try {
        await NativeModules.LocalMusic.downloadFile(
          opts.folderUri,
          opts.coverUrl,
          coverName,
          'image/jpeg',
        );
        done.push('封面');
      } catch (e) {
        // 同目录写入失败时回退旧私有附件目录，兼容低版本原生实现
        let ok = false;
        await ensureFallbackDir();
        ok = await downloadCoverTo(opts.coverUrl, `${fbBase}.jpg`);
        if (ok) {
          done.push('封面');
        }
      }
    }
    if (opts.lyric) {
      try {
        // 用 application/octet-stream 而非 text/plain：部分 OEM 的 SAF Provider
        // 会对 text/plain 自动追加 .txt 扩展名，导致删除时按 DISPLAY_NAME 匹配失败
        await NativeModules.LocalMusic.writeTextFile(
          opts.folderUri,
          lyricName,
          'application/octet-stream',
          opts.lyric,
        );
        done.push('歌词');
      } catch (e) {
        try {
          await ensureFallbackDir();
          await RNFS.writeFile(`${fbBase}.lrc`, opts.lyric, 'utf8');
          done.push('歌词');
        } catch (e2) {
          // 歌词失败忽略
        }
      }
    }
    if (opts.song) {
      const s = opts.song;
      const meta = JSON.stringify({
        mid: s.mid,
        title: s.title,
        singer: s.singer,
        album: s.album,
        interval: s.interval,
        coverUrl:
          opts.coverUrl && /^https?:/i.test(opts.coverUrl)
            ? opts.coverUrl
            : undefined,
      });
      try {
        await NativeModules.LocalMusic.writeTextFile(
          opts.folderUri,
          metaName,
          'application/json',
          meta,
        );
        done.push('元数据');
      } catch (e) {
        try {
          await ensureFallbackDir();
          await RNFS.writeFile(`${fbBase}.json`, meta, 'utf8');
          done.push('元数据');
        } catch (e2) {
          // 元数据失败忽略
        }
      }
    }
    return done;
  }
  if (opts.coverUrl && /^https?:/i.test(opts.coverUrl)) {
    // 公共目录（如 Music）写图片会被分区存储拒绝，失败回退私有附件目录
    let ok = await downloadCoverTo(opts.coverUrl, `${base}.jpg`);
    if (!ok) {
      await ensureFallbackDir();
      ok = await downloadCoverTo(opts.coverUrl, `${fbBase}.jpg`);
    }
    if (ok) {
      done.push('封面');
    }
  }
  if (opts.lyric) {
    try {
      await RNFS.writeFile(`${base}.lrc`, opts.lyric, 'utf8');
      done.push('歌词');
    } catch (e) {
      // 写入被拒（公共目录限制）回退私有附件目录
      try {
        await ensureFallbackDir();
        await RNFS.writeFile(`${fbBase}.lrc`, opts.lyric, 'utf8');
        done.push('歌词');
      } catch (e2) {
        // 歌词失败忽略
      }
    }
  }
  if (opts.song) {
    // 元数据（mid/歌手/专辑等）：本地播放时恢复完整歌曲信息
    const s = opts.song;
    const meta = JSON.stringify({
      mid: s.mid,
      title: s.title,
      singer: s.singer,
      album: s.album,
      interval: s.interval,
      // 封面在线直链一并保存，.jpg 下载失败时播放页仍可在线显示
      coverUrl:
        opts.coverUrl && /^https?:/i.test(opts.coverUrl)
          ? opts.coverUrl
          : undefined,
    });
    try {
      await RNFS.writeFile(`${base}.json`, meta, 'utf8');
      done.push('元数据');
    } catch (e) {
      // 写入被拒（公共目录限制）回退私有附件目录
      try {
        await ensureFallbackDir();
        await RNFS.writeFile(`${fbBase}.json`, meta, 'utf8');
        done.push('元数据');
      } catch (e2) {
        // 元数据失败忽略
      }
    }
  }
  return done;
}

/**
 * 补全本地歌曲信息：读取下载时保存的同名 .json 元数据（mid/歌手/专辑）
 * 与同名 .jpg 封面，播放页即可显示封面、歌词与歌曲信息
 */
export async function enrichLocalSong(s: Song): Promise<Song> {
  const fsPath = s.filePath || s.localPath;
  // 无本地路径（在线歌曲）不处理；content:// URI（SAF 目录歌曲）RNFS 读不到原目录，
  // 但下载时附件已回退私有附件目录（按文件名映射），下方 base 失败自动走 fbBase 兜底
  if (!fsPath) {
    return s;
  }
  const base = companionBase(fsPath);
  const fbBase = fallbackCompanionBase(fsPath);
  const out: Song = {...s};
  let metaCover: string | undefined;
  // 附件可能因公共目录写入受限保存在私有附件目录，音频同目录找不到时二次查找
  let raw: string | null = null;
  if (isDocumentUri(fsPath)) {
    raw = await readSafTextCompanion(
      fsPath,
      `${companionStemFromPath(fsPath)}.json`,
    );
  }
  try {
    raw = raw ?? (await RNFS.readFile(`${base}.json`, 'utf8'));
  } catch (e) {
    raw =
      raw ?? (await RNFS.readFile(`${fbBase}.json`, 'utf8').catch(() => null));
  }
  if (raw) {
    try {
      const meta = JSON.parse(raw);
      out.mid = out.mid ?? meta.mid;
      out.title = meta.title || out.title;
      out.singer = out.singer?.length ? out.singer : meta.singer;
      out.album = out.album ?? meta.album;
      out.interval = out.interval ?? meta.interval;
      if (
        typeof meta.coverUrl === 'string' &&
        /^https?:/i.test(meta.coverUrl)
      ) {
        metaCover = meta.coverUrl;
      }
    } catch (e) {
      // 元数据损坏忽略
    }
  }
  if (!out.coverUrl) {
    if (isDocumentUri(fsPath)) {
      out.coverUrl =
        (await findSafSiblingFile(
          fsPath,
          `${companionStemFromPath(fsPath)}.jpg`,
        )) ?? undefined;
    }
  }
  if (!out.coverUrl) {
    for (const jpg of [`${base}.jpg`, `${fbBase}.jpg`]) {
      try {
        // stat 兼探测与校验：0 字节的坏封面文件视为不存在，退回线上直链
        const stat = await RNFS.stat(jpg);
        if (Number(stat.size) > 0) {
          // 路径含空格/中文/方括号，必须百分号编码，否则 RN Image 解析 file:// URI 失败
          out.coverUrl = `file://${encodeURI(jpg).replace(/#/g, '%23')}`;
          break;
        }
      } catch (e) {
        // 封面文件不存在，尝试下一个位置
      }
    }
  }
  if (!out.coverUrl && metaCover) {
    // 本地 .jpg 不存在时退回元数据里的在线封面直链
    out.coverUrl = metaCover;
  }
  return out;
}

/** 读取本地歌曲同名 .lrc 歌词（下载时保存），不存在时返回空串 */
export async function readLocalLyric(audioPath: string): Promise<string> {
  if (!audioPath) {
    return '';
  }
  if (isDocumentUri(audioPath)) {
    const text = await readSafTextCompanion(
      audioPath,
      `${companionStemFromPath(audioPath)}.lrc`,
    );
    if (text) {
      return text;
    }
  }
  const base = companionBase(audioPath);
  try {
    return await RNFS.readFile(`${base}.lrc`, 'utf8');
  } catch (e) {
    // 歌词可能保存在私有附件目录（公共目录写入受限时的回退位置）
    return RNFS.readFile(
      `${fallbackCompanionBase(audioPath)}.lrc`,
      'utf8',
    ).catch(() => '');
  }
}

/**
 * 删除本地歌曲及其附件（歌词/封面/元数据）；
 * 同基础名还有其他音质的音频文件时保留共用附件。
 * 主文件删除失败直接抛出，由调用方提示。
 */
export async function deleteLocalSongWithCompanions(audioPath: string) {
  if (!audioPath) {
    return;
  }
  // content:// URI（SAF 授权目录歌曲）：RNFS 无法删除，由原生 ContentResolver 删除；
  // 附件下载时已回退私有附件目录（按文件名映射），删除主文件后一并清理。
  // 注意：仅接受 document uri（单个文件），tree uri 是整个目录授权，无法定位文件，跳过
  if (!audioPath.startsWith('/')) {
    if (!audioPath.includes('/document/')) {
      return;
    }
    const stem = companionStemFromPath(audioPath);
    if (NativeModules.LocalMusic?.deleteFile) {
      try {
        await NativeModules.LocalMusic.deleteFile(audioPath);
      } catch (e) {
        throw new Error('文件可能已被移除或没有删除权限');
      }
    } else {
      throw new Error('当前系统不支持删除授权目录文件');
    }
    let stillUsed = false;
    if (NativeModules.LocalMusic?.hasSiblingAudioWithBase) {
      try {
        stillUsed = !!(await NativeModules.LocalMusic.hasSiblingAudioWithBase(
          audioPath,
          stem,
        ));
      } catch (e) {
        stillUsed = false;
      }
    }
    if (!stillUsed && NativeModules.LocalMusic?.deleteSiblingFile) {
      for (const fileName of [`${stem}.lrc`, `${stem}.jpg`, `${stem}.json`]) {
        await NativeModules.LocalMusic.deleteSiblingFile(
          audioPath,
          fileName,
        ).catch(() => {});
      }
    }
    const fbBase = fallbackCompanionBase(audioPath);
    for (const ext of ['.lrc', '.jpg', '.json']) {
      await RNFS.unlink(`${fbBase}${ext}`).catch(() => {});
    }
    return;
  }
  await RNFS.unlink(audioPath);
  const base = companionBase(audioPath);
  try {
    const dir = audioPath.slice(0, audioPath.lastIndexOf('/'));
    const items = await RNFS.readDir(dir);
    const stillUsed = items.some(
      i =>
        i.isFile() &&
        /\.(mp3|flac|m4a|wav|aac|ogg|wma)$/i.test(i.name) &&
        companionBase(i.path) === base,
    );
    if (stillUsed) {
      return;
    }
  } catch (e) {
    // 目录扫描失败时仍继续清理附件
  }
  // 附件同时清理音频同目录与私有附件目录（回退位置）
  const fbBase = fallbackCompanionBase(audioPath);
  for (const ext of ['.lrc', '.jpg', '.json']) {
    await RNFS.unlink(`${base}${ext}`).catch(() => {});
    await RNFS.unlink(`${fbBase}${ext}`).catch(() => {});
  }
}
