// 下载任务队列：统一管理下载任务、进度、限速与历史
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { app } = require('electron');
const logger = require('../logger');

const UA = 'BlockVibeLauncher/1.0.0 (minecraft launcher)';
const MAX_CONCURRENT = 3;
const MAX_HISTORY = 120;

let seq = 0;
const tasks = new Map();     // id -> task
let pending = [];            // 排队中的任务 id
let running = 0;
let notify = () => {};
let storePath = null;

/* ---------- 持久化 ---------- */

function file() {
  if (!storePath) storePath = path.join(app.getPath('userData'), 'downloads.json');
  return storePath;
}

// 延迟到首次使用时再读盘，避免 app ready 前访问用户目录
let loaded = false;
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  load();
}

function persist() {
  try {
    const done = [...tasks.values()].filter((t) => t.finishedAt).slice(-MAX_HISTORY);
    fs.writeFileSync(file(), JSON.stringify(done.map(clean), null, 2));
  } catch { /* 持久化失败不影响下载 */ }
}

function clean(t) {
  const out = {};
  for (const [k, v] of Object.entries(t)) {
    if (k.startsWith('_')) continue;   // 内部字段（_opts / _cancel / _onCancel）不落盘
    out[k] = v;
  }
  return out;
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(file(), 'utf8'));
    for (const t of arr || []) {
      // 上次未收尾的任务标记为已中断
      if (!t.finishedAt) { t.status = 'failed'; t.error = '应用已退出'; t.finishedAt = Date.now(); }
      tasks.set(t.id, t);
    }
  } catch { /* 首次运行 */ }
}

/* ---------- 对外 ---------- */

function setNotifier(fn) { notify = fn; }

function emit() { notify(list()); }

function list() {
  ensureLoaded();
  return [...tasks.values()]
    .map(clean)
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

function defaultDir() {
  const dir = path.join(app.getPath('userData'), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function create(name, kind, opts = {}) {
  const id = `dl-${Date.now().toString(36)}-${++seq}`;
  const t = {
    id,
    name: String(name || '未命名文件'),
    kind: kind || 'file',
    url: opts.url || '',
    dest: opts.dest || '',
    status: 'queued',
    percent: 0,
    received: 0,
    total: opts.size || 0,
    speed: 0,
    error: '',
    addedAt: Date.now(),
    finishedAt: 0,
    _opts: opts,
    _cancel: false,
  };
  tasks.set(id, t);
  emit();
  return t;
}

function update(id, patch) {
  const t = tasks.get(id);
  if (!t) return null;
  Object.assign(t, patch);
  emit();
  return t;
}

/**
 * 外部接管下载（如内置浏览器窗口）时的收尾：写入终态并把历史落盘。
 * 这类下载的流程不归本模块跑，所以不走 track()，改用它。
 */
function settle(id, patch) {
  const t = update(id, patch);
  persist();
  return t;
}

/**
 * 追踪一个已有的下载动作（不负责落盘，只做进度登记）
 * @param {string} name 显示名
 * @param {string} kind 分类 mod/modpack/shader/...
 * @param {(onProgress:Function)=>Promise<any>} fn 实际执行函数
 */
async function track(name, kind, fn, opts = {}) {
  const t = create(name, kind, opts);
  t.status = 'running';
  t.startedAt = Date.now();
  emit();
  try {
    const res = await fn((p) => {
      if (typeof p === 'number') update(t.id, { percent: Math.max(0, Math.min(100, p)) });
      else if (p && typeof p === 'object') {
        update(t.id, {
          percent: p.percent != null ? p.percent : t.percent,
          received: p.received != null ? p.received : t.received,
          total: p.total || t.total,
          name: p.name || t.name,
        });
      }
    });
    t.status = 'done';
    t.percent = 100;
    t.finishedAt = Date.now();
    emit();
    persist();
    return res;
  } catch (e) {
    t.status = 'failed';
    t.error = e.message || String(e);
    t.finishedAt = Date.now();
    emit();
    persist();
    throw e;
  }
}

/** 加入下载队列（自己负责真正的 HTTP 下载） */
function enqueue(opts) {
  const t = create(opts.name || guessName(opts.url), opts.kind, opts);
  pending.push(t.id);
  pump();
  return t.id;
}

function guessName(url) {
  try {
    const base = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '');
    return base || '未命名文件';
  } catch { return '未命名文件'; }
}

function pump() {
  while (running < MAX_CONCURRENT && pending.length) {
    const id = pending.shift();
    const t = tasks.get(id);
    if (!t || t._cancel) continue;
    running++;
    runJob(t).finally(() => { running--; pump(); });
  }
}

async function runJob(t) {
  t.status = 'running';
  t.startedAt = Date.now();
  emit();
  try {
    await download(t, t._opts);
    t.status = 'done';
    t.percent = 100;
    t.finishedAt = Date.now();
    t.speed = 0;
    logger.info(`下载完成：${t.name}`);
  } catch (e) {
    if (t._cancel) {
      t.status = 'cancelled';
      t.error = '';
    } else {
      t.status = 'failed';
      t.error = e.message || String(e);
    }
    t.finishedAt = Date.now();
    t.speed = 0;
  }
  emit();
  persist();
}

async function download(t, opts) {
  const res = await fetch(opts.url, {
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  const total = Number(res.headers.get('content-length')) || t.total || 0;
  t.total = total;

  const dest = opts.dest || path.join(defaultDir(), t.name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  const src = Readable.fromWeb(res.body);

  let received = 0;
  let lastEmit = 0;
  let lastBytes = 0;
  let lastTime = Date.now();
  let settled = false;

  await new Promise((resolve, reject) => {
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { src.destroy(); } catch { /* ignore */ }
      try { out.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    src.on('data', (chunk) => {
      received += chunk.length;
      if (t._cancel) { fail(new Error('已取消')); return; }
      const now = Date.now();
      if (now - lastEmit >= 300) {
        const dt = (now - lastTime) / 1000;
        t.speed = dt > 0 ? (received - lastBytes) / dt : 0;
        t.received = received;
        t.percent = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
        lastEmit = now;
        lastBytes = received;
        lastTime = now;
        emit();
      }
    });
    src.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    src.pipe(out);
  });

  if (t._cancel) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error('已取消');
  }
  fs.renameSync(tmp, dest);
  t.received = received;
  t.total = total || received;
  t.dest = dest;
  return dest;
}

function cancel(id) {
  const t = tasks.get(id);
  if (!t) throw new Error('任务不存在');
  t._cancel = true;
  // 外部接管的下载（浏览器窗口）需要自己去把底层任务停掉
  if (typeof t._onCancel === 'function') {
    try { t._onCancel(); } catch { /* 任务已经结束了 */ }
  }
  if (t.status === 'queued') {
    pending = pending.filter((x) => x !== id);
    t.status = 'cancelled';
    t.finishedAt = Date.now();
    emit();
    persist();
  }
  return true;
}

function retry(id) {
  const t = tasks.get(id);
  if (!t) throw new Error('任务不存在');
  t._cancel = false;
  t.error = '';
  t.percent = 0;
  t.received = 0;
  t.speed = 0;
  t.status = 'queued';
  t.finishedAt = 0;
  t.addedAt = Date.now();
  pending.push(id);
  emit();
  pump();
  return true;
}

function remove(id) {
  const t = tasks.get(id);
  if (!t) return false;
  if (t.status === 'running' || t.status === 'queued') cancel(id);
  pending = pending.filter((x) => x !== id);
  tasks.delete(id);
  emit();
  persist();
  return true;
}

function clearFinished() {
  for (const [id, t] of [...tasks.entries()]) {
    if (t.finishedAt) tasks.delete(id);
  }
  emit();
  persist();
  return true;
}

function openDir() {
  return defaultDir();
}

module.exports = {
  setNotifier,
  list,
  create,
  update,
  settle,
  track,
  enqueue,
  cancel,
  retry,
  remove,
  clearFinished,
  defaultDir,
  openDir,
  MAX_CONCURRENT,
};