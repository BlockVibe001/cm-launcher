// 内置浏览器：独立窗口 + 多标签网页视图 + 下载接管
//
// 窗口是单例：启动器点一次开一个，再点就把已经开着的那个拎到前面。
// 登录态走持久化分区（userData/Partitions/cmbrowser），关掉启动器再开还在。
// 网页里点出来的下载统一登记进启动器的下载队列，并按文件名分流到当前实例的
// mods / resourcepacks / schematics，认不出类型或玩家把模式改成「只存下载目录」时
// 就落启动器自己的下载目录，之后可以在下载页拖进启动器导入。
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session, dialog, nativeTheme } = require('electron');
const config = require('../config');
const logger = require('../logger');
const downloads = require('./downloads');
const instances = require('../minecraft/instances');

const PARTITION = 'persist:cmbrowser';

/** 默认收藏栏：查资料、找资源、登录三件事的入口 */
const DEFAULT_BOOKMARKS = [
  { name: 'MC 百科', url: 'https://www.mcmod.cn/' },
  { name: 'CurseForge', url: 'https://www.curseforge.com/minecraft' },
  { name: 'Modrinth', url: 'https://modrinth.com/' },
  { name: 'LittleSkin', url: 'https://littleskin.cn/' },
  { name: '微软账号', url: 'https://www.microsoft.com/link' },
];

/** 下载落地方式：自动分流 / 每次弹框 / 只存下载目录 */
const MODES = ['auto', 'ask', 'queue'];

let win = null;
let hooked = false;

/* ---------- 收藏栏与下载模式 ---------- */

function bookmarks() {
  const saved = config.get('browserBookmarks');
  // null / 非数组表示「还没自己调过」，用默认那几条；空数组表示玩家清空了，得尊重
  return Array.isArray(saved) ? saved : DEFAULT_BOOKMARKS.slice();
}

function setBookmarks(list) {
  const clean = (Array.isArray(list) ? list : [])
    .filter((b) => b && /^https?:\/\//i.test(String(b.url || '')))
    .map((b) => ({ name: String(b.name || b.url).slice(0, 40), url: String(b.url) }))
    .slice(0, 40);
  config.set('browserBookmarks', clean);
  return clean;
}

function downloadMode() {
  const m = config.get('browserDownloadMode');
  return MODES.includes(m) ? m : 'auto';
}

function setDownloadMode(mode) {
  if (!MODES.includes(mode)) throw new Error('未知的下载保存方式');
  config.set('browserDownloadMode', mode);
  return mode;
}

function info() {
  return {
    bookmarks: bookmarks(),
    downloadMode: downloadMode(),
    modes: MODES,
    partition: PARTITION,
    // 浏览器窗口跟着启动器的外观走
    theme: config.get('theme') || 'dark',
    accent: config.get('accent') || 'axolotl',
    ui: config.get('ui') || {},
  };
}

/* ---------- 下载文件是什么、该落哪儿 ---------- */

function fileNameOf(url, filename) {
  if (filename) return String(filename);
  try {
    return decodeURIComponent(String(url || '').split('?')[0].split('/').pop() || '');
  } catch { return ''; }
}

/**
 * 靠文件名判断这是什么东西（必要时参考来源地址里的关键词）。
 * dir 为空表示「塞不进实例」，落启动器下载目录。
 */
function classify(url, filename) {
  const name = fileNameOf(url, filename).toLowerCase();
  const hint = `${name} ${String(url || '').toLowerCase()}`;
  if (name.endsWith('.jar')) return { kind: 'mod', dir: 'mods', label: '模组' };
  if (/\.(schem|schematic|litematic|nbt)$/.test(name)) return { kind: 'schematic', dir: 'schematics', label: '投影' };
  if (name.endsWith('.mrpack')) return { kind: 'modpack', dir: '', label: '整合包' };
  if (/\.(zip|mcworld)$/.test(name)) {
    if (/shader|光影/.test(hint)) return { kind: 'shaderpack', dir: 'shaderpacks', label: '光影' };
    if (/data.?pack|数据包/.test(hint)) return { kind: 'datapack', dir: 'datapacks', label: '数据包' };
    if (/(modpack|整合包)/.test(hint)) return { kind: 'modpack', dir: '', label: '整合包' };
    if (/(world|saves|存档|地图)/.test(hint)) return { kind: 'world', dir: '', label: '存档' };
    return { kind: 'resourcepack', dir: 'resourcepacks', label: '资源包' };
  }
  return { kind: 'file', dir: '', label: '文件' };
}

/** 当前实例的游戏目录；实例不存在（已被删）就退回全局设置里的那个 */
function currentGameDir() {
  const inst = instances.getInstance(config.get('selectedInstance'));
  return (inst && inst.gameDir) || config.get('gameDir');
}

/** 分流目标目录；实例目录建不出来就退回下载目录，不让下载直接失败 */
function targetDir(rule) {
  if (!rule.dir) return downloads.defaultDir();
  try {
    const dir = path.join(currentGameDir(), rule.dir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return downloads.defaultDir();
  }
}

/** 重名时自动加 (1)(2)，别把已有的模组覆盖掉 */
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 1000; i += 1) {
    const next = `${base} (${i})${ext}`;
    if (!fs.existsSync(next)) return next;
  }
  return p;
}

/* ---------- 下载接管 ---------- */

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function attachDownloads() {
  const ses = session.fromPartition(PARTITION);
  if (hooked) return ses;
  hooked = true;
  // 有些站点看见 UA 里的 Electron 字样会直接拦掉，抹掉它
  try {
    ses.setUserAgent(ses.getUserAgent().replace(/\s*(Electron|cm-minecraft-launcher)\/[\d.]*/gi, '').trim());
  } catch { /* 拿不到 UA 就算了 */ }
  ses.on('will-download', (_e, item) => trackDownload(item));
  return ses;
}

function trackDownload(item) {
  const name = path.basename(item.getFilename() || '') || '未命名文件';
  const url = item.getURL();
  const rule = classify(url, name);
  const mode = downloadMode();
  const parent = win && !win.isDestroyed() ? win : null;

  const task = downloads.create(name, rule.kind, { url, dest: '' });
  downloads.update(task.id, { status: 'running', startedAt: Date.now(), total: item.getTotalBytes() || 0 });
  // 下载页点「取消」时，得把底层这个真实任务也停掉
  task._onCancel = () => { try { item.cancel(); } catch { /* 已经结束了 */ } };

  const place = (dest) => {
    task._opts.dest = dest;      // 重试时也回到同一个地方
    item.setSavePath(dest);
    downloads.update(task.id, { dest });
  };

  if (mode === 'ask') {
    item.pause();
    const opts = { title: '保存到', defaultPath: path.join(downloads.defaultDir(), name) };
    const asking = parent ? dialog.showSaveDialog(parent, opts) : dialog.showSaveDialog(opts);
    asking.then((res) => {
      if (res.canceled || !res.filePath) { item.cancel(); return; }
      place(res.filePath);
      item.resume();
    }).catch(() => { try { item.cancel(); } catch { /* 已经结束了 */ } });
  } else {
    const dir = mode === 'queue' ? downloads.defaultDir() : targetDir(rule);
    place(uniquePath(path.join(dir, name)));
  }

  item.on('updated', () => {
    const total = item.getTotalBytes();
    const received = item.getReceivedBytes();
    downloads.update(task.id, {
      received,
      total,
      percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
    });
  });

  item.on('done', (_ev, state) => {
    const dest = item.getSavePath() || '';
    if (state === 'completed') {
      downloads.settle(task.id, { status: 'done', percent: 100, finishedAt: Date.now(), dest });
      logger.info(`浏览器下载完成：${name} → ${dest}`);
      send('bw:download', { ok: true, name, dest, label: rule.label });
    } else if (state === 'cancelled') {
      downloads.settle(task.id, { status: 'cancelled', finishedAt: Date.now(), error: '' });
    } else {
      downloads.settle(task.id, { status: 'failed', finishedAt: Date.now(), error: '下载中断', dest });
    }
  });
}

/* ---------- 窗口 ---------- */

/** 页面里 target=_blank / window.open 一律收成新标签，不弹系统浏览器 */
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) send('bw:newTab', url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!/^https?:/i.test(url)) e.preventDefault();
  });
});

/** 窗口底色跟着主题走，避免浅色模式下先黑一下 */
function bgColor() {
  const t = config.get('theme') || 'dark';
  const dark = t === 'system' ? nativeTheme.shouldUseDarkColors : t !== 'light';
  return dark ? '#0b0f17' : '#f2f5fa';
}

function isOpen() {
  return !!(win && !win.isDestroyed());
}

function open(url) {
  if (isOpen()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    if (url) send('bw:navigate', url);
    return true;
  }

  attachDownloads();
  win = new BrowserWindow({
    width: 980,
    height: 660,
    minWidth: 640,
    minHeight: 440,
    backgroundColor: bgColor(),
    frame: false,
    title: 'CM 浏览器',
    webPreferences: {
      preload: path.join(__dirname, '..', 'browser-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  win.setMenuBarVisibility(false);
  // 网页视图强制走持久化分区，并且不许它有 node 能力
  win.webContents.on('will-attach-webview', (_e, prefs) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.partition = PARTITION;
  });
  win.on('closed', () => { win = null; });
  win.webContents.once('did-finish-load', () => { if (url) send('bw:navigate', url); });
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'browser.html'));
  return true;
}

function close() {
  if (isOpen()) win.close();
}

/** 无边框窗口右上角那三个按钮 */
function windowAction(action) {
  if (!isOpen()) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
  else if (action === 'close') win.close();
}

module.exports = {
  PARTITION,
  DEFAULT_BOOKMARKS,
  MODES,
  classify,
  targetDir,
  currentGameDir,
  bookmarks,
  setBookmarks,
  downloadMode,
  setDownloadMode,
  info,
  attachDownloads,
  open,
  close,
  isOpen,
  windowAction,
};