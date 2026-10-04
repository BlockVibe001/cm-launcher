// 启动器自更新
// 四件事：读用户填的更新地址拿清单 → 比对版本 → 流式下载安装包 → 静默安装并退出。
// 不依赖 electron-updater：那套要把更新源写死在构建配置里，且不支持免安装的 portable 版。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const { app } = require('electron');
const logger = require('../logger');

const UA = 'BlockVibeLauncher/1.0.0 (minecraft launcher)';
const PROGRESS_STEP_MS = 200;

function currentVersion() {
  return app.getVersion();
}

/**
 * 免安装版（portable）每次运行都解压到临时目录，自己那个 exe 是只读的临时副本，
 * 没法自我替换 —— 界面上要据此把「立即更新」降级成「打开下载页」。
 */
function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

function versionParts(v) {
  return String(v || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.\-+_]/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

/** 按数字段逐位比较：字符串比较会把 1.10.0 判成小于 1.9.0 */
function compareVersion(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  const n = Math.max(x.length, y.length, 1);
  for (let i = 0; i < n; i++) {
    const p = x[i] || 0;
    const q = y[i] || 0;
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 读清单。地址由用户自己填，任何 host 都接受，不套国内镜像替换。 */
async function check(url) {
  const target = str(url);
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('更新地址无效，需要以 http:// 或 https:// 开头');
  }
  let res;
  try {
    res = await fetch(target, {
      headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' },
      redirect: 'follow',
    });
  } catch (e) {
    throw new Error(`连不上更新地址：${e.message}`);
  }
  if (!res.ok) throw new Error(`读取更新清单失败：HTTP ${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('更新清单不是合法的 JSON');
  }
  const latest = str(data && data.version);
  if (!latest) throw new Error('更新清单缺少 version 字段');

  const current = currentVersion();
  return {
    current,
    latest,
    hasUpdate: compareVersion(latest, current) > 0,
    notes: str(data && data.notes),
    publishedAt: str(data && data.publishedAt),
    installer: str(data && data.installer),
    sha256: str(data && data.sha256).toLowerCase(),
    page: str(data && data.page),
    portable: isPortable(),
  };
}

function updateDir() {
  return path.join(app.getPath('userData'), 'update');
}

/**
 * 流式下载安装包到 <userData>/update。
 * 不用 downloader.downloadFile：那个是一次性 arrayBuffer()，98MB 的包会整块进内存且没有进度。
 */
async function download(manifest, onProgress) {
  const url = str(manifest && manifest.installer);
  if (!/^https?:\/\//i.test(url)) throw new Error('清单里没有可用的安装包地址');

  const dir = updateDir();
  fs.mkdirSync(dir, { recursive: true });
  let base = 'setup.exe';
  try {
    base = path.basename(new URL(url).pathname) || base;
  } catch { /* 地址异常就用默认名 */ }
  if (!/\.exe$/i.test(base)) base = `${base}.exe`;
  const dest = path.join(dir, base);
  const tmp = `${dest}.part`;

  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`下载安装包失败：HTTP ${res.status}`);
  if (!res.body) throw new Error('下载安装包失败：响应没有内容');

  const total = Number(res.headers.get('content-length')) || 0;
  const wanted = str(manifest && manifest.sha256).toLowerCase();
  const hash = wanted ? crypto.createHash('sha256') : null;

  let received = 0;
  let lastTick = 0;
  const started = Date.now();

  // 进度和 sha256 必须在同一根管道里算。之前在 pipe 之外另挂一个 'data' 监听，
  // 会让 Readable.fromWeb 的流同时被两个消费者读：data 事件看到的字节是对的，
  // 但写进文件的那份是另一套顺序，结果就是「sha256 校验通过、落盘文件却是坏的」。
  // 用 Transform 串进管道，保证「算过的字节就是写下去的字节」。
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (hash) hash.update(chunk);
      const now = Date.now();
      if (typeof onProgress === 'function' && (now - lastTick >= PROGRESS_STEP_MS || received === total)) {
        lastTick = now;
        const secs = (now - started) / 1000;
        onProgress({
          percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0,
          received,
          total,
          speed: secs > 0 ? Math.round(received / secs) : 0,
        });
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清不掉就算了 */ }
    throw new Error(`下载安装包失败：${e.message}`);
  }

  if (hash && hash.digest('hex') !== wanted) {
    try { fs.unlinkSync(tmp); } catch { /* 同上 */ }
    throw new Error('安装包校验失败（sha256 不匹配），已丢弃，请重试');
  }

  try { fs.unlinkSync(dest); } catch { /* 首次下载没有旧文件 */ }
  fs.renameSync(tmp, dest);
  if (typeof onProgress === 'function') {
    onProgress({ percent: 100, received, total: total || received, speed: 0 });
  }
  logger.info(`更新包已下载：${dest}（${received} 字节）`);
  return { path: dest, size: received };
}

/**
 * 静默安装。装完由安装包自己拉起新版，所以这里起完进程就让调用方退出。
 * /S 无界面安装；--updated 让旧版卸载时保留用户数据而不是清库；
 * --force-run 是辅助式安装器在静默模式下唯一的重启开关（见 NSIS 模板 installSection.nsh），少了它装完就没人拉起启动器。
 */
function install(setupPath) {
  if (isPortable()) throw new Error('免安装版无法自更新，请点「打开下载页」获取新版');
  const file = str(setupPath);
  if (!file || !fs.existsSync(file)) throw new Error('安装包不存在，请重新下载');

  const child = spawn(file, ['/S', '--updated', '--force-run'], {
    cwd: path.dirname(file),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  logger.info(`启动静默安装：${file}`);
  return { pid: child.pid, path: file };
}

module.exports = {
  currentVersion,
  isPortable,
  compareVersion,
  check,
  download,
  install,
  updateDir,
};