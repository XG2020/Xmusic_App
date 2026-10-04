// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {expect, it, vi} from 'vitest';
import {usePlayer} from './usePlayer';
import type {DesktopBridge} from './types';

const require = createRequire(import.meta.url);
const {OnlineAudioService} = require('../electron/online-audio.cjs');

it('keeps terminal expiry across native IPC, the real preload, and an Error-stripping contextBridge boundary', async () => {
  const qualities: string[] = [];
  const native = new OnlineAudioService({
    requestApi: async (request: {params: {quality: string}}) => {
      qualities.push(request.params.quality);
      return {data: {expired: 'https://media.example/expired'}};
    },
    fetcher: async () => new Response(null, {status: 403}),
  });
  let bridge!: DesktopBridge;
  vm.runInNewContext(readFileSync(require.resolve('../electron/preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: {exposeInMainWorld: (_name: string, api: Record<string, (...args: unknown[]) => unknown>) => {
        bridge = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, async (...args: unknown[]) => {
          try {return structuredClone(await fn(...structuredClone(args)));}
          catch (error) {
            // Electron copies only standard Error properties to the main world.
            // A custom .code placed on a preload Error cannot survive this hop.
            throw new Error((error as Error).message);
          }
        }])) as unknown as DesktopBridge;
      }},
      ipcRenderer: {invoke: async (channel: string, input: unknown) => {
        if (channel !== 'online:resolve') return {ok: true, value: undefined};
        try {return {ok: true, value: await native.resolve(input)};}
        catch (error) {
          const failure = error as Error & {code?: string};
          return {ok: false, error: failure.message, ...(failure.code === 'AUDIO_URL_EXPIRED' ? {code: failure.code} : {})};
        }
      }},
    }),
  });
  class AudioStub {
    src = '';
    currentTime = 0;
    error = null;
    pause = vi.fn();
    play = vi.fn();
    load = vi.fn();
    removeAttribute = vi.fn();
  }
  vi.stubGlobal('Audio', AudioStub);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  window.desktop = bridge;
  const container = document.createElement('div');
  const root = createRoot(container);
  let player!: ReturnType<typeof usePlayer>;
  function Probe() {player = usePlayer('flac', '', vi.fn()); return null;}
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => player.playTrack({key: 'online:expired', mid: 'expired', title: 'Expired', artist: 'Test', source: 'online'}));
    expect(qualities).toEqual(['flac', 'flac']);
    expect(player.error).toContain('已重新解析同音质');
    expect(player.playing).toBe(false);
    expect(player.loading).toBe(false);
  } finally {
    await act(async () => root.unmount());
    native.dispose();
    delete window.desktop;
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});
