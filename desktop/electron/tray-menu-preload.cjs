'use strict';

const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('trayMenu', Object.freeze({
  getSnapshot: () => ipcRenderer.invoke('tray-menu:get-snapshot'),
  onSnapshot(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('tray-menu:snapshot', listener);
    return () => ipcRenderer.removeListener('tray-menu:snapshot', listener);
  },
  command: (action, value) => ipcRenderer.send('tray-menu:command', action, value),
}));
