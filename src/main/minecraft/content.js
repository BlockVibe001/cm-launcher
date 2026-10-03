// 实例内容扫描：资源包 / 光影 / 存档 / 截图 / 日志
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function sub(gameDir, ...parts) {
  return path.join(gameDir, ...parts);
}

/** 递归计算目录大小（带深度上限，避免卡死） */
function dirSize(dir, depth = 0) {
  if (depth > 3) return 0;
  let total = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const n of names) {
    const full = path.join(dir, n);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) total += dirSize(full, depth + 1);
    else total += st.size;
  }
  return total;
}

/* ---------- options.txt / properties 读写 ---------- */

function parseOptionsTxt(gameDir) {
  const out = {};
  try {
    const text = fs.readFileSync(sub(gameDir, 'options.txt'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
  } catch {}
  return out;
}

function writeOption(gameDir, key, value) {
  const p = sub(gameDir, 'options.txt');
  let lines = [];
  try { lines = fs.readFileSync(p, 'utf8').split(/\r?\n/); } catch {}
  let found = false;
  lines = lines.map((l) => {
    if (l.startsWith(`${key}:`)) { found = true; return `${key}:${value}`; }
    return l;
  });
  if (!found) lines.push(`${key}:${value}`);
  fs.writeFileSync(p, lines.join('\n'));
}

function readProp(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
  } catch {}
  return out;
}

function writeProp(file, key, value) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch {}
  let found = false;
  lines = lines.map((l) => {
    if (l.startsWith(`${key}=`)) { found = true; return `${key}=${value}`; }
    return l;
  });
  if (!found) lines.push(`${key}=${value}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
}

/* ---------- 资源包 ---------- */

function listResourcePacks(gameDir) {
  const dir = sub(gameDir, 'resourcepacks');
  const opts = parseOptionsTxt(gameDir);
  const enabled = new Set();
  try {
    JSON.parse(opts.resourcePacks || '[]').forEach((x) => {
      enabled.add(String(x).replace(/^file\//, ''));
    });
  } catch {}

  const items = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const isZip = /\.zip$/i.test(name);
      if (!st.isDirectory() && !isZip) continue;
      const icon = path.join(full, 'pack.png');
      items.push({
        name,
        type: st.isDirectory() ? 'folder' : 'zip',
        enabled: enabled.has(name),
        size: st.isDirectory() ? dirSize(full) : st.size,
        icon: st.isDirectory() && fs.existsSync(icon) ? icon : null,
        path: full,
      });
    }
  }
  return items;
}

function toggleResourcePack(gameDir, name, on) {
  const opts = parseOptionsTxt(gameDir);
  let list = [];
  try { list = JSON.parse(opts.resourcePacks || '[]'); } catch {}
  list = list.filter((x) => String(x).replace(/^file\//, '') !== name);
  if (on) list.push(`file/${name}`);   // 放最后 = 优先级最高
  writeOption(gameDir, 'resourcePacks', JSON.stringify(list));
  return listResourcePacks(gameDir);
}

/* ---------- 光影包 ---------- */

function currentShaderPack(gameDir) {
  const iris = readProp(sub(gameDir, 'config', 'iris.properties')).shaderPack;
  if (iris) return iris;
  const of = readProp(sub(gameDir, 'optionsshaders.txt')).shaderPack;
  return of || '';
}

function listShaderPacks(gameDir) {
  const dir = sub(gameDir, 'shaderpacks');
  const active = currentShaderPack(gameDir);
  const items = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const isZip = /\.zip$/i.test(name);
      if (!st.isDirectory() && !isZip) continue;
      items.push({
        name,
        type: st.isDirectory() ? 'folder' : 'zip',
        enabled: active === name,
        size: st.isDirectory() ? dirSize(full) : st.size,
        path: full,
      });
    }
  }
  return items;
}

function enableShaderPack(gameDir, name) {
  // Iris 与 OptiFine 都写一份，保证兼容
  writeProp(sub(gameDir, 'config', 'iris.properties'), 'shaderPack', name);
  writeProp(sub(gameDir, 'optionsshaders.txt'), 'shaderPack', name);
  return listShaderPacks(gameDir);
}

/* ---------- 存档 ---------- */

function listSaves(gameDir) {
  const dir = sub(gameDir, 'saves');
  const items = [];
  if (!fs.existsSync(dir)) return items;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    const icon = path.join(full, 'icon.png');
    items.push({
      name,
      path: full,
      lastPlayed: st.mtimeMs,
      size: dirSize(full),
      icon: fs.existsSync(icon) ? icon : null,
      hasLevel: fs.existsSync(path.join(full, 'level.dat')),
    });
  }
  return items.sort((a, b) => b.lastPlayed - a.lastPlayed);
}

/* ---------- 截图 ---------- */

function listScreenshots(gameDir) {
  const dir = sub(gameDir, 'screenshots');
  const items = [];
  if (!fs.existsSync(dir)) return items;
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(png|jpe?g)$/i.test(name)) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    items.push({ name, path: full, size: st.size, mtime: st.mtimeMs });
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}

/* ---------- 日志 ---------- */

function listLogs(gameDir) {
  const out = [];

  const push = (dir, rel, kind) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ name: f, rel: path.join(rel, f), size: st.size, mtime: st.mtimeMs, kind });
    }
  };

  push(sub(gameDir, 'logs'), 'logs', 'log');
  push(sub(gameDir, 'crash-reports'), 'crash-reports', 'crash');

  // JVM 崩溃日志在游戏根目录
  if (fs.existsSync(gameDir)) {
    for (const f of fs.readdirSync(gameDir)) {
      if (!/^hs_err_pid.*\.log$/.test(f)) continue;
      const full = path.join(gameDir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      out.push({ name: f, rel: f, size: st.size, mtime: st.mtimeMs, kind: 'jvm' });
    }
  }

  return out.sort((a, b) => b.mtime - a.mtime);
}

function readLogFile(gameDir, rel, maxBytes = 512 * 1024) {
  const full = path.resolve(path.join(gameDir, rel));
  if (!full.startsWith(path.resolve(gameDir))) throw new Error('非法路径');
  if (!fs.existsSync(full)) throw new Error('文件不存在');
  let buf = fs.readFileSync(full);
  if (full.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  let text = buf.toString('utf8');
  if (text.length > maxBytes) text = `…（仅显示最后 ${Math.round(maxBytes / 1024)}KB）\n${text.slice(-maxBytes)}`;
  return text;
}

/* ---------- 删除 ---------- */

function deleteInDir(gameDir, category, name) {
  const targets = {
    resourcepacks: 'resourcepacks',
    shaderpacks: 'shaderpacks',
    saves: 'saves',
    screenshots: 'screenshots',
  };
  const folder = targets[category];
  if (!folder) throw new Error('未知分类');
  const full = path.resolve(path.join(gameDir, folder, name));
  if (!full.startsWith(path.resolve(path.join(gameDir, folder)))) throw new Error('非法路径');
  if (!fs.existsSync(full)) throw new Error('文件不存在');
  fs.rmSync(full, { recursive: true, force: true });
  return true;
}

module.exports = {
  listResourcePacks,
  toggleResourcePack,
  listShaderPacks,
  enableShaderPack,
  currentShaderPack,
  listSaves,
  listScreenshots,
  listLogs,
  readLogFile,
  deleteInDir,
  dirSize,
};