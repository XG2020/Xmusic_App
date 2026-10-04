'use strict';

/** Native application lifetime, separate from renderer and audio state. */
class AppLifecycle {
  constructor({app, Tray, Menu, nativeImage, getWindow, getLyrics, getPlayerState, playback, preferences, trayMenu,
    disposeDownloads, unregisterShortcuts, iconPaths, headless = false}) {
    Object.assign(this, {app, Tray, Menu, nativeImage, getWindow, getLyrics, getPlayerState, playback, preferences, trayMenu,
      disposeDownloads, unregisterShortcuts, iconPaths, headless});
    this.tray = null;
    this.traySignature = '';
    this.nativeTrayMenu = null;
    this.trayPopupPending = false;
    this.closePrompt = null;
    this.closePromptWindow = null;
    this.closePromptSequence = 0;
    this.showRequested = false;
    this.quitting = false;
    this.shutdownComplete = false;
    this.shutdownPromise = null;
    this.nativeDisposed = false;
  }

  windowIcon() {
    for (const iconPath of this.iconPaths) {
      try {
        const image = this.nativeImage.createFromPath(iconPath);
        if (image && !image.isEmpty()) return image;
      } catch { /* A missing optional format can fall back to the other bundled icon. */ }
    }
    return undefined;
  }

  showMainWindow() {
    if (this.quitting) return;
    try {this.trayMenu?.hide();} catch { /* The main window remains the reliable restore action. */ }
    const window = this.getWindow();
    if (!window || window.isDestroyed()) {this.showRequested = true; return;}
    this.showRequested = false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  attachWindow(window) {
    window.once('ready-to-show', () => {
      if (!this.headless || this.showRequested) this.showMainWindow();
    });
    window.on('close', event => this.handleWindowClose(event, window));
    window.on('closed', () => {
      if (this.closePromptWindow === window) this.clearClosePrompt();
    });
  }

  hasTray() {
    try {return !!this.tray && !this.tray.isDestroyed();} catch {return false;}
  }

  createTray() {
    if (this.headless || this.quitting || this.nativeDisposed) return false;
    if (this.hasTray()) return true;
    this.tray = null;
    const icon = this.windowIcon();
    if (!icon) {this.showMainWindow(); return false;}
    let tray;
    try {
      tray = new this.Tray(icon);
      if (tray.isDestroyed()) throw new Error('托盘不可用');
      tray.on('click', () => this.showMainWindow());
      tray.on('double-click', () => this.showMainWindow());
      tray.on('right-click', () => {if (this.trayMenu) void this.showTrayMenu();});
      this.tray = tray;
      this.traySignature = '';
      this.refreshTray();
      return this.hasTray();
    } catch {
      try {tray?.destroy();} catch { /* Best-effort cleanup after native tray initialization fails. */ }
      this.tray = null;
      this.showMainWindow();
      return false;
    }
  }

  refreshTray() {
    if (!this.hasTray() || this.quitting) return;
    const lyrics = this.getLyrics();
    const player = this.getPlayerState ? this.getPlayerState() : lyrics?.content;
    const playing = !!player?.playing;
    const visible = !!lyrics?.visible;
    const title = player?.title || '';
    const signature = JSON.stringify([playing, visible, title]);
    if (signature === this.traySignature) return;
    // A late lyric update must never replace newer playback metadata from the player bridge.
    try {this.trayMenu?.update(this.getPlayerState ? {visible} : {playing, visible, title});}
    catch { /* Native menu remains available as a fallback. */ }
    try {
      this.tray.setToolTip((title && title !== 'Xmusic' ? `Xmusic · ${title}` : 'Xmusic').slice(0, 120));
      const menu = this.Menu.buildFromTemplate([
        {label: '显示 Xmusic', click: () => this.showMainWindow()},
        {type: 'separator'},
        {label: playing ? '暂停' : '播放', click: () => this.playback('toggle')},
        {label: '上一首', click: () => this.playback('previous')},
        {label: '下一首', click: () => this.playback('next')},
        {type: 'separator'},
        {label: '桌面歌词', type: 'checkbox', checked: visible, click: () => {
          if (this.quitting) return;
          const current = this.getLyrics();
          try {current?.setVisible(!current.visible); this.refreshTray();} catch {this.showMainWindow();}
        }},
        {type: 'separator'},
        {label: '退出软件', click: () => this.requestQuit()},
      ]);
      this.nativeTrayMenu = menu;
      this.tray.setContextMenu(this.trayMenu ? null : menu);
      this.traySignature = signature;
    } catch {
      // Never strand playback in an invisible window when its only restore affordance fails.
      try {this.tray.destroy();} catch { /* Already unavailable. */ }
      this.tray = null;
      this.showMainWindow();
    }
  }

  async showTrayMenu() {
    if (this.quitting || !this.hasTray() || this.trayPopupPending) return;
    this.trayPopupPending = true;
    try {
      this.refreshTray();
      if (await this.trayMenu.show() !== false) return;
    } catch { /* A failed custom renderer must not remove access to tray actions. */ }
    finally {this.trayPopupPending = false;}
    if (this.quitting || !this.hasTray()) return;
    try {this.tray.popUpContextMenu(this.nativeTrayMenu);}
    catch {this.showMainWindow();}
  }

  getClosePrompt() {
    return this.closePrompt ? {...this.closePrompt} : null;
  }

  publishClosePrompt() {
    const window = this.closePromptWindow ?? this.getWindow();
    if (!window || window.isDestroyed()) return;
    try {window.webContents.send('window:close-prompt', this.getClosePrompt());}
    catch { /* A reloading renderer reads the outstanding prompt when it reconnects. */ }
  }

  clearClosePrompt() {
    if (!this.closePrompt) return;
    this.closePrompt = null;
    this.publishClosePrompt();
    this.closePromptWindow = null;
  }

  handleWindowClose(event, window) {
    if (this.quitting) return;
    event.preventDefault();
    if (this.closePrompt) {this.showMainWindow(); return;}
    const action = this.preferences?.snapshot().closeAction ?? 'ask';
    if (action === 'quit') {this.requestQuit(); return;}
    const canHide = this.createTray();
    if (action === 'hide' && canHide) {
      try {window.hide(); return;} catch { /* Keep the prompt available when native hiding fails. */ }
    }
    this.showMainWindow();
    this.closePromptWindow = window;
    this.closePrompt = {id: ++this.closePromptSequence, canHide};
    this.publishClosePrompt();
  }

  respondToClosePrompt(value) {
    if (!value || !Number.isSafeInteger(value.id) || !['hide', 'quit', 'cancel'].includes(value.action) ||
        value.remember !== undefined && typeof value.remember !== 'boolean') {
      throw new Error('无效的关闭操作');
    }
    // Ignore delayed or duplicated replies so they cannot act on a later close request.
    if (this.quitting || !this.closePrompt || value.id !== this.closePrompt.id) return this.getClosePrompt();
    const window = this.closePromptWindow;
    if (!window || window.isDestroyed()) {this.clearClosePrompt(); return null;}
    if (value.action === 'hide') {
      if (!this.closePrompt.canHide || !this.createTray()) {
        this.closePrompt = {...this.closePrompt, canHide: false};
        this.publishClosePrompt();
        this.showMainWindow();
        return this.getClosePrompt();
      }
      window.hide();
      if (value.remember) {
        try {this.preferences?.update({closeAction: 'hide'});}
        catch (error) {this.showMainWindow(); throw error;}
      }
      this.clearClosePrompt();
    } else {
      // Persist the accepted exit choice before asynchronous shutdown destroys the renderer.
      if (value.action === 'quit' && value.remember) this.preferences?.update({closeAction: 'quit'});
      this.clearClosePrompt();
      if (value.action === 'quit') this.requestQuit();
      else this.showMainWindow();
    }
    return this.getClosePrompt();
  }

  requestQuit() {
    if (this.quitting) return;
    // Set intent before app.quit closes windows, so explicit exit never reopens the choice dialog.
    this.quitting = true;
    this.clearClosePrompt();
    this.app.quit();
  }

  beforeQuit(event) {
    this.quitting = true;
    this.clearClosePrompt();
    if (this.shutdownComplete) return;
    event.preventDefault();
    if (this.shutdownPromise) return;
    this.shutdownPromise = Promise.resolve().then(() => this.disposeDownloads()).catch(() => {}).finally(() => {
      this.disposeNative();
      this.shutdownComplete = true;
      this.app.quit();
    });
  }

  disposeNative() {
    if (this.nativeDisposed) return;
    this.nativeDisposed = true;
    try {this.unregisterShortcuts();} catch { /* Continue cleaning up other native resources. */ }
    try {this.getLyrics()?.dispose();} catch { /* Continue even if the overlay was already destroyed. */ }
    try {this.trayMenu?.dispose();} catch { /* A crashed popup must not interrupt shutdown. */ }
    try {this.tray?.destroy();} catch { /* The OS may have already removed the tray. */ }
    this.tray = null;
  }
}

module.exports = {AppLifecycle};
