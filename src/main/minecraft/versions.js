const fs = require('fs');
const path = require('path');
const { mirrorUrl } = require('./mirror');

let manifestCache = null;

async function getManifest(force = false) {
  if (!force && manifestCache) return manifestCache;
  const url = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
  const res = await fetch(mirrorUrl(url), {
    headers: { 'User-Agent': 'CM-Launcher/1.0' },
  });
  if (!res.ok) throw new Error(`版本清单获取失败 (HTTP ${res.status})`);
  manifestCache = await res.json();
  return manifestCache;
}

async function getVersionDetail(entry) {
  const res = await fetch(mirrorUrl(entry.url), {
    headers: { 'User-Agent': 'CM-Launcher/1.0' },
  });
  if (!res.ok) throw new Error(`版本详情获取失败 (HTTP ${res.status})`);
  return res.json();
}

/** 读本地 versions/<id>/<id>.json（Forge / Fabric / Quilt 装完会落在这里） */
function readLocalVersion(gameDir, id) {
  if (!gameDir || !id) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(gameDir, 'versions', id, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/** 库列表按 name 去重：后出现的（子版本本体/覆盖）盖掉先出现的（父版本） */
function mergeLibraries(parent, child) {
  const out = [];
  const idx = new Map();
  for (const lib of [...(parent || []), ...(child || [])]) {
    const key = lib && lib.name ? lib.name : `__anon_${out.length}`;
    if (idx.has(key)) out[idx.get(key)] = lib;
    else { idx.set(key, out.length); out.push(lib); }
  }
  return out;
}

/**
 * 把带 inheritsFrom 的子版本清单（Forge / Fabric / Quilt 装出来的）
 * 与父版本合并成一份可直接启动的完整清单。
 * 子版本只写自己那部分（mainClass / 自己的库 / 自己的参数），其余全从父版本继承。
 */
function mergeInherited(child, parent) {
  const merged = { ...parent, ...child };
  merged.id = child.id || parent.id;
  merged.mainClass = child.mainClass || parent.mainClass;
  merged.libraries = mergeLibraries(parent.libraries, child.libraries);

  const pa = parent.arguments || {};
  const ca = child.arguments || {};
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...(pa.game || []), ...(ca.game || [])],
      jvm: [...(pa.jvm || []), ...(ca.jvm || [])],
    };
  }
  if (!child.minecraftArguments && parent.minecraftArguments) {
    merged.minecraftArguments = parent.minecraftArguments;
  }
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  merged.downloads = child.downloads || parent.downloads;
  merged.type = child.type || parent.type || 'release';
  return merged;
}

/**
 * 解析版本清单：优先读本地 —— 带 Mod 加载器的版本只存在于本地（官方清单里没有），
 * 以前只能查官方清单，导致装了 Fabric/Forge 的实例启动时用的还是原版（模组一个不加载）。
 * 本地没有再去官方清单取原版。
 */
async function resolveVersionDetail(versionId, gameDir) {
  const local = readLocalVersion(gameDir, versionId);
  if (local) {
    if (local.inheritsFrom && local.inheritsFrom !== versionId) {
      const parent = await resolveVersionDetail(local.inheritsFrom, gameDir);
      return mergeInherited(local, parent);
    }
    return local;
  }
  const manifest = await getManifest();
  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`版本清单中找不到版本：${versionId}`);
  return getVersionDetail(entry);
}

module.exports = {
  getManifest,
  getVersionDetail,
  resolveVersionDetail,
  mergeInherited,
  readLocalVersion,
};