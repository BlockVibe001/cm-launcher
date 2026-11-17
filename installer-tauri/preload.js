const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  info: () => ipcRenderer.invoke('installer:info'),
  pickDir: () => ipcRenderer.invoke('installer:pick-dir'),
  install: (payload) => ipcRenderer.invoke('installer:install', payload),
  launch: (targetDir) => ipcRenderer.invoke('installer:launch', targetDir),
  minimize: () => ipcRenderer.send('installer:minimize'),
  close: () => ipcRenderer.send('installer:close'),
  onProgress: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('installer:progress', handler);
    return () => ipcRenderer.removeListener('installer:progress', handler);
  },
});
