'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const EMPTY_CONTENT = Object.freeze({ title: 'Xmusic', artist: '', line: '播放一首喜欢的歌', nextLine: '', words: [], lineStart: 0, lineEnd: 0, position: 0, playbackRate: 1, playing: false, loading: false, accentColor: '#63da9d', fontSize: 30, fontFamily: '', singleLine: false, borderRadius: 12, opacity: 0.55, backgroundImage: null });
const MIN_WIDTH = 240;
const MIN_HEIGHT = 80;
const DEFAULT_HEIGHT = 144;
// The toolbar remains outside the background. Reserve line-height, padding
// and a small glyph/shadow margin at the configured font size.
const contentHeight = content => Math.ceil(50 + content.fontSize * 1.3 * (!content.singleLine && content.nextLine ? 1.65 : 1) + (!content.singleLine && content.nextLine ? 3 : 0));
const layoutKey = content => JSON.stringify([content.fontSize, content.fontFamily, content.singleLine === true, content.line, content.nextLine]);
const sameBounds = (first, second) => first && second && ['x', 'y', 'width', 'height'].every(key => first[key] === second[key]);

function sanitizeBackgroundImage(value) {
  return typeof value === 'string' && value.length <= 850000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

function sanitizeFontFamily(value) {
  if (typeof value !== 'string') return '';
  const family = value.trim();
  return /^[\p{L}\p{N}\p{M} ._+\-]{1,80}$/u.test(family) ? family : '';
}

function sanitizeWords(value) {
  if (!Array.isArray(value) || value.length > 1000) return [];
  let length = 0;
  let previousStart = -1;
  const words = [];
  for (const word of value) {
    if (!word || typeof word.text !== 'string' || !word.text || word.text.length > 2000 || typeof word.start !== 'number' || !Number.isFinite(word.start) || word.start < 0 || word.start > 86400 || word.start < previousStart || typeof word.dur !== 'number' || !Number.isFinite(word.dur) || word.dur < 0 || word.dur > 3600) return [];
    length += word.text.length;
    if (length > 2000) return [];
    words.push({text: word.text, start: word.start, dur: word.dur});
    previousStart = word.start;
  }
  return words;
}

function sanitizeContent(value, previous = EMPTY_CONTENT) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('歌词内容无效');
  const image = value.backgroundImage === undefined ? previous.backgroundImage : sanitizeBackgroundImage(value.backgroundImage);
  value = {...previous, ...value};
  const text = (key, maximum) => typeof value[key] === 'string' ? value[key].slice(0, maximum) : '';
  const number = (key, fallback, min, max) => typeof value[key] === 'number' && Number.isFinite(value[key]) ? Math.max(min, Math.min(max, value[key])) : fallback;
  const line = text('line', 2000);
  const words = sanitizeWords(value.words);
  return {
    title: text('title', 500), artist: text('artist', 500), line, nextLine: text('nextLine', 2000),
    words: words.map(word => word.text).join('') === line ? words : [],
    lineStart: number('lineStart', 0, 0, 86400), lineEnd: number('lineEnd', 0, 0, 86400),
    position: number('position', 0, 0, 86400), playbackRate: number('playbackRate', 1, 0.25, 4),
    playing: value.playing === true, loading: value.loading === true,
    accentColor: /^#[a-f\d]{6}$/i.test(value.accentColor) ? value.accentColor : EMPTY_CONTENT.accentColor,
    fontSize: number('fontSize', 30, 18, 60), fontFamily: sanitizeFontFamily(value.fontFamily), singleLine: value.singleLine === true,
    borderRadius: number('borderRadius', 12, 0, 40), opacity: number('opacity', 0.55, 0, 0.95),
    backgroundImage: image,
  };
}

function fitBounds(bounds, area) {
  const width = Math.min(Math.max(Math.round(bounds.width), Math.min(MIN_WIDTH, area.width)), area.width);
  const height = Math.min(Math.max(Math.round(bounds.height), Math.min(MIN_HEIGHT, area.height)), area.height);
  return {
    width, height,
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))),
  };
}

function readPreferences(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const position = value?.position ?? value?.bounds;
    const valid = position && ['x', 'y'].every(key => Number.isSafeInteger(position[key]) && Math.abs(position[key]) <= 100000);
    const size = value?.bounds;
    const validSize = size && ['width', 'height'].every(key => Number.isSafeInteger(size[key]) && size[key] > 0 && size[key] <= 100000);
    // v4 retained only position. Older manual records and v5 restore their size.
    return {locked: value?.locked === true, bounds: valid ? {x: position.x, y: position.y, width: validSize ? size.width : 560, height: validSize ? size.height : DEFAULT_HEIGHT} : null};
  } catch { return { locked: false, bounds: null }; }
}

class DesktopLyrics {
  constructor({ BrowserWindow, screen, notify, playback, showMain, headless = false, preferencesPath }) {
    Object.assign(this, { BrowserWindow, screen, notify, playback, showMain, headless, preferencesPath });
    const saved = readPreferences(preferencesPath);
    this.window = null;
    this.visible = false;
    this.locked = saved.locked;
    this.content = { ...EMPTY_CONTENT };
    this.layoutId = 1;
    this.sentBackgroundImage = undefined;
    this.bounds = saved.bounds;
    this.observedBounds = null;
    this.observedDisplay = null;
    this.userResizing = false;
    this.appliedBounds = null;
    this.applyingBounds = false;
    this.minimumSize = null;
    this.contentSize = null;
    this.availableWidth = null;
    this.pointerInside = false;
    this.pointerTimer = null;
    this.saveTimer = null;
    this.disposed = false;
    this.pagePath = path.join(__dirname, 'lyrics.html');
    this.pageUrl = pathToFileURL(this.pagePath).href;
    this.onDisplayChange = (_event, display) => this.fitWindow(!display || display.id === this.observedDisplay?.id);
    screen.on('display-removed', this.onDisplayChange);
    screen.on('display-metrics-changed', this.onDisplayChange);
  }

  savePreferences() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.preferencesPath) return;
    try {
      const temporary = `${this.preferencesPath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 5, bounds: this.bounds, locked: this.locked }), 'utf8');
      fs.renameSync(temporary, this.preferencesPath);
    } catch { console.warn('桌面歌词的位置与锁定设置未能保存。'); }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    if (!this.preferencesPath) return;
    this.saveTimer = setTimeout(() => this.savePreferences(), 250);
    this.saveTimer.unref?.();
  }

  rememberBounds(rebaseSize = false) {
    const window = this.window;
    if (!window || window.isDestroyed() || this.applyingBounds) return;
    const current = window.getBounds();
    const previous = this.observedBounds;
    const display = this.screen.getDisplayMatching(current);
    const observedDisplay = {id: display.id, scaleFactor: display.scaleFactor ?? 1};
    const displayChanged = this.observedDisplay && (this.observedDisplay.id !== observedDisplay.id || this.observedDisplay.scaleFactor !== observedDisplay.scaleFactor);
    const rebase = rebaseSize || displayChanged;
    const preserveSize = rebase && !this.userResizing;
    // Native readback can differ from the requested DIP bounds. Apply user
    // deltas to the last requested rectangle, never accumulate that offset.
    // Automatic lyric expansion is separate from the saved manual rectangle.
    if (previous && !sameBounds(current, previous)) {
      const keys = preserveSize ? ['x', 'y'] : ['x', 'y', 'width', 'height'];
      const applied = this.appliedBounds ?? this.bounds;
      const target = {...applied, ...Object.fromEntries(keys.map(key => [key, applied[key] + current[key] - previous[key]]))};
      const widthChanged = !preserveSize && current.width !== previous.width;
      const heightChanged = !preserveSize && current.height !== previous.height;
      this.bounds = {
        // At a display edge the expanded rectangle may have been clamped away
        // from the saved center. A real move adopts its visible center/top so
        // the next fit does not jump back toward that old, unclamped anchor.
        x: widthChanged ? target.x : current.x !== previous.x ? target.x + (target.width - this.bounds.width) / 2 : this.bounds.x,
        y: heightChanged || current.y !== previous.y ? target.y : this.bounds.y,
        width: widthChanged ? target.width : this.bounds.width,
        height: heightChanged ? target.height : this.bounds.height,
      };
      this.appliedBounds = target;
      this.scheduleSave();
    }
    this.observedBounds = current;
    this.observedDisplay = observedDisplay;
    if (rebase) {
      this.appliedBounds = null;
      this.minimumSize = null;
    }
    return rebase;
  }

  updatePointer(inside) {
    if (this.pointerInside === inside) return;
    this.pointerInside = inside;
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('desktop-lyrics:pointer', inside);
  }

  syncPointerTracking() {
    if (!this.visible || this.locked || this.disposed || !this.window || this.window.isDestroyed() || typeof this.screen.getCursorScreenPoint !== 'function') {
      clearInterval(this.pointerTimer);
      this.pointerTimer = null;
      this.updatePointer(false);
      return;
    }
    if (this.pointerTimer !== null) return;
    const check = () => {
      if (!this.window || this.window.isDestroyed()) return;
      try {
        const cursor = this.screen.getCursorScreenPoint();
        const bounds = this.window.getBounds();
        this.updatePointer(cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height);
      } catch { /* A transient display change will be checked again on the next tick. */ }
    };
    check();
    this.pointerTimer = setInterval(check, 120);
    this.pointerTimer.unref?.();
  }

  fitWindow(rebaseSize = false) {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    this.rememberBounds(rebaseSize);
    const current = window.getBounds();
    const area = this.screen.getDisplayMatching(current).workArea;
    const widthChanged = this.availableWidth !== area.width;
    this.availableWidth = area.width;
    const minimumSize = {
      width: Math.min(Math.max(MIN_WIDTH, this.contentSize?.width ?? 0), area.width),
      height: Math.min(Math.max(MIN_HEIGHT, contentHeight(this.content), this.contentSize?.height ?? 0), area.height),
    };
    // Keep the user's baseline, including on short lines. Long lines expand
    // equally left and right until the display edge requires clamping.
    const manual = fitBounds(this.bounds, area);
    const width = Math.max(manual.width, minimumSize.width);
    const height = Math.max(manual.height, minimumSize.height);
    const target = fitBounds({...manual, x: manual.x - (width - manual.width) / 2, width, height}, area);
    this.applyingBounds = true;
    try {
      if (this.minimumSize?.width !== minimumSize.width || this.minimumSize?.height !== minimumSize.height) {
        window.setMinimumSize(minimumSize.width, minimumSize.height);
        this.minimumSize = minimumSize;
      }
      if (!sameBounds(target, this.appliedBounds)) window.setBounds(target);
      this.bounds = manual;
      this.appliedBounds = {...target};
      this.observedBounds = window.getBounds();
    } finally { this.applyingBounds = false; }
    this.scheduleSave();
    if (widthChanged) this.sendSnapshot();
  }

  state() { return { visible: this.visible, locked: this.locked }; }
  snapshot() { return { ...this.state(), pointerInside: this.pointerInside,
    nativePointerAvailable: typeof this.screen.getCursorScreenPoint === 'function', availableWidth: this.availableWidth, layoutId: this.layoutId, content: this.content }; }
  sendSnapshot() {
    if (!this.window || this.window.isDestroyed()) return;
    const {backgroundImage, ...content} = this.content;
    this.window.webContents.send('desktop-lyrics:snapshot', {...this.state(), availableWidth: this.availableWidth, layoutId: this.layoutId,
      content: this.sentBackgroundImage === backgroundImage ? content : this.content});
    this.sentBackgroundImage = backgroundImage;
  }
  broadcast() {
    this.sendSnapshot();
    this.notify(this.state());
  }

  trusted(event) {
    return !!this.window && !this.window.isDestroyed() && event.sender === this.window.webContents &&
      event.senderFrame === this.window.webContents.mainFrame && event.senderFrame.url === this.pageUrl;
  }

  create() {
    const area = this.bounds ? this.screen.getDisplayMatching(this.bounds).workArea : this.screen.getPrimaryDisplay().workArea;
    const height = DEFAULT_HEIGHT;
    const initial = this.bounds || { width: Math.min(560, area.width), height, x: area.x + (area.width - Math.min(560, area.width)) / 2, y: area.y + area.height - height - 40 };
    this.bounds = fitBounds(initial, area);
    const window = new this.BrowserWindow({
      ...this.bounds, minWidth: Math.min(MIN_WIDTH, area.width), minHeight: Math.min(MIN_HEIGHT, area.height),
      title: 'Xmusic 桌面歌词', frame: false, transparent: true, backgroundColor: '#00000000',
      show: false, alwaysOnTop: true, skipTaskbar: true, resizable: true, maximizable: false, fullscreenable: false,
      webPreferences: { preload: path.join(__dirname, 'lyrics-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, spellcheck: false },
    });
    this.window = window;
    this.sentBackgroundImage = undefined;
    this.observedBounds = window.getBounds();
    const display = this.screen.getDisplayMatching(this.observedBounds);
    this.observedDisplay = {id: display.id, scaleFactor: display.scaleFactor ?? 1};
    this.userResizing = false;
    this.appliedBounds = null;
    this.minimumSize = null;
    window.setAlwaysOnTop(true, 'floating');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('did-finish-load', () => {
      if (this.disposed || window.isDestroyed() || this.window !== window) return;
      this.applyLock();
      this.sentBackgroundImage = undefined;
      this.broadcast();
      if (this.visible && !this.headless) window.showInactive();
    });
    window.on('close', event => {
      if (!this.disposed) { event.preventDefault(); this.setVisible(false); }
    });
    const remember = () => { if (!this.applyingBounds) this.fitWindow(); };
    window.on('will-resize', () => { if (!this.applyingBounds) this.userResizing = true; });
    window.on('resized', () => { remember(); this.userResizing = false; });
    window.on('move', remember);
    window.on('resize', remember);
    window.on('closed', () => {
      if (this.window !== window) return;
      this.window = null;
      this.visible = false;
      this.syncPointerTracking();
      this.broadcast();
    });
    const failed = () => {
      if (this.window !== window || this.disposed) return;
      // Recreate a fresh renderer on the next open instead of reusing a blank window.
      window.destroy();
    };
    window.webContents.on('render-process-gone', failed);
    void window.loadFile(this.pagePath).catch(failed);
    return window;
  }

  setVisible(visible) {
    if (typeof visible !== 'boolean') throw new Error('歌词窗口状态无效');
    if (this.disposed) return this.state();
    this.visible = visible;
    if (visible) {
      const window = this.window && !this.window.isDestroyed() ? this.window : this.create();
      this.fitWindow();
      this.applyLock();
      if (!this.headless && !window.webContents.isLoading()) window.showInactive();
    } else if (this.window && !this.window.isDestroyed()) { this.window.hide(); }
    this.syncPointerTracking();
    this.broadcast();
    return this.state();
  }

  applyLock() {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.setIgnoreMouseEvents(this.locked, { forward: true });
    this.window.setFocusable(!this.locked);
    // On Windows, changing focusability can reset the extended taskbar style.
    // Reapply this after every lock/unlock and reopen, not only at construction.
    this.window.setSkipTaskbar(true);
    this.syncPointerTracking();
  }

  setLocked(locked) {
    if (typeof locked !== 'boolean') throw new Error('歌词锁定状态无效');
    if (this.disposed) return this.state();
    this.locked = locked;
    this.applyLock();
    this.broadcast();
    this.scheduleSave();
    return this.state();
  }

  update(value) {
    if (this.disposed) return;
    const previousLayout = layoutKey(this.content);
    this.content = sanitizeContent(value, this.content);
    if (layoutKey(this.content) !== previousLayout) {
      this.layoutId++;
      this.fitWindow();
    }
    // Clock, lock and layout changes do not resend the user's image over IPC.
    this.sendSnapshot();
  }

  resizeToContent(size) {
    if (this.disposed || !size || size.layoutId !== this.layoutId || !Number.isSafeInteger(size.layoutId) ||
      !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width < 24 || size.width > 500000 || size.height < 48 || size.height > 100000) return;
    const next = {width: Math.ceil(size.width), height: Math.ceil(size.height)};
    if (this.contentSize?.width === next.width && this.contentSize?.height === next.height) return;
    this.contentSize = next;
    this.fitWindow();
  }

  command(command) {
    if (['toggle', 'previous', 'next'].includes(command)) this.playback(command);
    else if (command === 'show-main') this.showMain();
    else if (command === 'close') this.setVisible(false);
    else if (command === 'lock') this.setLocked(true);
    else if (command === 'unlock') this.setLocked(false);
    else throw new Error('不支持的歌词窗口操作');
  }

  dispose() {
    if (this.disposed) return;
    this.rememberBounds();
    this.savePreferences();
    this.disposed = true;
    this.visible = false;
    this.syncPointerTracking();
    this.window?.destroy();
    this.window = null;
    this.screen.removeListener('display-removed', this.onDisplayChange);
    this.screen.removeListener('display-metrics-changed', this.onDisplayChange);
  }
}

module.exports = { DesktopLyrics, sanitizeContent, fitBounds };
