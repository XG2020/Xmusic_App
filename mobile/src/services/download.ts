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

/**
 * 附带下载封面（同名 .jpg）、歌词（同名 .lrc）与元数据（同名 .json），
 * 任一失败不影响主文件。返回实际成功的附件类型列表。
 */
export async function downloadCompanions(
  audioPath: string,
  opts: {coverUrl?: string; lyric?: string; song?: Song},
): Promise<string[]> {
  const base = audioPath.replace(/\.[^.]+$/, '');
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
  const base = s.localPath.replace(/\.[^.]+$/, '');
  const out: Song = {...s};
  try {
    const raw = await RNFS.readFile(`${base}.json`, 'utf8');
    const meta = JSON.parse(raw);
    out.mid = out.mid ?? meta.mid;
    out.title = meta.title || out.title;
    out.singer = out.singer?.length ? out.singer : meta.singer;
    out.album = out.album ?? meta.album;
    out.interval = out.interval ?? meta.interval;
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
  return out;
}

/** 读取本地歌曲同名 .lrc 歌词（下载时保存），不存在时返回空串 */
export async function readLocalLyric(audioPath: string): Promise<string> {
  const base = audioPath.replace(/\.[^.]+$/, '');
  try {
    return await RNFS.readFile(`${base}.lrc`, 'utf8');
  } catch (e) {
    return '';
  }
}
