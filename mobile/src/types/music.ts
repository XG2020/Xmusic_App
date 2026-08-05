export type Singer = {
  mid?: string;
  name: string;
};

export type Album = {
  mid?: string;
  pmid?: string;
  name?: string;
};

export type Song = {
  mid?: string;
  id?: number;
  title: string;
  singer?: Singer[];
  album?: Album;
  interval?: number;
  url?: string;
  coverUrl?: string;
  localPath?: string;
  /** MediaStore content:// URI（Android 10+ 分区存储，优先用于播放） */
  uri?: string;
  /** MediaStore 原始文件路径（仅展示/兼容用） */
  filePath?: string;
  /** 无播放地址（需要VIP或已下架），列表灰显禁止点播 */
  unplayable?: boolean;
};

export type Playlist = {
  id: number | string;
  name: string;
  creator?: { name?: string; id?: number };
  coverUrl?: string;
  songs: Song[];
};
