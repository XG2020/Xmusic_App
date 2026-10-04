'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {EventEmitter} = require('node:events');
const {JSDOM} = require('jsdom');
const {TrayMenu, menuBounds} = require('./tray-menu.cjs');

function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.bounds = {...options}; this.visible = false; this.destroyed = false; this.focusCount = 0;
    this.messages = [];
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = {url: ''};
    this.webContents.send = (channel, value) => this.messages.push({channel, value});
    this.webContents.setWindowOpenHandler = callback => {this.openHandler = callback;};
  }
  isDestroyed() {return this.destroyed;}
  loadFile(filePath) {this.webContents.mainFrame.url = pathToFileURL(filePath).href; return Promise.resolve();}
  setBounds(bounds) {this.bounds = {...bounds};}
  show() {this.visible = true;}
  focus() {this.focusCount++;}
  hide() {this.visible = false;}
  destroy() {this.destroyed = true; this.visible = false; this.emit('closed');}
}
function fixture(options = {}) {
  const commands = [];
  const screen = {getCursorScreenPoint: () => ({x: 1910, y: 1060}),
    getDisplayNearestPoint: () => ({workArea: {x: 0, y: 0, width: 1920, height: 1040}})};
  const menu = new TrayMenu({BrowserWindow: FakeWindow, screen, onCommand: (action, value) => commands.push({action, value}), ...options});
  return {menu, commands, screen};
}

test('tray popup is lazy, frameless, absent from the taskbar and clamps to the monitor at the tray', async () => {
  const {menu} = fixture();
  menu.update({playing: true, visible: true, title: '晚风'});
  assert.equal(menu.window, null);
  assert.equal(await menu.show(), true);
  const window = menu.window;
  assert.equal(window.options.skipTaskbar, true); assert.equal(window.options.frame, false); assert.equal(window.options.resizable, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.deepEqual(window.bounds, {x: 1668, y: 712, width: 252, height: 328});
  assert.equal(window.visible, true); assert.equal(window.focusCount, 1);
  assert.deepEqual(window.messages.at(-1), {channel: 'tray-menu:snapshot', value: {playing: true, visible: true, title: '晚风',
    artist: '', favorite: false, volume: 0.75, muted: false, hasTrack: false, hasQueue: false}});
  await menu.show(); assert.equal(menu.window, window);
  assert.deepEqual(menuBounds({x: -1200, y: 20}, {x: -1280, y: 0, width: 1280, height: 720}), {x: -1280, y: 28, width: 252, height: 328});
  assert.deepEqual(menuBounds({x: 9999, y: 9999}, {x: 10, y: 20, width: 180, height: 100}), {x: 10, y: 20, width: 180, height: 100});
  menu.dispose();
});

test('blur and dismiss commands hide the popup; playback controls keep it open; untrusted frames are rejected', async () => {
  const {menu, commands} = fixture(); await menu.show();
  const window = menu.window;
  window.emit('blur'); assert.equal(window.visible, false);
  await menu.show();
  let prevented = 0;
  window.emit('close', {preventDefault() {prevented++;}});
  assert.equal(prevented, 1); assert.equal(window.visible, false); assert.equal(window.destroyed, false);
  for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.emit(event, {preventDefault() {prevented++;}});
  assert.equal(prevented, 4); assert.deepEqual(window.openHandler(), {action: 'deny'});
  const sender = {sender: window.webContents, senderFrame: window.webContents.mainFrame};
  assert.equal(menu.trusted(sender), true);
  assert.equal(menu.trusted({...sender, sender: {}}), false);
  assert.equal(menu.trusted({...sender, senderFrame: {url: menu.pageUrl}}), false);
  window.webContents.mainFrame.url += '?arbitrary=1';
  assert.equal(menu.trusted(sender), false);
  window.webContents.mainFrame.url = menu.pageUrl;
  for (const action of ['toggle', 'previous', 'next', 'favorite', 'mute', 'lyrics']) {
    await menu.show(); menu.command(action); assert.equal(window.visible, true);
  }
  menu.command('volume', 0.23); assert.equal(window.visible, true);
  for (const value of [-1, 1.01, NaN, Infinity, '0.5', null, undefined]) {
    assert.throws(() => menu.command('volume', value), /音量无效/);
  }
  for (const action of ['show-main', 'queue', 'quit']) {
    await menu.show(); menu.command(action); assert.equal(window.visible, false);
  }
  menu.command('hide');
  assert.deepEqual(commands, [
    ...['toggle', 'previous', 'next', 'favorite', 'mute', 'lyrics'].map(action => ({action, value: undefined})),
    {action: 'volume', value: 0.23}, ...['show-main', 'queue', 'quit'].map(action => ({action, value: undefined})),
  ]);
  for (const action of ['open-url', 'library:remove', {}, null]) assert.throws(() => menu.command(action), /不支持/);
  menu.dispose(); assert.equal(menu.trusted(sender), false); assert.equal(window.destroyed, true);
  menu.command('quit'); assert.equal(commands.length, 10);
});

test('partial snapshots preserve player state and sanitize metadata and volume', () => {
  const {menu} = fixture();
  menu.update({title: '晚风\u0000', artist: '歌手\n', playing: true, favorite: true, volume: 0.42, muted: true, hasTrack: true, hasQueue: true});
  menu.update({visible: true});
  assert.deepEqual(menu.snapshot(), {title: '晚风', artist: '歌手', playing: true, favorite: true, volume: 0.42, muted: true, hasTrack: true, hasQueue: true, visible: true});
  menu.update({volume: NaN}); assert.equal(menu.snapshot().volume, 0.42);
  menu.update({volume: 2}); assert.equal(menu.snapshot().volume, 1);
  menu.update({volume: -1}); assert.equal(menu.snapshot().volume, 0);
  menu.update({title: {}, artist: null});
  assert.equal(menu.snapshot().title, 'Xmusic'); assert.equal(menu.snapshot().artist, '');
  for (const value of [null, [], 'bad']) assert.throws(() => menu.update(value), /状态无效/);
  const snapshot = menu.snapshot(); snapshot.title = 'changed'; assert.equal(menu.snapshot().title, 'Xmusic');
});

test('a late popup load failure cannot reopen a native fallback after the user dismisses it', async () => {
  const gate = deferred();
  class LoadingWindow extends FakeWindow {loadFile() {return gate.promise;}}
  const {menu} = fixture({BrowserWindow: LoadingWindow});
  const pending = menu.show();
  menu.hide();
  gate.reject(new Error('Renderer failed after restoring the main window'));
  assert.equal(await pending, true, 'the superseded show must remain dismissed, including on load failure');
  assert.equal(menu.window, null);
  menu.dispose();
});

test('hiding or disposing during load prevents a delayed popup and failed loads can fall back then retry', async () => {
  const gate = deferred();
  class LoadingWindow extends FakeWindow {loadFile() {return gate.promise;}}
  const {menu} = fixture({BrowserWindow: LoadingWindow});
  const showing = menu.show(); const window = menu.window;
  menu.hide(); gate.resolve();
  assert.equal(await showing, true, 'an intentionally hidden popup should not summon a native fallback');
  assert.equal(window.visible, false);
  assert.equal(await menu.show(), true); assert.equal(window.visible, true);
  menu.dispose();
  const pending = deferred();
  class DisposedWindow extends FakeWindow {loadFile() {return pending.promise;}}
  const disposed = fixture({BrowserWindow: DisposedWindow}).menu;
  const loading = disposed.show(); const closed = disposed.window;
  disposed.dispose(); pending.resolve();
  assert.equal(await loading, false); assert.equal(closed.visible, false); assert.equal(closed.destroyed, true);
  let fail = true;
  class FailedWindow extends FakeWindow {loadFile() {return fail ? Promise.reject(new Error('Missing renderer')) : Promise.resolve();}}
  const recovered = fixture({BrowserWindow: FailedWindow}).menu;
  assert.equal(await recovered.show(), false); assert.equal(recovered.window, null);
  fail = false; assert.equal(await recovered.show(), true);
  const crashed = recovered.window;
  crashed.webContents.emit('render-process-gone');
  assert.equal(crashed.destroyed, true); assert.equal(await recovered.show(), true);
  assert.notEqual(recovered.window, crashed); recovered.dispose();
});

test('renderer tracks playback, favorites, mute and lyrics without interpreting metadata as HTML', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'tray-menu.html'), 'utf8');
  const dom = new JSDOM(html, {runScripts: 'outside-only'});
  const {window} = dom;
  const style = window.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, 'tray-menu.css'), 'utf8');
  window.document.head.append(style);
  const snapshot = deferred();
  const commands = [];
  let notify, unsubscribed = false;
  window.trayMenu = {getSnapshot: () => snapshot.promise, onSnapshot(listener) {notify = listener; return () => {unsubscribed = true;};}, command: (action, value) => commands.push({action, value})};
  window.eval(fs.readFileSync(path.join(__dirname, 'tray-menu.js'), 'utf8'));
  const toggle = window.document.getElementById('toggle');
  const favorite = window.document.getElementById('favorite');
  const volume = window.document.getElementById('volume');
  assert.equal(window.getComputedStyle(window.document.body).userSelect, 'none');
  assert.equal(toggle.disabled, true); assert.equal(favorite.disabled, true);
  const state = {playing: true, visible: true, title: '<img src=x onerror=bad>', artist: '<b>artist</b>', favorite: true,
    volume: 0.42, muted: false, hasTrack: true, hasQueue: true};
  notify(state);
  snapshot.resolve({playing: false, visible: false, title: 'old snapshot'}); await Promise.resolve();
  assert.equal(window.document.getElementById('song-title').textContent, '<img src=x onerror=bad>');
  assert.equal(window.document.querySelector('img'), null);
  assert.equal(window.document.getElementById('song-artist').textContent, '<b>artist</b>');
  assert.equal(window.document.querySelector('b'), null);
  assert.equal(toggle.getAttribute('aria-label'), '暂停');
  assert.equal(toggle.disabled, false); assert.equal(toggle.dataset.playing, 'true');
  assert.equal(favorite.getAttribute('aria-pressed'), 'true'); assert.equal(favorite.disabled, false);
  assert.deepEqual([...window.document.querySelectorAll('.playback-controls button')].map(button => button.getAttribute('aria-label')), ['上一首', '暂停', '下一首']);
  assert.equal(window.getComputedStyle(toggle.querySelector('.icon-play')).display, 'none');
  assert.equal(window.getComputedStyle(toggle.querySelector('.icon-pause')).display, 'block');
  assert.equal(window.document.getElementById('lyrics').getAttribute('aria-checked'), 'true');
  assert.equal(volume.value, '42'); assert.equal(volume.getAttribute('aria-valuetext'), '42%');
  window.dispatchEvent(new window.Event('focus'));
  assert.equal(window.document.activeElement, toggle);
  window.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'ArrowDown', cancelable: true}));
  assert.equal(window.document.activeElement.dataset.command, 'next');
  window.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'End', cancelable: true}));
  assert.equal(window.document.activeElement.dataset.command, 'quit');
  toggle.click(); favorite.click(); window.document.getElementById('mute').click();
  notify({...state, playing: false, visible: false, favorite: false, title: '晚风', artist: '', muted: true});
  assert.equal(toggle.getAttribute('aria-label'), '播放'); assert.equal(toggle.dataset.playing, 'false');
  assert.equal(window.getComputedStyle(toggle.querySelector('.icon-pause')).display, 'none');
  assert.equal(window.document.getElementById('song-artist').hidden, true);
  assert.equal(favorite.getAttribute('aria-pressed'), 'false');
  assert.equal(window.document.getElementById('mute').getAttribute('aria-label'), '取消静音');
  assert.equal(volume.value, '0');
  volume.focus();
  for (const key of ['ArrowDown', 'ArrowRight', 'Home', 'End']) {
    const event = new window.KeyboardEvent('keydown', {key, cancelable: true, bubbles: true});
    volume.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, `native slider behavior for ${key} must remain available`);
    assert.equal(window.document.activeElement, volume);
  }
  volume.value = '65'; volume.dispatchEvent(new window.Event('input'));
  assert.equal(volume.getAttribute('aria-valuetext'), '65%');
  assert.equal(volume.style.getPropertyValue('--volume-fill'), '65%');
  volume.dispatchEvent(new window.Event('pointerdown'));
  notify({...state, volume: 0.15}); assert.equal(volume.value, '65', 'a delayed snapshot must not move the thumb during a drag');
  window.dispatchEvent(new window.Event('pointerup'));
  notify({...state, volume: 0.65}); assert.equal(volume.value, '65');
  const escape = new window.KeyboardEvent('keydown', {key: 'Escape', cancelable: true});
  window.dispatchEvent(escape); assert.equal(escape.defaultPrevented, true);
  assert.deepEqual(commands, [{action: 'toggle', value: undefined}, {action: 'favorite', value: undefined},
    {action: 'mute', value: undefined}, {action: 'volume', value: 0.65}, {action: 'hide', value: undefined}]);
  notify({...state, hasTrack: false, hasQueue: false});
  toggle.click(); favorite.click(); assert.equal(commands.length, 5, 'unavailable track actions stay disabled');
  window.dispatchEvent(new window.Event('unload')); assert.equal(unsubscribed, true);
  window.close();
});
