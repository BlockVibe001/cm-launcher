// Mod 更新检查与版本回滚（基于 Modrinth）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UA = 'BlockVibeLauncher/1.0.0 (minecraft launcher)';
const API = 'https://api.modrinth.com/v2';

function hashFile(file, algo) {
  return crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
}

function localMods(gameDir) {
  const dir = path.join(gameDir, 'mods');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.jar(\.disabled)?$/i.test(f))
    .map((f) => ({
      file: f,
      full: path.join(dir, f),
      disabled: /\.disabled$/i.test(f),
    }));
}

/** 检查已装 Mod 是否有更新 */
async function checkUpdates(gameDir, mcVersion, loader) {
  const mods = localMods(gameDir).filter((m) => !m.disabled);
  if (!mods.length) return [];

  const bySha1 = {};
  for (const m of mods) {
    try { bySha1[hashFile(m.full, 'sha1')] = m; } catch {}
  }
  const hashes = Object.keys(bySha1);
  if (!hashes.length) return [];

  // 批量反查每个文件对应的 Modrinth 版本
  let resolved = {};
  try {
    const res = await fetch(`${API}/version_files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ hashes, algorithm: 'sha1' }),
    });
    if (res.ok) resolved = await res.json();
  } catch {}

  const results = hashes.map((sha1) => {
    const m = bySha1[sha1];
    const v = resolved[sha1];
    if (!v) return { file: m.file, known: false };
    return {
      file: m.file,
      known: true,
      projectId: v.project_id,
      projectName: v.name,
      currentVersion: v.version_number,
      currentVersionId: v.id,
      versionType: v.version_type,
    };
  });

  // 查询项目在「当前 MC 版本 + 当前加载器」下的最新版本
  const targets = results.filter((r) => r.known).slice(0, 40);
  await Promise.all(targets.map(async (r) => {
    try {
      const url = `${API}/project/${r.projectId}/version`
        + `?loaders=${encodeURIComponent(JSON.stringify([loader || 'fabric']))}`
        + `&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) { r.updateAvailable = false; return; }
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) { r.updateAvailable = false; return; }
      r.latestVersion = list[0].version_number;
      r.latestVersionId = list[0].id;
      r.latestDate = list[0].date_published;
      r.updateAvailable = list[0].id !== r.currentVersionId;
    } catch {
      r.updateAvailable = false;
    }
  }));

  return results;
}

/** 取出某个项目在指定 MC 版本/加载器下的所有历史版本（用于回滚） */
async function getProjectVersions(projectId, mcVersion, loader) {
  const url = `${API}/project/${projectId}/version`
    + `?loaders=${encodeURIComponent(JSON.stringify([loader || 'fabric']))}`
    + `&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('获取版本列表失败');
  const list = await res.json();
  return list.map((v) => ({
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    versionType: v.version_type,
    date: v.date_published,
    downloads: v.downloads,
    filename: (v.files.find((f) => f.primary) || v.files[0] || {}).filename,
  }));
}

/** 下载指定版本并替换旧的 Mod 文件 */
async function installVersion(projectId, versionId, gameDir, replaceFile) {
  const res = await fetch(`${API}/version/${versionId}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('获取版本信息失败');
  const v = await res.json();
  const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
  if (!file) throw new Error('该版本没有可下载的文件');

  const modsDir = path.join(gameDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  if (replaceFile) {
    const old = path.join(modsDir, replaceFile);
    if (fs.existsSync(old)) fs.rmSync(old, { force: true });
  }
  // 避免同名残留
  const dest = path.join(modsDir, file.filename);
  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });

  const dl = await fetch(file.url, { headers: { 'User-Agent': UA } });
  if (!dl.ok) throw new Error(`下载失败 HTTP ${dl.status}`);
  fs.writeFileSync(dest, Buffer.from(await dl.arrayBuffer()));
  return { file: file.filename, size: file.size, versionNumber: v.version_number };
}

/** 反查单个 Mod 文件对应的 Modrinth 项目 */
async function resolveMod(gameDir, fileName) {
  const full = path.join(gameDir, 'mods', fileName);
  if (!fs.existsSync(full)) throw new Error('Mod 文件不存在');
  const sha1 = hashFile(full, 'sha1');
  const res = await fetch(`${API}/version_files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ hashes: [sha1], algorithm: 'sha1' }),
  });
  if (!res.ok) throw new Error('查询失败');
  const data = await res.json();
  const v = data[sha1];
  if (!v) return null;
  return {
    projectId: v.project_id,
    projectName: v.name,
    currentVersion: v.version_number,
    currentVersionId: v.id,
  };
}

module.exports = { checkUpdates, getProjectVersions, installVersion, resolveMod, localMods };