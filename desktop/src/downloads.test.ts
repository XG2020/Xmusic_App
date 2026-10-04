// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {useDownloads, type DownloadBridge, type DownloadsController, type DownloadSnapshot, type DownloadTask} from './downloads';
import {resolveTrackById} from './services/musicApi';
import type {DesktopBridge, Track} from './types';

vi.mock('./services/musicApi', () => ({resolveTrackById: vi.fn()}));
const track: Track = {key: 'online:one', mid: 'one', title: '歌曲', artist: '歌手', source: 'online'};
const task: DownloadTask = {id: 'task-one', track, quality: 'flac', status: 'downloading', receivedBytes: 500, directory: 'D:/Music', imported: false, createdAt: 1};
let root: Root;
let container: HTMLDivElement;
let controller: DownloadsController;
let onChanged: (snapshot: DownloadSnapshot) => void;
const onError = vi.fn();
const onImported = vi.fn();
const onRemovedLocalIds = vi.fn();
const bridge = {
  getDownloads: vi.fn<DownloadBridge['getDownloads']>(), startDownload: vi.fn<DownloadBridge['startDownload']>(),
  cancelDownload: vi.fn<DownloadBridge['cancelDownload']>(), retryDownload: vi.fn<DownloadBridge['retryDownload']>(),
  pauseDownload: vi.fn<DownloadBridge['pauseDownload']>(), resumeDownload: vi.fn<DownloadBridge['resumeDownload']>(),
  redownload: vi.fn<DownloadBridge['redownload']>(), removeDownload: vi.fn<DownloadBridge['removeDownload']>(),
  selectDownloadDirectory: vi.fn<DownloadBridge['selectDownloadDirectory']>(), openDownloadDirectory: vi.fn<DownloadBridge['openDownloadDirectory']>(),
  importDownload: vi.fn<DownloadBridge['importDownload']>(), clearDownloadHistory: vi.fn<DownloadBridge['clearDownloadHistory']>(),
  onDownloadsChanged: vi.fn<DownloadBridge['onDownloadsChanged']>(),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  window.desktop = bridge as unknown as DesktopBridge;
  bridge.getDownloads.mockResolvedValue({directory: 'D:/Music', tasks: [task]});
  bridge.onDownloadsChanged.mockImplementation(listener => {onChanged = listener; return vi.fn();});
  bridge.startDownload.mockImplementation(async request => ({...task, ...request, id: 'new-task'}));
  vi.mocked(resolveTrackById).mockImplementation(async value => value);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktop;
  vi.unstubAllGlobals();
});

function Harness() {
  controller = useDownloads({baseUrl: 'https://music.example', onError, onImported, onRemovedLocalIds});
  return null;
}
async function mount() {await act(async () => root.render(createElement(Harness)));}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}

it('defaults to mobile lossless/cover/lyrics choices and persists them independently from playback quality', async () => {
  localStorage.setItem('xmusic:quality', '"128"');
  await mount();
  expect(controller.downloadQuality).toBe('flac');
  expect(controller.downloadCover).toBe(true);
  expect(controller.downloadLyrics).toBe(true);
  await act(async () => {await controller.start(track);});
  expect(bridge.startDownload).toHaveBeenLastCalledWith({track, quality: 'flac', baseUrl: 'https://music.example', downloadCover: true, downloadLyrics: true});
  await act(async () => {controller.setDownloadQuality('320'); controller.setDownloadCover(false); controller.setDownloadLyrics(false);});
  await act(async () => {await controller.start(track);});
  expect(bridge.startDownload).toHaveBeenLastCalledWith({track, quality: '320', baseUrl: 'https://music.example', downloadCover: false, downloadLyrics: false});
  expect(localStorage.getItem('xmusic:quality')).toBe('"128"');
  await act(async () => root.render(null));
  await mount();
  expect(controller.downloadQuality).toBe('320');
  expect(controller.downloadCover).toBe(false);
  expect(controller.downloadLyrics).toBe(false);
});

it('uses real pause/resume/redownload APIs, prevents duplicate operations and preserves old jobs when a new task is returned', async () => {
  await mount();
  const paused = deferred<DownloadTask>();
  bridge.pauseDownload.mockReturnValue(paused.promise);
  let pauseRequest!: ReturnType<DownloadsController['pause']>;
  await act(async () => {pauseRequest = controller.pause(task.id); await controller.pause(task.id);});
  expect(bridge.pauseDownload).toHaveBeenCalledTimes(1);
  expect(controller.pendingTaskIds.has(task.id)).toBe(true);
  await act(async () => {paused.resolve({...task, status: 'paused'}); await pauseRequest;});
  expect(controller.tasks[0].status).toBe('paused');
  expect(controller.pendingTaskIds.size).toBe(0);
  bridge.resumeDownload.mockResolvedValue({...task, status: 'queued', receivedBytes: 0});
  await act(async () => {await controller.resume(task.id);});
  expect(bridge.resumeDownload).toHaveBeenCalledWith(task.id);
  expect(controller.tasks[0]).toMatchObject({status: 'queued', receivedBytes: 0});
  bridge.redownload.mockResolvedValue({...task, id: 'new-copy', status: 'queued', receivedBytes: 0});
  await act(async () => {await controller.redownload(task.id);});
  expect(bridge.redownload).toHaveBeenCalledWith(task.id);
  expect(controller.tasks.map(item => item.id)).toEqual(['new-copy', 'task-one']);
});

it('passes the explicit deletion choice and reports removed local IDs for App cleanup', async () => {
  await mount();
  bridge.removeDownload.mockResolvedValueOnce({snapshot: {directory: 'D:/Music', tasks: []}, removedLocalIds: []});
  await act(async () => {await controller.removeTask(task.id, false);});
  expect(bridge.removeDownload).toHaveBeenLastCalledWith({id: task.id, deleteFiles: false});
  expect(onRemovedLocalIds).not.toHaveBeenCalled();
  bridge.removeDownload.mockResolvedValueOnce({snapshot: {directory: 'D:/Music', tasks: []}, removedLocalIds: ['local-one', 'local-two']});
  await act(async () => {await controller.removeTask(task.id, true);});
  expect(bridge.removeDownload).toHaveBeenLastCalledWith({id: task.id, deleteFiles: true});
  expect(onRemovedLocalIds).toHaveBeenCalledWith(['local-one', 'local-two']);
  expect(controller.tasks).toEqual([]);
});

it('keeps the latest native snapshot when an initial read or action reply arrives late', async () => {
  const initial = deferred<DownloadSnapshot>();
  bridge.getDownloads.mockReturnValue(initial.promise);
  await mount();
  await act(async () => {onChanged({directory: 'D:/New', tasks: [{...task, status: 'completed'}]});});
  await act(async () => {initial.resolve({directory: 'D:/Old', tasks: []});});
  expect(controller.directory).toBe('D:/New');
  const response = deferred<DownloadTask>();
  bridge.redownload.mockReturnValue(response.promise);
  let request!: ReturnType<DownloadsController['redownload']>;
  await act(async () => {request = controller.redownload(task.id);});
  await act(async () => {onChanged({directory: 'D:/New', tasks: [{...task, id: 'new-copy', status: 'completed'}]});});
  await act(async () => {response.resolve({...task, id: 'new-copy', status: 'queued'}); await request;});
  expect(controller.tasks[0].status).toBe('completed');
});

it('surfaces action errors, releases pending state and leaves failed deletion records available for retry', async () => {
  await mount();
  bridge.removeDownload.mockRejectedValue(new Error('文件正在被占用'));
  await act(async () => {expect(await controller.removeTask(task.id, true)).toBeUndefined();});
  expect(controller.error).toBe('文件正在被占用');
  expect(onError).toHaveBeenCalledWith('文件正在被占用');
  expect(controller.pendingTaskIds.size).toBe(0);
  expect(controller.tasks).toEqual([task]);
  expect(onRemovedLocalIds).not.toHaveBeenCalled();
});
