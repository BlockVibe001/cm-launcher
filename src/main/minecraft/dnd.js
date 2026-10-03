// 拖拽智能识别：把外部拖入的文件 / 压缩包自动分类并放入对应实例目录
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const instances = require('./instances');
const modrinth = require('./modrinth');
const { openZip } = require('../util/zipread');

const KINDS = {
  mod: { label: '模组', icon: '🧩' },
  resourcepack: { label: '资源包', icon: '🎨' },
  shaderpack: { label: '光影包', icon: '✨' },
  datapack: { label: '数据包', icon: '📦' },
  world: { label: '世界存档', icon: '🌍' },
  modpack: { label: '整合包', icon: '🗃️' },
  schematic: { label: '投影文件', icon: '📐' },
  unknown: { label: '未识别', icon: '❓' },
};

const SCHEMATIC_EXT = new Set(['.schem', '.schematic', '.litematic', '.nbt']);

/* ---------- 工具 ---------- */

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/** 目标目录内取一个不冲突的路径 */
function uniquePath(dir, name) {
  let target = path.join(dir, name);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 999; i++) {
    target = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(target)) return target;
  }
  throw new Error('同名文件过多，请先清理目录');
}

function copyInto(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const target = uniquePath(destDir, path.basename(src));
  let st;
  try { st = fs.statSync(src); } catch { throw new Error('源文件不存在'); }
  if (st.isDirectory()) copyDirRecursive(src, target);
  else fs.copyFileSync(src, target);
  return target;
}

/** 过滤掉 macOS 元数据等干扰项 */
function usable(files) {
  return files.filter((f) => !f.isDir && !/(^|\/)__MACOSX\//.test(f.name) && !/(^|\/)\.DS_Store$/i.test(f.name));
}

/* ---------- 分类 ---------- */

function classifyDir(dir, base) {
  const has = (rel) => fs.existsSync(path.join(dir, rel));
  if (has('level.dat')) return { ...base, kind: 'world', detail: '世界存档文件夹' };
  if (has('modrinth.index.json')) return { ...base, kind: 'modpack', detail: 'Modrinth 整合包目录' };
  if (has('META-INF/mods.toml') || has('fabric.mod.json') || has('quilt.mod.json')) {
    return { ...base, kind: 'mod', detail: '模组文件夹' };
  }
  if (has('pack.mcmeta') && has('assets')) return { ...base, kind: 'resourcepack', detail: '资源包文件夹' };
  if (has('pack.mcmeta') && has('data')) return { ...base, kind: 'datapack', detail: '数据包文件夹' };
  if (has('shaders')) return { ...base, kind: 'shaderpack', detail: '光影包文件夹' };
  if (has('mods') && has('config')) return { ...base, kind: 'modpack', detail: '疑似整合包（含 mods / config）' };
  return { ...base, kind: 'unknown', detail: '无法识别的文件夹' };
}

function classifyZip(file, base) {
  let z;
  try {
    z = openZip(file);
  } catch (e) {
    return { ...base, kind: 'unknown', detail: `压缩包解析失败：${e.message}` };
  }
  try {
    const rel = (re) => z.names.filter((n) => re.test(n));
    const roots = new Set(z.names.map((n) => n.split('/')[0]));

    if (rel(/(^|\/)modrinth\.index\.json$/i).length) {
      return { ...base, kind: 'modpack', detail: 'Modrinth 整合包（.mrpack）' };
    }

    const manifestName = rel(/(^|\/)manifest\.json$/i)[0];
    if (manifestName) {
      try {
        const m = JSON.parse(z.read(manifestName).toString('utf8'));
        if (m && m.minecraft && Array.isArray(m.files)) {
          return { ...base, kind: 'modpack', detail: `CurseForge 整合包（${m.files.length} 个文件）` };
        }
      } catch { /* 非整合包 manifest */ }
    }

    if (rel(/(^|\/)level\.dat$/).length) {
      return { ...base, kind: 'world', detail: 'Minecraft 世界存档' };
    }

    const packs = rel(/(^|\/)pack\.mcmeta$/);
    if (packs.length) {
      if (rel(/(^|\/)assets\//).length) return { ...base, kind: 'resourcepack', detail: '资源包' };
      if (rel(/(^|\/)data\//).length) return { ...base, kind: 'datapack', detail: '数据包' };
      if (rel(/(^|\/)shaders\//).length || roots.has('shaders')) {
        return { ...base, kind: 'shaderpack', detail: '光影包（含 pack.mcmeta）' };
      }
      return { ...base, kind: 'resourcepack', detail: '资源包（未发现 assets 目录）' };
    }

    if (rel(/(^|\/)shaders\/[^/]+\.(fsh|vsh|glsl|csh|gsh)$/i).length || roots.has('shaders')) {
      return { ...base, kind: 'shaderpack', detail: '光影包' };
    }

    if (rel(/(^|\/)fabric\.mod\.json$/).length || rel(/(^|\/)META-INF\/mods\.toml$/i).length) {
      return { ...base, kind: 'mod', detail: '模组（zip 打包）' };
    }

    if (roots.has('mods') && roots.has('config')) {
      return { ...base, kind: 'modpack', detail: '疑似整合包（含 mods / config）' };
    }

    return { ...base, kind: 'unknown', detail: '压缩包内容无法识别' };
  } finally {
    z.close();
  }
}

/** 识别单个路径 */
function classify(file) {
  const name = path.basename(file);
  const ext = path.extname(name).toLowerCase();
  const base = { path: file, name, ext, kind: 'unknown', detail: '', size: 0, isDir: false };

  let st;
  try { st = fs.statSync(file); } catch { return { ...base, detail: '文件不存在' }; }
  base.isDir = st.isDirectory();
  base.size = st.isDirectory() ? 0 : st.size;

  if (st.isDirectory()) return classifyDir(file, base);
  if (SCHEMATIC_EXT.has(ext)) return { ...base, kind: 'schematic', detail: '结构 / 投影文件，可在实验室预览' };
  if (ext === '.jar') return { ...base, kind: 'mod', detail: 'JAR 模组' };
  if (ext === '.mrpack') return { ...base, kind: 'modpack', detail: 'Modrinth 整合包' };
  if (ext === '.zip') return classifyZip(file, base);
  if (ext === '.disabled') return { ...base, kind: 'mod', detail: '已禁用的模组文件' };
  return base;
}

function inspect(paths) {
  return (paths || []).filter(Boolean).map(classify);
}

/* ---------- 解压世界存档 ---------- */

function extractWorld(zipPath, savesDir) {
  const z = openZip(zipPath);
  const files = usable(z.entries);
  if (!files.length) throw new Error('压缩包内没有文件');

  const roots = new Set(files.map((f) => f.name.split('/')[0]));
  const single = roots.size === 1 && files.every((f) => f.name.includes('/'));
  const rootName = single ? [...roots][0] : '';
  const prefix = rootName ? `${rootName}/` : '';
  const folder = rootName || path.basename(zipPath).replace(/\.zip$/i, '');

  const target = uniquePath(savesDir, folder);
  fs.mkdirSync(target, { recursive: true });
  const base = path.resolve(target);

  let count = 0;
  for (const f of files) {
    const rel = prefix ? f.name.slice(prefix.length) : f.name;
    if (!rel) continue;
    const dest = path.resolve(path.join(target, rel));
    if (!dest.startsWith(base)) continue;   // 路径穿越保护
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, z.read(f.name));
    count++;
  }

  if (!fs.existsSync(path.join(target, 'level.dat'))) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error('压缩包内未找到 level.dat，可能不是世界存档');
  }
  return { path: target, name: path.basename(target), files: count };
}

/* ---------- 整合包 ---------- */

function nextInstanceDir(gameRoot, safeName) {
  let dir = path.join(gameRoot, 'instances', safeName);
  let n = 1;
  while (fs.existsSync(dir)) dir = path.join(gameRoot, 'instances', `${safeName}-${++n}`);
  return dir;
}

function loaderFromCurseId(id) {
  const [l, v] = String(id || '').split('-');
  const map = { forge: 'forge', neoforge: 'neoforge', fabric: 'fabric', quilt: 'quilt' };
  return { modLoader: map[l] || 'vanilla', loaderVersion: v || '' };
}

/** 安装 CurseForge 整合包：解压 overrides（模组本体需 API Key，无法自动下载） */
function installCurseModpack(zipPath, gameRoot) {
  const z = openZip(zipPath);
  const manifestName = z.names.find((n) => /(^|\/)manifest\.json$/i.test(n));
  if (!manifestName) throw new Error('整合包缺少 manifest.json');
  const manifest = JSON.parse(z.read(manifestName).toString('utf8'));

  const mc = manifest.minecraft || {};
  const safeName = String(manifest.name || path.basename(zipPath, '.zip')).replace(/[\\/:*?"<>|]/g, '_');
  const gameDir = nextInstanceDir(gameRoot, safeName);
  fs.mkdirSync(gameDir, { recursive: true });

  let overrides = 0;
  for (const e of usable(z.entries)) {
    const m = /^(?:overrides|client-overrides)\/(.+)$/.exec(e.name);
    if (!m || !m[1]) continue;
    const dest = path.resolve(path.join(gameDir, m[1]));
    if (!dest.startsWith(path.resolve(gameDir))) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, z.read(e.name));
    overrides++;
  }

  const ml = (mc.modLoaders || [])[0] || {};
  const { modLoader, loaderVersion } = loaderFromCurseId(ml.id);

  return {
    gameDir,
    name: safeName,
    versionId: mc.version || '',
    modLoader,
    loaderVersion,
    overrides,
    pending: (manifest.files || []).length,
  };
}

/* ---------- 导入 ---------- */

const CATEGORY_DIR = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shaderpack: 'shaderpacks',
  datapack: 'datapacks',
};

/**
 * 执行导入
 * @param {Array<{path:string, kind:string}>} items 已识别（或用户手动指定）的条目
 * @param {{ gameDir:string, gameRoot?:string, worldDir?:string, instanceId?:string }} opts
 * @param {(p:any)=>void} send 进度回调
 */
async function importItems(items, opts, send) {
  const gameDir = opts.gameDir || config.get('gameDir');
  const gameRoot = opts.gameRoot || config.get('gameDir');
  const results = [];

  for (const it of items) {
    const kind = it.kind || 'unknown';
    const label = it.name || path.basename(it.path);
    try {
      if (kind === 'schematic') {
        results.push({ name: label, kind, ok: true, action: 'schematic', path: it.path, message: '已交给 Axolotl 实验室预览' });
        continue;
      }
      if (kind === 'unknown') {
        results.push({ name: label, kind, ok: false, message: '无法识别类型，可手动选择分类后重试' });
        continue;
      }
      if (kind === 'world') {
        const savesDir = path.join(gameDir, 'saves');
        fs.mkdirSync(savesDir, { recursive: true });
        let dir = it.path;
        let files = 0;
        if (it.isDir) {
          const target = uniquePath(savesDir, path.basename(it.path));
          copyDirRecursive(it.path, target);
          dir = target;
        } else {
          const r = extractWorld(it.path, savesDir);
          dir = r.path; files = r.files;
        }
        if (!fs.existsSync(path.join(dir, 'level.dat'))) {
          throw new Error('未找到 level.dat，可能不是有效的世界存档');
        }
        results.push({ name: label, kind, ok: true, message: `已放入 saves/${path.basename(dir)}${files ? `（${files} 个文件）` : ''}` });
        continue;
      }
      if (kind === 'modpack') {
        const ext = it.ext || path.extname(it.path || '').toLowerCase();
        const isMrpack = ext === '.mrpack'
          || (ext === '.zip' && /modrinth\.index\.json/i.test(String(it.detail)));
        if (isMrpack) {
          const info = await modrinth.installMrpack({ localPath: it.path }, gameRoot, send);
          const instanceId = `mp-${Date.now()}-${results.length}`;
          instances.saveInstance(instanceId, {
            name: info.name,
            versionId: info.versionId,
            gameDir: info.gameDir,
            modLoader: info.modLoader,
            loaderVersion: info.loaderVersion,
            icon: '🗃️',
          });
          results.push({ name: label, kind, ok: true, message: `已安装为新实例「${info.name}」`, instanceId });
        } else {
          const info = installCurseModpack(it.path, gameRoot);
          const instanceId = `cf-${Date.now()}-${results.length}`;
          instances.saveInstance(instanceId, {
            name: info.name,
            versionId: info.versionId,
            gameDir: info.gameDir,
            modLoader: info.modLoader,
            loaderVersion: info.loaderVersion,
            icon: '🗃️',
          });
          results.push({
            name: label,
            kind,
            ok: true,
            message: `已创建实例「${info.name}」，导入 ${info.overrides} 个配置文件；${info.pending} 个模组需 CurseForge API Key 才能自动下载`,
            instanceId,
          });
        }
        continue;
      }

      // mod / resourcepack / shaderpack / datapack
      let destDir;
      if (kind === 'datapack') {
        if (!opts.worldDir) throw new Error('数据包需要先选择目标世界');
        destDir = path.join(opts.worldDir, 'datapacks');
      } else {
        destDir = path.join(gameDir, CATEGORY_DIR[kind]);
      }
      const target = copyInto(it.path, destDir);
      results.push({ name: label, kind, ok: true, message: `已放入 ${CATEGORY_DIR[kind]}/${path.basename(target)}` });
    } catch (e) {
      logger.warn(`导入「${label}」失败：${e.message}`);
      results.push({ name: label, kind, ok: false, message: e.message });
    }
  }

  return {
    results,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    newInstances: results.filter((r) => r.instanceId).map((r) => ({ id: r.instanceId, name: r.name })),
  };
}

module.exports = { inspect, classify, importItems, KINDS, extractWorld };