// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import ClosePrompt from './ClosePrompt';
import type {ClosePromptState, DesktopBridge} from './types';

let container: HTMLDivElement;
let trigger: HTMLButtonElement;
let root: Root;
let publish: (value: ClosePromptState | null) => void;
const getClosePrompt = vi.fn<() => Promise<ClosePromptState | null>>();
const respondToClosePrompt = vi.fn<DesktopBridge['respondToClosePrompt']>();
const unsubscribe = vi.fn();
const showModal = vi.fn(function(this: HTMLDialogElement) {this.setAttribute('open', '');});
const close = vi.fn(function(this: HTMLDialogElement) {this.removeAttribute('open');});
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {resolve = yes;});
  return {promise, resolve};
}
async function render() {await act(async () => root.render(createElement(ClosePrompt)));}
async function open(value: ClosePromptState = {id: 1, canHide: true}) {await act(async () => publish(value));}
async function click(selector: string) {await act(async () => document.querySelector<HTMLButtonElement>(selector)!.click());}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable: true, value: showModal});
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable: true, value: close});
  getClosePrompt.mockResolvedValue(null);
  respondToClosePrompt.mockResolvedValue(null);
  window.desktop = {
    getClosePrompt, respondToClosePrompt,
    onClosePrompt(callback: (value: ClosePromptState | null) => void) {publish = callback; return unsubscribe;},
  } as unknown as DesktopBridge;
  container = document.createElement('div');
  trigger = document.createElement('button');
  trigger.textContent = '关闭窗口';
  document.body.append(trigger, container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); trigger.remove(); delete window.desktop;
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow);
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  vi.unstubAllGlobals();
});

it('restores an outstanding close prompt and submits hide once while preserving focus', async () => {
  getClosePrompt.mockResolvedValue({id: 4, canHide: true});
  const reply = deferred<ClosePromptState | null>();
  respondToClosePrompt.mockReturnValue(reply.promise);
  trigger.focus();
  await render();
  expect(document.querySelector('dialog')?.textContent).toContain('音乐和下载继续');
  expect(document.activeElement).toBe(document.querySelector('.close-prompt-hide'));
  await open({id: 4, canHide: true});
  expect(document.querySelectorAll('dialog')).toHaveLength(1);
  expect(showModal).toHaveBeenCalledTimes(1);
  await click('.close-prompt-hide');
  await click('.close-prompt-hide');
  expect(respondToClosePrompt).toHaveBeenCalledExactlyOnceWith({id: 4, action: 'hide'});
  expect(document.querySelector('.close-prompt-progress')?.textContent).toContain('正在处理');
  await act(async () => reply.resolve(null));
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('offers exit and cancellation when no tray exists, and defaults focus to cancellation', async () => {
  await render();
  await open({id: 3, canHide: false});
  expect(document.querySelector('.close-prompt-hide')).toBeNull();
  expect(document.querySelector('.close-prompt-notice')?.textContent).toContain('系统托盘不可用');
  expect(document.activeElement?.textContent).toBe('取消');
  await click('.close-prompt-quit');
  expect(respondToClosePrompt).toHaveBeenCalledWith({id: 3, action: 'quit'});
  expect(document.querySelector('dialog')).toBeNull();
});

it('keeps keyboard focus inside the prompt, cancels on Escape and prevents background shortcuts', async () => {
  const backgroundKey = vi.fn();
  window.addEventListener('keydown', backgroundKey);
  try {
    await render(); await open();
    const first = document.querySelector<HTMLButtonElement>('.close-prompt-header button')!;
    const last = document.querySelector<HTMLButtonElement>('.close-prompt footer button')!;
    last.focus();
    await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true})));
    expect(document.activeElement).toBe(first);
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', shiftKey: true, bubbles: true, cancelable: true})));
    expect(document.activeElement).toBe(last);
    await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', code: 'Space', bubbles: true})));
    expect(backgroundKey).not.toHaveBeenCalled();
    await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})));
    expect(respondToClosePrompt).toHaveBeenCalledWith({id: 1, action: 'cancel'});
    expect(document.querySelector('dialog')).toBeNull();
  } finally {window.removeEventListener('keydown', backgroundKey);}
});

it('cancels from the backdrop, cancel button, close icon and native cancel event', async () => {
  await render();
  for (const selector of ['dialog', '.close-prompt footer button', '.close-prompt-header button']) {
    await open(); await click(selector);
    expect(document.querySelector('dialog')).toBeNull();
  }
  await open();
  const event = new Event('cancel', {cancelable: true});
  await act(async () => document.querySelector('dialog')!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(respondToClosePrompt).toHaveBeenCalledTimes(4);
  expect(respondToClosePrompt.mock.calls.every(([value]) => value.action === 'cancel')).toBe(true);
});

it('ignores stale startup reads and old replies after the next prompt has arrived', async () => {
  const snapshot = deferred<ClosePromptState | null>();
  const reply = deferred<ClosePromptState | null>();
  getClosePrompt.mockReturnValue(snapshot.promise);
  respondToClosePrompt.mockReturnValue(reply.promise);
  await render(); await open();
  await act(async () => snapshot.resolve(null));
  expect(document.querySelector('dialog')).not.toBeNull();
  await click('.close-prompt-hide');
  await open({id: 2, canHide: false});
  await act(async () => reply.resolve(null));
  expect(document.querySelector('dialog')).not.toBeNull();
  expect(document.querySelector('.close-prompt-hide')).toBeNull();
  expect(document.querySelector<HTMLButtonElement>('.close-prompt-quit')?.disabled).toBe(false);
});

it('keeps the prompt available after a failed response and a tray disappearing mid-choice', async () => {
  respondToClosePrompt.mockRejectedValueOnce(new Error('请重试'));
  await render(); await open();
  await click('.close-prompt-hide');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('请重试');
  expect(document.querySelector<HTMLButtonElement>('.close-prompt-hide')?.disabled).toBe(false);
  respondToClosePrompt.mockResolvedValueOnce({id: 1, canHide: false});
  await click('.close-prompt-hide');
  expect(document.querySelector('.close-prompt-hide')).toBeNull();
  expect(document.querySelector('.close-prompt-notice')).not.toBeNull();
  respondToClosePrompt.mockResolvedValueOnce(null);
  await click('.close-prompt footer button');
  expect(document.querySelector('dialog')).toBeNull();
});

it('unsubscribes on unmount and runs without an Electron bridge in web previews', async () => {
  await render();
  await act(async () => root.render(null));
  expect(unsubscribe).toHaveBeenCalledOnce();
  delete window.desktop;
  await render();
  expect(document.querySelector('dialog')).toBeNull();
});

it('remembers only a checked hide or quit selection and resets the checkbox for each new prompt', async () => {
  await render(); await open();
  const checkbox = () => document.querySelector<HTMLInputElement>('.close-prompt-remember input')!;
  expect(checkbox().checked).toBe(false);
  await click('.close-prompt-remember input');
  expect(checkbox().checked).toBe(true);
  await click('.close-prompt-hide');
  expect(respondToClosePrompt).toHaveBeenLastCalledWith({id: 1, action: 'hide', remember: true});
  await open({id: 2, canHide: true});
  expect(checkbox().checked).toBe(false);
  await click('.close-prompt-remember input');
  await click('.close-prompt footer button');
  expect(respondToClosePrompt).toHaveBeenLastCalledWith({id: 2, action: 'cancel'});
  await open({id: 3, canHide: false});
  await click('.close-prompt-remember input');
  await click('.close-prompt-quit');
  expect(respondToClosePrompt).toHaveBeenLastCalledWith({id: 3, action: 'quit', remember: true});
});
