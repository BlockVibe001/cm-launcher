const fs = require('fs');
const path = require('path');
const os = require('os');
const extractZip = require('extract-zip');
const { downloadFile } = require('./downloader');
const { mirrorUrl } = require('./mirror');

const CF_API = 'https://api.curseforge.com/v1';
const CF_HEADERS = {
  'User-Agent': 'CM-Launcher',
  'Accept': 'application/json',
};

/** CurseForge Minecraft 分类 classId */
const CLASS_IDS = {
  mod: 6,
  world: 17,
  resourcepack: 12,
  modpack: 4479,
};

/**
 * CurseForge 公开 API。注意：无 API Key 时部分接口受限，但搜索通常可用。
 * @param cls mod | world | resourcepack | modpack
 */
async function searchMods(query, mcVersion, modLoader, pageSize = 20, cls = 'mod') {
  const params = new URLSearchParams({
    gameId: '432',
    classId: String(CLASS_IDS[cls] || CLASS_IDS.mod),
    searchFilter: query,
    pageSize: String(pageSize),
    sortField: '2', // popularity
    sortOrder: 'desc',
  });
  if (mcVersion) params.set('gameVersion', mcVersion);
  if (cls === 'mod' && modLoader && modLoader !== 'vanilla') {
    params.set('modLoaderType', modLoader === 'forge' ? '1' : modLoader === 'fabric' ? '4' : modLoader === 'quilt' ? '5' : '');
  }
  const res = await fetch(`${CF_API}/mods/search?${params}`, { headers: CF_HEADERS });
  // 403 = CurseForge 官方收紧了公开接口，必须带 x-api-key 才能查；
  // 与其把裸状态码甩给玩家，不如直接告诉他该去哪儿找。
  if (res.status === 403) throw new Error('CurseForge 接口需要 API Key（403），请改用 Modrinth');
  if (!res.ok) throw new Error(`CurseForge 搜索失败 (HTTP ${res.status})`);
  const data = await res.json();
  return (data.data || []).map((m) => ({
    id: m.id,
    name: m.name,
    slug: m.slug,
    summary: m.summary,
    authors: (m.authors || []).map((a) => a.name).join(', '),
    downloadCount: m.downloadCount,
    icon: (m.logo && m.logo.thumbnailUrl) || '',
    url: m.links && m.links.websiteUrl,
    categories: (m.categories || []).map((c) => c.name),
  }));
}

async function getFiles(modId, mcVersion) {
  const params = new URLSearchParams({ gameVersion: mcVersion || '' });
  const res = await fetch(`${CF_API}/mods/${modId}/files?${params}`, { headers: CF_HEADERS });
  if (!res.ok) throw new Error(`获取文件列表失败 (HTTP ${res.status})`);
  const data = await res.json();
  return (data.data || []).map((f) => ({
    id: f.id,
    name: f.fileName,
    displayName: f.displayName,
    size: f.fileLength,
    releaseType: f.releaseType, // 1 release 2 beta 3 alpha
    gameVersions: f.gameVersions || [],
    downloadUrl: f.downloadUrl,
  })).sort((a, b) => b.id - a.id);
}

async function downloadMod(file, gameDir) {
  const modsDir = path.join(gameDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, file.name);
  await downloadFile(mirrorUrl(file.downloadUrl), dest, null);
  return dest;
}

/**
 * 下载世界 zip 并解压到游戏目录的 saves/ 下。
 * 支持两种压缩结构：
 *  - 根目录直接是世界文件（level.dat 在根）→ saves/<世界名>
 *  - 压缩包内有一层同名文件夹
 */
async function installWorld(file, gameDir) {
  if (!file.downloadUrl) throw new Error('该文件不提供直链下载（CurseForge 限制），请打开网页手动下载');
  const tmpZip = path.join(os.tmpdir(), `cm-world-${Date.now()}.zip`);
  await downloadFile(mirrorUrl(file.downloadUrl), tmpZip, null);

  const tmpDir = path.join(os.tmpdir(), `cm-world-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  await extractZip(tmpZip, { dir: tmpDir });

  const savesDir = path.join(gameDir, 'saves');
  fs.mkdirSync(savesDir, { recursive: true });

  // 找到含 level.dat 的目录（最深一层）
  let worldSrc = findWorldDir(tmpDir);
  if (!worldSrc) throw new Error('压缩包内未找到世界文件（level.dat）');

  const worldName = path.basename(worldSrc);
  let dest = path.join(savesDir, worldName);
  let n = 1;
  while (fs.existsSync(dest)) dest = path.join(savesDir, `${worldName}-${++n}`);
  copyDirRecursive(worldSrc, dest);

  try { fs.rmSync(tmpZip, { force: true }); fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  return dest;
}

function findWorldDir(dir) {
  if (fs.existsSync(path.join(dir, 'level.dat'))) return dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const hit = findWorldDir(path.join(dir, entry.name));
      if (hit) return hit;
    }
  }
  return null;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = { searchMods, getFiles, downloadMod, installWorld };
