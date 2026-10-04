// @vitest-environment jsdom
import {act, createElement, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ContextMenu} from './ContextMenu';

let root: Root;
let container: HTMLDivElement;
let trigger: HTMLButtonElement;
const choose = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerWidth', 300);
  vi.stubGlobal('innerHeight', 180);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({x: 0, y: 0, top: 0, left: 0, width: 220, height: 120, right: 220, bottom: 120, toJSON() {return {};}});
  choose.mockReset();
  container = document.createElement('div');
  trigger = document.createElement('button');
  trigger.textContent = '原歌曲';
  document.body.append(trigger, container);
  trigger.focus();
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); trigger.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function open() {
  function Probe() {
    const [shown, setShown] = useState(true);
    return shown ? createElement(ContextMenu, {position: {x: 290, y: 170}, onClose: () => setShown(false), items: [
      {id: 'first', label: '播放', onSelect: () => choose('first')},
      {id: 'disabled', label: '暂不可用', disabled: true, onSelect: () => choose('disabled')},
      {id: 'last', label: '移除', danger: true, onSelect: () => choose('last')},
    ]}) : null;
  }
  await act(async () => root.render(createElement(Probe)));
}

it('keeps the menu inside the viewport and navigates only enabled items before restoring focus', async () => {
  await open();
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  expect(menu.style.left).toBe('72px');
  expect(menu.style.top).toBe('52px');
  expect(document.activeElement?.textContent).toBe('播放');
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true})));
  expect(document.activeElement?.textContent).toBe('移除');
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true})));
  expect(document.activeElement?.textContent).toBe('播放');
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true})));
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})));
  expect(choose).toHaveBeenCalledExactlyOnceWith('last');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('closes on Escape without selecting and leaves focus alone after an outside click', async () => {
  await open();
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
  expect(choose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  await act(async () => root.unmount());
  root = createRoot(container);
  await open();
  trigger.focus();
  await act(async () => trigger.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true})));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
