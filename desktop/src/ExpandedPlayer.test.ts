// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import ExpandedPlayer from './ExpandedPlayer';
import {parseLyrics} from './lib/music';
import {fetchSongDetails} from './services/musicApi';
import type {Track} from './types';

vi.mock('./services/musicApi', () => ({fetchSongDetails: vi.fn()}));

let root: Root;
let container: HTMLDivElement;
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
let scrollDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  frameId = 0;
  frames.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {frames.set(++frameId, callback); return frameId;});
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {configurable: true, value: vi.fn()});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

function infoProps(track: Track, baseUrl?: string) {
  return {track, baseUrl, playing: false, lyrics: [], position: 0, duration: 0, rawLyric: '', lyricStatus: '暂无歌词',
    favorite: false, onFavorite: vi.fn(), onSeek: vi.fn(), onClose: vi.fn()};
}

async function openInfo() {
  await act(async () => container.querySelector<HTMLButtonElement>('#info-tab')!.click());
}

function infoValue(label: string) {
  return [...container.querySelectorAll('.detail-info-card dt')].find(term => term.textContent === label)?.nextElementSibling?.textContent;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}

it('loads online encyclopedia data only when its tab opens and displays the mobile information groups', async () => {
  const track: Track = {key: 'online:one', mid: 'one', title: '当前歌曲', artist: '当前歌手', source: 'online'};
  vi.mocked(fetchSongDetails).mockResolvedValue({...track, title: '完整歌曲', artist: '歌手甲 / 歌手乙', album: '真实专辑',
    language: '国语', genre: '流行', releaseDate: '2026-09-29', recordLabel: '真实唱片公司', duration: 245, introduction: '第一段\n\n第二段'});
  await act(async () => root.render(createElement(ExpandedPlayer, infoProps(track, 'https://details.example'))));
  expect(fetchSongDetails).not.toHaveBeenCalled();
  await openInfo();
  expect(fetchSongDetails).toHaveBeenCalledWith(track, 'https://details.example');
  expect([...container.querySelectorAll('.detail-info-card h3')].map(title => title.textContent)).toEqual(['基础信息', '更多信息', '简介']);
  expect(infoValue('歌曲名')).toBe('完整歌曲');
  expect(infoValue('歌手')).toBe('歌手甲 / 歌手乙');
  expect(infoValue('语种')).toBe('国语');
  expect(infoValue('流派')).toBe('流行');
  expect(infoValue('专辑')).toBe('真实专辑');
  expect(infoValue('专辑发行时间')).toBe('2026-09-29');
  expect(infoValue('时长')).toBe('4:05');
  expect(infoValue('唱片公司')).toBe('真实唱片公司');
  expect(infoValue('来源')).toBe('在线播放');
  expect(container.querySelector('.detail-info-introduction')?.textContent).toBe('第一段\n\n第二段');
});

it('shows registered local fields, leaves missing fields unspecified and never fetches online details for local audio', async () => {
  const track: Track = {key: 'local:one', localId: 'one', mid: 'retained-online-mid', title: '本地歌曲', artist: '本地歌手', source: 'local', genre: 'Jazz', introduction: '<b>本地备注</b>'};
  await act(async () => root.render(createElement(ExpandedPlayer, infoProps(track))));
  await openInfo();
  expect(fetchSongDetails).not.toHaveBeenCalled();
  expect(infoValue('流派')).toBe('Jazz');
  expect(infoValue('语种')).toBe('未提供');
  expect(infoValue('专辑')).toBe('未提供');
  expect(infoValue('专辑发行时间')).toBe('未提供');
  expect(infoValue('唱片公司')).toBe('未提供');
  expect(infoValue('时长')).toBe('未提供');
  expect(infoValue('来源')).toBe('本地文件');
  expect(container.querySelector('.detail-info-introduction')?.textContent).toBe('<b>本地备注</b>');
  expect(container.querySelector('.detail-info-introduction b')).toBeNull();
});

it('hides old details immediately when the track or service changes and discards late results', async () => {
  const first = deferred<Track>();
  const second = deferred<Track>();
  const third = deferred<Track>();
  vi.mocked(fetchSongDetails).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
  const firstTrack: Track = {key: 'online:first', mid: 'first', title: '第一首', artist: '甲', source: 'online'};
  const secondTrack: Track = {key: 'online:second', mid: 'second', title: '第二首', artist: '乙', source: 'online'};
  await act(async () => root.render(createElement(ExpandedPlayer, infoProps(firstTrack, 'https://a.example'))));
  await openInfo();
  await act(async () => root.render(createElement(ExpandedPlayer, infoProps(secondTrack, 'https://a.example'))));
  expect(infoValue('歌曲名')).toBe('第二首');
  await act(async () => first.resolve({...firstTrack, language: '不应显示的旧语种'}));
  expect(infoValue('语种')).toBe('未提供');
  await act(async () => second.resolve({...secondTrack, language: '当前语种'}));
  expect(infoValue('语种')).toBe('当前语种');
  await act(async () => root.render(createElement(ExpandedPlayer, infoProps(secondTrack, 'https://b.example'))));
  expect(infoValue('语种')).toBe('未提供');
  await act(async () => third.resolve({...secondTrack, language: '新服务语种'}));
  expect(infoValue('语种')).toBe('新服务语种');
  expect(fetchSongDetails).toHaveBeenCalledTimes(3);
});

it('retains known track fields when details fail and provides a working retry', async () => {
  const track: Track = {key: 'online:retry', mid: 'retry', title: '已知歌曲', artist: '已知歌手', album: '已知专辑', source: 'online'};
  vi.mocked(fetchSongDetails).mockRejectedValueOnce(new Error('服务返回 HTTP 403')).mockResolvedValueOnce({...track, recordLabel: '重试后的公司'});
  await act(async () => root.render(createElement(ExpandedPlayer, infoProps(track))));
  await openInfo();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('服务返回 HTTP 403');
  expect(infoValue('歌曲名')).toBe('已知歌曲');
  expect(infoValue('专辑')).toBe('已知专辑');
  await act(async () => container.querySelector<HTMLButtonElement>('.detail-info-error button')!.click());
  expect(container.querySelector('.detail-info-error')).toBeNull();
  expect(infoValue('唱片公司')).toBe('重试后的公司');
  expect(fetchSongDetails).toHaveBeenCalledTimes(2);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function frame() {
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => pending.forEach(callback => callback(performance.now())));
}

it('uses the audio clock for word fill, freezes on pause and seeks backwards immediately', async () => {
  let audioPosition = 1.25;
  const onSeek = vi.fn();
  const props = {
    track: {key: 'song', title: '歌曲', artist: '歌手', source: 'online' as const},
    playing: true,
    lyrics: parseLyrics('[1000,2000]你(1000,500)好(2000,1000)\n[4000,1000]再见(4000,1000)'),
    position: 1.25,
    getPosition: () => audioPosition,
    duration: 20,
    rawLyric: '',
    lyricStatus: '',
    favorite: false,
    onFavorite: vi.fn(),
    onSeek,
    onClose: vi.fn(),
  };
  const render = async () => {await act(async () => root.render(createElement(ExpandedPlayer, {...props})));};
  const fills = () => [...container.querySelectorAll<HTMLElement>('.detail-lyric-line.active .detail-lyric-word')].map(word => parseFloat(word.style.getPropertyValue('--word-progress')));
  await render();
  expect(fills()).toEqual([50, 0]);

  audioPosition = 1.75;
  await frame();
  expect(fills()).toEqual([100, 0]);
  audioPosition = 2.5;
  await frame();
  expect(fills()).toEqual([100, 50]);

  props.playing = false;
  props.position = 2.5;
  await render();
  expect(frames.size).toBe(0);
  audioPosition = 9;
  await frame();
  expect(fills()).toEqual([100, 50]);

  props.position = 1.1;
  await render();
  expect(fills()[0]).toBeCloseTo(20);
  expect(fills()[1]).toBe(0);

  props.playing = true;
  audioPosition = 4.5;
  await render();
  expect(container.querySelector('.detail-lyric-line.active')?.textContent).toBe('再见');
  expect(fills()).toEqual([50]);
  await act(async () => container.querySelector<HTMLButtonElement>('.detail-lyric-line')!.click());
  expect(onSeek).toHaveBeenLastCalledWith(1);
});

it('copies a right-clicked lyric or all plain lyric text without seeking', async () => {
  const copyText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('desktop', {copyText});
  const props = {...infoProps({key: 'local:lyrics', title: '歌曲', artist: '歌手', source: 'local'}),
    lyrics: parseLyrics('[00:05]第一句\n[00:12]第二句'), position: 6};
  await act(async () => root.render(createElement(ExpandedPlayer, props)));
  const second = container.querySelectorAll<HTMLButtonElement>('.detail-lyric-line')[1];
  await act(async () => second.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 40, clientY: 60})));
  expect(props.onSeek).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(copyText).toHaveBeenLastCalledWith('第二句');
  expect(container.querySelector('[role="status"]')?.textContent).toBe('已复制歌词');
  expect(document.activeElement).toBe(second);
  await act(async () => second.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true})));
  await act(async () => document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1].click());
  expect(copyText).toHaveBeenLastCalledWith('第一句\n第二句');
  expect(props.onSeek).not.toHaveBeenCalled();
  await act(async () => second.click());
  expect(props.onSeek).toHaveBeenLastCalledWith(12);
});

it('shows one browsed-line time bubble only during manual browsing and resumes following after two seconds', async () => {
  vi.useFakeTimers();
  const props = {...infoProps({key: 'local:times', title: '歌曲', artist: '歌手', source: 'local'}),
    lyrics: parseLyrics('[00:05]第一句\n[00:12]第二句'), position: 6};
  await act(async () => root.render(createElement(ExpandedPlayer, props)));
  expect(container.querySelector('.detail-lyric-time')).toBeNull();
  const scroll = container.querySelector('.detail-lyrics-scroll')!;
  await act(async () => scroll.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: 100})));
  expect(container.querySelectorAll('.detail-lyric-time')).toHaveLength(1);
  expect(container.querySelector('.detail-lyric-time')?.textContent).toBe('0:05');
  const second = container.querySelectorAll<HTMLButtonElement>('.detail-lyric-line')[1];
  await act(async () => second.focus());
  expect(container.querySelector('.detail-lyric-time')?.textContent).toBe('0:12');
  await act(async () => vi.advanceTimersByTime(1999));
  expect(container.querySelector('.detail-lyric-time')).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(container.querySelector('.detail-lyric-time')).toBeNull();
  expect(container.querySelector('.follow-lyric')).toBeNull();
  expect(props.onSeek).not.toHaveBeenCalled();
});
