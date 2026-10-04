'use strict';

const { app, BrowserWindow, dialog, ipcMain, protocol, session, screen, globalShortcut, shell, Tray, Menu, nativeImage, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { AUDIO_EXTENSIONS, AudioRegistry, localAudioResponse, requestApi } = require('./core.cjs');
const { DesktopLyrics } = require('./desktop-lyrics.cjs');
const { DownloadManager } = require('./downloads.cjs');
const { AppLifecycle } = require('./app-lifecycle.cjs');
const { DesktopPreferencesController, syncDesktopShortcuts } = require('./desktop-preferences.cjs');
const { OnlineAudioService } = require('./online-audio.cjs');
const { TrayMenu } = require('./tray-menu.cjs');
const { resolvePlaylistId } = require('./playlist-import.cjs');

protocol.registerSchemesAsPrivileged([{
  scheme: 'xmusic-audio',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}, {
  scheme: 'xmusic-online',
  privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true},
}]);

if (process.env.XMUSIC_USER_DATA) {
  if (!path.isAbsolute(process.env.XMUSIC_USER_DATA)) throw new Error('XMUSIC_USER_DATA 必须是绝对路径');
  fs.mkdirSync(process.env.XMUSIC_USER_DATA, { recursive: true });
  app.setPath('userData', process.env.XMUSIC_USER_DATA);
}

const rendererFile = path.join(__dirname, '../dist/index.html');
const rendererUrl = pathToFileURL(rendererFile);
const developmentUrl = process.env.VITE_DEV_SERVER_URL;
if (developmentUrl && !/^http:\/\/127\.0\.0\.1:5173\/?$/.test(developmentUrl)) {
  throw new Error('开发服务器地址必须为 http://127.0.0.1:5173');
}

let mainWindow;
let registry;
let importPending = false;
let desktopLyrics;
let downloads;
let onlineAudio;
const preferences = new DesktopPreferencesController({
  preferencesPath: path.join(app.getPath('userData'), 'preferences.json'),
  notify: value => {
    updateShortcuts(value.shortcutsEnabled);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:preferences-changed', value);
  },
});
function updateShortcuts(enabled = preferences.snapshot().shortcutsEnabled) {
  if (!app.isReady() || !desktopLyrics) return;
  syncDesktopShortcuts(globalShortcut, enabled, {
    toggleLyrics: () => desktopLyrics.setVisible(!desktopLyrics.visible),
    unlockLyrics: () => desktopLyrics.setLocked(false),
  });
}
const lifecycle = new AppLifecycle({
  app, Tray, Menu, nativeImage, preferences,
  getWindow: () => mainWindow,
  getLyrics: () => desktopLyrics,
  getPlayerState: () => trayMenu.snapshot(),
  playback: command => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-lyrics:playback', command);
  },
  disposeDownloads: async () => {await downloads?.dispose(); onlineAudio?.dispose();},
  unregisterShortcuts: () => globalShortcut.unregisterAll(),
  iconPaths: [path.join(__dirname, '../resources/icon.ico'), path.join(__dirname, '../resources/icon.png')],
  headless: process.env.XMUSIC_HEADLESS === '1',
});

function showMainWindow() {
  lifecycle.showMainWindow();
}

const trayMenu = new TrayMenu({BrowserWindow, screen, onCommand: (command, value) => {
  if (command === 'show-main') showMainWindow();
  else if (['toggle', 'previous', 'next'].includes(command)) lifecycle.playback(command);
  else if (command === 'lyrics') {desktopLyrics?.setVisible(!desktopLyrics.visible); lifecycle.refreshTray();}
  else if (command === 'quit') lifecycle.requestQuit();
  else if (['favorite', 'queue', 'mute', 'volume'].includes(command)) {
    if (command === 'queue') showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tray-player:command', {action: command, value});
  }
}});
lifecycle.trayMenu = trayMenu;

function isTrustedUrl(value) {
  try {
    const url = new URL(value);
    if (developmentUrl) return url.origin === 'http://127.0.0.1:5173' && ['/', '/index.html'].includes(url.pathname);
    return url.protocol === 'file:' && url.host === rendererUrl.host && url.pathname === rendererUrl.pathname && !url.search;
  } catch { return false; }
}

function assertSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame || !isTrustedUrl(event.senderFrame.url)) {
    throw new Error('无权执行此操作');
  }
}

function handle(channel, action) {
  ipcMain.handle(channel, async (event, value) => {
    try {
      assertSender(event);
      return { ok: true, value: await action(value) };
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作失败，请重试';
      // Native filesystem diagnostics can include full private paths.
      return { ok: false, error: /^(E[A-Z]+:|EPERM|EACCES|ENOENT)/.test(message) ? '本地文件无法访问，请检查权限或重新导入' : message,
        ...(error?.code === 'AUDIO_URL_EXPIRED' ? {code: error.code} : {}) };
    }
  });
}

function installHandlers() {
  ipcMain.handle('tray-menu:get-snapshot', event => {
    if (!trayMenu.trusted(event)) throw new Error('无权读取托盘菜单');
    return trayMenu.snapshot();
  });
  ipcMain.on('tray-menu:command', (event, command, value) => {
    if (!trayMenu.trusted(event)) return;
    try {trayMenu.command(command, value);} catch { /* Ignore unknown menu commands. */ }
  });
  ipcMain.on('tray-player:update', (event, state) => {
    try {assertSender(event); trayMenu.update(state); lifecycle.refreshTray();} catch { /* Reject untrusted state. */ }
  });
  handle('library:list', () => registry.list());
  handle('library:import', async () => {
    if (importPending) return [];
    importPending = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入本地音乐', buttonLabel: '导入音乐', properties: ['openFile', 'multiSelections'],
        filters: [{ name: '音频文件', extensions: AUDIO_EXTENSIONS }],
      });
      return result.canceled ? [] : await registry.importFiles(result.filePaths);
    } finally { importPending = false; }
  });
  handle('library:remove', localId => registry.remove(localId));
  handle('library:import-folders', async () => {
    const canceled = {tracks: [], canceled: true, truncated: false, scannedEntries: 0, skippedDirectories: 0};
    if (importPending) return canceled;
    importPending = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入音乐文件夹', buttonLabel: '导入文件夹', properties: ['openDirectory', 'multiSelections'],
      });
      return result.canceled ? canceled : await registry.importFolders(result.filePaths);
    } finally {importPending = false;}
  });
  handle('library:resolve', localId => registry.resolveUrl(localId));
  handle('library:lyrics', localId => registry.readLyrics(localId));
  handle('service:request', value => requestApi(value));
  handle('playlist:resolve-id', resolvePlaylistId);
  handle('app:version', () => app.getVersion());
  handle('app:open-project', () => shell.openExternal('https://github.com/XG2020/Xmusic_App'));
  handle('online:resolve', input => onlineAudio.resolve(input));
  handle('online:failure', source => onlineAudio.failure(source));
  handle('app:preferences', () => preferences.snapshot());
  handle('app:set-preferences', patch => preferences.update(patch));
  ipcMain.handle('clipboard:copy', (event, text) => {
    if (!desktopLyrics.trusted(event)) assertSender(event);
    if (typeof text !== 'string' || !text || text.length > 2000000) throw new Error('复制内容为空或过长');
    clipboard.writeText(text);
  });
  handle('window:close-prompt-state', () => lifecycle.getClosePrompt());
  handle('window:close-prompt-response', response => lifecycle.respondToClosePrompt(response));
  handle('downloads:list', () => downloads.snapshot());
  handle('downloads:start', request => downloads.start(request));
  handle('downloads:cancel', id => downloads.cancel(id));
  handle('downloads:retry', id => downloads.retry(id));
  handle('downloads:pause', id => downloads.pause(id));
  handle('downloads:resume', id => downloads.resume(id));
  handle('downloads:redownload', id => downloads.redownload(id));
  handle('downloads:remove', request => downloads.remove(request));
  handle('downloads:directory', () => downloads.selectDirectory());
  handle('downloads:open-directory', id => downloads.openDirectory(id));
  handle('downloads:import', id => downloads.importDownload(id));
  handle('downloads:resolve-audio', async input => {
    const url = await downloads.resolveDownloadedAudio(input);
    if (url && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library:changed', registry.list());
    return url;
  });
  handle('downloads:clear', () => downloads.clearHistory());
  handle('desktop-lyrics:state', () => desktopLyrics.state());
  handle('desktop-lyrics:visible', visible => desktopLyrics.setVisible(visible));
  handle('desktop-lyrics:locked', locked => desktopLyrics.setLocked(locked));
  ipcMain.on('desktop-lyrics:update', (event, content) => {
    try { assertSender(event); desktopLyrics.update(content); lifecycle.refreshTray(); } catch { /* Reject untrusted or invalid content. */ }
  });
  ipcMain.handle('desktop-lyrics:get-snapshot', event => {
    if (!desktopLyrics.trusted(event)) throw new Error('无权读取桌面歌词');
    return desktopLyrics.snapshot();
  });
  ipcMain.on('desktop-lyrics:command', (event, command) => {
    try {
      if (!desktopLyrics.trusted(event)) return;
      desktopLyrics.command(command);
    } catch { /* Only the known overlay commands are accepted. */ }
  });
  ipcMain.on('desktop-lyrics:size', (event, size) => {
    try {
      if (desktopLyrics.trusted(event)) desktopLyrics.resizeToContent(size);
    } catch { /* Reject invalid or stale layout measurements. */ }
  });
  for (const [channel, action] of [
    ['window:minimize', () => mainWindow.minimize()],
    ['window:maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()],
    ['window:close', () => mainWindow.close()],
  ]) {
    ipcMain.on(channel, event => {
      try { assertSender(event); action(); } catch { /* Ignore untrusted window-control messages. */ }
    });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380, height: 900, minWidth: 1000, minHeight: 680,
    title: 'Xmusic', frame: false, show: false, backgroundColor: '#141b17', icon: lifecycle.windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true,
      allowRunningInsecureContent: false, spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!isTrustedUrl(url)) event.preventDefault(); });
  mainWindow.webContents.on('will-redirect', (event, url) => { if (!isTrustedUrl(url)) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  lifecycle.attachWindow(mainWindow);
  mainWindow.on('closed', () => { mainWindow = null; });
  return developmentUrl ? mainWindow.loadURL(developmentUrl) : mainWindow.loadFile(rendererFile);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.xmusic.desktop');
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    registry = new AudioRegistry(app.getPath('userData'));
    await registry.load();
    onlineAudio = new OnlineAudioService({requestApi});
    downloads = new DownloadManager({
      dataDirectory: app.getPath('userData'),
      defaultDirectory: path.join(app.getPath('downloads'), 'Xmusic'),
      registry,
      chooseDirectory: async currentDirectory => {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: '选择音乐下载文件夹', defaultPath: currentDirectory,
          properties: ['openDirectory', 'createDirectory'], buttonLabel: '保存到这里',
        });
        return result.canceled ? null : result.filePaths[0];
      },
      openDirectory: async directory => {
        if (await shell.openPath(directory)) throw new Error('无法打开下载文件夹，请检查文件夹是否存在。');
      },
      notify: snapshot => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('downloads:changed', snapshot);
      },
    });
    await downloads.load();
    desktopLyrics = new DesktopLyrics({
      BrowserWindow, screen, headless: process.env.XMUSIC_HEADLESS === '1',
      preferencesPath: path.join(app.getPath('userData'), 'desktop-lyrics.json'),
      notify: state => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-lyrics:state-changed', state);
        lifecycle.refreshTray();
      },
      playback: command => lifecycle.playback(command),
      showMain: showMainWindow,
    });
    protocol.handle('xmusic-audio', request => localAudioResponse(request, registry));
    protocol.handle('xmusic-online', request => onlineAudio.respond(request));
    installHandlers();
    await createWindow();
    lifecycle.createTray();
    updateShortcuts();
    app.on('activate', () => { if (!mainWindow) void createWindow(); else showMainWindow(); });
  }).catch(error => {
    if (process.env.XMUSIC_HEADLESS === '1') console.error('Xmusic 启动失败:', error.message || '无法启动播放器');
    else dialog.showErrorBox('XMusic 启动失败', error.message || '无法启动播放器');
    lifecycle.requestQuit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') lifecycle.requestQuit(); });
  app.on('before-quit', event => lifecycle.beforeQuit(event));
  app.on('will-quit', () => lifecycle.disposeNative());
}
