'use strict';

const path = require('node:path');
const {pathToFileURL} = require('node:url');

const WIDTH = 252;
const HEIGHT = 328;
const COMMANDS = new Set(['show-main', 'toggle', 'previous', 'next', 'favorite', 'queue', 'mute', 'volume', 'lyrics', 'quit', 'hide']);
const DISMISS_COMMANDS = new Set(['show-main', 'queue', 'quit', 'hide']);
const cleanText = (value, fallback = '') => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) || fallback : fallback;

function menuBounds(point, area) {
  const width = Math.min(WIDTH, area.width), height = Math.min(HEIGHT, area.height);
  const left = point.x - width + 12;
  const top = point.y - height - 8 >= area.y ? point.y - height - 8 : point.y + 8;
  return {
    width, height,
    x: Math.round(Math.max(area.x, Math.min(left, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(top, area.y + area.height - height))),
  };
}

class TrayMenu {
  constructor({BrowserWindow, screen, onCommand}) {
    Object.assign(this, {BrowserWindow, screen, onCommand});
    this.window = null;
    this.loading = null;
    this.disposed = false;
    this.showGeneration = 0;
    this.content = {playing: false, visible: false, title: 'Xmusic', artist: '',
      favorite: false, volume: 0.75, muted: false, hasTrack: false, hasQueue: false};
    this.pagePath = path.join(__dirname, 'tray-menu.html');
    this.pageUrl = pathToFileURL(this.pagePath).href;
  }

  snapshot() {return {...this.content};}

  update(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('托盘菜单状态无效');
    this.content = {
      playing: value.playing === undefined ? this.content.playing : value.playing === true,
      visible: value.visible === undefined ? this.content.visible : value.visible === true,
      title: value.title === undefined ? this.content.title : cleanText(value.title, 'Xmusic'),
      artist: value.artist === undefined ? this.content.artist : cleanText(value.artist),
      favorite: value.favorite === undefined ? this.content.favorite : value.favorite === true,
      volume: typeof value.volume === 'number' && Number.isFinite(value.volume)
        ? Math.max(0, Math.min(1, value.volume)) : this.content.volume,
      muted: value.muted === undefined ? this.content.muted : value.muted === true,
      hasTrack: value.hasTrack === undefined ? this.content.hasTrack : value.hasTrack === true,
      hasQueue: value.hasQueue === undefined ? this.content.hasQueue : value.hasQueue === true,
    };
    this.broadcast();
  }

  broadcast() {
    if (!this.window || this.window.isDestroyed()) return;
    try {this.window.webContents.send('tray-menu:snapshot', this.snapshot());}
    catch { /* A freshly loaded renderer also reads a snapshot through its preload. */ }
  }

  trusted(event) {
    return !!this.window && !this.window.isDestroyed() && event?.sender === this.window.webContents &&
      event.senderFrame === this.window.webContents.mainFrame && event.senderFrame.url === this.pageUrl;
  }

  command(action, value) {
    if (!COMMANDS.has(action)) throw new Error('不支持的托盘菜单操作');
    if (action === 'volume' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error('托盘音量无效');
    }
    if (this.disposed) return;
    if (DISMISS_COMMANDS.has(action)) this.hide();
    if (action !== 'hide') this.onCommand(action, action === 'volume' ? value : undefined);
  }

  async create() {
    if (this.loading) return this.loading;
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new this.BrowserWindow({
      width: WIDTH, height: HEIGHT, useContentSize: true,
      title: 'Xmusic 托盘菜单', frame: false, show: false, backgroundColor: '#ffffff',
      skipTaskbar: true, alwaysOnTop: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, autoHideMenuBar: true,
      webPreferences: {preload: path.join(__dirname, 'tray-menu-preload.cjs'), contextIsolation: true,
        sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false},
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.on(event, action => action.preventDefault());
    window.on('blur', () => this.hide());
    window.on('close', event => {if (!this.disposed) {event.preventDefault(); this.hide();}});
    window.on('closed', () => {if (this.window === window) this.window = null;});
    window.webContents.on('render-process-gone', () => {if (!window.isDestroyed()) window.destroy();});
    this.loading = Promise.resolve().then(() => window.loadFile(this.pagePath)).then(() => {
      if (this.disposed || window.isDestroyed()) throw new Error('托盘菜单已关闭');
      this.broadcast();
      return window;
    }).catch(error => {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }).finally(() => {this.loading = null;});
    return this.loading;
  }

  async show() {
    if (this.disposed) return false;
    const generation = ++this.showGeneration;
    try {
      const point = this.screen.getCursorScreenPoint();
      const window = await this.create();
      // A main-window restore or another right click may supersede a pending load.
      if (generation !== this.showGeneration) return !this.disposed;
      if (this.disposed || window.isDestroyed()) return false;
      const display = this.screen.getDisplayNearestPoint(point);
      window.setBounds(menuBounds(point, display.workArea));
      this.broadcast();
      window.show();
      window.focus();
      return true;
    } catch {
      // A failed load is still dismissed if the user has already restored the
      // main window or hidden the menu. Only an active show needs a fallback.
      return !this.disposed && generation !== this.showGeneration;
    }
  }

  hide() {
    ++this.showGeneration;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.showGeneration;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = {TrayMenu, menuBounds};
