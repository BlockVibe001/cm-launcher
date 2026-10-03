const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const extract = require('extract-zip');
const { mirrorUrl } = require('./mirror');
const { matchesRules, osName } = require('./rules');
const logger = require('../logger');

const CONCURRENCY = 16;

class CanceledError extends Error {
  constructor() {
    super('已取消下载');
    this.code = 'CANCELED';
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function hashBuffer(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function fetchBuffer(url, signal) {
  const res = await fetch(mirrorUrl(url), {
    signal,
    headers: { 'User-Agent': 'CM-Launcher/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 下载单个文件（已存在且 sha1 匹配则跳过），最多重试 3 次。
 * @returns {Promise<boolean>} 是否实际发生了网络下载
 */
async function downloadFile(url, dest, expectedSha1, signal) {
  if (signal && signal.aborted) throw new CanceledError();

  if (fs.existsSync(dest)) {
    if (!expectedSha1 || (await hashFile(dest)) === expectedSha1) return false;
  }

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const buf = await fetchBuffer(url, signal);
      if (expectedSha1 && hashBuffer(buf) !== expectedSha1) {
        throw new Error('SHA1 校验失败');
      }
      mkdirp(path.dirname(dest));
      fs.writeFileSync(dest, buf);
      return true;
    } catch (e) {
      if (e.name === 'AbortError') throw new CanceledError();
      lastErr = e;
      if (attempt < 3) {
        logger.warn(`下载重试 ${attempt}/3：${path.basename(dest)}（${e.message}）`);
      }
    }
  }
  throw new Error(`下载失败：${path.basename(dest)}（${lastErr.message}）`);
}

function parseMavenName(name) {
  const p = name.split(':');
  return { group: p[0], artifact: p[1], version: p[2], classifier: p[3] || null };
}

function isCurrentOsClassifier(classifier) {
  if (!classifier) return false;
  if (osName === 'windows') return classifier.includes('windows');
  if (osName === 'osx') return classifier.includes('osx') || classifier.includes('macos');
  return classifier.includes('linux');
}

async function extractNatives(zipFile, destDir, excludes, signal) {
  mkdirp(destDir);
  await extract(zipFile, {
    dir: destDir,
    defaultDirMode: 0o755,
    onEntry: () => {
      if (signal && signal.aborted) throw new CanceledError();
    },
  });
  // 清理不需要的条目（如 META-INF/）
  for (const ex of excludes || []) {
    const target = path.join(destDir, ex.replace(/[\\/]$/, ''));
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // 忽略删除失败
    }
  }
}

/**
 * 确保指定版本的所有文件就绪：client、libraries、natives、assets。
 */
async function prepareGame(vj, gameDir, options = {}) {
  const { signal, onProgress } = options;

  const versionsDir = path.join(gameDir, 'versions', vj.id);
  const nativesDir = path.join(versionsDir, 'natives');
  const librariesDir = path.join(gameDir, 'libraries');
  const assetsDir = path.join(gameDir, 'assets');

  mkdirp(versionsDir);
  fs.writeFileSync(path.join(versionsDir, `${vj.id}.json`), JSON.stringify(vj, null, 2));

  const downloads = [];
  const extractions = [];
  const copies = [];

  // 1) 客户端主 jar
  downloads.push({
    url: vj.downloads.client.url,
    dest: path.join(versionsDir, `${vj.id}.jar`),
    sha1: vj.downloads.client.sha1,
    size: vj.downloads.client.size,
    label: `${vj.id}.jar`,
  });

  // 2) 库文件与本地原生库
  for (const lib of vj.libraries || []) {
    if (lib.rules && !matchesRules(lib.rules)) continue;

    const artifact = lib.downloads && lib.downloads.artifact;
    if (artifact) {
      downloads.push({
        url: artifact.url,
        dest: path.join(librariesDir, artifact.path),
        sha1: artifact.sha1,
        size: artifact.size,
        label: artifact.path,
      });
    }

    // 新格式：natives 作为带 classifier 的普通库出现，需要解压
    const maven = parseMavenName(lib.name || '');
    if (maven.classifier && maven.classifier.startsWith('natives-') && isCurrentOsClassifier(maven.classifier) && artifact) {
      extractions.push({
        zip: path.join(librariesDir, artifact.path),
        destDir: nativesDir,
        excludes: ['META-INF/'],
      });
    }

    // 旧格式：natives + classifiers
    if (lib.natives && lib.downloads && lib.downloads.classifiers) {
      let key = lib.natives[osName];
      if (key) {
        key = key.replace('${arch}', process.arch === 'x64' ? '64' : '32');
        const cls = lib.downloads.classifiers[key];
        if (cls) {
          const zipDest = path.join(librariesDir, cls.path);
          downloads.push({
            url: cls.url,
            dest: zipDest,
            sha1: cls.sha1,
            size: cls.size,
            label: cls.path,
          });
          extractions.push({
            zip: zipDest,
            destDir: nativesDir,
            excludes: (lib.extract && lib.extract.exclude) || ['META-INF/'],
          });
        }
      }
    }
  }

  // 3) 资源索引与资源文件
  if (vj.assetIndex) {
    const indexDest = path.join(assetsDir, 'indexes', `${vj.assetIndex.id}.json`);
    await downloadFile(vj.assetIndex.url, indexDest, vj.assetIndex.sha1, signal);
    const index = JSON.parse(fs.readFileSync(indexDest, 'utf8'));

    for (const [name, obj] of Object.entries(index.objects)) {
      const sub = obj.hash.slice(0, 2);
      const dest = path.join(assetsDir, 'objects', sub, obj.hash);
      downloads.push({
        url: `https://resources.download.minecraft.net/${sub}/${obj.hash}`,
        dest,
        sha1: obj.hash,
        size: obj.size,
        label: name,
      });
      if (index.virtual) {
        copies.push({ from: dest, to: path.join(assetsDir, 'virtual', vj.assetIndex.id, name) });
      } else if (index.map_to_resources) {
        copies.push({ from: dest, to: path.join(gameDir, 'resources', name) });
      }
    }
  }

  // 4) 并发执行下载并上报进度
  const total = downloads.length + extractions.length + copies.length;
  let completed = 0;
  let bytesDone = 0;
  const bytesTotal = downloads.reduce((a, d) => a + (d.size || 0), 0);

  const report = (current) => {
    if (onProgress) {
      onProgress({
        completed,
        total,
        bytesDone,
        bytesTotal,
        current: current || '',
        percent: total ? Math.round((completed / total) * 100) : 100,
      });
    }
  };
  report('');

  let cursor = 0;
  const worker = async () => {
    while (cursor < downloads.length) {
      if (signal && signal.aborted) throw new CanceledError();
      const task = downloads[cursor++];
      try {
        await downloadFile(task.url, task.dest, task.sha1, signal);
      } finally {
        bytesDone += task.size || 0;
        completed += 1;
        report(task.label);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // 5) 解压 natives
  for (const ex of extractions) {
    if (signal && signal.aborted) throw new CanceledError();
    await extractNatives(ex.zip, ex.destDir, ex.excludes, signal);
    completed += 1;
    report(path.basename(ex.zip));
  }

  // 6) 旧版本资源复制（virtual / map_to_resources）
  for (const cp of copies) {
    if (signal && signal.aborted) throw new CanceledError();
    mkdirp(path.dirname(cp.to));
    fs.copyFileSync(cp.from, cp.to);
    completed += 1;
    report(path.basename(cp.to));
  }

  report('完成');
}

module.exports = { prepareGame, CanceledError, hashFile, downloadFile };
