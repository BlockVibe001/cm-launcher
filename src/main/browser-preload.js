// 内置浏览器窗口的 preload：只暴露浏览器窗口自己要用的那几个能力
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 收藏栏 / 下载保存方式
  info: () => ipcRenderer.invoke('browser:info'),
  setBookmarks: (list) => ipcRenderer.invoke('browser:setBookmarks', list),
  setDownloadMode: (mode) => ipcRenderer.invoke('browser:setDownloadMode', mode),
  openDownloadDir: () => ipcRenderer.invoke('downloads:openDir'),

  // 窗口控制（无边框）
  minimize: () => ipcRenderer.send('bw:window', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('bw:window', 'maximize'),
  close: () => ipcRenderer.send('bw:window', 'close'),

  // 主进程推过来的事件
  onNavigate: (cb) => ipcRenderer.on('bw:navigate', (_e, url) => cb(url)),
  onNewTab: (cb) => ipcRenderer.on('bw:newTab', (_e, url) => cb(url)),
  onDownload: (cb) => ipcRenderer.on('bw:download', (_e, info) => cb(info)),
});