'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {AppLifecycle} = require('./app-lifecycle.cjs');
const {TrayMenu} = require('./tray-menu.cjs');
const {DesktopPreferencesController} = require('./desktop-preferences.cjs');

function event() {return {prevented: false, preventDefault() {this.prevented = true;}};}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

class FakeWindow extends EventEmitter {
  constructor() {
    super(); this.visible = true; this.minimized = false; this.destroyed = false; this.focused = 0; this.hideCount = 0;
    this.messages = [];
    this.webContents = {send: (channel, value) => this.messages.push({channel, value})};
  }
  isDestroyed() {return this.destroyed;}
  isMinimized() {return this.minimized;}
  restore() {this.minimized = false;}
  show() {this.visible = true;}
  focus() {this.focused++;}
  hide() {this.visible = false; this.hideCount++;}
  close() {
    const closeEvent = event();
    this.emit('close', closeEvent);
    if (!closeEvent.prevented) {this.destroyed = true; this.visible = false; this.emit('closed');}
    return closeEvent;
  }
}

function fixture(options = {}) {
  const app = new EventEmitter();
  const state = {window: new FakeWindow(), commands: [], downloaded: 0, shortcuts: 0, trayCreated: 0, trayDestroyed: 0, quitAttempts: 0, exited: 0, menuBuilds: 0, iconReads: []};
  const lyrics = {visible: false, content: {playing: false, title: '歌名'}, disposed: 0,
    setVisible(value) {this.visible = value;}, dispose() {this.disposed++;}};
  const preferences = options.preferences ?? new DesktopPreferencesController();
  class Tray extends EventEmitter {
    constructor(icon) {
      super();
      state.trayCreated++;
      if (options.trayFailure) throw new Error('No system tray');
      this.icon = icon;
      this.destroyed = false;
    }
    isDestroyed() {return this.destroyed;}
    destroy() {if (!this.destroyed) state.trayDestroyed++; this.destroyed = true;}
    setToolTip(value) {this.tooltip = value;}
    setContextMenu(value) {if (options.menuFailure) throw new Error('Tray menu unavailable'); this.menu = value;}
    popUpContextMenu(value) {this.poppedMenu = value;}
  }
  const lifecycle = new AppLifecycle({
    app, Tray, preferences, trayMenu: options.trayMenu,
    Menu: {buildFromTemplate(template) {state.menuBuilds++; return template;}},
    nativeImage: {createFromPath(file) {state.iconReads.push(file); return {file, isEmpty: () => !!options.noIcons || !!options.pngOnly && file.endsWith('.ico')};}},
    getWindow: () => state.window,
    getLyrics: () => lyrics, getPlayerState: options.getPlayerState,
    playback: command => state.commands.push(command),
    disposeDownloads: () => {state.downloaded++; return options.downloads?.promise;},
    unregisterShortcuts: () => {state.shortcuts++;},
    iconPaths: ['/resources/icon.ico', '/resources/icon.png'],
    headless: !!options.headless,
  });
  app.on('before-quit', closeEvent => lifecycle.beforeQuit(closeEvent));
  app.on('will-quit', () => lifecycle.disposeNative());
  app.quit = () => {
    state.quitAttempts++;
    const quitEvent = event();
    app.emit('before-quit', quitEvent);
    if (!quitEvent.prevented) {state.window?.close(); state.exited++; app.emit('will-quit');}
  };
  lifecycle.attachWindow(state.window);
  return {app, state, lyrics, lifecycle, preferences};
}

test('tray uses the shared icon, sends playback commands and follows playback/lyrics state', () => {
  const {state, lifecycle, lyrics} = fixture({pngOnly: true});
  assert.equal(lifecycle.createTray(), true);
  assert.deepEqual(state.iconReads, ['/resources/icon.ico', '/resources/icon.png']);
  assert.equal(lifecycle.tray.icon.file, '/resources/icon.png');
  for (const label of ['播放', '上一首', '下一首']) lifecycle.tray.menu.find(item => item.label === label).click();
  assert.deepEqual(state.commands, ['toggle', 'previous', 'next']);
  lifecycle.tray.menu.find(item => item.label === '桌面歌词').click();
  assert.equal(lyrics.visible, true);
  assert.equal(lifecycle.tray.menu.find(item => item.label === '桌面歌词').checked, true);
  lyrics.content.playing = true;
  lifecycle.refreshTray();
  assert.ok(lifecycle.tray.menu.some(item => item.label === '暂停'));
  const builds = state.menuBuilds;
  lyrics.content.position = 27;
  lifecycle.refreshTray();
  assert.equal(state.menuBuilds, builds, 'progress ticks must not rebuild native menus');
  state.window.minimized = true;
  state.window.visible = false;
  lifecycle.tray.emit('double-click');
  assert.equal(state.window.visible, true);
  assert.equal(state.window.minimized, false);
  assert.equal(state.window.focused, 1);
});

test('a second-instance request during startup is replayed when the main window is ready', () => {
  const {state, lifecycle} = fixture({headless: true});
  const window = state.window;
  state.window = null;
  lifecycle.showMainWindow();
  assert.equal(lifecycle.showRequested, true);
  state.window = window;
  window.visible = false;
  window.minimized = true;
  window.emit('ready-to-show');
  assert.equal(window.visible, true);
  assert.equal(window.minimized, false);
  assert.equal(lifecycle.showRequested, false);
});

test('close choices are shown once and hiding keeps downloads and the renderer alive', () => {
  const {state, lifecycle} = fixture();
  const firstEvent = state.window.close();
  const repeatedEvent = state.window.close();
  assert.equal(firstEvent.prevented, true);
  assert.equal(repeatedEvent.prevented, true);
  assert.equal(state.window.messages.length, 1);
  assert.deepEqual(state.window.messages[0], {channel: 'window:close-prompt', value: {id: 1, canHide: true}});
  assert.deepEqual(lifecycle.getClosePrompt(), {id: 1, canHide: true});
  assert.equal(lifecycle.respondToClosePrompt({id: 1, action: 'hide'}), null);
  assert.equal(state.window.visible, false);
  assert.equal(state.window.destroyed, false);
  assert.equal(state.downloaded, 0);
  assert.equal(state.quitAttempts, 0);
  assert.equal(lifecycle.getClosePrompt(), null);
  assert.deepEqual(state.window.messages.at(-1), {channel: 'window:close-prompt', value: null});
  lifecycle.tray.menu.find(item => item.label === '显示 Xmusic').click();
  assert.equal(state.window.visible, true);
});

test('missing icons, unavailable system trays or failing menus cannot hide the main window', () => {
  for (const failure of [{noIcons: true}, {trayFailure: true}, {menuFailure: true}]) {
    const {state, lifecycle} = fixture(failure);
    state.window.visible = false;
    const closeEvent = event();
    lifecycle.handleWindowClose(closeEvent, state.window);
    assert.equal(closeEvent.prevented, true);
    assert.deepEqual(lifecycle.getClosePrompt(), {id: 1, canHide: false});
    assert.deepEqual(lifecycle.respondToClosePrompt({id: 1, action: 'hide'}), {id: 1, canHide: false});
    assert.equal(state.window.visible, true);
    assert.equal(state.window.hideCount, 0);
    assert.equal(state.exited, 0);
    assert.equal(lifecycle.hasTray(), false);
    lifecycle.respondToClosePrompt({id: 1, action: 'cancel'});
    assert.equal(lifecycle.getClosePrompt(), null);
    assert.equal(state.window.visible, true);
  }
});

test('explicit tray exit waits once for downloads and cleans every native resource without a close prompt', async () => {
  const downloads = deferred();
  const {state, lifecycle, lyrics, app} = fixture({downloads});
  lifecycle.createTray();
  lifecycle.tray.menu.find(item => item.label === '退出软件').click();
  lifecycle.requestQuit();
  app.quit();
  await Promise.resolve();
  assert.equal(state.downloaded, 1);
  assert.equal(state.exited, 0);
  assert.equal(state.window.messages.length, 0);
  downloads.resolve();
  await lifecycle.shutdownPromise;
  assert.equal(state.exited, 1);
  assert.equal(state.window.destroyed, true);
  assert.equal(state.window.messages.length, 0);
  assert.equal(lyrics.disposed, 1);
  assert.equal(state.shortcuts, 1);
  assert.equal(state.trayDestroyed, 1);
  lifecycle.disposeNative();
  assert.equal(lyrics.disposed, 1);
});

test('programmatic quit bypasses the prompt and headless close exposes the no-tray choice', async () => {
  const programmatic = fixture();
  programmatic.app.quit();
  await programmatic.lifecycle.shutdownPromise;
  assert.equal(programmatic.state.window.messages.length, 0);
  assert.equal(programmatic.state.exited, 1);
  const downloads = deferred();
  const headless = fixture({headless: true, downloads});
  assert.equal(headless.lifecycle.createTray(), false);
  headless.state.window.close();
  assert.deepEqual(headless.lifecycle.getClosePrompt(), {id: 1, canHide: false});
  headless.lifecycle.respondToClosePrompt({id: 1, action: 'quit'});
  await Promise.resolve();
  downloads.reject(new Error('Interrupted filesystem write'));
  await headless.lifecycle.shutdownPromise;
  assert.equal(headless.lifecycle.getClosePrompt(), null);
  assert.equal(headless.state.trayCreated, 0);
  assert.equal(headless.state.exited, 1);
  assert.equal(headless.lyrics.disposed, 1);
});

test('an outstanding close dialog cannot hide or interrupt the app after explicit exit begins', async () => {
  const downloads = deferred();
  const {state, lifecycle} = fixture({downloads});
  state.window.close();
  lifecycle.requestQuit();
  lifecycle.respondToClosePrompt({id: 1, action: 'hide'});
  assert.equal(state.window.hideCount, 0);
  downloads.resolve();
  await lifecycle.shutdownPromise;
  assert.equal(state.exited, 1);
  assert.equal(lifecycle.getClosePrompt(), null);
});

test('cancelled and stale responses cannot close a later prompt or hide the window twice', () => {
  const {state, lifecycle} = fixture();
  state.window.close();
  lifecycle.respondToClosePrompt({id: 1, action: 'cancel'});
  assert.equal(lifecycle.getClosePrompt(), null);
  assert.equal(state.window.visible, true);
  state.window.close();
  assert.deepEqual(lifecycle.getClosePrompt(), {id: 2, canHide: true});
  for (const action of ['hide', 'quit', 'cancel']) lifecycle.respondToClosePrompt({id: 1, action});
  assert.deepEqual(lifecycle.getClosePrompt(), {id: 2, canHide: true});
  assert.equal(state.window.hideCount, 0);
  assert.equal(state.quitAttempts, 0);
  lifecycle.respondToClosePrompt({id: 2, action: 'hide'});
  lifecycle.respondToClosePrompt({id: 2, action: 'hide'});
  assert.equal(state.window.hideCount, 1);
});

test('losing the tray while choosing hide refreshes the prompt instead of stranding the app', () => {
  const options = {};
  const {state, lifecycle} = fixture(options);
  state.window.close();
  lifecycle.tray.destroy();
  options.trayFailure = true;
  assert.deepEqual(lifecycle.respondToClosePrompt({id: 1, action: 'hide'}), {id: 1, canHide: false});
  assert.equal(state.window.visible, true);
  assert.equal(state.window.hideCount, 0);
  assert.equal(state.quitAttempts, 0);
  assert.deepEqual(state.window.messages.at(-1).value, {id: 1, canHide: false});
});

test('quit choice cleans downloads once, rejects invalid replies and ignores duplicate confirmation', async () => {
  const {state, lifecycle, lyrics} = fixture();
  for (const value of [null, {}, {id: '1', action: 'quit'}, {id: 1, action: 'unknown'}]) {
    assert.throws(() => lifecycle.respondToClosePrompt(value), /无效的关闭操作/);
  }
  state.window.close();
  lifecycle.respondToClosePrompt({id: 1, action: 'quit'});
  lifecycle.respondToClosePrompt({id: 1, action: 'quit'});
  await lifecycle.shutdownPromise;
  assert.equal(state.exited, 1);
  assert.equal(state.downloaded, 1);
  assert.equal(lyrics.disposed, 1);
  assert.equal(lifecycle.getClosePrompt(), null);
});

test('renderer startup or reload can retrieve a close request even if event delivery failed', () => {
  const {state, lifecycle} = fixture();
  state.window.webContents.send = () => {throw new Error('Renderer is loading');};
  state.window.close();
  const snapshot = lifecycle.getClosePrompt();
  assert.deepEqual(snapshot, {id: 1, canHide: true});
  snapshot.canHide = false;
  assert.equal(lifecycle.getClosePrompt().canHide, true, 'callers cannot mutate the pending choice');
  lifecycle.respondToClosePrompt({id: 1, action: 'cancel'});
  assert.equal(lifecycle.getClosePrompt(), null);
});

test('remembered hide applies to future closes and the settings choice can restore the prompt', () => {
  const {state, lifecycle, preferences} = fixture();
  state.window.close();
  lifecycle.respondToClosePrompt({id: 1, action: 'hide', remember: true});
  assert.equal(preferences.snapshot().closeAction, 'hide');
  lifecycle.showMainWindow();
  state.window.close();
  assert.equal(state.window.visible, false);
  assert.equal(state.window.hideCount, 2);
  assert.equal(lifecycle.getClosePrompt(), null);
  preferences.update({closeAction: 'ask'});
  lifecycle.showMainWindow(); state.window.close();
  assert.deepEqual(lifecycle.getClosePrompt(), {id: 2, canHide: true});
  lifecycle.respondToClosePrompt({id: 2, action: 'cancel', remember: true});
  assert.equal(preferences.snapshot().closeAction, 'ask');
});

test('remembered quit survives restart and exits without another close prompt', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xmusic-close-preferences-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const preferencesPath = path.join(directory, 'preferences.json');
  const first = fixture({preferences: new DesktopPreferencesController({preferencesPath})});
  first.state.window.close();
  first.lifecycle.respondToClosePrompt({id: 1, action: 'quit', remember: true});
  await first.lifecycle.shutdownPromise;
  assert.equal(first.state.exited, 1);
  const second = fixture({preferences: new DesktopPreferencesController({preferencesPath})});
  second.state.window.close();
  await second.lifecycle.shutdownPromise;
  assert.equal(second.state.exited, 1);
  assert.equal(second.state.window.messages.length, 0);
});

test('remembered hiding falls back to a prompt when the tray is unavailable and never exits silently', () => {
  for (const failure of [{trayFailure: true}, {noIcons: true}, {menuFailure: true}, {headless: true}]) {
    const {state, lifecycle, preferences} = fixture(failure);
    preferences.update({closeAction: 'hide'});
    state.window.close();
    assert.deepEqual(lifecycle.getClosePrompt(), {id: 1, canHide: false});
    assert.equal(state.window.visible, true);
    assert.equal(state.window.hideCount, 0);
    assert.equal(state.quitAttempts, 0);
    lifecycle.respondToClosePrompt({id: 1, action: 'hide', remember: true});
    assert.equal(preferences.snapshot().closeAction, 'hide');
    assert.equal(state.window.hideCount, 0);
    lifecycle.respondToClosePrompt({id: 1, action: 'cancel', remember: true});
    assert.equal(state.quitAttempts, 0);
  }
});

test('cancel, stale replies, failed tray choices and unchecked choices cannot remember a different close action', () => {
  const {state, lifecycle, preferences} = fixture();
  state.window.close();
  lifecycle.respondToClosePrompt({id: 1, action: 'cancel', remember: true});
  state.window.close();
  lifecycle.respondToClosePrompt({id: 1, action: 'quit', remember: true});
  assert.equal(preferences.snapshot().closeAction, 'ask');
  assert.equal(state.quitAttempts, 0);
  lifecycle.respondToClosePrompt({id: 2, action: 'hide'});
  assert.equal(preferences.snapshot().closeAction, 'ask');
  const failed = fixture({trayFailure: true});
  failed.state.window.close();
  failed.lifecycle.respondToClosePrompt({id: 1, action: 'hide', remember: true});
  assert.equal(failed.preferences.snapshot().closeAction, 'ask');
  assert.throws(() => failed.lifecycle.respondToClosePrompt({id: 1, action: 'quit', remember: 'yes'}), /无效的关闭操作/);
});

test('remembering cannot lose a visible prompt when the preference file is not writable', () => {
  for (const action of ['hide', 'quit']) {
    const preferences = {snapshot: () => ({closeAction: 'ask', shortcutsEnabled: true}), update() {throw new Error('设置保存失败');}};
    const {state, lifecycle} = fixture({preferences});
    state.window.close();
    assert.throws(() => lifecycle.respondToClosePrompt({id: 1, action, remember: true}), /设置保存失败/);
    assert.equal(state.window.visible, true);
    assert.equal(state.quitAttempts, 0);
    assert.deepEqual(lifecycle.getClosePrompt(), {id: 1, canHide: true});
    lifecycle.respondToClosePrompt({id: 1, action: 'cancel'});
  }
});

test('injected custom tray popup receives playback state and opens once, while restoring the main window hides it', async () => {
  const pending = deferred();
  const updates = [];
  let shows = 0, hides = 0, disposals = 0;
  const popup = {update(value) {updates.push(value);}, show() {shows++; return pending.promise;}, hide() {hides++;}, dispose() {disposals++;}};
  const {lifecycle, lyrics, state} = fixture({trayMenu: popup});
  lifecycle.createTray();
  assert.equal(lifecycle.tray.menu, null, 'right-click uses the custom popup rather than an automatically opened native menu');
  lyrics.content.playing = true; lyrics.visible = true; lifecycle.refreshTray();
  assert.deepEqual(updates.at(-1), {playing: true, visible: true, title: '歌名'});
  const show = lifecycle.showTrayMenu();
  await lifecycle.showTrayMenu();
  assert.equal(shows, 1);
  pending.resolve(true); await show;
  assert.equal(lifecycle.tray.poppedMenu, undefined);
  state.window.visible = false;
  lifecycle.tray.emit('click');
  assert.equal(state.window.visible, true); assert.equal(hides, 1);
  lifecycle.disposeNative(); lifecycle.disposeNative();
  assert.equal(disposals, 1);
});

test('a failed custom popup retains every native tray action as a fallback', async () => {
  for (const fail of ['false', 'throw']) {
    const popup = {update() {}, hide() {}, dispose() {}, async show() {if (fail === 'throw') throw new Error('Renderer failed'); return false;}};
    const {lifecycle, state} = fixture({trayMenu: popup});
    lifecycle.createTray(); await lifecycle.showTrayMenu();
    const menu = lifecycle.tray.poppedMenu;
    for (const label of ['显示 Xmusic', '播放', '上一首', '下一首', '桌面歌词', '退出软件']) assert.ok(menu.some(item => item.label === label));
    menu.find(item => item.label === '播放').click();
    assert.deepEqual(state.commands, ['toggle']);
    lifecycle.disposeNative();
  }
});

test('lyric refreshes cannot overwrite newer player metadata and native menus follow the same player snapshot', () => {
  const popup = new TrayMenu({onCommand() {}});
  const player = {title: '新歌曲', artist: '新歌手', playing: true, favorite: true, volume: 0.42,
    muted: false, hasTrack: true, hasQueue: true};
  popup.update(player);
  const {lifecycle, lyrics, state} = fixture({trayMenu: popup, getPlayerState: () => popup.snapshot()});
  lifecycle.createTray();
  assert.equal(lifecycle.tray.tooltip, 'Xmusic · 新歌曲');
  assert.ok(lifecycle.nativeTrayMenu.some(item => item.label === '暂停'));
  lyrics.visible = true;
  lyrics.content = {title: '旧歌曲', playing: false};
  lifecycle.refreshTray();
  assert.deepEqual(popup.snapshot(), {...player, visible: true});
  assert.equal(lifecycle.tray.tooltip, 'Xmusic · 新歌曲');
  assert.ok(lifecycle.nativeTrayMenu.some(item => item.label === '暂停'));
  assert.equal(lifecycle.nativeTrayMenu.find(item => item.label === '桌面歌词').checked, true);

  popup.update({title: '下一首', playing: false});
  lifecycle.refreshTray();
  assert.equal(lifecycle.tray.tooltip, 'Xmusic · 下一首');
  assert.ok(lifecycle.nativeTrayMenu.some(item => item.label === '播放'));
  const builds = state.menuBuilds;
  lyrics.content = {title: '迟到的歌词标题', playing: true};
  lifecycle.refreshTray();
  assert.equal(state.menuBuilds, builds);
  assert.deepEqual(popup.snapshot(), {...player, title: '下一首', playing: false, visible: true});
  lifecycle.disposeNative();
});
