// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import BehaviorSettings from './BehaviorSettings';
import {useDesktopPreferences, type DesktopPreferencesState} from './useDesktopPreferences';
import type {DesktopBridge, DesktopPreferences} from './types';

let container: HTMLDivElement;
let root: Root;
let settings: DesktopPreferencesState;
let publish: (value: DesktopPreferences) => void;
let stored: DesktopPreferences;
const getPreferences = vi.fn<() => Promise<DesktopPreferences>>();
const setPreferences = vi.fn<DesktopBridge['setPreferences']>();
const unsubscribe = vi.fn();
function Probe() {settings = useDesktopPreferences(); return createElement(BehaviorSettings, {settings});}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {resolve = yes;});
  return {promise, resolve};
}
async function render() {await act(async () => root.render(createElement(Probe)));}
async function select(value: 'ask' | 'hide' | 'quit') {
  await act(async () => closeAction().click());
  const label = {ask: '每次询问', hide: '隐藏到托盘', quit: '退出软件'}[value];
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === label)!;
  expect(option).toBeTruthy();
  await act(async () => option.click());
}
const closeAction = () => container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="关闭主窗口时"]')!;
const shortcut = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stored = {closeAction: 'ask', shortcutsEnabled: true};
  getPreferences.mockImplementation(async () => stored);
  setPreferences.mockImplementation(async patch => {
    stored = {...stored, ...patch}; publish(stored); return stored;
  });
  window.desktop = {
    getPreferences, setPreferences,
    onPreferencesChanged(callback: (value: DesktopPreferences) => void) {publish = callback; return unsubscribe;},
  } as unknown as DesktopBridge;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); delete window.desktop; vi.unstubAllGlobals();
});

it('edits close behavior and the shortcut switch through persistent partial updates', async () => {
  await render();
  expect(shortcut().getAttribute('aria-checked')).toBe('true');
  await select('hide');
  expect(setPreferences).toHaveBeenLastCalledWith({closeAction: 'hide'});
  expect(closeAction().textContent).toBe('隐藏到托盘');
  await act(async () => shortcut().click());
  expect(setPreferences).toHaveBeenLastCalledWith({shortcutsEnabled: false});
  expect(shortcut().getAttribute('aria-checked')).toBe('false');
  expect(settings.preferences).toEqual({closeAction: 'hide', shortcutsEnabled: false});
  await select('ask');
  expect(settings.preferences).toEqual({closeAction: 'ask', shortcutsEnabled: false});
});

it('uses remembered-choice broadcasts and ignores an older initial preferences response', async () => {
  const snapshot = deferred<DesktopPreferences>();
  getPreferences.mockReturnValue(snapshot.promise);
  await render();
  expect(settings.loading).toBe(true);
  expect(shortcut().disabled).toBe(true);
  await act(async () => publish({closeAction: 'quit', shortcutsEnabled: false}));
  await act(async () => snapshot.resolve({closeAction: 'ask', shortcutsEnabled: true}));
  expect(settings.loading).toBe(false);
  expect(settings.preferences).toEqual({closeAction: 'quit', shortcutsEnabled: false});
  expect(closeAction().textContent).toBe('退出软件');
  expect(shortcut().getAttribute('aria-checked')).toBe('false');
});

it('keeps controls disabled until a save finishes and does not overwrite a newer broadcast with an old save reply', async () => {
  const reply = deferred<DesktopPreferences>();
  setPreferences.mockReturnValue(reply.promise);
  await render();
  await select('hide');
  expect(shortcut().disabled).toBe(true);
  await act(async () => publish({closeAction: 'quit', shortcutsEnabled: false}));
  await act(async () => reply.resolve({closeAction: 'hide', shortcutsEnabled: true}));
  expect(shortcut().disabled).toBe(false);
  expect(settings.preferences).toEqual({closeAction: 'quit', shortcutsEnabled: false});
});

it('shows save failures while retaining the actual setting and supports retry', async () => {
  setPreferences.mockRejectedValueOnce(new Error('设置保存失败'));
  await render(); await select('quit');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('设置保存失败');
  expect(closeAction().textContent).toBe('每次询问');
  expect(shortcut().disabled).toBe(false);
  await select('quit');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(settings.preferences.closeAction).toBe('quit');
  await act(async () => root.render(null));
  expect(unsubscribe).toHaveBeenCalledOnce();
});
