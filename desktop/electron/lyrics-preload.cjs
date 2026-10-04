'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('floatingLyrics', Object.freeze({
  getSnapshot: () => ipcRenderer.invoke('desktop-lyrics:get-snapshot'),
  onSnapshot: callback => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('desktop-lyrics:snapshot', handler);
    return () => ipcRenderer.removeListener('desktop-lyrics:snapshot', handler);
  },
  onPointerInside: callback => {
    const handler = (_event, inside) => callback(inside === true);
    ipcRenderer.on('desktop-lyrics:pointer', handler);
    return () => ipcRenderer.removeListener('desktop-lyrics:pointer', handler);
  },
  command: command => ipcRenderer.send('desktop-lyrics:command', command),
  reportSize: size => ipcRenderer.send('desktop-lyrics:size', size),
  copyText: text => ipcRenderer.invoke('clipboard:copy', text),
}));
