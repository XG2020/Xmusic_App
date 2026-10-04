import type { PlayMode, Track } from '../types';

/** Absolute song timing in seconds, matching the mobile QRC format. */
export interface LyricWord {
  start: number;
  dur: number;
  text: string;
}

export interface LyricLine {
  time: number;
  text: string;
  end?: number;
  words?: LyricWord[];
}

export function formatTime(seconds?: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds!)) : 0;
  const minutes = Math.floor(total / 60);
  const remainder = String(total % 60).padStart(2, '0');
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`;
}

/** LRC offsets are milliseconds; a positive offset advances the lyrics. */
export function parseLrc(text: string): LyricLine[] {
  const offsets = [...text.matchAll(/\[offset\s*:\s*([+-]?\d+)\s*\]/gi)];
  const offset = Number(offsets.at(-1)?.[1] ?? 0) / 1000;
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r\n?|\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const lyric = raw
      .replace(/\[(\d+):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g, '')
      .replace(/\[(?:ar|al|ti|au|by|re|ve|length|offset)\s*:[^\]]*\]/gi, '')
      .replace(/<\d+:[0-5]?\d(?:\.\d{1,3})?>/g, '')
      .trim();
    for (const tag of tags) {
      const fraction = Number(`0.${tag[3] ?? '0'}`);
      const time = Number(tag[1]) * 60 + Number(tag[2]) + fraction - offset;
      if (Number.isFinite(time)) lines.push({ time: Math.max(0, time), text: lyric });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

function decodeQrcEntities(value: string): string {
  const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

/** Parse QQ's XML-wrapped or plain QRC without estimating any word timings. */
export function parseQrc(source: string): LyricLine[] {
  const xml = source.includes('&lt;') && !source.includes('<') ? decodeQrcEntities(source) : source;
  // The service may already have decoded quotes inside the lyric attribute.
  const attribute = xml.match(/\bLyricContent\s*=\s*(["'])([\s\S]*?)\1\s*(?:\/?>|[\w:.-]+\s*=)/i);
  const content = decodeQrcEntities(attribute?.[2] ?? xml);
  const lines: LyricLine[] = [];
  for (const raw of content.split(/\r\n?|\n/)) {
    const header = raw.match(/^\s*\[(\d+),(\d+)\]/);
    if (!header) continue;
    const time = Number(header[1]) / 1000;
    const end = time + Number(header[2]) / 1000;
    if (!Number.isFinite(time) || !Number.isFinite(end)) continue;
    const body = raw.slice(header[0].length);
    const words: LyricWord[] = [];
    let cursor = 0;
    for (const timing of body.matchAll(/\((\d+),(\d+)(?:,\d+)?\)/g)) {
      const start = Number(timing[1]) / 1000;
      const dur = Number(timing[2]) / 1000;
      if (!Number.isFinite(start) || !Number.isFinite(dur)) continue;
      const text = body.slice(cursor, timing.index);
      if (text) words.push({ start, dur, text });
      cursor = timing.index + timing[0].length;
    }
    if (words.length) {
      // Untimed punctuation at the end belongs to the final sung word.
      words[words.length - 1].text += body.slice(cursor);
      // Preserve intentional spacing so the text exactly matches its timed words.
      lines.push({ time, end, text: words.map(word => word.text).join(''), words });
    } else if (!body.trim()) {
      lines.push({ time, end, text: '', words: [] });
    }
  }
  return lines.some(line => line.words?.length) ? lines.sort((a, b) => a.time - b.time) : [];
}

/** QRC has real word timings; ordinary LRC retains its existing line behavior. */
export function parseLyrics(source: string): LyricLine[] {
  const qrc = parseQrc(source);
  return qrc.length ? qrc : parseLrc(source);
}

/** Pure playhead-based fill: seeking backwards and pausing need no animation reset. */
export function getLyricWordProgress(word: LyricWord, position: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(word.start) || !Number.isFinite(word.dur)) return 0;
  if (position < word.start) return 0;
  if (word.dur <= 0) return 1;
  return Math.min(1, Math.max(0, (position - word.start) / word.dur));
}

/** Return the last line at or before the playhead, including empty pause lines. */
export function findActiveLine(lines: LyricLine[], position: number): number {
  if (!Number.isFinite(position)) return -1;
  let start = 0;
  let end = lines.length - 1;
  let active = -1;
  while (start <= end) {
    const middle = Math.floor((start + end) / 2);
    if (lines[middle].time <= position) {
      active = middle;
      start = middle + 1;
    } else {
      end = middle - 1;
    }
  }
  return active;
}

/** Keep queue order and the first copy of each stable track key. */
export function mergeTracks(existing: Track[], incoming: Track[]): Track[] {
  const seen = new Set<string>();
  return [...existing, ...incoming].filter((track) => {
    if (seen.has(track.key)) return false;
    seen.add(track.key);
    return true;
  });
}

export function getNextIndex(
  queue: Track[],
  currentKey: string | undefined,
  mode: PlayMode,
  direction: 1 | -1,
  ended = false,
  random: () => number = Math.random,
): number {
  if (!queue.length) return -1;
  const current = queue.findIndex((track) => track.key === currentKey);
  if (current < 0) return direction === 1 ? 0 : queue.length - 1;
  if (ended && mode === 'single') return current;
  if (mode === 'shuffle' && queue.length > 1) {
    const sample = random();
    const fraction = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1 - Number.EPSILON) : 0;
    const next = Math.floor(fraction * (queue.length - 1));
    return next >= current ? next + 1 : next;
  }
  return (current + direction + queue.length) % queue.length;
}
