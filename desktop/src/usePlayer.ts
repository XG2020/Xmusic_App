import {useCallback, useEffect, useRef, useState} from 'react';
import {getNextIndex, mergeTracks} from './lib/music';
import {resolveTrackUrl} from './services/musicApi';
import {isString, isTracks, isVolume, useStoredState} from './state';
import type {PlayMode, Quality, Track} from './types';

const isMode = (value: unknown): value is PlayMode => value === 'list' || value === 'single' || value === 'shuffle';
export const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const isPlaybackRate = (value: unknown): value is number => typeof value === 'number' && playbackRates.includes(value as typeof playbackRates[number]);
function applyPlaybackRate(element: HTMLAudioElement, rate: number) {
  element.defaultPlaybackRate = rate;
  element.playbackRate = rate;
  element.preservesPitch = true;
}

type PlaybackSession = {request: number; track: Track; qualities: Quality[]; position: number; notified: boolean; skipDownloaded?: boolean; refreshedToken?: boolean};
type PlaybackAttempt = {session: PlaybackSession; index: number};
const qualityLabel: Record<Quality, string> = {flac: '无损 FLAC', '320': '320 kbps', '128': '128 kbps'};
const failureName = (cause: unknown): string => cause !== null && typeof cause === 'object' && 'name' in cause && typeof cause.name === 'string' ? cause.name : '';
const failureCode = (cause: unknown): string => cause !== null && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
function playbackFailure(track: Track, cause: unknown, code?: number): string {
  if (['AUDIO_URL_EXPIRED', 'AUDIO_TOKEN_EXPIRED'].includes(failureCode(cause))) {
    return cause instanceof Error ? cause.message : '播放地址已失效，重新解析后仍无法播放，请稍后重试。';
  }
  const name = failureName(cause);
  if (name === 'NotAllowedError') return '播放被系统阻止，请点击播放重试。';
  if (code === 1 || name === 'AbortError') return '播放已中断，请点击播放重试。';
  if (code === 2) return track.source === 'local' ? '本地文件读取失败，请确认文件仍可访问。' : '音频网络传输失败，请检查网络后重试。';
  if (code === 3) return '音频解码失败，服务返回的音频可能不完整或已损坏。';
  if (code === 4 || name === 'NotSupportedError') return track.source === 'local'
    ? '本地音频格式不受支持，或文件已不可访问，请重新导入。'
    : '无法载入音频：音频格式不受支持或播放地址已失效。';
  return cause instanceof Error && cause.message ? cause.message : '音频无法载入，请重新播放。';
}

export function usePlayer(quality: Quality, baseUrl: string, onPlayed: (track: Track) => void) {
  const [queue, setQueue] = useStoredState<Track[]>('queue', [], isTracks);
  const [currentKey, setCurrentKey] = useStoredState('current', '', isString);
  const [mode, setMode] = useStoredState<PlayMode>('mode', 'list', isMode);
  const [volume, setVolume] = useStoredState('volume', 0.75, isVolume);
  const [playbackRate, storePlaybackRate] = useStoredState('playbackRate', 1, isPlaybackRate);
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);
  const loadedKey = useRef('');
  const pendingSeek = useRef<{key: string; seconds: number} | null>(null);
  const activeAttempt = useRef<PlaybackAttempt | null>(null);
  // A user-selected next track takes precedence for one forward transition,
  // including shuffle and repeat-one, without changing the saved playback mode.
  const priorityNextKey = useRef<string | null>(null);
  const qualityRef = useRef(quality);
  const previousQuality = useRef(quality);
  // A menu can change quality and start another track in the same event.
  // Keep that choice available before React commits the parent's stored state.
  if (previousQuality.current !== quality) {
    previousQuality.current = quality;
    qualityRef.current = quality;
  }
  const rateRef = useRef(playbackRate);
  // An audio element may still be paused while its URL or play() promise is pending.
  // Keep user intent separately so pause/remove also work during that interval.
  const wantsPlayback = useRef(false);
  // A paused quality refresh still has a cancellable request, without an intent
  // to play. Read this synchronously so every toggle cancels that request.
  const pendingPlayback = useRef(false);
  const current = queue.find(track => track.key === currentKey);
  const live = useRef({queue, currentKey, mode, onPlayed});
  live.current = {queue, currentKey, mode, onPlayed};
  const nextRef = useRef<(direction: 1 | -1, ended?: boolean) => void>(() => {});

  useEffect(() => {
    const restoredQueue = mergeTracks([], queue);
    const restoredKey = restoredQueue.some(track => track.key === currentKey) ? currentKey : restoredQueue[0]?.key ?? '';
    if (restoredQueue.length !== queue.length || restoredKey !== currentKey) {
      live.current = {...live.current, queue: restoredQueue, currentKey: restoredKey};
      if (restoredQueue.length !== queue.length) setQueue(restoredQueue);
      if (restoredKey !== currentKey) setCurrentKey(restoredKey);
    }
  }, [queue, currentKey, setQueue, setCurrentKey]);

  useEffect(() => {
    const element = new Audio();
    element.preload = 'metadata';
    audio.current = element;
    const updateTime = () => setPosition(pendingSeek.current?.seconds ?? (Number.isFinite(element.currentTime) ? element.currentTime : 0));
    const restorePosition = () => {
      const target = pendingSeek.current;
      if (!target || target.key !== loadedKey.current || !Number.isFinite(element.duration) || element.duration <= 0) return;
      try {
        element.currentTime = Math.max(0, Math.min(target.seconds, element.duration));
        setPosition(element.currentTime);
        pendingSeek.current = null;
      } catch { /* Some media sources only become seekable on the next duration event. */ }
    };
    const updateDuration = () => {
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
      restorePosition();
    };
    element.ontimeupdate = updateTime;
    element.ondurationchange = updateDuration;
    element.onloadedmetadata = () => {
      applyPlaybackRate(element, rateRef.current);
      updateDuration();
    };
    element.onplay = () => { if (wantsPlayback.current && !element.paused) { setPlaying(true); setError(''); } };
    element.onpause = () => {
      if (!element.paused) return;
      setPlaying(false);
      updateTime();
      // Media failures can also emit pause. Keep the playback intent until the
      // error handler has had a chance to retry the next quality.
      if (wantsPlayback.current && !pendingPlayback.current && !element.error && !element.ended && loadedKey.current && loadedKey.current === live.current.currentKey) {
        ++generation.current;
        wantsPlayback.current = false;
        pendingPlayback.current = false;
        setLoading(false);
      }
    };
    element.onwaiting = () => { if (wantsPlayback.current && !element.paused) setLoading(true); };
    element.onplaying = () => {
      if (!wantsPlayback.current) { element.pause(); return; }
      setPlaying(true);
      setLoading(false);
    };
    element.onended = () => {
      if (wantsPlayback.current && loadedKey.current === live.current.currentKey && element.ended) nextRef.current(1, true);
    };
    return () => {
      generation.current++;
      wantsPlayback.current = false;
      pendingPlayback.current = false;
      activeAttempt.current = null;
      loadedKey.current = '';
      element.onplay = element.onpause = element.onwaiting = element.onplaying = element.onended = element.onerror = null;
      element.ontimeupdate = element.ondurationchange = element.onloadedmetadata = null;
      element.pause();
      element.removeAttribute('src');
      element.load();
      audio.current = null;
    };
  }, []);

  useEffect(() => { if (audio.current) audio.current.volume = muted ? 0 : volume; }, [volume, muted]);
  useEffect(() => {
    rateRef.current = playbackRate;
    if (audio.current) applyPlaybackRate(audio.current, playbackRate);
  }, [playbackRate]);

  const setPlaybackRate = useCallback((value: number) => {
    if (!isPlaybackRate(value)) return;
    rateRef.current = value;
    if (audio.current) applyPlaybackRate(audio.current, value);
    storePlaybackRate(value);
  }, [storePlaybackRate]);

  const attemptSource = useCallback(async function attemptSource(session: PlaybackSession, index: number, reuseSource = false): Promise<void> {
    const element = audio.current;
    if (!element || session.request !== generation.current) return;
    const attempt = {session, index};
    activeAttempt.current = attempt;
    const isCurrent = () => session.request === generation.current && activeAttempt.current === attempt;
    pendingPlayback.current = true;
    setLoading(true);
    setError('');
    let downloadedSource = reuseSource && session.track.source === 'online' && element.src.startsWith('xmusic-audio://');
    let recovery: Promise<void> | undefined;
    let handlingFailure = false;
    const fail = (cause: unknown, code?: number): Promise<void> | undefined => {
      if (!isCurrent() || handlingFailure) return recovery;
      // Claim the failure before an IPC lookup: one error can emit both a media
      // event and a rejected play() promise, but must trigger only one recovery.
      handlingFailure = true;
      pendingPlayback.current = true;
      setLoading(true);
      const seconds = pendingSeek.current?.key === session.track.key ? pendingSeek.current.seconds
        : Number.isFinite(element.currentTime) ? element.currentTime : session.position;
      session.position = Math.max(0, seconds);
      pendingSeek.current = session.position > 0 ? {key: session.track.key, seconds: session.position} : null;
      setPosition(session.position);
      const interrupted = code === 1 || ['AbortError', 'NotAllowedError'].includes(failureName(cause));
      recovery = (async () => {
        if (!interrupted && !failureCode(cause) && element.src.startsWith('xmusic-online://') && window.desktop?.getOnlineAudioFailure) {
          // Chromium reports generic MediaError codes for custom protocols. Ask
          // native playback whether URL refresh was already attempted before
          // interpreting that generic error as a reason to lower the quality.
          const failure = await window.desktop.getOnlineAudioFailure(element.src).catch(() => undefined);
          if (!isCurrent()) return;
          if (failure) cause = Object.assign(new Error(failure.message), {code: failure.code});
        }
        if (!isCurrent()) return;
        activeAttempt.current = null;
        if (!interrupted && failureCode(cause) === 'AUDIO_TOKEN_EXPIRED' && !session.refreshedToken) {
          session.refreshedToken = true;
          await attemptSource(session, index);
          return;
        }
        if (!interrupted && downloadedSource && !session.skipDownloaded) {
          // A downloaded file may disappear or fail to decode after resolution.
          // Retry online once at the same quality instead of reopening the same
          // bad local file for every quality in the fallback chain.
          session.skipDownloaded = true;
          await attemptSource(session, index);
          return;
        }
        if (!interrupted && !['AUDIO_URL_EXPIRED', 'AUDIO_TOKEN_EXPIRED'].includes(failureCode(cause)) && index + 1 < session.qualities.length) {
          await attemptSource(session, index + 1);
          return;
        }
        element.onerror = null;
        loadedKey.current = '';
        wantsPlayback.current = false;
        pendingPlayback.current = false;
        element.pause();
        setLoading(false);
        setPlaying(false);
        const tried = session.track.source === 'online' && index > 0
          ? `（已尝试 ${session.qualities.slice(0, index + 1).map(value => qualityLabel[value]).join(' → ')}）` : '';
        setError(`播放失败${tried}：${playbackFailure(session.track, cause, code)}`);
      })();
      return recovery;
    };
    if (!reuseSource) {
      setPlaying(false);
      loadedKey.current = '';
      element.onerror = null;
      element.pause();
      element.removeAttribute('src');
      element.load();
      setDuration(0);
    }
    try {
      if (!reuseSource) {
        const url = await resolveTrackUrl(session.track, session.qualities[index], baseUrl,
          {isActive: isCurrent, ...(session.skipDownloaded ? {skipDownloaded: true} : {})});
        if (!isCurrent()) return;
        downloadedSource = session.track.source === 'online' && url.startsWith('xmusic-audio://');
        element.src = url;
        loadedKey.current = session.track.key;
      }
      element.onerror = () => {
        // Loading a new source resets MediaError. Ignore an already-queued
        // error event from the previous source after that reset.
        if (element.getAttribute('src') && element.error) void fail(undefined, element.error.code);
      };
      applyPlaybackRate(element, rateRef.current);
      if (session.position > 0) { try { element.currentTime = session.position; } catch { /* Seek again after metadata. */ } }
      if (wantsPlayback.current) {
        await element.play();
        if (isCurrent() && !handlingFailure && !session.notified) {
          session.notified = true;
          live.current.onPlayed(session.track);
        }
      }
    } catch (cause) {
      await fail(cause, element.error?.code);
    } finally {
      if (isCurrent() && !handlingFailure) { pendingPlayback.current = false; setLoading(false); }
    }
  }, [baseUrl]);

  const loadTrack = useCallback(async (track: Track, tracks?: Track[], options: {autoplay?: boolean; position?: number; notify?: boolean} = {}) => {
    const element = audio.current;
    if (!element) return;
    if (priorityNextKey.current === track.key) priorityNextKey.current = null;
    const request = ++generation.current;
    const updatedQueue = mergeTracks(tracks ?? live.current.queue, [track]);
    live.current = {...live.current, queue: updatedQueue, currentKey: track.key};
    setQueue(updatedQueue);
    setCurrentKey(track.key);
    wantsPlayback.current = options.autoplay !== false;
    const resumeAt = Math.max(0, options.position ?? 0);
    pendingSeek.current = resumeAt > 0 ? {key: track.key, seconds: resumeAt} : null;
    setPosition(resumeAt);
    const preferred = qualityRef.current;
    const qualities: Quality[] = track.source === 'local' ? [preferred]
      : preferred === 'flac' ? ['flac', '320', '128'] : preferred === '320' ? ['320', '128'] : ['128'];
    // A quality refresh continues the same listening session. It must still
    // record this track if its first play was paused or superseded before it
    // started, while avoiding another history entry for an already playing song.
    const previous = activeAttempt.current?.session;
    const notified = options.notify === false && previous?.track.key === track.key ? previous.notified : false;
    await attemptSource({request, track, qualities, position: resumeAt, notified}, 0);
  }, [attemptSource, setQueue, setCurrentKey]);

  const playTrack = useCallback((track: Track, tracks?: Track[]) => {
    priorityNextKey.current = null;
    return loadTrack(track, tracks);
  }, [loadTrack]);

  const changeQuality = useCallback(async (nextQuality: Quality) => {
    if (qualityRef.current === nextQuality) return;
    qualityRef.current = nextQuality;
    const track = live.current.queue.find(item => item.key === live.current.currentKey);
    if (!track || track.source === 'local') return;
    const seconds = pendingSeek.current?.key === track.key ? pendingSeek.current.seconds : audio.current?.currentTime ?? 0;
    await loadTrack(track, undefined, {autoplay: wantsPlayback.current, position: seconds, notify: false});
  }, [loadTrack]);

  const next = useCallback((direction: 1 | -1, ended = false) => {
    const state = live.current;
    if (direction === -1 && !ended && audio.current && audio.current.currentTime > 3) {
      pendingSeek.current = null;
      audio.current.currentTime = 0;
      setPosition(0);
      return;
    }
    if (direction === 1 && priorityNextKey.current) {
      const preferred = state.queue.find(track => track.key === priorityNextKey.current);
      priorityNextKey.current = null;
      if (preferred && preferred.key !== state.currentKey) {void loadTrack(preferred); return;}
    }
    const index = getNextIndex(state.queue, state.currentKey, state.mode, direction, ended);
    if (index >= 0) void loadTrack(state.queue[index]);
  }, [loadTrack]);
  nextRef.current = next;

  const pause = useCallback(() => {
    ++generation.current;
    wantsPlayback.current = false;
    pendingPlayback.current = false;
    audio.current?.pause();
    setPosition(pendingSeek.current?.seconds ?? (audio.current && Number.isFinite(audio.current.currentTime) ? audio.current.currentTime : 0));
    setPlaying(false);
    setLoading(false);
  }, []);

  const play = useCallback(() => {
    const element = audio.current;
    if (!element) return;
    if (wantsPlayback.current) return;
    const track = live.current.queue.find(item => item.key === live.current.currentKey) ?? live.current.queue[0];
    if (!track) return;
    if (loadedKey.current === track.key && element.src && !element.error) {
      const request = ++generation.current;
      wantsPlayback.current = true;
      const previous = activeAttempt.current;
      const session: PlaybackSession = {request, track, qualities: previous?.session.qualities ?? [qualityRef.current],
        position: pendingSeek.current?.seconds ?? element.currentTime,
        skipDownloaded: previous?.session.skipDownloaded,
        notified: previous?.session.track.key === track.key ? previous.session.notified : false};
      void attemptSource(session, previous?.index ?? 0, true);
    } else {
      const seconds = pendingSeek.current?.key === track.key ? pendingSeek.current.seconds : 0;
      void loadTrack(track, undefined, {position: seconds});
    }
  }, [loadTrack, attemptSource]);

  const toggle = useCallback(() => {
    if (wantsPlayback.current || pendingPlayback.current) pause();
    else play();
  }, [pause, play]);

  const seek = useCallback((seconds: number) => {
    const element = audio.current;
    if (element && Number.isFinite(element.duration) && element.duration > 0 && Number.isFinite(seconds)) {
      element.currentTime = Math.max(0, Math.min(seconds, element.duration));
      pendingSeek.current = null;
      setPosition(element.currentTime);
    }
  }, []);

  const clear = useCallback(() => {
    priorityNextKey.current = null;
    ++generation.current;
    wantsPlayback.current = false;
    pendingPlayback.current = false;
    activeAttempt.current = null;
    loadedKey.current = '';
    pendingSeek.current = null;
    audio.current?.pause();
    audio.current?.removeAttribute('src');
    audio.current?.load();
    live.current = {...live.current, queue: [], currentKey: ''};
    setQueue([]); setCurrentKey(''); setLoading(false); setPlaying(false); setPosition(0); setDuration(0); setError('');
  }, [setQueue, setCurrentKey]);

  const remove = useCallback((key: string) => {
    if (priorityNextKey.current === key) priorityNextKey.current = null;
    const state = live.current;
    const remaining = state.queue.filter(track => track.key !== key);
    if (key === state.currentKey) {
      const index = state.queue.findIndex(track => track.key === key);
      if (!remaining.length) { clear(); return; }
      if (wantsPlayback.current) { void playTrack(remaining[Math.min(index, remaining.length - 1)], remaining); return; }
      ++generation.current;
      pendingPlayback.current = false;
      activeAttempt.current = null;
      loadedKey.current = '';
      pendingSeek.current = null;
      audio.current?.pause(); audio.current?.removeAttribute('src'); audio.current?.load();
      const nextKey = remaining[Math.min(index, remaining.length - 1)].key;
      if (priorityNextKey.current === nextKey) priorityNextKey.current = null;
      live.current = {...state, queue: remaining, currentKey: nextKey};
      setCurrentKey(nextKey); setPosition(0); setDuration(0); setLoading(false); setPlaying(false); setError('');
    } else { live.current = {...state, queue: remaining}; }
    setQueue(remaining);
  }, [clear, playTrack, setCurrentKey, setQueue]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = current ? new MediaMetadata({title: current.title, artist: current.artist, album: current.album ?? ''}) : null;
    }
    navigator.mediaSession.playbackState = current ? playing ? 'playing' : 'paused' : 'none';
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', play], ['pause', pause],
      ['previoustrack', () => next(-1)], ['nexttrack', () => next(1)],
      ['seekto', details => { if (details.seekTime !== undefined) seek(details.seekTime); }],
    ];
    for (const [action, handler] of actions) { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Not every OS supports every action. */ } }
    return () => { for (const [action] of actions) { try { navigator.mediaSession.setActionHandler(action, null); } catch { /* Unsupported action. */ } } };
  }, [current, playing, play, pause, next, seek]);

  const enqueue = useCallback((track: Track) => {
    const updatedQueue = mergeTracks(live.current.queue, [track]);
    live.current = {...live.current, queue: updatedQueue};
    setQueue(updatedQueue);
  }, [setQueue]);

  const enqueueNext = useCallback((track: Track): boolean => {
    const state = live.current;
    if (track.key === state.currentKey) return false;
    const updatedQueue = mergeTracks([], state.queue.filter(item => item.key !== track.key));
    const currentIndex = updatedQueue.findIndex(item => item.key === state.currentKey);
    updatedQueue.splice(currentIndex + 1, 0, track);
    const selectedKey = currentIndex >= 0 ? state.currentKey : track.key;
    priorityNextKey.current = currentIndex >= 0 ? track.key : null;
    live.current = {...state, queue: updatedQueue, currentKey: selectedKey};
    setQueue(updatedQueue);
    if (selectedKey !== state.currentKey) setCurrentKey(selectedKey);
    return true;
  }, [setQueue, setCurrentKey]);

  const getPosition = useCallback(() => {
    const pending = pendingSeek.current;
    if (pending?.key === live.current.currentKey) return pending.seconds;
    if (loadedKey.current !== live.current.currentKey) return 0;
    const seconds = audio.current?.currentTime;
    return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0;
  }, []);

  return {queue, current, mode, setMode, volume, setVolume, muted, setMuted, playing, loading, position, duration, error, setError,
    playbackRate, setPlaybackRate, changeQuality, pause,
    playTrack, toggle, next, seek, clear, remove,
    enqueue, enqueueNext, getPosition,
  };
}
