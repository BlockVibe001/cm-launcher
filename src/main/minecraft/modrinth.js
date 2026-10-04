const fs = require('fs');
const path = require('path');
const os = require('os');
const extractZip = require('extract-zip');
const config = require('../config');
const { downloadFile } = require('./downloader');
const { mirrorUrl } = require('./mirror');

/* Modrinth API：官方在国内直连不稳，配 MCIM 镜像（PCL2 同款）做兜底。
   开了 BMCL 镜像的用户优先走 MCIM；官方优先时失败也会回落到 MCIM。 */
const MR_OFFICIAL = 'https://api.modrinth.com/v2';
const MR_MCIM = 'https://mod.mcimirror.top/modrinth/v2';

const HEADERS = {
  'User-Agent': 'CM-Launcher (https://github.com/cm)',
  'Accept': 'application/json',
};

function mrBases() {
  return config.get('mirror') === 'bmcl' ? [MR_MCIM, MR_OFFICIAL] : [MR_OFFICIAL, MR_MCIM];
}

/** 依次尝试各 API 源，全部失败才抛错。 */
async function mrFetch(path) {
  let lastErr;
  for (const base of mrBases()) {
    try {
      const res = await fetch(base + path, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Modrinth 请求失败：${lastErr && lastErr.message}`);
}

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
  const buildFacets = (withVersion) => {
    const facets = [`["project_type:${projectType}"]`];
    if (withVersion && mcVersion) facets.push(`["versions:${mcVersion}"]`);
    // loader 分类仅对模组有意义（光影走 iris/optifine 分类时同样可用）
    if (modLoader && modLoader !== 'vanilla') facets.push(`["categories:${modLoader}"]`);
    return `[${facets.join(',')}]`;
  };

  const search = (facets) => mrFetch(`/search?${new URLSearchParams({
    query: query || '',
    limit: String(limit),
    facets,
  })}`);

  let data = await search(buildFacets(true));
  // Modrinth 的 versions 面片对裸 1.X（如 1.20）匹配不到任何项目，0 结果时去掉版本过滤重搜
  if (mcVersion && !(data.total_hits > 0)) {
    data = await search(buildFacets(false));
  }
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
  const fetchVersions = (withVersion) => {
    const params = new URLSearchParams();
    if (withVersion && mcVersion) params.set('game_versions', JSON.stringify([mcVersion]));
    if (modLoader && modLoader !== 'vanilla') params.set('loaders', JSON.stringify([modLoader]));
    return mrFetch(`/project/${projectId}/version?${params}`);
  };
  let data = await fetchVersions(true);
  // 同搜索：裸 1.X 匹配不到时去掉版本过滤重试
  if (mcVersion && (!Array.isArray(data) || data.length === 0)) {
    data = await fetchVersions(false);
  }
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

/** 取项目基本信息（前置模组解析名字用） */
async function getProject(projectId) {
  const p = await mrFetch(`/project/${projectId}`);
  return { id: p.id || p.slug, title: p.title, slug: p.slug, icon: p.icon_url || '' };
}

module.exports = { searchMods, getVersions, getProject, downloadMod, installMrpack };
