// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import DownloadManagerView, {DownloadSettings} from './DownloadManagerView';
import type {DownloadRemovalResult, DownloadsController, DownloadTask} from './downloads';

let root: Root;
let container: HTMLDivElement;
let showModalDescriptor: PropertyDescriptor | undefined;
let closeDescriptor: PropertyDescriptor | undefined;
const baseTask: DownloadTask = {id: 'one', track: {key: 'online:one', mid: 'one', title: '歌曲', artist: '歌手', source: 'online'},
  quality: 'flac', status: 'completed', receivedBytes: 1000, directory: 'D:/Music', fileName: '歌曲.flac', coverFileName: '歌曲.jpg', lyricsFileName: '歌曲.lrc', imported: false, createdAt: 1};

function makeController(tasks: DownloadTask[] = [baseTask]): DownloadsController {
  return {directory: 'D:/Music', tasks, loading: false, error: '', clearError: vi.fn(), pendingTaskIds: new Set(),
    downloadQuality: 'flac', setDownloadQuality: vi.fn(), downloadCover: true, setDownloadCover: vi.fn(), downloadLyrics: true, setDownloadLyrics: vi.fn(),
    start: vi.fn().mockResolvedValue(baseTask), cancel: vi.fn().mockResolvedValue(undefined), retry: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(undefined), redownload: vi.fn().mockResolvedValue(undefined),
    removeTask: vi.fn().mockResolvedValue({snapshot: {directory: 'D:/Music', tasks: []}, removedLocalIds: []}),
    selectDirectory: vi.fn().mockResolvedValue(undefined), openDirectory: vi.fn().mockResolvedValue(undefined),
    importTrack: vi.fn().mockResolvedValue(undefined), clearHistory: vi.fn().mockResolvedValue(undefined)};
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  showModalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable: true, value() {this.setAttribute('open', '');}});
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable: true, value() {this.removeAttribute('open');}});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (showModalDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModalDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (closeDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'close', closeDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  vi.unstubAllGlobals();
});

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLButtonElement).click());
}
function button(text: string, parent: ParentNode = document): HTMLButtonElement | undefined {
  return [...parent.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text);
}
function deleteChoice(text: string) {
  return [...document.querySelectorAll('.download-delete-dialog strong')].find(item => item.textContent === text)?.closest('button');
}
async function openDelete() {
  await click(document.querySelector('[aria-label="更多下载操作 歌曲"]'));
  await click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === '删除下载…'));
}

it('offers independent quality, cover and lyrics controls using the shared settings switches', async () => {
  const controller = makeController();
  await act(async () => root.render(createElement(DownloadSettings, {controller})));
  const select = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="默认下载音质"]')!;
  expect(select.textContent).toBe('无损 · FLAC');
  await click(select);
  await click([...document.querySelectorAll('[role="option"]')].find(item => item.textContent === '高清 · 320 kbps'));
  expect(controller.setDownloadQuality).toHaveBeenCalledWith('320');
  const cover = container.querySelector('[aria-label="下载时同时下载封面"]');
  const lyrics = container.querySelector('[aria-label="下载时同时下载歌词"]');
  expect(cover?.getAttribute('role')).toBe('switch');
  expect(lyrics?.getAttribute('aria-checked')).toBe('true');
  await click(cover);
  expect(controller.setDownloadCover).toHaveBeenCalledWith(false);
  expect(controller.setDownloadLyrics).not.toHaveBeenCalled();
  await click(lyrics);
  expect(controller.setDownloadLyrics).toHaveBeenCalledWith(false);
});

it('exposes actual pause/resume/redownload actions and separate attachment warnings', async () => {
  const active = {...baseTask, id: 'active', status: 'downloading' as const};
  const paused = {...baseTask, id: 'paused', status: 'paused' as const, track: {...baseTask.track, title: '暂停歌曲'}};
  const complete = {...baseTask, id: 'complete', track: {...baseTask.track, title: '完成歌曲'}, attachmentWarnings: ['歌词暂时无法保存']};
  const controller = makeController([active, paused, complete]);
  await act(async () => root.render(createElement(DownloadManagerView, {controller})));
  await click(container.querySelector('[aria-label="暂停下载 歌曲"]'));
  expect(controller.pause).toHaveBeenCalledWith('active');
  await click(container.querySelector('[aria-label="恢复下载 暂停歌曲"]'));
  expect(controller.resume).toHaveBeenCalledWith('paused');
  expect(container.querySelector('.download-paused')?.textContent).toContain('恢复时从头下载');
  await click(button('重新下载', container.querySelector('.download-completed')!));
  expect(controller.redownload).toHaveBeenCalledWith('complete');
  expect(controller.retry).not.toHaveBeenCalled();
  expect(container.querySelector('.download-completed .download-attachment-warning')?.textContent).toBe('歌词暂时无法保存');
  expect(container.querySelector('.download-completed .download-attachments')?.textContent).toContain('封面已保存');
});

it('deletes nothing until the themed dialog receives an explicit record-only or file deletion choice', async () => {
  const controller = makeController();
  await act(async () => root.render(createElement(DownloadManagerView, {controller})));
  await openDelete();
  expect(document.querySelector('dialog[open]')?.textContent).toContain('歌曲.flac');
  expect(document.activeElement?.textContent).toBe('取消');
  expect(controller.removeTask).not.toHaveBeenCalled();
  await click(deleteChoice('仅删除记录'));
  expect(controller.removeTask).toHaveBeenLastCalledWith('one', false);
  expect(document.querySelector('dialog')).toBeNull();
  await openDelete();
  await click(deleteChoice('同时删除音频、封面和歌词'));
  expect(controller.removeTask).toHaveBeenLastCalledWith('one', true);
  expect(document.querySelector('dialog')).toBeNull();
});

it('keeps pending deletion disabled, blocks dismissal until it finishes, and retains a failed dialog for retry', async () => {
  const controller = makeController();
  let resolve!: (value: DownloadRemovalResult | undefined) => void;
  vi.mocked(controller.removeTask).mockReturnValueOnce(new Promise(done => {resolve = done;}));
  await act(async () => root.render(createElement(DownloadManagerView, {controller})));
  await openDelete();
  await click(deleteChoice('同时删除音频、封面和歌词'));
  expect(document.querySelector('dialog')?.getAttribute('aria-busy')).toBe('true');
  expect((deleteChoice('仅删除记录') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
  expect(document.querySelector('dialog')).not.toBeNull();
  await act(async () => resolve(undefined));
  expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('删除未完成');
  vi.mocked(controller.removeTask).mockRejectedValueOnce(new Error('文件正在被占用'));
  await click(deleteChoice('同时删除音频、封面和歌词'));
  expect(document.querySelector('dialog [role="alert"]')?.textContent).toBe('文件正在被占用');
  await click(button('取消', document.querySelector('dialog')!));
  expect(document.querySelector('dialog')).toBeNull();
});

it('keeps paused work out of the clear-history action', async () => {
  const controller = makeController([{...baseTask, status: 'paused'}]);
  await act(async () => root.render(createElement(DownloadManagerView, {controller})));
  expect(button('清除下载记录')?.disabled).toBe(true);
  expect(container.querySelector('.downloads-heading')?.textContent).toContain('1 首已暂停');
});
