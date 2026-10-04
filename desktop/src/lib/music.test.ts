import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import { findActiveLine, formatTime, getLyricWordProgress, getNextIndex, mergeTracks, parseLrc, parseLyrics, parseQrc } from './music';

const tracks: Track[] = ['a', 'b', 'c'].map((key) => ({ key, title: key, artist: 'Artist', source: 'online' }));

describe('lyric synchronization', () => {
  it('expands repeated timestamps, scales fractions, sorts and applies a global offset', () => {
    const lines = parseLrc('[ti:Song]\r\n[01:02.34][00:12.3]同一句\r\n[00:02.005]开头\r\n[offset:+500]');
    expect(lines).toEqual([
      { time: 1.505, text: '开头' },
      { time: 11.8, text: '同一句' },
      { time: 61.84, text: '同一句' },
    ]);
  });

  it('keeps timed pauses, drops word timestamps and ignores metadata/invalid timestamps', () => {
    expect(parseLrc('[ar:Artist]\n[00:00.10]<00:00.10>你<00:00.50>好\n[00:01.00]\n[00:99.0]坏标签\n[offset:-250]')).toEqual([
      { time: 0.35, text: '你好' },
      { time: 1.25, text: '' },
    ]);
  });

  it('finds exact boundary lines, including duplicate timestamps and prelude silence', () => {
    const lines = parseLrc('[00:01]First\n[00:02]Second\n[00:02]Translation\n[00:03]');
    expect(findActiveLine(lines, 0.99)).toBe(-1);
    expect(findActiveLine(lines, 1)).toBe(0);
    expect(findActiveLine(lines, 2)).toBe(2);
    expect(findActiveLine(lines, 99)).toBe(3);
    expect(findActiveLine([], 2)).toBe(-1);
    expect(findActiveLine(lines, NaN)).toBe(-1);
  });

  it('parses XML QRC into real word timing, preserving entities, punctuation and timed silence', () => {
    const lines = parseLyrics('<QrcInfos><LyricInfo><Lyric_1 LyricType="1" LyricContent="[4000,1000]结尾(4000,1000)&#10;[1000,2000]你(1000,500) &amp; 我(2000,750)！&#10;[3000,500]"/></LyricInfo></QrcInfos>');
    expect(lines).toEqual([
      {time: 1, end: 3, text: '你 & 我！', words: [{start: 1, dur: 0.5, text: '你'}, {start: 2, dur: 0.75, text: ' & 我！'}]},
      {time: 3, end: 3.5, text: '', words: []},
      {time: 4, end: 5, text: '结尾', words: [{start: 4, dur: 1, text: '结尾'}]},
    ]);
    expect(parseQrc('[1000,500]（你）(1000,500)')).toEqual([{time: 1, end: 1.5, text: '（你）', words: [{start: 1, dur: 0.5, text: '（你）'}]}]);
    const spaced = parseQrc('[1000,500] 你(1000,500) ')[0];
    expect(spaced.text).toBe(' 你 ');
    expect(spaced.words!.map(word => word.text).join('')).toBe(spaced.text);
  });

  it('falls back to LRC without fabricating word timings or accepting malformed QRC', () => {
    expect(parseLyrics('[00:01]普通歌词')).toEqual([{time: 1, text: '普通歌词'}]);
    expect(parseQrc('[1000,1000]歌词没有逐字时间')).toEqual([]);
    expect(parseQrc('<Lyric_1 LyricContent="not lyrics"/>')).toEqual([]);
    expect(parseLyrics('')).toEqual([]);
  });

  it('fills each word only during its own timing, including backward seeks and instantaneous words', () => {
    const first = {start: 1, dur: 0.5, text: '你'};
    const second = {start: 2, dur: 1, text: '好'};
    expect(getLyricWordProgress(first, 0.9)).toBe(0);
    expect(getLyricWordProgress(first, 1.25)).toBe(0.5);
    expect(getLyricWordProgress(first, 1.75)).toBe(1);
    expect(getLyricWordProgress(second, 1.75)).toBe(0);
    expect(getLyricWordProgress(second, 2.75)).toBe(0.75);
    expect(getLyricWordProgress(second, 2.25)).toBe(0.25);
    expect(getLyricWordProgress(second, 20)).toBe(1);
    expect(getLyricWordProgress({...first, dur: 0}, 1)).toBe(1);
    expect(getLyricWordProgress(first, NaN)).toBe(0);
  });
});

describe('queue navigation', () => {
  it('wraps in list mode and handles an empty or missing selection', () => {
    expect(getNextIndex(tracks, 'c', 'list', 1, true)).toBe(0);
    expect(getNextIndex(tracks, 'a', 'list', -1)).toBe(2);
    expect(getNextIndex([], undefined, 'shuffle', 1)).toBe(-1);
    expect(getNextIndex(tracks, 'deleted', 'list', 1)).toBe(0);
    expect(getNextIndex(tracks, undefined, 'list', -1)).toBe(2);
  });

  it('repeats a single track at its end, while respecting manual skip', () => {
    expect(getNextIndex(tracks, 'b', 'single', 1, true)).toBe(1);
    expect(getNextIndex(tracks, 'b', 'single', 1)).toBe(2);
    expect(getNextIndex(tracks, 'b', 'single', -1)).toBe(0);
    expect(getNextIndex([tracks[0]], 'a', 'shuffle', 1)).toBe(0);
  });

  it('never immediately repeats in shuffle mode and guards faulty random sources', () => {
    for (const current of tracks) {
      for (const sample of [0, 0.3, 0.5, 0.99999, 1, -1, NaN]) {
        const index = getNextIndex(tracks, current.key, 'shuffle', 1, true, () => sample);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(tracks.length);
        expect(tracks[index].key).not.toBe(current.key);
      }
    }
  });

  it('deduplicates both sources without mutating the original queue', () => {
    const existing = [tracks[0], tracks[0], tracks[1]];
    const duplicate = { ...tracks[0], title: 'Changed' };
    expect(mergeTracks(existing, [duplicate, tracks[2], tracks[2]])).toEqual(tracks);
    expect(existing).toHaveLength(3);
  });
});

it('formats unknown, negative, fractional and long durations', () => {
  expect(formatTime()).toBe('0:00');
  expect(formatTime(NaN)).toBe('0:00');
  expect(formatTime(Infinity)).toBe('0:00');
  expect(formatTime(-1)).toBe('0:00');
  expect(formatTime(65.8)).toBe('1:05');
  expect(formatTime(3661)).toBe('1:01:01');
});
