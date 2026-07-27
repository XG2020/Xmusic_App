import {NativeModules, Platform} from 'react-native';
import RNFS from 'react-native-fs';
import {getScanFolders} from './settings';
import type {Song} from '../types/music';

const {LocalMusic} = NativeModules;

/** 调用系统文件管理器打开文件所在目录（原生多级兜底），返回是否成功唤起 */
export async function openLocalFolder(path: string): Promise<boolean> {
  if (Platform.OS !== 'android' || !LocalMusic?.openFolder) {
    return false;
  }
  try {
    return await LocalMusic.openFolder(path);
  } catch (e) {
    return false;
  }
}

const AUDIO_EXT = ['.mp3', '.flac', '.m4a', '.wav', '.aac', '.ogg', '.wma'];

function isAudioFile(name: string) {
  const lower = name.toLowerCase();
  return AUDIO_EXT.some(ext => lower.endsWith(ext));
}

/** 本应用下载文件名中的音质后缀，如 "歌名 [SQ 无损].flac" */
const QUALITY_TAG_RE =
  /\s*\[(标准|HQ 高品质|SQ 无损|臻品音质|臻品全景声|臻品母带)\]$/;

/** 从文件名解析 "歌手 - 歌名"（去掉本应用下载时附加的音质后缀） */
function songFromPath(path: string): Song {
  const fileName = path.split('/').pop() ?? path;
  const base = fileName.replace(/\.[^.]+$/, '').replace(QUALITY_TAG_RE, '');
  const parts = base.split(' - ');
  const artist = parts.length > 1 ? parts[0].trim() : '';
  const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : base;
  return {
    title: title || fileName,
    singer: artist ? [{name: artist}] : undefined,
    localPath: path,
  };
}

/** 递归扫描目录下的音频文件（限制深度，避免全盘遍历卡顿） */
async function scanDir(dir: string, depth = 2): Promise<string[]> {
  try {
    const items = await RNFS.readDir(dir);
    const files: string[] = [];
    for (const item of items) {
      if (item.isFile() && isAudioFile(item.name)) {
        files.push(item.path);
      } else if (item.isDirectory() && depth > 0 && !item.name.startsWith('.')) {
        files.push(...(await scanDir(item.path, depth - 1)));
      }
    }
    return files;
  } catch (e) {
    // 目录不存在或无权限，跳过
    return [];
  }
}

/** 系统媒体库（MediaStore）中的歌曲 */
async function getMediaStoreSongs(): Promise<Song[]> {
  if (Platform.OS !== 'android' || !LocalMusic?.getAudioFiles) {
    return [];
  }
  try {
    const list = await LocalMusic.getAudioFiles();
    return list.map((item: any) => ({
      id: Number(item.id),
      title: item.title,
      singer: item.artist && item.artist !== '<unknown>' ? [{name: item.artist}] : undefined,
      album: item.album ? {name: item.album} : undefined,
      interval: Number(item.duration ?? 0) / 1000,
      localPath: item.path,
    })) as Song[];
  } catch (e) {
    return [];
  }
}

/**
 * 全量扫描本地歌曲：
 * MediaStore + 常用目录（Music/Download/应用下载目录）+ 用户自定义文件夹，按路径去重
 */
export async function scanLocalSongs(): Promise<Song[]> {
  const customDirs = await getScanFolders();
  const [mediaSongs, ...dirResults] = await Promise.all([
    getMediaStoreSongs(),
    scanDir(RNFS.DownloadDirectoryPath ?? '/storage/emulated/0/Download'),
    scanDir('/storage/emulated/0/Music'),
    scanDir(RNFS.DocumentDirectoryPath, 1),
    // 自定义文件夹允许更深的递归
    ...customDirs.map(dir => scanDir(dir, 4)),
  ]);

  const byPath = new Map<string, Song>();
  for (const s of mediaSongs) {
    if (s.localPath) {
      byPath.set(s.localPath, s);
    }
  }
  for (const paths of dirResults) {
    for (const p of paths) {
      if (!byPath.has(p)) {
        byPath.set(p, songFromPath(p));
      }
    }
  }
  return Array.from(byPath.values()).sort((a, b) =>
    a.title.localeCompare(b.title, 'zh-Hans-CN'),
  );
}

/** 兼容旧调用 */
export async function getLocalSongs(): Promise<Song[]> {
  return scanLocalSongs();
}

export type DirEntry = {
  name: string;
  path: string;
  /** 目录内音频文件数（仅当前层，用于列表展示提示） */
  audioCount: number;
};

/** 目录浏览器的默认根目录（外部存储） */
export const STORAGE_ROOT = '/storage/emulated/0';

/** 列出目录下的子文件夹（供自定义扫描文件夹选择器使用） */
export async function listSubDirs(dir: string): Promise<DirEntry[]> {
  try {
    const items = await RNFS.readDir(dir);
    const dirs = items.filter(i => i.isDirectory() && !i.name.startsWith('.'));
    const entries = await Promise.all(
      dirs.map(async d => {
        let audioCount = 0;
        try {
          const children = await RNFS.readDir(d.path);
          audioCount = children.filter(c => c.isFile() && isAudioFile(c.name)).length;
        } catch (e) {
          // 无权限的目录忽略计数
        }
        return {name: d.name, path: d.path, audioCount};
      }),
    );
    return entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  } catch (e) {
    return [];
  }
}
