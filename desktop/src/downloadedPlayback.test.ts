// @vitest-environment jsdom
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, rm, unlink} from 'node:fs/promises';
import path from 'node:path';
import {expect, it, vi} from 'vitest';
import {resolveTrackUrl} from './services/musicApi';
import type {DesktopBridge, Track} from './types';

const require = createRequire(import.meta.url);
const {AudioRegistry, localAudioResponse} = require('../electron/core.cjs');
const {DownloadManager} = require('../electron/downloads.cjs');

it('plays the downloaded bytes through the real registry after clearing history and restarting, then falls back when the file disappears', async () => {
  const artifacts = path.resolve('.test-data');
  await mkdir(artifacts, {recursive: true});
  const directory = await mkdtemp(path.join(artifacts, 'offline-integration-'));
  const dataDirectory = path.join(directory, 'profile');
  const downloadDirectory = path.join(directory, 'downloads');
  const track: Track = {key: 'online:offline_check', mid: 'offline_check', source: 'online', title: '离线集成检查', artist: 'Xmusic'};
  const bytes = Buffer.alloc(8044, 128);
  bytes.write('RIFF'); bytes.writeUInt32LE(8036, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(8000, 40);
  const apiRequest = vi.fn(async () => ({code: 0, data: {offline_check: 'https://audio.example.test/check.wav'}}));
  const fetcher = vi.fn(async () => new Response(bytes, {headers: {'content-type': 'audio/wav'}}));
  const online = vi.fn(async () => 'xmusic-online://stream/00000000-0000-4000-8000-000000000000');
  let registry = new AudioRegistry(dataDirectory);
  const options = () => ({dataDirectory, defaultDirectory: downloadDirectory, registry,
    chooseDirectory: async () => null, openDirectory: async () => {}, notify: () => {}, apiRequest, fetcher});
  let manager = new DownloadManager(options());
  try {
    await registry.load(); await manager.load();
    await manager.start({track, quality: '320', downloadCover: false, downloadLyrics: false});
    await vi.waitFor(() => expect(manager.snapshot().tasks[0]?.status).toBe('completed'), {timeout: 5000});
    const fileName = manager.snapshot().tasks[0].fileName;
    apiRequest.mockClear(); fetcher.mockClear();
    window.desktop = {resolveDownloadedAudio: (input: Parameters<DesktopBridge['resolveDownloadedAudio']>[0]) => manager.resolveDownloadedAudio(input), resolveOnlineAudio: online} as unknown as DesktopBridge;
    const firstUrl = await resolveTrackUrl(track, '320');
    expect(firstUrl).toMatch(/^xmusic-audio:\/\/track\//);
    expect(online).not.toHaveBeenCalled();
    await manager.clearHistory(); await manager.dispose();
    registry = new AudioRegistry(dataDirectory);
    await registry.load();
    manager = new DownloadManager(options()); await manager.load();
    expect(manager.snapshot().tasks).toEqual([]);
    const restoredUrl = await resolveTrackUrl({...track}, '320');
    expect(restoredUrl).toBe(firstUrl);
    const response = await localAudioResponse(new Request(restoredUrl, {headers: {Range: 'bytes=12-63'}}), registry);
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(12, 64));
    expect(online).not.toHaveBeenCalled();
    expect(apiRequest).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    await unlink(path.join(downloadDirectory, fileName));
    expect(await resolveTrackUrl(track, '320')).toMatch(/^xmusic-online:/);
    expect(online).toHaveBeenCalledOnce();
  } finally {
    await manager.dispose(); delete window.desktop;
    expect(directory.startsWith(artifacts + path.sep)).toBe(true);
    await rm(directory, {recursive: true, force: true});
  }
});
