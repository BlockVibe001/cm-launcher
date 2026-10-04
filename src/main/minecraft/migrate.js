// 从其他启动器搬家：探测 PCL2 / HMCL 的安装目录、实例、存档与设置，导入本启动器
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const config = require('../config');
const logger = require('../logger');
const instances = require('./instances');

const LAUNCHERS = [
  {
    id: 'pcl2',
    name: 'PCL2',
    fullName: 'Plain Craft Launcher 2',
    icon: '🟦',
    dirNames: ['PCL', 'Plain Craft Launcher 2'],
  },
  {
    id: 'hmcl',
    name: 'HMCL',
    fullName: 'Hello Minecraft! Launcher',
    icon: '🟩',
    dirNames: ['HMCL', '.hmcl'],
  },
];

/* ---------- 工具 ---------- */

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function subdirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { return []; }
}

function countFiles(dir, exts) {
  try {
    return fs.readdirSync(dir).filter((f) => !exts || exts.includes(path.extname(f).toLowerCase())).length;
  } catch { return 0; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function safeName(s) {
  return String(s || '实例').replace(/[\\/:*?"<>|]/g, '_').trim() || '实例';
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function uniqueDir(root, name) {
  let dir = path.join(root, name);
  let n = 1;
  while (exists(dir)) dir = path.join(root, `${name}-${++n}`);
  return dir;
}

/* ---------- 探测启动器数据目录 ---------- */

function launcherDataDirs(spec) {
  const appData = app.getPath('appData');
  const home = app.getPath('home');
  // PCL2 既可能把配置放 %APPDATA%\PCL，也可能把整个启动器丢在桌面 / 文档 / 下载里，
  // 只认 %APPDATA% 会让装在别处的 PCL2 一律「扫不到」。
  const bases = process.platform === 'win32'
    ? [
      appData,
      process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      home,
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'Downloads'),
      path.join(home, 'OneDrive', 'Desktop'),
      path.join(home, 'OneDrive', 'Documents'),
    ]
    : [path.join(home, '.config'), path.join(home, 'Library', 'Application Support'), home];
  const out = [];
  for (const base of bases) {
    for (const name of spec.dirNames) {
      const dir = path.join(base, name);
      if (isDir(dir) && exists(dir) && !out.includes(dir)) out.push(dir);
    }
  }
  return out;
}

/** 除了启动器数据目录，官方 / PCL2 默认的游戏目录也要算进来 */
function defaultGameDirs() {
  const home = app.getPath('home');
  const appData = app.getPath('appData');
  const out = [
    path.join(appData, '.minecraft'),
    path.join(home, '.minecraft'),
    path.join(home, 'AppData', 'Roaming', '.minecraft'),
    path.join(home, 'Desktop', '.minecraft'),
    path.join(home, 'Documents', '.minecraft'),
  ];
  return [...new Set(out)].filter((d) => looksLikeGameDir(d));
}

/** 从 PCL2 的 ini 中提取可能是 .minecraft 的路径 */
function gameDirsFromPclIni(dataDir) {
  const out = [];
  const files = ['Setup.ini', 'PCL.ini', 'pcl.ini'];
  for (const f of files) {
    const text = readText(path.join(dataDir, f));
    if (!text) continue;
    for (const m of text.matchAll(/([A-Za-z]:\\[^\r\n"']+)/g)) {
      const p = m[1].trim().replace(/\\+$/, '');
      if (!p || out.includes(p)) continue;
      if (/(^|\\)(versions|saves|mods)(\\)?$/.test(p) || /\.minecraft$/i.test(p) || /\.minecraft\\/i.test(p)) {
        out.push(p);
      }
    }
  }
  return out;
}

/** 定位 HMCL 的游戏目录 */
function gameDirsFromHmcl(dataDir) {
  const out = [];
  const cfgFiles = [
    path.join(dataDir, 'hmcl.json'),
    path.join(dataDir, '.hmcl.json'),
    path.join(app.getPath('home'), '.hmcl.json'),
  ];
  for (const f of cfgFiles) {
    const j = readJson(f);
    if (!j) continue;
    for (const key of ['gameDir', 'selectedGameDir', 'gameDirectory']) {
      if (typeof j[key] === 'string' && exists(j[key])) out.push(j[key]);
    }
  }
  return out;
}

/** 判断一个目录是否像游戏根目录 */
function looksLikeGameDir(dir) {
  if (!isDir(dir)) return false;
  return exists(path.join(dir, 'versions')) || exists(path.join(dir, 'saves'))
    || exists(path.join(dir, 'mods')) || exists(path.join(dir, 'libraries'));
}

/** 读取一个版本目录的信息 */
function readVersion(gameDir, id) {
  const dir = path.join(gameDir, 'versions', id);
  const jsonPath = path.join(dir, `${id}.json`);
  const jarPath = path.join(dir, `${id}.jar`);
  if (!exists(jsonPath)) return null;

  const j = readJson(jsonPath) || {};
  const inherits = j.inheritsFrom || '';
  let modLoader = 'vanilla';
  let loaderVersion = '';
  const src = String(inherits || j.id || id);
  const m = /(forge|neoforge|fabric|quilt|optifine)-?([\d.]*)/i.exec(src);
  if (m) {
    modLoader = m[1].toLowerCase();
    loaderVersion = m[2] || '';
  }

  // PCL2 版本隔离：版本目录下的 .minecraft 才是真正的游戏目录
  const isolated = path.join(dir, '.minecraft');
  const isolatedDir = isDir(isolated) ? isolated : '';
  const gameRoot = isolatedDir || gameDir;

  return {
    id,
    dir,
    jar: exists(jarPath),
    inherits,
    modLoader,
    loaderVersion,
    isolated: !!isolatedDir,
    gameRoot,
    mods: countFiles(path.join(gameRoot, 'mods'), ['.jar', '.disabled']),
    saves: subdirs(path.join(gameRoot, 'saves')).length,
    size: 0,
  };
}

/** 扫描一个游戏目录 */
function scanGameDir(dir) {
  const versionsRoot = path.join(dir, 'versions');
  const versions = [];
  for (const id of subdirs(versionsRoot)) {
    const v = readVersion(dir, id);
    if (v) versions.push(v);
  }
  const saves = subdirs(path.join(dir, 'saves'))
    .filter((n) => exists(path.join(dir, 'saves', n, 'level.dat')));

  return {
    dir,
    name: path.basename(dir) || dir,
    versions,
    saves,
    mods: countFiles(path.join(dir, 'mods'), ['.jar', '.disabled']),
    resourcepacks: countFiles(path.join(dir, 'resourcepacks')),
    shaderpacks: countFiles(path.join(dir, 'shaderpacks')),
  };
}

/** 读取启动器中的内存设置（尽力而为） */
function readSettings(spec, dataDir) {
  const out = { maxMemory: 0, source: '' };
  if (spec.id === 'hmcl') {
    for (const f of [path.join(dataDir, 'hmcl.json'), path.join(app.getPath('home'), '.hmcl.json')]) {
      const j = readJson(f);
      if (j && typeof j.maxMemory === 'number' && j.maxMemory > 0) {
        out.maxMemory = j.maxMemory;
        out.source = path.basename(f);
        break;
      }
    }
  } else if (spec.id === 'pcl2') {
    const text = readText(path.join(dataDir, 'Setup.ini'));
    // PCL2 使用 RamSet（单位 MB）
    const m = /RamSet\s*=\s*(\d+)/i.exec(text);
    if (m && Number(m[1]) > 0) {
      out.maxMemory = Number(m[1]);
      out.source = 'Setup.ini';
    }
  }
  return out;
}

/** 探测单个启动器数据目录下的可搬家内容 */
function collectFor(spec, dataDir, guessedDirs) {
  // 兜底：数据目录旁 / 内部的 .minecraft
  const fallbacks = [
    path.join(dataDir, '.minecraft'),
    path.join(dataDir, 'minecraft'),
  ];
  const dirs = [...new Set([...guessedDirs, ...fallbacks])]
    .filter((d) => looksLikeGameDir(d));

  const gameDirs = dirs.map(scanGameDir).filter((g) => g.versions.length || g.saves.length);
  if (!gameDirs.length) return null;

  return {
    id: spec.id,
    name: spec.name,
    fullName: spec.fullName,
    icon: spec.icon,
    dataDir,
    settings: readSettings(spec, dataDir),
    gameDirs,
  };
}

/** 探测全部可搬家的内容 */
function detect() {
  const found = [];
  const claimed = new Set();

  for (const spec of LAUNCHERS) {
    const dataDirs = launcherDataDirs(spec);
    for (const dataDir of dataDirs) {
      const item = collectFor(spec, dataDir,
        spec.id === 'pcl2' ? gameDirsFromPclIni(dataDir) : gameDirsFromHmcl(dataDir));
      if (!item) continue;
      found.push(item);
      for (const g of item.gameDirs) claimed.add(path.resolve(g.dir));
    }
  }

  // 启动器数据目录一个都没探到，但本机确实存在 .minecraft 时也要能搬。
  // PCL2 绝大多数情况下管的正是这个目录，把它挂到 PCL2 名下比直接报「未检测到」有用得多。
  const leftovers = defaultGameDirs().filter((d) => !claimed.has(path.resolve(d)));
  const gameDirs = leftovers.map(scanGameDir).filter((g) => g.versions.length || g.saves.length);
  if (gameDirs.length) {
    found.push({
      id: 'pcl2',
      name: 'PCL2',
      fullName: 'Plain Craft Launcher 2（默认游戏目录）',
      icon: '🟦',
      dataDir: leftovers[0],
      settings: { maxMemory: 0, source: '' },
      gameDirs,
    });
  }

  return found;
}

/** 把一个目录解析成游戏根目录：既接受游戏目录本身，也接受装着 .minecraft 的启动器目录 */
function resolveGameDir(dir) {
  if (!isDir(dir)) return '';
  if (looksLikeGameDir(dir)) return dir;
  for (const c of ['.minecraft', 'minecraft']) {
    const p = path.join(dir, c);
    if (looksLikeGameDir(p)) return p;
  }
  for (const name of subdirs(dir)) {
    const p = path.join(dir, name);
    if (looksLikeGameDir(p)) return p;
  }
  return '';
}

/** 手动指定目录：扫描它（以及它里面的 .minecraft），当成一个搬家来源 */
function detectIn(dir) {
  if (!dir || !isDir(dir)) throw new Error('目录不存在或不可读');
  const root = String(dir);
  const candidates = [];
  const resolved = resolveGameDir(root);
  if (resolved) candidates.push(resolved);
  // 指定的是启动器目录时，配置里还可能写着别的游戏目录
  for (const d of gameDirsFromPclIni(root)) {
    if (looksLikeGameDir(d) && !candidates.includes(d)) candidates.push(d);
  }

  const gameDirs = candidates.map(scanGameDir).filter((g) => g.versions.length || g.saves.length);
  if (!gameDirs.length) {
    throw new Error('这个目录里没找到 versions / saves，请选游戏根目录（含 .minecraft 的那一层）');
  }
  return [{
    id: 'manual',
    name: '手动指定',
    fullName: '手动指定的目录',
    icon: '📁',
    dataDir: root,
    settings: { maxMemory: 0, source: '' },
    gameDirs,
  }];
}

/* ---------- 执行导入 ---------- */

/**
 * @param {object} payload
 * @param {'link'|'copy'} payload.mode 引用（不复制文件）或复制
 * @param {string} payload.gameDir 源游戏目录
 * @param {string[]} payload.versions 要导入的版本 id 列表
 * @param {string[]} payload.saves 要导入的存档名列表
 * @param {boolean} payload.applySettings 是否套用对方的内存设置
 */
async function run(payload, onProgress) {
  const mode = payload.mode === 'copy' ? 'copy' : 'link';
  const srcGameDir = payload.gameDir;
  if (!looksLikeGameDir(srcGameDir)) throw new Error('源游戏目录无效');

  const ourGameDir = config.get('gameDir');
  fs.mkdirSync(ourGameDir, { recursive: true });

  const result = { instances: [], saves: [], skipped: [], failed: [], settings: null };
  const versionIds = payload.versions || [];
  const total = versionIds.length + (payload.saves || []).length;
  let done = 0;
  const tick = (label) => {
    done++;
    if (onProgress) onProgress({ done, total, label });
  };

  for (const id of versionIds) {
    try {
      const v = readVersion(srcGameDir, id);
      if (!v) { result.failed.push({ name: id, message: '版本文件已丢失' }); tick(id); continue; }

      const instName = safeName(id);
      const exist = Object.values(instances.listInstances())
        .find((x) => x.versionId === id && path.resolve(x.gameDir || '') === path.resolve(v.gameRoot));
      if (exist) { result.skipped.push({ name: id, message: '已导入过，跳过' }); tick(id); continue; }

      let targetGameDir = v.gameRoot;
      if (mode === 'copy') {
        // 复制版本核心文件
        const destVer = path.join(ourGameDir, 'versions', id);
        if (!exists(destVer)) copyDirRecursive(v.dir, destVer);
        if (v.isolated) {
          targetGameDir = uniqueDir(path.join(ourGameDir, 'instances'), instName);
          copyDirRecursive(v.gameRoot, targetGameDir);
        } else {
          targetGameDir = srcGameDir;
        }
      }

      const instId = `mg-${Date.now().toString(36)}-${result.instances.length}`;
      instances.saveInstance(instId, {
        name: instName,
        versionId: id,
        gameDir: targetGameDir,
        modLoader: v.modLoader,
        loaderVersion: v.loaderVersion,
        icon: v.modLoader === 'fabric' ? '🧵' : v.modLoader === 'forge' ? '🔥' : '⛏',
      });
      result.instances.push({
        id: instId, name: instName, versionId: id,
        mods: v.mods, isolated: v.isolated, mode,
      });
      logger.info(`搬家导入实例「${instName}」（${mode === 'copy' ? '复制' : '引用'}）`);
    } catch (e) {
      result.failed.push({ name: id, message: e.message });
    }
    tick(id);
  }

  // 存档导入到目标实例（或默认实例）的 saves 目录
  const instCfg = instances.getInstance(config.get('selectedInstance')) || {};
  const destGameDir = payload.targetGameDir || instCfg.gameDir || ourGameDir;
  for (const name of payload.saves || []) {
    try {
      const src = path.join(srcGameDir, 'saves', name);
      if (!exists(path.join(src, 'level.dat'))) {
        result.failed.push({ name, message: '不是有效的世界存档' });
        tick(name);
        continue;
      }
      const savesDir = path.join(destGameDir, 'saves');
      fs.mkdirSync(savesDir, { recursive: true });
      const target = uniqueDir(savesDir, safeName(name));
      copyDirRecursive(src, target);
      result.saves.push({ name: path.basename(target), from: name });
    } catch (e) {
      result.failed.push({ name, message: e.message });
    }
    tick(name);
  }

  if (payload.applySettings && payload.settings && payload.settings.maxMemory > 0) {
    config.set('maxMemory', payload.settings.maxMemory);
    result.settings = { maxMemory: payload.settings.maxMemory };
  }

  logger.info(`搬家完成：实例 ${result.instances.length} · 存档 ${result.saves.length} · 失败 ${result.failed.length}`);
  return result;
}

module.exports = { detect, detectIn, run, changeGameDir, rewriteInstanceDirs };

/* ============================================================================
 * 全局游戏目录变更（设置页「游戏目录」）
 *
 * 早先设置里把目录改到别的盘后游戏文件照样进 C 盘：
 *  - 默认实例把旧路径快照在自己的 gameDir 里（现已改为空串跟随全局）
 *  - 版本隔离实例的 gameDir 是「旧全局目录/instances/xxx」绝对路径
 * 这里在切换目录时把仍位于旧目录之下的实例路径整体改写，并可选移动全部文件。
 * ========================================================================== */

/**
 * 纯函数：把「位于 oldDir 之下」的实例目录前缀替换为 newDir。
 *  - gameDir 为空（跟随全局，如默认实例）→ 不动
 *  - 恰好等于旧目录（rel 为 ''）→ 映射到新目录本身
 *  - 在旧目录之外（rel 以 '..' 开头或跨盘符）→ 不动，尊重单独指定
 * 返回 { instances: 新映射, changed: {id: 新路径} }
 */
function rewriteInstanceDirs(list, oldDir, newDir) {
  const o = path.resolve(oldDir);
  const n = path.resolve(newDir);
  const out = {};
  const changed = {};
  for (const [id, inst] of Object.entries(list || {})) {
    const nd = (inst && inst.gameDir) || '';
    if (!nd) { out[id] = inst; continue; }
    const rel = path.relative(o, path.resolve(nd));
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (inside) {
      const np = rel === '' ? n : path.join(n, rel);
      out[id] = { ...inst, gameDir: np };
      changed[id] = np;
    } else {
      out[id] = inst;
    }
  }
  return { instances: out, changed };
}

/**
 * 用系统自带 robocopy 把旧目录整体移动到新目录（跨盘也可）。
 *   /E 含空子目录   /MOVE 复制后删除源（源根也会删除，C 盘清得干净）
 *   /IS 相同文件也重拷，保证源文件都经过「复制→删除」   /R:1 /W:1 占用文件只重试一次
 * robocopy 退出码 0~7 为成功，≥8 为失败。
 */
function robocopyMove(from, to) {
  return new Promise((resolve) => {
    const args = ['/E', '/MOVE', '/IS', '/NFL', '/NDL', '/NP', '/R:1', '/W:1', from, to];
    let log = '';
    let child;
    try {
      child = spawn('robocopy', args, { windowsHide: true });
    } catch (e) { return resolve({ code: -1, log: String(e) }); }
    child.stdout.on('data', (c) => { log += c; });
    child.stderr.on('data', (c) => { log += c; });
    child.on('error', (e) => resolve({ code: -1, log: String(e) }));
    child.on('close', (code) => resolve({ code, log }));
  });
}

/**
 * 变更全局游戏目录。
 * @param {string} newDir 新目录
 * @param {boolean} move 是否把旧目录文件一起移动过去
 * @param {(step:string)=>void} [onStep] 过程回调（仅日志用）
 */
async function changeGameDir(newDir, move, onStep) {
  const oldDir = path.resolve(config.get('gameDir'));
  const target = path.resolve(String(newDir || '').trim());
  if (!target) throw new Error('请选择有效的游戏目录');
  if (target === oldDir) throw new Error('新目录与当前目录相同');
  // 不允许把游戏目录设到启动器自己的数据目录里（配置会和游戏文件互相嵌套）
  try {
    const userData = path.resolve(app.getPath('userData'));
    if (target === userData || path.relative(userData, target) === '') {
      throw new Error('游戏目录不能设置为启动器的数据目录');
    }
  } catch (e) { if (e.message.startsWith('游戏目录不能')) throw e; }

  fs.mkdirSync(target, { recursive: true });

  let robocopyCode = null;
  const oldExists = exists(oldDir);
  if (move && oldExists) {
    if (onStep) onStep('move');
    const r = await robocopyMove(oldDir, target);
    robocopyCode = r.code;
    if (robocopyCode >= 8) {
      logger.warn(`robocopy move ${oldDir} -> ${target} failed (${robocopyCode}): ${r.log.slice(-400)}`);
      throw new Error(`文件移动失败（robocopy 退出码 ${robocopyCode}），目录设置未更改。通常是文件被占用，请先关闭游戏后重试。`);
    }
    logger.info(`robocopy move -> ${target}, code ${robocopyCode}`);
  }

  const list = config.get('instances') || {};
  const { instances: rewritten, changed } = rewriteInstanceDirs(list, oldDir, target);
  config.update({ gameDir: target, instances: rewritten });

  return { oldDir, newDir: target, moved: !!move && oldExists, changed, robocopyCode };
}