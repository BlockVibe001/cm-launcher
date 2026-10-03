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

module.exports = { getManifest, getVersionDetail };
