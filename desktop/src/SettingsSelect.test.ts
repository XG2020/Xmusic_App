// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {SettingsSelect, type SettingsSelectOption} from './SettingsSelect';

const options = [{value: '128', label: '标准 · 128 kbps'}, {value: '320', label: '高清 · 320 kbps'}, {value: 'flac', label: '无损 · FLAC'}];
let root: Root;
let container: HTMLDivElement;
const onChange = vi.fn<(value: string) => void>();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  onChange.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function render({value = '320', disabled = false, choices = options, labelClick}: {
  value?: string; disabled?: boolean; choices?: readonly SettingsSelectOption[]; labelClick?: () => void;
} = {}) {
  await act(async () => root.render(createElement('label', {htmlFor: 'quality', onClick: labelClick}, '音质',
    createElement(SettingsSelect, {id: 'quality', label: '音质', value, options: choices, onChange, disabled}))));
}
const control = () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
const list = () => document.querySelector<HTMLDivElement>('[role="listbox"]');
const option = (index: number) => list()!.querySelectorAll<HTMLDivElement>('[role="option"]')[index];
const activeOption = () => document.getElementById(control().getAttribute('aria-activedescendant')!);
async function open() {await act(async () => {control().focus(); control().click();});}
async function key(name: string) {
  const event = new KeyboardEvent('keydown', {key: name, bubbles: true, cancelable: true});
  await act(async () => control().dispatchEvent(event));
  return event;
}

it('links the focused combobox to a portalled listbox and tracks active and selected options separately', async () => {
  await render(); await open();
  expect(control().id).toBe('quality');
  expect(control().textContent).toBe('高清 · 320 kbps');
  expect(control().getAttribute('aria-expanded')).toBe('true');
  expect(control().getAttribute('aria-controls')).toBe(list()!.id);
  expect(list()!.parentElement).toBe(document.body);
  expect(document.activeElement).toBe(control());
  expect(activeOption()).toBe(option(1));
  expect(option(1).getAttribute('aria-selected')).toBe('true');
  await key('ArrowDown');
  expect(activeOption()).toBe(option(2));
  expect(option(1).getAttribute('aria-selected')).toBe('true');
  expect(onChange).not.toHaveBeenCalled();
});

it('opens from the keyboard, clamps arrows, supports Home and End, and selects only on Enter or Space', async () => {
  await render();
  await act(async () => control().focus());
  const pageShortcut = vi.fn();
  window.addEventListener('keydown', pageShortcut);
  try {
    expect((await key('ArrowDown')).defaultPrevented).toBe(true);
    expect(activeOption()).toBe(option(1));
    await key('End'); await key('ArrowDown');
    expect(activeOption()).toBe(option(2));
    await key('Home'); await key('ArrowUp');
    expect(activeOption()).toBe(option(0));
    expect(onChange).not.toHaveBeenCalled();
    await key('Enter');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('128');
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(control());
    onChange.mockClear();
    await key(' '); await key('End'); await key(' ');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('flac');
    expect(list()).toBeNull();
    expect(pageShortcut).not.toHaveBeenCalled();
  } finally {window.removeEventListener('keydown', pageShortcut);}
});

it('Escape cancels without selecting while Tab closes without preventing normal focus movement', async () => {
  await render(); await open(); await key('Home');
  expect((await key('Escape')).defaultPrevented).toBe(true);
  expect(list()).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  await open();
  expect((await key('Tab')).defaultPrevented).toBe(false);
  expect(list()).toBeNull();
  expect(control().hasAttribute('aria-activedescendant')).toBe(false);
  expect(control().hasAttribute('aria-controls')).toBe(false);
});

it('selecting an option keeps focus and does not bubble a second click into an enclosing settings label', async () => {
  const labelClick = vi.fn();
  await render({labelClick}); await open();
  labelClick.mockClear();
  const triggerClick = vi.fn();
  control().addEventListener('click', triggerClick);
  const selected = option(0);
  const down = new MouseEvent('mousedown', {bubbles: true, cancelable: true});
  await act(async () => {selected.dispatchEvent(down); selected.click();});
  expect(down.defaultPrevented).toBe(true);
  expect(onChange).toHaveBeenCalledExactlyOnceWith('128');
  expect(labelClick).not.toHaveBeenCalled();
  expect(triggerClick).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(control());
  expect(list()).toBeNull();
});

it('clicking the current value closes without issuing a redundant change', async () => {
  await render(); await open();
  await act(async () => option(1).click());
  expect(onChange).not.toHaveBeenCalled();
  expect(list()).toBeNull();
});

it('disabled and empty controls cannot open, and disabling an open control closes it permanently', async () => {
  await render({disabled: true});
  expect(control().disabled).toBe(true);
  await open(); await key('ArrowDown'); await key('Enter');
  expect(list()).toBeNull(); expect(onChange).not.toHaveBeenCalled();
  await render(); await open();
  expect(list()).not.toBeNull();
  await render({disabled: true});
  expect(list()).toBeNull();
  await render();
  expect(list()).toBeNull();
  await render({choices: []});
  expect(control().disabled).toBe(true);
  await key(' ');
  expect(list()).toBeNull();
});

it('keeps the active descendant valid when available options change while open', async () => {
  await render(); await open(); await key('End');
  await render({value: '128', choices: options.slice(0, 1)});
  expect(activeOption()).toBe(option(0));
  expect(option(0).getAttribute('aria-selected')).toBe('true');
  await render({choices: []});
  expect(list()).toBeNull();
});

it('dismisses on outside pointer, focus loss, viewport resize and ancestor scrolling but allows the list to scroll', async () => {
  await render(); await open();
  await act(async () => list()!.dispatchEvent(new Event('scroll')));
  expect(list()).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', {bubbles: true})));
  expect(list()).toBeNull();
  await open();
  const outside = document.createElement('button'); container.append(outside);
  await act(async () => outside.focus());
  expect(list()).toBeNull();
  await open();
  await act(async () => window.dispatchEvent(new Event('resize')));
  expect(list()).toBeNull();
  await open();
  vi.spyOn(control(), 'getBoundingClientRect').mockReturnValue({left: 0, top: -40, right: 0, bottom: -40, width: 0, height: 0} as DOMRect);
  await act(async () => container.dispatchEvent(new Event('scroll')));
  expect(list()).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

it('ignores the delayed scroll event from bringing the trigger into view but closes on subsequent page movement', async () => {
  await render();
  let top = 400;
  vi.spyOn(control(), 'getBoundingClientRect').mockImplementation(() => ({left: 100, top, right: 300, bottom: top + 40, width: 200, height: 40} as DOMRect));
  container.scrollTop = 300;
  await open();
  await act(async () => container.dispatchEvent(new Event('scroll')));
  expect(list()).not.toBeNull();
  expect(control().getAttribute('aria-expanded')).toBe('true');
  await act(async () => option(0).click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith('128');
  await open();
  top = 360;
  container.scrollTop = 340;
  await act(async () => container.dispatchEvent(new Event('scroll')));
  expect(list()).toBeNull();
});

it('keeps the active option visible by scrolling only the positioned popup', async () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable: true, value: scrollIntoView});
  const rect = (top: number, height: number) => ({left: 100, top, right: 300, bottom: top + height, width: 200, height} as DOMRect);
  try {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function(this: HTMLElement) {return this.getAttribute('role') === 'listbox' ? 80 : 0;});
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) {return this.getAttribute('role') === 'listbox' ? 80 : 36;});
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      if (this.getAttribute('role') === 'combobox') return rect(200, 40);
      if (this.getAttribute('role') === 'listbox') return rect(parseFloat(this.style.top) || 0, 80);
      if (this.getAttribute('role') === 'option') {
        const parent = this.parentElement!;
        const index = [...parent.children].indexOf(this);
        return rect((parseFloat(parent.style.top) || 0) + 5 + index * 36 - parent.scrollTop, 36);
      }
      return rect(0, 0);
    });
    await render({value: 'flac'});
    container.scrollTop = 300;
    await open();
    expect(list()!.style.visibility).toBe('visible');
    expect(list()!.scrollTop).toBe(33);
    await act(async () => list()!.dispatchEvent(new Event('scroll')));
    expect(list()).not.toBeNull();
    await key('Home');
    expect(list()!.scrollTop).toBe(5);
    await key('End');
    expect(list()!.scrollTop).toBe(33);
    expect(container.scrollTop).toBe(300);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(activeOption()).toBe(option(2));
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
});

it('measures wrapped options at the final width and keeps a tall popup above the trigger within viewport edges', async () => {
  vi.stubGlobal('innerWidth', 320); vi.stubGlobal('innerHeight', 240);
  await render();
  vi.spyOn(control(), 'getBoundingClientRect').mockReturnValue({left: 270, top: 190, right: 470, bottom: 230, width: 200, height: 40} as DOMRect);
  const widths: string[] = [];
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function(this: HTMLElement) {
    if (!this.matches('[role="listbox"]')) return 0;
    widths.push(this.style.width);
    return this.style.width === '200px' ? 220 : 80;
  });
  await open();
  expect(widths).toEqual(['200px']);
  expect(list()!.style.width).toBe('200px');
  expect(list()!.style.left).toBe('112px');
  expect(list()!.style.top).toBe('8px');
  expect(list()!.style.maxHeight).toBe('176px');
  expect(list()!.style.visibility).toBe('visible');
});

it('uses available space below the trigger and shrinks wide popups for a narrow viewport', async () => {
  vi.stubGlobal('innerWidth', 160); vi.stubGlobal('innerHeight', 300);
  await render();
  vi.spyOn(control(), 'getBoundingClientRect').mockReturnValue({left: 0, top: 10, right: 200, bottom: 50, width: 200, height: 40} as DOMRect);
  await open();
  expect(list()!.style.width).toBe('144px');
  expect(list()!.style.left).toBe('8px');
  expect(list()!.style.top).toBe('56px');
  expect(Number.parseFloat(list()!.style.maxHeight)).toBeLessThanOrEqual(236);
});
