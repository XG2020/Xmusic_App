// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {resolveTrackUrl} from './services/musicApi';
import {isTracks} from './state';
import type {Quality, Track} from './types';
import {usePlayer} from './usePlayer';

vi.mock('./services/musicApi', () => ({resolveTrackUrl: vi.fn()}));

const first: Track = {key: 'online:first', mid: 'first', title: 'First', artist: 'Artist', source: 'online'};
const second: Track = {...first, key: 'online:second', mid: 'second', title: 'Second'};
const third: Track = {...first, key: 'online:third', mid: 'third', title: 'Third'};
const fourth: Track = {...first, key: 'online:fourth', mid: 'fourth', title: 'Fourth'};

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = '';
  preload = '';
  currentTime = 0;
  duration = NaN;
  volume = 1;
  playbackRate = 1;
  preservesPitch = false;
  paused = true;
  ended = false;
  error: {code: number} | null = null;
  ontimeupdate: (() => void) | null = null;
  ondurationchange: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onwaiting: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeAudio.instances.push(this); }
  play = vi.fn(() => {
    this.paused = false;
    this.ended = false;
    this.onplay?.();
    this.onplaying?.();
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    const wasPaused = this.paused;
    this.paused = true;
    if (!wasPaused) this.onpause?.();
  });
  load = vi.fn(() => {
    this.currentTime = 0;
    this.duration = NaN;
    this.ended = false;
    this.error = null;
  });
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  getAttribute(name: string) { return name === 'src' ? this.src || null : null; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return {promise, resolve, reject};
}

let root: Root | undefined;
let container: HTMLDivElement;
let player: ReturnType<typeof usePlayer>;
const played = vi.fn();
const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
const activeResolution = expect.objectContaining({isActive: expect.any(Function)});

async function mount(quality: Quality = '320') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  function Probe() { player = usePlayer(quality, '', played); return null; }
  await act(async () => { root!.render(createElement(Probe)); });
  return FakeAudio.instances.at(-1)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeAudio.instances = [];
  handlers.clear();
  localStorage.clear();
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(navigator, 'mediaSession', {configurable: true, value: {
    metadata: null,
    playbackState: 'none',
    setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
    },
  }});
  vi.mocked(resolveTrackUrl).mockImplementation(async track => `https://audio.example/${track.mid}.mp3`);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('playback lifecycle', () => {
  it('ignores an older URL lookup after switching songs', async () => {
    const audio = await mount();
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    let oldRequest!: Promise<void>;
    await act(async () => { oldRequest = player.playTrack(first, [first, second]); });
    await act(async () => { await player.playTrack(second); });
    await act(async () => { pending.resolve('https://audio.example/old.mp3'); await oldRequest; });
    expect(player.current?.key).toBe(second.key);
    expect(audio.src).toContain('/second.mp3');
    expect(played.mock.calls.map(([track]) => track.key)).toEqual([second.key]);
    expect(vi.mocked(resolveTrackUrl).mock.calls[0][3]?.isActive?.()).toBe(false);
    expect(vi.mocked(resolveTrackUrl).mock.calls[1][3]?.isActive?.()).toBe(true);
    expect(player.playing).toBe(true);
  });

  it('cancels a pending URL lookup when toggled to pause, and retries on play', async () => {
    const audio = await mount();
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = player.playTrack(first); });
    expect(player.loading).toBe(true);
    await act(async () => { player.toggle(); });
    await act(async () => { pending.resolve('https://audio.example/cancelled.mp3'); await request; });
    expect(audio.play).not.toHaveBeenCalled();
    expect(player.loading).toBe(false);
    expect(player.playing).toBe(false);
    await act(async () => { player.toggle(); });
    expect(audio.src).toContain('/first.mp3');
    expect(player.playing).toBe(true);
    expect(resolveTrackUrl).toHaveBeenCalledTimes(2);
  });

  it('cancels pending playback on clear and cannot resurrect its queue', async () => {
    const audio = await mount();
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = player.playTrack(first); });
    await act(async () => { player.clear(); });
    await act(async () => { pending.resolve('https://audio.example/cleared.mp3'); await request; });
    expect(player.queue).toEqual([]);
    expect(player.current).toBeUndefined();
    expect(audio.src).toBe('');
    expect(audio.play).not.toHaveBeenCalled();
    expect(navigator.mediaSession.playbackState).toBe('none');
  });

  it('continues with the next track when removing a loading song', async () => {
    const audio = await mount();
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = player.playTrack(first, [first, second]); });
    await act(async () => { player.remove(first.key); });
    await act(async () => { pending.resolve('https://audio.example/removed.mp3'); await request; });
    expect(player.queue).toEqual([second]);
    expect(audio.src).toContain('/second.mp3');
    expect(player.playing).toBe(true);
  });

  it('keeps playback paused when removing the selected paused song', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first, [first, second]); });
    await act(async () => { player.toggle(); });
    await act(async () => { player.remove(first.key); });
    expect(player.queue).toEqual([second]);
    expect(player.current?.key).toBe(second.key);
    expect(player.playing).toBe(false);
    expect(audio.src).toBe('');
    expect(resolveTrackUrl).toHaveBeenCalledTimes(1);
  });

  it('does not surface a stale resume failure after switching songs', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first, [first, second]); });
    await act(async () => { player.toggle(); });
    const pending = deferred<void>();
    audio.play.mockImplementationOnce(() => pending.promise);
    await act(async () => { player.toggle(); });
    await act(async () => { await player.playTrack(second); });
    await act(async () => { pending.reject(new Error('old request aborted')); });
    expect(player.error).toBe('');
    expect(player.playing).toBe(true);
    expect(player.current?.key).toBe(second.key);
  });

  it('makes system play idempotent and system pause cancels pending autoplay', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first); });
    const calls = audio.pause.mock.calls.length;
    await act(async () => { handlers.get('play')!({action: 'play'}); });
    expect(audio.pause).toHaveBeenCalledTimes(calls);
    expect(player.playing).toBe(true);
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = player.playTrack(second); });
    await act(async () => { handlers.get('pause')!({action: 'pause'}); });
    await act(async () => { pending.resolve('https://audio.example/cancelled.mp3'); await request; });
    expect(player.playing).toBe(false);
    expect(player.loading).toBe(false);
    expect(audio.src).toBe('');
  });

  it('resumes after an audio interruption without requiring an extra pause click', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first); });
    await act(async () => { audio.pause(); });
    expect(player.playing).toBe(false);
    await act(async () => { player.toggle(); });
    expect(player.playing).toBe(true);
    expect(resolveTrackUrl).toHaveBeenCalledTimes(1);
  });

  it('repeats at the end in single mode but manual next advances', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first, [first, second]); player.setMode('single'); });
    await act(async () => { audio.ended = true; audio.paused = true; audio.onended?.(); });
    expect(player.current?.key).toBe(first.key);
    expect(resolveTrackUrl).toHaveBeenCalledTimes(2);
    await act(async () => { player.next(1); });
    expect(player.current?.key).toBe(second.key);
  });

  it('preserves tracks enqueued immediately before another playback action', async () => {
    await mount();
    await act(async () => { player.enqueue(second); await player.playTrack(first); });
    expect(player.queue).toEqual([second, first]);
  });

  it('invalidates an outstanding lookup on unmount', async () => {
    const audio = await mount();
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = player.playTrack(first); });
    await act(async () => { root!.unmount(); root = undefined; });
    pending.resolve('https://audio.example/unmounted.mp3');
    await request;
    expect(audio.play).not.toHaveBeenCalled();
    expect(played).not.toHaveBeenCalled();
  });
});

describe('play next queue actions', () => {
  it('moves one deduplicated copy after the current song without interrupting playback', async () => {
    const audio = await mount();
    await act(async () => {await player.playTrack(second, [first, second, third]);});
    await act(async () => {audio.duration = 120; player.seek(21);});
    const source = audio.src;
    let result = false;
    await act(async () => {result = player.enqueueNext(first);});
    expect(result).toBe(true);
    expect(player.queue).toEqual([second, first, third]);
    expect(player.current?.key).toBe(second.key);
    expect(audio.src).toBe(source);
    expect(audio.currentTime).toBe(21);
    expect(player.playing).toBe(true);
    expect(resolveTrackUrl).toHaveBeenCalledTimes(1);
    await act(async () => {expect(player.enqueueNext(first)).toBe(true); expect(player.enqueueNext(second)).toBe(false);});
    expect(player.queue).toEqual([second, first, third]);
    await act(async () => {player.next(1);});
    expect(player.current?.key).toBe(first.key);
  });

  it('adds to an empty queue without autoplay and preserves an existing paused selection', async () => {
    const audio = await mount();
    await act(async () => {expect(player.enqueueNext(first)).toBe(true);});
    expect(player.queue).toEqual([first]);
    expect(player.current?.key).toBe(first.key);
    expect(audio.play).not.toHaveBeenCalled();
    expect(resolveTrackUrl).not.toHaveBeenCalled();
    await act(async () => {player.enqueueNext(second);});
    expect(player.current?.key).toBe(first.key);
    expect(player.playing).toBe(false);
    await act(async () => {player.toggle();});
    await act(async () => {audio.ended = true; audio.paused = true; audio.onended?.();});
    expect(player.current?.key).toBe(second.key);
  });

  it('records the first successful playback after pausing an unresolved initial play promise', async () => {
    const audio = await mount();
    const pending = deferred<void>();
    audio.play.mockImplementationOnce(() => pending.promise);
    let initial!: Promise<void>;
    await act(async () => { initial = player.playTrack(first); });
    expect(played).not.toHaveBeenCalled();
    await act(async () => { player.pause(); player.toggle(); });
    expect(player.playing).toBe(true);
    expect(played.mock.calls.map(([track]) => track.key)).toEqual([first.key]);
    await act(async () => { pending.resolve(); await initial; });
    expect(played).toHaveBeenCalledTimes(1);
  });

  it('records a restored track when its first play follows a paused quality change', async () => {
    localStorage.setItem('xmusic:queue', JSON.stringify([first]));
    localStorage.setItem('xmusic:current', JSON.stringify(first.key));
    const audio = await mount();
    await act(async () => { await player.changeQuality('flac'); });
    expect(audio.play).not.toHaveBeenCalled();
    await act(async () => { player.toggle(); });
    expect(player.playing).toBe(true);
    expect(played.mock.calls.map(([track]) => track.key)).toEqual([first.key]);
    await act(async () => { player.pause(); player.toggle(); });
    expect(played).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['shuffle', 'manual'], ['shuffle', 'ended'], ['single', 'manual'], ['single', 'ended'],
  ] as const)('honors the specified song in %s mode on %s advancement without changing the mode', async (mode, trigger) => {
    const audio = await mount();
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    await act(async () => {await player.playTrack(first, [first, second, third]); player.setMode(mode);});
    await act(async () => {player.enqueueNext(third);});
    await act(async () => {
      if (trigger === 'manual') player.next(1);
      else {audio.ended = true; audio.paused = true; audio.onended?.();}
    });
    expect(player.current?.key).toBe(third.key);
    expect(player.mode).toBe(mode);
    expect(audio.src).toContain('/third.mp3');
    await act(async () => {audio.ended = true; audio.paused = true; audio.onended?.();});
    expect(player.current?.key).toBe(mode === 'single' ? third.key : second.key);
    expect(player.mode).toBe(mode);
  });

  it('uses the latest play-next choice and keeps it through previous, pause, resume and quality changes', async () => {
    const audio = await mount();
    await act(async () => {await player.playTrack(second, [first, second, third, fourth]);});
    await act(async () => {player.enqueueNext(third); player.enqueueNext(fourth); player.pause();});
    expect(player.queue).toEqual([first, second, fourth, third]);
    expect(player.playing).toBe(false);
    await act(async () => {await player.changeQuality('flac');});
    expect(player.playing).toBe(false);
    await act(async () => {player.toggle(); player.next(-1);});
    expect(player.current?.key).toBe(first.key);
    await act(async () => {player.next(1);});
    expect(player.current?.key).toBe(fourth.key);
    expect(audio.src).toContain('/fourth.mp3');
  });

  it('retains a play-next choice made while the current URL is still loading', async () => {
    const audio = await mount();
    const lookup = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => lookup.promise);
    let request!: Promise<void>;
    await act(async () => {request = player.playTrack(first, [first, second, third]); player.enqueueNext(third);});
    expect(player.loading).toBe(true);
    await act(async () => {lookup.resolve('https://audio.example/first.mp3'); await request;});
    expect(player.current?.key).toBe(first.key);
    expect(player.queue).toEqual([first, third, second]);
    await act(async () => {audio.ended = true; audio.paused = true; audio.onended?.();});
    expect(player.current?.key).toBe(third.key);
  });

  it('clears the old priority when explicitly playing another list that also contains the target', async () => {
    const audio = await mount();
    await act(async () => {await player.playTrack(first, [first, second, third]); player.setMode('single');});
    await act(async () => {player.enqueueNext(third); await player.playTrack(second, [second, third, first]);});
    await act(async () => {audio.ended = true; audio.paused = true; audio.onended?.();});
    expect(player.current?.key).toBe(second.key);
    expect(player.mode).toBe('single');
  });

  it.each(['remove', 'clear'] as const)('clears priority after %s even if the same target is later added normally', async action => {
    await mount();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await act(async () => {await player.playTrack(first, [first, second, third]); player.setMode('shuffle');});
    await act(async () => {
      player.enqueueNext(third);
      if (action === 'remove') player.remove(third.key);
      else {player.clear(); player.enqueue(first); player.enqueue(second);}
      player.enqueue(third);
    });
    if (action === 'clear') await act(async () => {player.toggle();});
    await act(async () => {player.next(1);});
    expect(player.current?.key).toBe(second.key);
    expect(player.mode).toBe('shuffle');
    expect(player.queue).toEqual([first, second, third]);
  });
});

describe('restored player state', () => {
  it('deduplicates a restored queue and repairs a missing selection without autoplay', async () => {
    localStorage.setItem('xmusic:queue', JSON.stringify([first, first, second]));
    localStorage.setItem('xmusic:current', JSON.stringify('removed-track'));
    localStorage.setItem('xmusic:volume', '0.3');
    const audio = await mount();
    expect(player.queue).toEqual([first, second]);
    expect(player.current?.key).toBe(first.key);
    expect(audio.volume).toBe(0.3);
    expect(audio.play).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('xmusic:queue')!)).toEqual([first, second]);
    expect(JSON.parse(localStorage.getItem('xmusic:current')!)).toBe(first.key);
  });

  it('falls back safely for malformed saved values', async () => {
    localStorage.setItem('xmusic:queue', '{broken');
    localStorage.setItem('xmusic:current', JSON.stringify('missing'));
    localStorage.setItem('xmusic:volume', '1.5');
    localStorage.setItem('xmusic:mode', JSON.stringify('invalid'));
    const audio = await mount();
    expect(player.queue).toEqual([]);
    expect(player.current).toBeUndefined();
    expect(player.mode).toBe('list');
    expect(audio.volume).toBe(0.75);
    expect(audio.play).not.toHaveBeenCalled();
    expect(isTracks([{...first, key: ''}])).toBe(false);
    expect(isTracks([{...first, duration: -1}])).toBe(false);
  });
});

describe('online quality recovery', () => {
  it('does not lower quality after native expiry refresh has already failed', async () => {
    await mount('flac');
    vi.mocked(resolveTrackUrl).mockRejectedValueOnce(Object.assign(new Error('播放地址已失效，已重新解析同音质但仍无法播放。'), {code: 'AUDIO_URL_EXPIRED'}));
    await act(async () => { await player.playTrack(first); });
    expect(resolveTrackUrl).toHaveBeenCalledTimes(1);
    expect(player.error).toContain('已重新解析同音质');
    expect(player.playing).toBe(false);
    expect(player.loading).toBe(false);
  });

  it('reports late expired-link failures without blindly lowering quality or duplicating recovery', async () => {
    const audio = await mount('flac');
    const source = 'xmusic-online://stream/12345678-1234-4234-8234-123456789abc';
    vi.mocked(resolveTrackUrl).mockResolvedValueOnce(source);
    const failure = deferred<{code: 'AUDIO_URL_EXPIRED'; message: string}>();
    const getOnlineAudioFailure = vi.fn(() => failure.promise);
    vi.stubGlobal('desktop', {getOnlineAudioFailure});
    await act(async () => { await player.playTrack(first); audio.duration = 180; player.seek(57); });
    await act(async () => { audio.error = {code: 2}; audio.onerror?.(); audio.onerror?.(); });
    expect(getOnlineAudioFailure).toHaveBeenCalledTimes(1);
    expect(getOnlineAudioFailure).toHaveBeenCalledWith(source);
    await act(async () => { failure.resolve({code: 'AUDIO_URL_EXPIRED', message: '播放地址已失效，已重新解析同音质但仍无法播放。'}); });
    expect(resolveTrackUrl).toHaveBeenCalledTimes(1);
    expect(player.position).toBe(57);
    expect(player.error).toContain('已重新解析同音质');
    expect(player.playing).toBe(false);
    expect(player.loading).toBe(false);
  });

  it('replaces an evicted token once at the same quality, preserving seek, speed, and listening history', async () => {
    const audio = await mount('flac');
    vi.mocked(resolveTrackUrl).mockResolvedValue('xmusic-online://stream/12345678-1234-4234-8234-123456789abc');
    vi.stubGlobal('desktop', {getOnlineAudioFailure: vi.fn().mockResolvedValue({code: 'AUDIO_TOKEN_EXPIRED', message: '播放地址缓存已过期，请重新解析。'})});
    await act(async () => { await player.playTrack(first); audio.duration = 180; player.seek(61); player.setPlaybackRate(1.5); });
    await act(async () => { audio.error = {code: 4}; audio.onerror?.(); });
    expect(vi.mocked(resolveTrackUrl).mock.calls.map(([, quality]) => quality)).toEqual(['flac', 'flac']);
    await act(async () => { audio.duration = 180; audio.onloadedmetadata?.(); });
    expect(audio.currentTime).toBe(61);
    expect(audio.playbackRate).toBe(1.5);
    expect(player.playing).toBe(true);
    expect(played).toHaveBeenCalledTimes(1);
    await act(async () => { audio.error = {code: 4}; audio.onerror?.(); });
    expect(resolveTrackUrl).toHaveBeenCalledTimes(2);
    expect(player.playing).toBe(false);
    expect(player.loading).toBe(false);
  });

  it.each(['pause', 'clear', 'switch', 'remove'] as const)('ignores delayed expiry diagnostics after %s', async action => {
    const audio = await mount('flac');
    vi.mocked(resolveTrackUrl).mockResolvedValueOnce('xmusic-online://stream/12345678-1234-4234-8234-123456789abc');
    const failure = deferred<{code: 'AUDIO_TOKEN_EXPIRED'; message: string}>();
    vi.stubGlobal('desktop', {getOnlineAudioFailure: vi.fn(() => failure.promise)});
    await act(async () => { await player.playTrack(first, [first, second]); audio.duration = 180; player.seek(39); });
    await act(async () => { audio.error = {code: 2}; audio.onerror?.(); });
    await act(async () => {
      if (action === 'pause') player.pause();
      if (action === 'clear') player.clear();
      if (action === 'switch') await player.playTrack(second);
      if (action === 'remove') player.remove(first.key);
    });
    const calls = vi.mocked(resolveTrackUrl).mock.calls.length;
    await act(async () => { failure.resolve({code: 'AUDIO_TOKEN_EXPIRED', message: '播放地址缓存已过期，请重新解析。'}); });
    expect(resolveTrackUrl).toHaveBeenCalledTimes(calls);
    expect(player.error).toBe('');
    expect(player.loading).toBe(false);
    expect(player.playing).toBe(action === 'switch' || action === 'remove');
  });

  it('keeps a paused quality change paused while renewing an evicted stream token', async () => {
    const audio = await mount();
    vi.mocked(resolveTrackUrl).mockResolvedValue('xmusic-online://stream/12345678-1234-4234-8234-123456789abc');
    vi.stubGlobal('desktop', {getOnlineAudioFailure: vi.fn().mockResolvedValue({code: 'AUDIO_TOKEN_EXPIRED', message: '播放地址缓存已过期，请重新解析。'})});
    await act(async () => { await player.playTrack(first); audio.duration = 180; player.seek(45); player.pause(); await player.changeQuality('flac'); });
    await act(async () => { audio.error = {code: 4}; audio.onerror?.(); audio.duration = 180; audio.onloadedmetadata?.(); });
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, 'flac', '', activeResolution);
    expect(player.position).toBe(45);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(false);
  });

  it.each(['AbortError', 'NotAllowedError'])('does not bypass a downloaded source for %s interruptions', async name => {
    const audio = await mount('flac');
    vi.mocked(resolveTrackUrl).mockResolvedValueOnce('xmusic-audio://track/12345678-1234-4234-8234-123456789abc');
    audio.play.mockRejectedValueOnce(new DOMException('interrupted', name));
    await act(async () => { await player.playTrack(first); });
    expect(resolveTrackUrl).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(false);
    expect(player.loading).toBe(false);
  });

  it('retries online at the same quality when a downloaded copy fails, preserving position and avoiding another local retry', async () => {
    const audio = await mount('flac');
    vi.mocked(resolveTrackUrl).mockResolvedValueOnce('xmusic-audio://track/12345678-1234-4234-8234-123456789abc');
    await act(async () => { await player.playTrack(first); audio.duration = 180; player.seek(31); });
    await act(async () => { audio.error = {code: 3}; audio.onerror?.(); });
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, 'flac', '', {skipDownloaded: true, isActive: expect.any(Function)});
    expect(player.position).toBe(31);
    expect(player.playing).toBe(true);
    await act(async () => { player.pause(); player.toggle(); audio.error = {code: 2}; audio.onerror?.(); });
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, '320', '', {skipDownloaded: true, isActive: expect.any(Function)});
    expect(played).toHaveBeenCalledTimes(1);
  });

  it('uses the next quality after real decoder errors, preserves position and speed, and keeps the preferred quality for the next song', async () => {
    const audio = await mount('flac');
    await act(async () => { await player.playTrack(first, [first, second]); audio.duration = 180; player.seek(63); player.setPlaybackRate(1.5); });
    await act(async () => { audio.error = {code: 3}; audio.paused = true; audio.onpause?.(); audio.onerror?.(); });
    expect(vi.mocked(resolveTrackUrl).mock.calls.map(([, quality]) => quality)).toEqual(['flac', '320']);
    expect(player.playing).toBe(true);
    await act(async () => { audio.currentTime = 0; audio.duration = 180; audio.onloadedmetadata?.(); });
    expect(audio.currentTime).toBe(63);
    expect(audio.playbackRate).toBe(1.5);
    await act(async () => { audio.error = {code: 2}; audio.onerror?.(); });
    await act(async () => { audio.currentTime = 0; audio.duration = 180; audio.onloadedmetadata?.(); });
    expect(audio.currentTime).toBe(63);
    expect(vi.mocked(resolveTrackUrl).mock.calls.map(([, quality]) => quality)).toEqual(['flac', '320', '128']);
    expect(played).toHaveBeenCalledTimes(1);
    expect(player.error).toBe('');
    await act(async () => { player.next(1); });
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(second, 'flac', '', activeResolution);
  });

  it('reports the actual final media failure after exhausting each quality exactly once', async () => {
    const audio = await mount('flac');
    await act(async () => { await player.playTrack(first); });
    for (const code of [4, 3, 2]) await act(async () => { audio.error = {code}; audio.onerror?.(); });
    expect(vi.mocked(resolveTrackUrl).mock.calls.map(([, quality]) => quality)).toEqual(['flac', '320', '128']);
    expect(player.error).toContain('音频网络传输失败');
    expect(player.error).toContain('无损 FLAC → 320 kbps → 128 kbps');
    expect(player.playing).toBe(false);
    expect(player.loading).toBe(false);
    await act(async () => { audio.onerror?.(); });
    expect(resolveTrackUrl).toHaveBeenCalledTimes(3);
    await act(async () => { player.toggle(); });
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, 'flac', '', activeResolution);
    expect(player.playing).toBe(true);
  });

  it('falls back on lookup errors and play promise rejection, without duplicate history entries', async () => {
    const audio = await mount('flac');
    vi.mocked(resolveTrackUrl).mockRejectedValueOnce(new Error('无损音质暂无播放地址'));
    audio.play.mockRejectedValueOnce(new DOMException('Cannot decode', 'NotSupportedError'));
    await act(async () => { await player.playTrack(first); });
    expect(vi.mocked(resolveTrackUrl).mock.calls.map(([, quality]) => quality)).toEqual(['flac', '320', '128']);
    expect(player.playing).toBe(true);
    expect(player.error).toBe('');
    expect(played).toHaveBeenCalledTimes(1);
  });

  it.each(['pause', 'clear', 'switch', 'remove'] as const)('invalidates an outstanding fallback on %s', async action => {
    const audio = await mount('flac');
    await act(async () => { await player.playTrack(first, [first, second]); audio.duration = 180; player.seek(37); });
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    await act(async () => { audio.error = {code: 3}; audio.onerror?.(); });
    expect(player.loading).toBe(true);
    await act(async () => {
      if (action === 'pause') player.pause();
      if (action === 'clear') player.clear();
      if (action === 'switch') await player.playTrack(second);
      if (action === 'remove') player.remove(first.key);
    });
    const calls = audio.play.mock.calls.length;
    await act(async () => { pending.reject(new Error('stale fallback failed')); });
    expect(audio.play).toHaveBeenCalledTimes(calls);
    expect(player.error).toBe('');
    expect(player.loading).toBe(false);
    expect(player.playing).toBe(action === 'switch' || action === 'remove');
    if (action === 'pause') {
      await act(async () => { player.toggle(); audio.duration = 180; audio.onloadedmetadata?.(); });
      expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, 'flac', '', activeResolution);
      expect(player.position).toBe(37);
    }
  });

  it('ignores obsolete error callbacks and play rejections after changing the quality during fallback', async () => {
    const audio = await mount('flac');
    await act(async () => { await player.playTrack(first); audio.duration = 180; player.seek(52); });
    const obsoleteError = audio.onerror;
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    await act(async () => { audio.error = {code: 3}; audio.onerror?.(); await player.changeQuality('128'); });
    await act(async () => { obsoleteError?.(); pending.reject(new Error('old 320 request')); });
    // A queued DOM error can dispatch through the newly assigned handler;
    // load() has already reset MediaError for the new source.
    await act(async () => { audio.onerror?.(); });
    expect(vi.mocked(resolveTrackUrl).mock.calls.map(([, quality]) => quality)).toEqual(['flac', '320', '128']);
    expect(player.playing).toBe(true);
    expect(player.error).toBe('');
    await act(async () => { audio.currentTime = 0; audio.duration = 180; audio.onloadedmetadata?.(); });
    expect(player.position).toBe(52);
  });

  it('resumes a downgraded stream without re-requesting a higher quality, then recovers from the actual loaded quality', async () => {
    const audio = await mount('flac');
    await act(async () => { await player.playTrack(first); audio.duration = 180; player.seek(38); audio.error = {code: 3}; audio.onerror?.(); });
    await act(async () => { audio.duration = 180; audio.onloadedmetadata?.(); player.pause(); });
    await act(async () => { player.toggle(); });
    expect(resolveTrackUrl).toHaveBeenCalledTimes(2);
    await act(async () => { audio.error = {code: 2}; audio.onerror?.(); });
    expect(vi.mocked(resolveTrackUrl).mock.calls.map(([, quality]) => quality)).toEqual(['flac', '320', '128']);
    expect(player.position).toBe(38);
    expect(player.playing).toBe(true);
    expect(played).toHaveBeenCalledTimes(1);
  });

  it('keeps a paused quality refresh paused while recovering, and allows cancellation of that fallback', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first); audio.duration = 180; player.seek(45); player.pause(); await player.changeQuality('flac'); });
    await act(async () => { audio.error = {code: 4}; audio.onerror?.(); });
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, '320', '', activeResolution);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(false);
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    await act(async () => { audio.error = {code: 2}; audio.onerror?.(); player.toggle(); });
    await act(async () => { pending.resolve('https://audio.example/cancelled-128.mp3'); });
    expect(audio.src).toBe('');
    expect(player.playing).toBe(false);
    expect(player.loading).toBe(false);
    await act(async () => { player.toggle(); });
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, 'flac', '', activeResolution);
    expect(player.position).toBe(45);
  });

  it('does not downgrade local files, explicit interruption, or autoplay permission failures', async () => {
    const audio = await mount('flac');
    const local: Track = {...first, key: 'local:first', source: 'local', localId: 'first'};
    await act(async () => { await player.playTrack(local); audio.error = {code: 3}; audio.onerror?.(); });
    expect(resolveTrackUrl).toHaveBeenCalledTimes(1);
    expect(player.error).toContain('解码失败');
    audio.play.mockRejectedValueOnce(new DOMException('Gesture required', 'NotAllowedError'));
    await act(async () => { await player.playTrack(first); });
    expect(resolveTrackUrl).toHaveBeenCalledTimes(2);
    expect(player.error).toContain('系统阻止');
    await act(async () => { await player.playTrack(first); audio.error = {code: 1}; audio.onerror?.(); });
    expect(resolveTrackUrl).toHaveBeenCalledTimes(3);
    expect(player.error).toContain('播放已中断');
  });
});

describe('quality and speed controls', () => {
  it('reloads the current stream at a new quality and restores its position after metadata', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first); });
    await act(async () => { audio.duration = 180; player.seek(67); player.setPlaybackRate(1.5); });
    await act(async () => { await player.changeQuality('flac'); });
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, 'flac', '', activeResolution);
    await act(async () => { audio.currentTime = 0; audio.duration = 175; audio.onloadedmetadata?.(); });
    expect(audio.currentTime).toBe(67);
    expect(player.position).toBe(67);
    expect(player.playing).toBe(true);
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.preservesPitch).toBe(true);
    expect(played).toHaveBeenCalledTimes(1);
  });

  it('keeps a paused stream paused when switching quality', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first); });
    await act(async () => { audio.duration = 180; player.seek(44); player.pause(); });
    await act(async () => { await player.changeQuality('128'); });
    await act(async () => { audio.duration = 180; audio.onloadedmetadata?.(); });
    expect(audio.currentTime).toBe(44);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(false);
    expect(player.loading).toBe(false);
    await act(async () => { player.toggle(); });
    expect(player.playing).toBe(true);
    expect(resolveTrackUrl).toHaveBeenCalledTimes(2);
  });

  it('cancels a paused quality lookup on toggle instead of starting playback', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first); });
    await act(async () => { audio.duration = 180; player.seek(44); player.pause(); });
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    // Toggle before React rerenders as well: the action must use the current
    // request intent, not the previous render's `loading` value.
    await act(async () => { request = player.changeQuality('flac'); player.toggle(); });
    await act(async () => { pending.resolve('https://audio.example/cancelled.flac'); await request; });
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(resolveTrackUrl).toHaveBeenCalledTimes(2);
    expect(audio.src).toBe('');
    expect(player.loading).toBe(false);
    expect(player.playing).toBe(false);
    await act(async () => { player.toggle(); });
    await act(async () => { audio.duration = 180; audio.onloadedmetadata?.(); });
    expect(player.playing).toBe(true);
    expect(audio.currentTime).toBe(44);
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, 'flac', '', activeResolution);
  });

  it.each(['clear', 'remove'] as const)('resets a paused quality request on %s so the next toggle can play', async action => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first, [first, second]); player.pause(); });
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = player.changeQuality('flac'); });
    await act(async () => {
      if (action === 'clear') { player.clear(); player.enqueue(second); }
      else player.remove(first.key);
    });
    await act(async () => { pending.resolve('https://audio.example/cancelled.flac'); await request; });
    expect(player.loading).toBe(false);
    expect(player.playing).toBe(false);
    await act(async () => { player.toggle(); });
    expect(player.current?.key).toBe(second.key);
    expect(audio.src).toContain('/second.mp3');
    expect(player.playing).toBe(true);
  });

  it('falls back from a failed quality even before its original play promise settles', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first); });
    const pending = deferred<void>();
    audio.play.mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = player.changeQuality('flac'); });
    await act(async () => { audio.error = {code: 3}; audio.onerror?.(); });
    expect(player.loading).toBe(false);
    expect(player.playing).toBe(true);
    expect(player.error).toBe('');
    await act(async () => { pending.reject(new Error('old stream failed')); await request; });
    expect(player.playing).toBe(true);
    expect(player.error).toBe('');
    expect(resolveTrackUrl).toHaveBeenCalledTimes(3);
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, '320', '', activeResolution);
  });

  it('does not restart after a sleep pause during a quality lookup and keeps the resume position', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first); });
    await act(async () => { audio.duration = 180; player.seek(49); });
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = player.changeQuality('flac'); });
    await act(async () => { player.pause(); });
    await act(async () => { pending.resolve('https://audio.example/cancelled.flac'); await request; });
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe('');
    expect(player.playing).toBe(false);
    await act(async () => { player.toggle(); });
    await act(async () => { audio.duration = 180; audio.onloadedmetadata?.(); });
    expect(audio.currentTime).toBe(49);
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, 'flac', '', activeResolution);
  });

  it('ignores an old quality response after switching tracks and uses the latest quality immediately', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first, [first, second]); });
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = player.changeQuality('flac'); await player.playTrack(second); });
    await act(async () => { pending.resolve('https://audio.example/old-quality.flac'); await request; });
    expect(player.current?.key).toBe(second.key);
    expect(audio.src).toContain('/second.mp3');
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(second, 'flac', '', activeResolution);
    expect(player.playing).toBe(true);
  });

  it('keeps the original position across rapid quality changes', async () => {
    const audio = await mount();
    await act(async () => { await player.playTrack(first); });
    await act(async () => { audio.duration = 180; player.seek(72); });
    const pending = deferred<string>();
    vi.mocked(resolveTrackUrl).mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = player.changeQuality('flac'); await player.changeQuality('128'); });
    await act(async () => { audio.duration = 170; audio.onloadedmetadata?.(); pending.resolve('https://audio.example/old.flac'); await request; });
    expect(resolveTrackUrl).toHaveBeenLastCalledWith(first, '128', '', activeResolution);
    expect(audio.currentTime).toBe(72);
    expect(player.position).toBe(72);
  });

  it('does not interrupt local playback when the preferred online quality changes', async () => {
    const audio = await mount();
    const local: Track = {...first, key: 'local:first', source: 'local', localId: 'first'};
    await act(async () => { await player.playTrack(local); });
    await act(async () => { audio.duration = 180; player.seek(25); await player.changeQuality('flac'); });
    expect(resolveTrackUrl).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(25);
    expect(player.playing).toBe(true);
  });

  it('applies and persists valid speed changes while rejecting unsupported values', async () => {
    const audio = await mount();
    await act(async () => { player.setPlaybackRate(0.75); });
    expect(audio.playbackRate).toBe(0.75);
    expect(audio.preservesPitch).toBe(true);
    expect(localStorage.getItem('xmusic:playbackRate')).toBe('0.75');
    await act(async () => { player.setPlaybackRate(3); player.setPlaybackRate(NaN); });
    expect(player.playbackRate).toBe(0.75);
    await act(async () => { await player.playTrack(first); await player.playTrack(second); });
    expect(audio.playbackRate).toBe(0.75);
  });

  it('restores speed without autoplay and ignores malformed saved speed', async () => {
    localStorage.setItem('xmusic:playbackRate', '2');
    const audio = await mount();
    expect(audio.playbackRate).toBe(2);
    expect(audio.play).not.toHaveBeenCalled();
    await act(async () => { root!.unmount(); root = undefined; });
    container.remove();
    localStorage.setItem('xmusic:playbackRate', '0');
    const restored = await mount();
    expect(restored.playbackRate).toBe(1);
  });
});
