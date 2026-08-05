import {NativeModules, Platform} from 'react-native';
import RNFS from 'react-native-fs';
import {getDefaultDownloadDir, getDownloadDir, getScanFolders} from './settings';
import {enrichLocalSong, QUALITY_TAG_RE, isTreeUri} from './download';
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

/**
 * 弹出系统目录选择器（SAF）并持久化授权所选目录（Android）。
 * 返回 {uri, name}；用户取消或平台不支持时返回 null。
 */
export async function pickDownloadDir(): Promise<{
  uri: string;
  name: string;
} | null> {
  if (Platform.OS !== 'android' || !LocalMusic?.pickDir) {
    return null;
  }
  try {
    const res = await LocalMusic.pickDir();
    return res
      ? {uri: String(res.uri), name: String(res.name ?? res.uri)}
      : null;
  } catch (e) {
    return null;
  }
}

/**
 * 弹出系统图片选择器（SAF，Android，无需存储权限）：返回 {uri, name, size}；
 * 用户取消或平台不支持时返回 null。
 */
export async function pickImage(): Promise<{
  uri: string;
  name: string;
  size: number;
} | null> {
  if (Platform.OS !== 'android' || !LocalMusic?.pickImage) {
    return null;
  }
  try {
    const res = await LocalMusic.pickImage();
    return res
      ? {
          uri: String(res.uri),
          name: String(res.name ?? res.uri),
          size: Number(res.size ?? -1),
        }
      : null;
  } catch (e) {
    return null;
  }
}

const AUDIO_EXT = ['.mp3', '.flac', '.m4a', '.wav', '.aac', '.ogg', '.wma'];

function isAudioFile(name: string) {
  const lower = name.toLowerCase();
  return AUDIO_EXT.some(ext => lower.endsWith(ext));
}

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

/**
 * 扫描 SAF 授权目录（content:// tree URI）下的音频：原生 DocumentFile 递归列出，
 * 返回带 content:// URI 的歌曲（RNFS 无法读取该目录，MediaStore 可能未收录）
 */
async function scanTreeDir(treeUri: string, depth = 2): Promise<Song[]> {
  if (Platform.OS !== 'android' || !LocalMusic?.listDirAudio) {
    return [];
  }
  try {
    const list = await LocalMusic.listDirAudio(treeUri, depth);
    return (list as any[]).map(item => {
      // 用文件名解析「歌手 - 歌名」（songFromPath 只需最后一段，传文件名即可）
      const parsed = songFromPath(item.name ?? '');
      return {
        ...parsed,
        localPath: item.uri,
        uri: item.uri,
        // 附件定位路径：主存储可反解真实路径（未编码，同时与 MediaStore 结果关联去重）；
        // 其他存储（SD 卡等）反解失败时用文件名构造伪路径，仅用于提取文件名定位回退附件
        filePath: item.path || `/${item.name ?? ''}`,
      };
    });
  } catch (e) {
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
      // 分区存储下优先用 content:// URI 播放（Android 10+ 路径不可靠），path 仅作展示/兼容
      localPath: item.uri || item.path,
      uri: item.uri,
      filePath: item.path,
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
  const [customDirs, downloadDir] = await Promise.all([
    getScanFolders(),
    getDownloadDir(),
  ]);
  const [mediaSongs, ...dirResults] = await Promise.all([
    getMediaStoreSongs(),
    scanDir(RNFS.DownloadDirectoryPath ?? '/storage/emulated/0/Download'),
    scanDir('/storage/emulated/0/Music'),
    scanDir(RNFS.DocumentDirectoryPath, 1),
    // 自定义下载目录：SAF 授权目录走原生扫描，普通路径走 RNFS；
    // 未自定义时同样扫描默认 Download/Xmusic，避免漏掉本应用默认下载的歌曲
    ...(downloadDir
      ? isTreeUri(downloadDir)
        ? [scanTreeDir(downloadDir, 2)]
        : [scanDir(downloadDir, 2)]
      : [scanDir(getDefaultDownloadDir(), 2)]),
    // 自定义文件夹允许更深的递归
    ...customDirs.map(dir => scanDir(dir, 4)),
  ]);

  const byPath = new Map<string, Song>();
  // MediaStore 条目以 content:// URI 为 key；目录扫描以文件路径为 key，
  // 两者对同一物理文件不重合，需用 filePath 关联去重，否则列表重复
  const mediaFilePaths = new Set<string>();
  for (const s of mediaSongs) {
    if (s.localPath) {
      byPath.set(s.localPath, s);
    }
    if (s.filePath) {
      mediaFilePaths.add(s.filePath);
    }
  }
  for (const result of dirResults) {
    if (!result.length) {
      continue;
    }
    if (typeof result[0] === 'string') {
      // 路径列表：转歌曲并去重（与 MediaStore 以真实路径关联）
      for (const p of result as string[]) {
        if (!byPath.has(p) && !mediaFilePaths.has(p)) {
          byPath.set(p, songFromPath(p));
        }
      }
    } else {
      // SAF 授权目录扫描结果：已是完整 Song（localPath 为 content:// URI）。
      // 主存储上的文件 MediaStore 也可能收录（uri 不同但物理路径相同），
      // 以 filePath 关联去重避免同一首歌重复显示
      for (const s of result as Song[]) {
        if (
          s.localPath &&
          !byPath.has(s.localPath) &&
          !(s.filePath && mediaFilePaths.has(s.filePath))
        ) {
          byPath.set(s.localPath, s);
        }
      }
    }
  }
  // 本应用下载的歌曲：读同名 .json/.jpg 补全歌手/专辑/封面
  //（MediaStore 对无标签文件返回未知歌手，列表靠元数据纠正）
  const merged = await Promise.all(
    Array.from(byPath.values()).map(s =>
      enrichLocalSong(s).catch(() => s),
    ),
  );
  // MediaStore 标签与元数据都缺歌手时，退回文件名「歌手 - 歌名」解析
  for (const s of merged) {
    // SAF 歌曲的 localPath 是 content:// URI，无法从路径解析歌手，跳过
    if (!s.singer?.length && s.localPath && !s.localPath.startsWith('content://')) {
      const parsed = songFromPath(s.localPath);
      if (parsed.singer?.length) {
        s.singer = parsed.singer;
      }
    }
  }
  return merged.sort((a, b) =>
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
