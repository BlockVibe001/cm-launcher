const fs = require('fs');
const path = require('path');
const os = require('os');
const extractZip = require('extract-zip');
const { downloadFile } = require('./downloader');
const { mirrorUrl } = require('./mirror');

const MR_API = 'https://api.modrinth.com/v2';
const HEADERS = {
  'User-Agent': 'CM-Launcher (https://github.com/cm)',
  'Accept': 'application/json',
};

/* 各类型资源的落地目录（相对游戏目录） */
const TYPE_DIRS = {
  mod: 'mods',
  shader: 'shaderpacks',
  resourcepack: 'resourcepacks',
  datapack: 'datapacks',
  modpack: '.modpacks',
};

/**
 * Modrinth 搜索。
 * @param projectType mod | modpack | shader | resourcepack | datapack
 */
async function searchMods(query, mcVersion, modLoader, limit = 20, projectType = 'mod') {
  const facets = [`["project_type:${projectType}"]`];
  if (mcVersion) facets.push(`["versions:${mcVersion}"]`);
  // loader 分类仅对模组有意义（光影走 iris/optifine 分类时同样可用）
  if (modLoader && modLoader !== 'vanilla') facets.push(`["categories:${modLoader}"]`);

  const params = new URLSearchParams({
    query: query || '',
    limit: String(limit),
    facets: `[${facets.join(',')}]`,
  });
  const res = await fetch(`${MR_API}/search?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Modrinth 搜索失败 (HTTP ${res.status})`);
  const data = await res.json();
  return (data.hits || []).map((h) => ({
    id: h.project_id || h.slug,
    name: h.title,
    slug: h.slug,
    summary: h.description,
    author: h.author,
    downloadCount: h.downloads,
    icon: h.icon_url || '',
    categories: h.categories || [],
    versions: h.versions || [],
    follows: h.follows,
  }));
}

async function getVersions(projectId, mcVersion, modLoader) {
  const params = new URLSearchParams();
  if (mcVersion) params.set('game_versions', JSON.stringify([mcVersion]));
  if (modLoader && modLoader !== 'vanilla') params.set('loaders', JSON.stringify([modLoader]));
  const res = await fetch(`${MR_API}/project/${projectId}/version?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`获取版本失败 (HTTP ${res.status})`);
  const data = await res.json();
  return (data || []).map((v) => ({
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    files: (v.files || []).map((f) => ({
      name: f.filename,
      size: f.size,
      url: f.url,
      primary: f.primary,
    })),
    gameVersions: v.game_versions || [],
    loaders: v.loaders || [],
    datePublished: v.date_published,
    dependencies: v.dependencies || [],
  })).sort((a, b) => new Date(b.datePublished) - new Date(a.datePublished));
}

/**
 * 下载单个资源文件到对应类型目录。
 */
async function downloadMod(file, gameDir, projectType = 'mod') {
  const sub = TYPE_DIRS[projectType] || 'downloads';
  const dir = path.join(gameDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file.name);
  await downloadFile(mirrorUrl(file.url), dest, null);
  return dest;
}

/**
 * 安装 .mrpack 整合包：在 gameRoot/instances/<name> 下建立独立游戏目录，
 * 下载所有客户端文件并套用 overrides。
 * @returns {{instanceId:string,name:string,gameDir:string,versionId:string,modLoader:string,loaderVersion:string}}
 */
async function installMrpack(file, gameRoot, send) {
  const progress = (pct, label) => send && send('modloader:progress', { pct, label });

  // 1. 准备 mrpack（本地文件直接复制，网络来源则下载）
  progress(2, file.localPath ? '读取本地整合包…' : '下载整合包文件…');
  const tmpZip = path.join(os.tmpdir(), `cm-mrpack-${Date.now()}.mrpack`);
  if (file.localPath) fs.copyFileSync(file.localPath, tmpZip);
  else await downloadFile(mirrorUrl(file.url), tmpZip, null);

  // 2. 解压
  progress(8, '解压整合包…');
  const tmpDir = path.join(os.tmpdir(), `cm-mrpack-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  await extractZip(tmpZip, { dir: tmpDir });

  const indexRaw = fs.readFileSync(path.join(tmpDir, 'modrinth.index.json'), 'utf8');
  const index = JSON.parse(indexRaw);

  // 3. 创建实例目录
  const safeName = (index.name || 'modpack').replace(/[\\/:*?"<>|]/g, '_');
  let gameDir = path.join(gameRoot, 'instances', safeName);
  let n = 1;
  while (fs.existsSync(gameDir)) gameDir = path.join(gameRoot, 'instances', `${safeName}-${++n}`);
  fs.mkdirSync(gameDir, { recursive: true });

  // 4. 下载客户端文件
  const files = (index.files || []).filter((f) => !f.env || f.env.client !== 'false');
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const pct = 10 + Math.round(((i + 1) / files.length) * 75);
    progress(pct, `下载 Mod 文件 ${i + 1}/${files.length}：${path.basename(f.path)}`);
    const dest = path.join(gameDir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) continue;
    const dl = f.downloads.find((u) => u.includes('cdn.modrinth.com')) || f.downloads[0];
    await downloadFile(mirrorUrl(dl), dest, f.hashes && f.hashes.sha1);
  }

  // 5. 覆盖文件（overrides + client-overrides）
  progress(90, '应用整合包配置…');
  for (const ov of ['overrides', 'client-overrides']) {
    const src = path.join(tmpDir, ov);
    if (fs.existsSync(src)) copyDirRecursive(src, gameDir);
  }

  // 6. 解析依赖
  const deps = index.dependencies || {};
  let modLoader = 'vanilla';
  let loaderVersion = '';
  if (deps.forge) { modLoader = 'forge'; loaderVersion = deps.forge; }
  else if (deps['neoforge']) { modLoader = 'neoforge'; loaderVersion = deps['neoforge']; }
  else if (deps['fabric-loader']) { modLoader = 'fabric'; loaderVersion = deps['fabric-loader']; }
  else if (deps['quilt-loader']) { modLoader = 'quilt'; loaderVersion = deps['quilt-loader']; }

  // 清理临时文件
  try { fs.rmSync(tmpZip, { force: true }); fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  progress(100, '整合包安装完成');
  return {
    instanceId: 'mp-' + Date.now(),
    name: index.name,
    gameDir,
    versionId: deps.minecraft || '',
    modLoader,
    loaderVersion,
  };
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

module.exports = { searchMods, getVersions, downloadMod, installMrpack };
