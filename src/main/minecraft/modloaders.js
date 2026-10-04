const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { mirrorUrl } = require('./mirror');
const { downloadFile } = require('./downloader');

/**
 * 获取 Forge 可用版本列表
 */
async function getForgeVersions(mcVersion) {
  const url = `https://bmclapi2.bangbang93.com/forge/minecraft/${mcVersion}`;
  const res = await fetch(mirrorUrl(url), { headers: { 'User-Agent': 'CM-Launcher' } });
  if (!res.ok) throw new Error(`获取 Forge 版本列表失败 (HTTP ${res.status})`);
  const list = await res.json();
  return list.map((v) => ({
    mcVersion: v.mcversion,
    version: v.version,
    isLatest: v.latest,
    isRecommended: v.recommended,
  }));
}

/**
 * 安装 Forge：下载 installer.jar，用 java 执行 --installClient
 */
async function installForge(mcVersion, forgeVersion, gameDir, javaPath, onProgress) {
  if (!javaPath) throw new Error('安装 Forge 需要 Java，请在设置中指定 java.exe');

  const installerUrl = `https://bmclapi2.bangbang93.com/forge/download?mcversion=${mcVersion}&version=${forgeVersion}&category=installer`;
  const installerFile = path.join(gameDir, `forge-${mcVersion}-${forgeVersion}-installer.jar`);
  fs.mkdirSync(gameDir, { recursive: true });

  if (onProgress) onProgress({ step: '下载 Forge 安装器…', percent: 10 });
  await downloadFile(mirrorUrl(installerUrl), installerFile, null);

  if (onProgress) onProgress({ step: '运行 Forge 安装器…', percent: 30 });
  await runJar(javaPath, [installerFile, '--installClient', '--gameDir', gameDir], gameDir, onProgress, 30, 90);

  // 清理安装器
  try { fs.unlinkSync(installerFile); } catch { /* 忽略 */ }
  if (onProgress) onProgress({ step: 'Forge 安装完成', percent: 100 });

  // 返回新生成的版本 id
  const newId = `${mcVersion}-forge-${forgeVersion}`;
  return newId;
}

/**
 * 获取 NeoForge 可用版本列表（BMCLAPI 提供按 MC 版本过滤的清单）
 */
async function getNeoForgeVersions(mcVersion) {
  const url = `https://bmclapi2.bangbang93.com/neoforge/list/${encodeURIComponent(mcVersion)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'CM-Launcher' } });
  if (!res.ok) throw new Error(`获取 NeoForge 版本列表失败 (HTTP ${res.status})`);
  const list = await res.json();
  return list.map((v) => ({
    mcVersion: v.mcversion,
    version: v.version,
  }));
}

/**
 * 安装 NeoForge：与 Forge 同套路，下载 installer.jar 后 java --installClient。
 * 安装器走 BMCLAPI 的 maven 镜像。
 */
async function installNeoForge(mcVersion, neoVersion, gameDir, javaPath, onProgress) {
  if (!javaPath) throw new Error('安装 NeoForge 需要 Java，请在设置中指定 java.exe');

  const installerUrl = `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${neoVersion}/neoforge-${neoVersion}-installer.jar`;
  const installerFile = path.join(gameDir, `neoforge-${mcVersion}-${neoVersion}-installer.jar`);
  fs.mkdirSync(gameDir, { recursive: true });

  if (onProgress) onProgress({ step: '下载 NeoForge 安装器…', percent: 10 });
  await downloadFile(installerUrl, installerFile, null);

  if (onProgress) onProgress({ step: '运行 NeoForge 安装器…', percent: 30 });
  await runJar(javaPath, [installerFile, '--installClient', '--gameDir', gameDir], gameDir, onProgress, 30, 90);

  try { fs.unlinkSync(installerFile); } catch { /* 忽略 */ }
  if (onProgress) onProgress({ step: 'NeoForge 安装完成', percent: 100 });

  // NeoForge 安装器生成的版本 id
  return `neoforge-${neoVersion}`;
}

/**
 * Fabric：直接从 meta API 拉取完整 version.json，无需安装器
 */
async function getFabricLoaders() {
  const res = await fetch('https://meta.fabricmc.net/v2/versions/loader', {
    headers: { 'User-Agent': 'CM-Launcher' },
  });
  if (!res.ok) throw new Error('获取 Fabric loader 版本失败');
  return res.json();
}

async function installFabric(mcVersion, loaderVersion, gameDir, onProgress) {
  const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'CM-Launcher' } });
  if (!res.ok) throw new Error(`Fabric profile 获取失败 (HTTP ${res.status})`);
  const profile = await res.json();

  fs.mkdirSync(path.join(gameDir, 'versions', profile.id), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'versions', profile.id, `${profile.id}.json`), JSON.stringify(profile, null, 2));
  if (onProgress) onProgress({ step: `Fabric ${profile.id} 版本清单已生成`, percent: 100 });
  return profile.id;
}

/**
 * Quilt：同 Fabric，走 meta API
 */
async function getQuiltLoaders() {
  const res = await fetch('https://meta.quiltmc.org/v3/versions/loader', {
    headers: { 'User-Agent': 'CM-Launcher' },
  });
  if (!res.ok) throw new Error('获取 Quilt loader 版本失败');
  return res.json();
}

async function installQuilt(mcVersion, loaderVersion, gameDir, onProgress) {
  const url = `https://meta.quiltmc.org/v3/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'CM-Launcher' } });
  if (!res.ok) throw new Error(`Quilt profile 获取失败 (HTTP ${res.status})`);
  const profile = await res.json();

  fs.mkdirSync(path.join(gameDir, 'versions', profile.id), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'versions', profile.id, `${profile.id}.json`), JSON.stringify(profile, null, 2));
  if (onProgress) onProgress({ step: `Quilt ${profile.id} 版本清单已生成`, percent: 100 });
  return profile.id;
}

/**
 * 运行 java -jar 并等待结束，带进度映射
 */
function runJar(javaPath, args, cwd, onProgress, fromPct, toPct) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, ['-jar', ...args], { cwd, windowsHide: true });
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`安装器退出码 ${code}\n${output.slice(-2000)}`));
    });
  });
}

module.exports = {
  getForgeVersions, installForge,
  getNeoForgeVersions, installNeoForge,
  getFabricLoaders, installFabric,
  getQuiltLoaders, installQuilt,
};
