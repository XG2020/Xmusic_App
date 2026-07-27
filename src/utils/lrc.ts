export type LrcLine = {
  time: number; // 秒
  text: string;
};

const TIME_TAG = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * 解析 LRC 歌词为按时间排序的行数组
 */
export function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  if (!lrc) {
    return lines;
  }
  for (const raw of lrc.split(/\r?\n/)) {
    TIME_TAG.lastIndex = 0;
    const text = raw.replace(TIME_TAG, '').trim();
    let match: RegExpExecArray | null;
    TIME_TAG.lastIndex = 0;
    while ((match = TIME_TAG.exec(raw)) !== null) {
      const min = Number(match[1]);
      const sec = Number(match[2]);
      const msRaw = match[3] ?? '0';
      const ms = Number(msRaw.padEnd(3, '0').slice(0, 3));
      if (text) {
        lines.push({time: min * 60 + sec + ms / 1000, text});
      }
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/**
 * 找到当前播放进度对应的歌词行下标
 */
export function findActiveLine(lines: LrcLine[], position: number): number {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= position + 0.2) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}
