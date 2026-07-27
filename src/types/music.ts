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
