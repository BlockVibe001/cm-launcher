const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { execFile, execSync } = require('child_process');
const { app } = require('electron');
const config = require('../config');
const logger = require('../logger');
const { extractZip } = require('../util/zipread');

const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
const UA = 'BlockVibeLauncher/1.0.0 (minecraft launcher)';

/** 本启动器托管的 Java 安装目录 */
function javaHome() {
  const dir = path.join(app.getPath('userData'), 'java');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function versionInfo(javaPath) {
  return new Promise((resolve) => {
    execFile(javaPath, ['-version'], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const text = `${stderr || ''}${stdout || ''}`;
      const line = text.split(/\r?\n/).find((l) => l.includes('version')) || '';
      const m = line.match(/version "(\d+)(?:\.(\d+))?/);
      if (!m) return resolve({ major: 0, text: line.trim() });
      let major = parseInt(m[1], 10);
      if (major === 1) major = parseInt(m[2] || '0', 10); // 1.8 -> 8
      resolve({ major, text: line.trim() });
    });
  });
}

function accessible(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function listSubdirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

async function findCandidates(gameDir) {
  const found = new Set();
  const add = (p) => {
    if (p && accessible(p)) found.add(path.resolve(p));
  };

  // 已配置
  add(config.get('javaPath'));
  // JAVA_HOME
  if (process.env.JAVA_HOME) add(path.join(process.env.JAVA_HOME, 'bin', exeName));

  // 本启动器下载的 Java（userData/java/jre-<major>）
  for (const dir of listSubdirs(javaHome())) {
    add(path.join(javaHome(), dir, 'bin', exeName));
    add(path.join(javaHome(), dir, 'Contents', 'Home', 'bin', exeName));
  }

  if (process.platform === 'win32') {
    // PATH
    try {
      const out = execSync('where java', { windowsHide: true, timeout: 5000 }).toString();
      out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach(add);
    } catch {
      // PATH 中没有 java
    }

    // 注册表
    const regRoots = [
      'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
      'HKLM\\SOFTWARE\\JavaSoft\\JRE',
      'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
      'HKLM\\SOFTWARE\\JavaSoft\\JDK',
      'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Runtime Environment',
      'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Development Kit',
    ];
    for (const root of regRoots) {
      try {
        const out = execSync(`reg query "${root}" /s /v JavaHome`, {
          windowsHide: true,
          timeout: 5000,
        }).toString();
        for (const m of out.matchAll(/JavaHome\s+REG_SZ\s+(.+)/g)) {
          add(path.join(m[1].trim(), 'bin', exeName));
        }
      } catch {
        // 该注册表路径不存在
      }
    }

    // 常见安装目录（深度 1）
    const roots = [
      'C:\\Program Files\\Java',
      'C:\\Program Files (x86)\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files (x86)\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\IBM',
      'C:\\Program Files\\Semeru',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium') : null,
    ].filter(Boolean);
    for (const root of roots) {
      for (const dir of listSubdirs(root)) {
        add(path.join(root, dir, 'bin', exeName));
      }
    }

    // 官方启动器自带的运行时：runtime\<组件>\windows-x64\<组件>\bin\java.exe
    const rtRoots = [
      path.join(gameDir, 'runtime'),
      path.join(app.getPath('appData'), '.minecraft', 'runtime'),
    ];
    for (const rt of rtRoots) {
      for (const comp of listSubdirs(rt)) {
        const archDir = path.join(rt, comp, `windows-${process.arch === 'arm64' ? 'arm64' : 'x64'}`);
        for (const inner of listSubdirs(archDir)) {
          add(path.join(archDir, inner, 'bin', exeName));
        }
      }
    }
  } else {
    const roots = process.platform === 'darwin'
      ? ['/Library/Java/JavaVirtualMachines', '/System/Library/Java/JavaVirtualMachines']
      : ['/usr/lib/jvm', '/opt/java'];
    for (const root of roots) {
      for (const dir of listSubdirs(root)) {
        add(path.join(root, dir, 'bin', exeName));
        add(path.join(root, dir, 'Contents', 'Home', 'bin', exeName));
      }
    }
  }

  return [...found];
}

async function listJavas() {
  const gameDir = config.get('gameDir');
  const candidates = await findCandidates(gameDir);
  const results = [];
  for (const p of candidates) {
    const info = await versionInfo(p);
    if (info) results.push({ path: p, major: info.major, text: info.text });
  }
  const uniq = new Map();
  for (const r of results) {
    if (!uniq.has(r.path)) uniq.set(r.path, r);
  }
  return [...uniq.values()].sort((a, b) => b.major - a.major);
}

/* ========== 版本匹配 ========== */

/**
 * 根据 MC 版本推断所需 Java 大版本
 * 1.20.5+ → 21 · 1.17~1.20.4 → 17 · 1.16 及更早 → 8
 */
function requiredJava(mcVersion) {
  const v = String(mcVersion || '');
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(v);
  if (!m) return { major: 21, text: 'Java 21', tip: '相对较新的版本 / 快照，建议 Java 21' };
  const minor = parseInt(m[1], 10);
  const patch = parseInt(m[2] || '0', 10);
  let major = 8;
  if (minor >= 21) major = 21;
  else if (minor === 20) major = patch >= 5 ? 21 : 17;
  else if (minor >= 17) major = 17;
  else major = 8;
  return { major, text: `Java ${major}`, tip: `${v} 需要 Java ${major}` };
}

/** 从已安装列表中挑出最合适的 Java */
function pickFor(mcVersion, javas) {
  const need = requiredJava(mcVersion).major;
  const list = [...(javas || [])].filter((j) => j && j.major > 0);
  if (!list.length) return null;
  const exact = list.find((j) => j.major === need);
  if (exact) return exact;
  // 向后兼容：高于所需版本通常可用，取最接近的
  const higher = list.filter((j) => j.major > need).sort((a, b) => a.major - b.major);
  if (higher.length) return higher[0];
  // 低版本：Java 8~11 之间可互相兼容（旧版本游戏）
  const lower = list.filter((j) => j.major < need).sort((a, b) => b.major - a.major);
  return lower[0] || null;
}

/* ========== 已安装（启动器托管） ========== */

function listInstalled() {
  const home = javaHome();
  const out = [];
  for (const dir of listSubdirs(home)) {
    if (dir.startsWith('.')) continue;
    const exe = path.join(home, dir, 'bin', exeName);
    if (accessible(exe)) out.push({ major: parseInt((dir.match(/(\d+)$/) || [])[1], 10) || 0, dir, path: exe });
  }
  return out.sort((a, b) => b.major - a.major);
}

function uninstall(major) {
  const home = javaHome();
  let removed = 0;
  for (const dir of listSubdirs(home)) {
    if (!dir.startsWith('jre-')) continue;
    const m = parseInt((dir.match(/(\d+)$/) || [])[1], 10) || 0;
    if (major && m !== major) continue;
    fs.rmSync(path.join(home, dir), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/* ========== Adoptium 自动下载 ========== */

function adoptiumUrl(major) {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const params = new URLSearchParams({
    architecture: arch,
    image_type: 'jre',
    os,
    vendor: 'eclipse',
    page_size: '1',
  });
  return `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?${params.toString()}`;
}

/** 查询某个大版本可下载的 JRE（返回下载地址与体积） */
async function adoptiumRelease(major) {
  const res = await fetch(adoptiumUrl(major), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Adoptium 查询失败（HTTP ${res.status}）`);
  const arr = await res.json();
  const first = Array.isArray(arr) ? arr[0] : null;
  const pkg = first && first.binary && first.binary.package;
  if (!pkg || !pkg.link) throw new Error(`Adoptium 未提供 Java ${major} 的安装包`);
  return {
    major,
    name: pkg.name,
    link: pkg.link,
    size: pkg.size || 0,
    version: (first.version && first.version.semver) || String(major),
  };
}

/** 流式下载并汇报进度 */
async function downloadFile(url, dest, totalSize, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  const total = Number(res.headers.get('content-length')) || totalSize || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  const src = Readable.fromWeb(res.body);
  let received = 0;
  let last = 0;
  await new Promise((resolve, reject) => {
    src.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (onProgress && now - last > 300) {
        last = now;
        onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0 });
      }
    });
    src.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    src.pipe(out);
  });
  if (onProgress) onProgress({ received, total: total || received, percent: 100 });
  return dest;
}

/** 在解压目录中查找 java 可执行文件 */
function findJavaExe(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (it.name === 'bin') {
          const exe = path.join(full, exeName);
          if (accessible(exe)) return exe;
        }
        stack.push(full);
      }
    }
  }
  return null;
}

/** 下载并解压 Java 到 userData/java/jre-<major> */
async function install(major, onProgress) {
  const info = await adoptiumRelease(major);
  const home = javaHome();
  const zipPath = path.join(home, `.tmp-jre-${major}.zip`);
  const tmpDir = path.join(home, `.tmp-extract-${major}-${Date.now()}`);

  logger.info(`开始下载 Java ${major}（${info.name}）`);
  try {
    await downloadFile(info.link, zipPath, info.size, (p) => {
      if (onProgress) onProgress({ stage: 'download', ...p });
    });
    if (onProgress) onProgress({ stage: 'extract', percent: 0 });
    fs.mkdirSync(tmpDir, { recursive: true });
    extractZip(zipPath, tmpDir, (done, total) => {
      if (onProgress) onProgress({ stage: 'extract', percent: Math.round((done / total) * 100) });
    });

    const exe = findJavaExe(tmpDir);
    if (!exe) throw new Error('安装包中未找到 java 可执行文件');

    // 顶层目录即 JAVA_HOME，移动为 jre-<major>
    const rootDir = path.dirname(path.dirname(exe));
    const dest = path.join(home, `jre-${major}`);
    fs.rmSync(dest, { recursive: true, force: true });
    if (path.resolve(rootDir) === path.resolve(tmpDir)) {
      // 压缩包没有顶层目录：直接把临时目录搬过去
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(tmpDir, dest);
    } else {
      fs.renameSync(rootDir, dest);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const finalExe = path.join(dest, 'bin', exeName);
    const ver = await versionInfo(finalExe);
    logger.info(`Java ${major} 安装完成：${finalExe}`);
    return {
      major,
      home: dest,
      path: finalExe,
      version: (ver && ver.text) || info.version,
      detected: ver ? ver.major : major,
      name: info.name,
    };
  } finally {
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = {
  listJavas,
  versionInfo,
  javaHome,
  requiredJava,
  pickFor,
  listInstalled,
  uninstall,
  adoptiumRelease,
  install,
};
