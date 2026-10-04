'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, value) {
  const response = await ipcRenderer.invoke(channel, value);
  if (!response || !response.ok) {
    throw new Error(response?.error || '操作失败，请重试');
  }
  return response.value;
}

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  importAudio: () => invoke('library:import'),
  importAudioFolders: () => invoke('library:import-folders'),
  resolvePlaylistId: input => invoke('playlist:resolve-id', input),
  updateTrayPlayer: state => ipcRenderer.send('tray-player:update', state),
  onTrayPlayerCommand: callback => subscribe('tray-player:command', callback),
  getLocalTracks: () => invoke('library:list'),
  onLocalTracksChanged: callback => subscribe('library:changed', callback),
  resolveDownloadedAudio: input => invoke('downloads:resolve-audio', input),
  removeLocalTrack: localId => invoke('library:remove', localId),
  resolveLocalAudio: localId => invoke('library:resolve', localId),
  readLocalLyrics: localId => invoke('library:lyrics', localId),
  requestApi: request => invoke('service:request', request),
  getVersion: () => invoke('app:version'),
  openProjectPage: () => invoke('app:open-project'),
  resolveOnlineAudio: async input => {
    const response = await ipcRenderer.invoke('online:resolve', input);
    if (response?.ok) return response.value;
    // contextBridge drops custom properties on rejected Error objects. Carry
    // this actionable failure as plain data; the renderer rebuilds its Error.
    if (response?.code === 'AUDIO_URL_EXPIRED') return {code: response.code, message: response.error};
    throw new Error(response?.error || '操作失败，请重试');
  },
  getOnlineAudioFailure: source => invoke('online:failure', source),
  getPreferences: () => invoke('app:preferences'),
  setPreferences: patch => invoke('app:set-preferences', patch),
  onPreferencesChanged: callback => subscribe('app:preferences-changed', callback),
  copyText: text => ipcRenderer.invoke('clipboard:copy', text),
  getClosePrompt: () => invoke('window:close-prompt-state'),
  respondToClosePrompt: response => invoke('window:close-prompt-response', response),
  onClosePrompt: callback => subscribe('window:close-prompt', callback),
  getDownloads: () => invoke('downloads:list'),
  startDownload: request => invoke('downloads:start', request),
  cancelDownload: id => invoke('downloads:cancel', id),
  retryDownload: id => invoke('downloads:retry', id),
  pauseDownload: id => invoke('downloads:pause', id),
  resumeDownload: id => invoke('downloads:resume', id),
  redownload: id => invoke('downloads:redownload', id),
  removeDownload: request => invoke('downloads:remove', request),
  selectDownloadDirectory: () => invoke('downloads:directory'),
  openDownloadDirectory: id => invoke('downloads:open-directory', id),
  importDownload: id => invoke('downloads:import', id),
  clearDownloadHistory: () => invoke('downloads:clear'),
  onDownloadsChanged: callback => subscribe('downloads:changed', callback),
  getDesktopLyricsState: () => invoke('desktop-lyrics:state'),
  setDesktopLyricsVisible: visible => invoke('desktop-lyrics:visible', visible),
  setDesktopLyricsLocked: locked => invoke('desktop-lyrics:locked', locked),
  updateDesktopLyrics: content => ipcRenderer.send('desktop-lyrics:update', content),
  onDesktopLyricsState: callback => subscribe('desktop-lyrics:state-changed', callback),
  onDesktopPlaybackCommand: callback => subscribe('desktop-lyrics:playback', callback),
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
}));
