import RNFS from 'react-native-fs';
import {getDownloadDir} from './settings';
import type {Song} from '../types/music';

/** 解析实际下载目录（用户自定义优先，默认应用私有目录），并确保存在 */
export async function resolveDownloadDir(): Promise<string> {
  const custom = await getDownloadDir();
  const dir = custom || RNFS.DocumentDirectoryPath;
  try {
    const exists = await RNFS.exists(dir);
    if (!exists) {
      await RNFS.mkdir(dir);
    }
  } catch (e) {
    // 创建失败时仍尝试写入，由下载报错兜底
  }
  return dir;
}

export async function downloadToAppDir(url: string, filename: string) {
  const dir = await resolveDownloadDir();
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

/** 附件基础名：去扩展名与音质后缀，同一首歌不同音质共用歌词/封面/元数据 */
function companionBase(audioPath: string): string {
  return audioPath.replace(/\.[^.]+$/, '').replace(QUALITY_TAG_RE, '');
}

/**
 * 附带下载封面（同名 .jpg）、歌词（同名 .lrc）与元数据（同名 .json），
 * 任一失败不影响主文件。返回实际成功的附件类型列表。
 */
export async function downloadCompanions(
  audioPath: string,
  opts: {coverUrl?: string; lyric?: string; song?: Song},
): Promise<string[]> {
  const base = companionBase(audioPath);
  const done: string[] = [];
  if (opts.coverUrl && /^https?:/i.test(opts.coverUrl)) {
    try {
      const ret = await RNFS.downloadFile({
        fromUrl: opts.coverUrl,
        toFile: `${base}.jpg`,
      }).promise;
      if (ret.statusCode >= 200 && ret.statusCode < 300) {
        done.push('封面');
      }
    } catch (e) {
      // 封面失败忽略
    }
  }
  if (opts.lyric) {
    try {
      await RNFS.writeFile(`${base}.lrc`, opts.lyric, 'utf8');
      done.push('歌词');
    } catch (e) {
      // 歌词失败忽略
    }
  }
  if (opts.song) {
    // 元数据（mid/歌手/专辑等）：本地播放时恢复完整歌曲信息
    try {
      const s = opts.song;
      const meta = {
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
      };
      await RNFS.writeFile(`${base}.json`, JSON.stringify(meta), 'utf8');
      done.push('元数据');
    } catch (e) {
      // 元数据失败忽略
    }
  }
  return done;
}

/**
 * 补全本地歌曲信息：读取下载时保存的同名 .json 元数据（mid/歌手/专辑）
 * 与同名 .jpg 封面，播放页即可显示封面、歌词与歌曲信息
 */
export async function enrichLocalSong(s: Song): Promise<Song> {
  if (!s.localPath) {
    return s;
  }
  const base = companionBase(s.localPath);
  const out: Song = {...s};
  let metaCover: string | undefined;
  try {
    const raw = await RNFS.readFile(`${base}.json`, 'utf8');
    const meta = JSON.parse(raw);
    out.mid = out.mid ?? meta.mid;
    out.title = meta.title || out.title;
    out.singer = out.singer?.length ? out.singer : meta.singer;
    out.album = out.album ?? meta.album;
    out.interval = out.interval ?? meta.interval;
    if (typeof meta.coverUrl === 'string' && /^https?:/i.test(meta.coverUrl)) {
      metaCover = meta.coverUrl;
    }
  } catch (e) {
    // 无元数据文件（非本应用下载的歌曲）
  }
  if (!out.coverUrl) {
    try {
      if (await RNFS.exists(`${base}.jpg`)) {
        // 路径含空格/中文/方括号，必须百分号编码，否则 RN Image 解析 file:// URI 失败
        out.coverUrl = `file://${encodeURI(`${base}.jpg`).replace(/#/g, '%23')}`;
      }
    } catch (e) {
      // 封面探测失败忽略
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
  const base = companionBase(audioPath);
  try {
    return await RNFS.readFile(`${base}.lrc`, 'utf8');
  } catch (e) {
    return '';
  }
}

/**
 * 删除本地歌曲及其附件（歌词/封面/元数据）；
 * 同基础名还有其他音质的音频文件时保留共用附件。
 * 主文件删除失败直接抛出，由调用方提示。
 */
export async function deleteLocalSongWithCompanions(audioPath: string) {
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
  for (const ext of ['.lrc', '.jpg', '.json']) {
    await RNFS.unlink(`${base}${ext}`).catch(() => {});
  }
}
