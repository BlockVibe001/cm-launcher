// 实例导出为整合包（.mrpack 格式）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createZip, collectDir } = require('../util/zip');
const instances = require('./instances');

const UA = 'BlockVibeLauncher/1.0.0 (minecraft launcher)';

// 不打包进 overrides 的目录（mods 单独处理，其余为游戏本体/大文件）
const EXCLUDE_DIRS = new Set([
  'mods', 'saves', 'logs', 'screenshots', 'crash-reports',
  'versions', 'libraries', 'assets', 'runtime', 'shaderpacks', 'resourcepacks',
]);

// 需要打包进 overrides 的配置类目录
const EXTRA_DIRS = ['config', 'defaultconfigs', 'kubejs', 'scripts', 'datapacks'];

async function exportModpack(instanceId, outPath) {
  const inst = instances.getInstance(instanceId);
  if (!inst) throw new Error('实例不存在');
  if (!inst.versionId) throw new Error('该实例未选择游戏版本，无法导出');

  const gameDir = inst.gameDir;
  const modsDir = path.join(gameDir, 'mods');
  const files = [];
  const overrides = [];

  // ① mods：能识别为 Modrinth 项目的走下载链接，识别不了的塞进 overrides
  let modNames = [];
  if (fs.existsSync(modsDir)) {
    modNames = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar'));
  }

  const hashMap = {};
  for (const f of modNames) {
    try {
      const buf = fs.readFileSync(path.join(modsDir, f));
      const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
      const sha512 = crypto.createHash('sha512').update(buf).digest('hex');
      hashMap[sha1] = { file: f, sha1, sha512, size: buf.length };
    } catch {}
  }

  let resolved = {};
  const hashes = Object.keys(hashMap);
  if (hashes.length) {
    try {
      const res = await fetch('https://api.modrinth.com/v2/version_files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ hashes, algorithm: 'sha1' }),
      });
      if (res.ok) resolved = await res.json();
    } catch {}
  }

  for (const sha1 of hashes) {
    const info = hashMap[sha1];
    const v = resolved[sha1];
    const remote = v && v.files && v.files.length
      ? (v.files.find((x) => x.primary) || v.files[0])
      : null;
    if (remote) {
      files.push({
        path: `mods/${info.file}`,
        hashes: { sha1: info.sha1, sha512: info.sha512 },
        downloads: [remote.url],
        fileSize: info.size,
      });
    } else {
      // 无法解析来源的 Mod 直接打包，保证整合包可用
      overrides.push({ name: `overrides/mods/${info.file}`, path: path.join(modsDir, info.file) });
    }
  }

  // ② 配置类目录
  for (const d of EXTRA_DIRS) {
    const full = path.join(gameDir, d);
    if (!fs.existsSync(full)) continue;
    for (const e of collectDir(full)) {
      overrides.push({ name: `overrides/${d}/${e.name}`, path: e.path });
    }
  }

  // ③ 关键单文件
  for (const f of ['options.txt', 'servers.dat']) {
    const full = path.join(gameDir, f);
    if (fs.existsSync(full)) overrides.push({ name: `overrides/${f}`, path: full });
  }

  // ④ 构建索引
  const deps = { minecraft: inst.versionId };
  if (inst.modLoader === 'fabric' && inst.loaderVersion) deps['fabric-loader'] = inst.loaderVersion;
  else if (inst.modLoader === 'quilt' && inst.loaderVersion) deps['quilt-loader'] = inst.loaderVersion;
  else if (inst.modLoader === 'forge' && inst.loaderVersion) deps.forge = inst.loaderVersion;

  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1.0.0',
    name: inst.name,
    summary: `${inst.name} — 由 BlockVibe 启动器导出`,
    files,
    dependencies: deps,
  };

  const entries = [
    { name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2), 'utf8') },
    ...overrides,
  ];

  createZip(outPath, entries);
  return {
    outPath,
    total: entries.length,
    resolvedMods: files.length,
    bundledMods: overrides.filter((o) => o.name.startsWith('overrides/mods/')).length,
  };
}

module.exports = { exportModpack };