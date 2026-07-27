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

/** QRC 逐字歌词：单个字/词的演唱起止时间（秒） */
export type QrcWord = {
  start: number;
  dur: number;
  text: string;
};

export type QrcLine = {
  time: number; // 行开始（秒）
  end: number; // 行结束（秒）
  text: string;
  words: QrcWord[];
};

/**
 * 解析 QRC 逐字歌词（XML 中 LyricContent 内容）
 * 行格式：[行起始ms,行时长ms]字(起始ms,时长ms)字(起始ms,时长ms)...
 */
export function parseQrc(xml: string): QrcLine[] {
  if (!xml) {
    return [];
  }
  // 从 XML 属性中提取歌词正文；拿不到就把整段文本当正文尝试
  const m = xml.match(/LyricContent\s*=\s*"([\s\S]*?)"\s*\/?>/);
  let content = m ? m[1] : xml;
  content = content
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  const lines: QrcLine[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const lm = raw.match(/^\[(\d+),(\d+)\]/);
    if (!lm) {
      continue;
    }
    const lineStart = Number(lm[1]);
    const lineDur = Number(lm[2]);
    const body = raw.slice(lm[0].length);
    const words: QrcWord[] = [];
    const wordRe = /([^(]*)\((\d+),(\d+)\)/g;
    let wm: RegExpExecArray | null;
    let text = '';
    while ((wm = wordRe.exec(body)) !== null) {
      text += wm[1];
      words.push({
        start: Number(wm[2]) / 1000,
        dur: Number(wm[3]) / 1000,
        text: wm[1],
      });
    }
    const trimmed = text.trim();
    if (!trimmed || !words.length) {
      continue;
    }
    lines.push({
      time: lineStart / 1000,
      end: (lineStart + lineDur) / 1000,
      text: trimmed,
      words,
    });
  }
  return lines.sort((a, b) => a.time - b.time);
}
