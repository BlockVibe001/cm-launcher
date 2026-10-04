// 种子地图原生引擎：spawn 随包分发的 seedmap.exe（cubiomes + mapcli）。
// 协议见 resources/tools/seedmap/seedmap.exe 的 mapcli.c：
//   tile      → "OK\n" + w*h 个 RGB
//   structs   → 每行 "<类型> <x> <z>"，以 END 结束
//   stronghold→ 每行 "<x> <z>"，END
//   spawn     → "<x> <z>"
//   slime     → 每行 "<cx> <cz>"，END
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { app } = require('electron');
const logger = require('../logger');

function exePath() {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'tools')
    : path.join(__dirname, '..', '..', '..', 'resources', 'tools');
  return path.join(root, 'seedmap', 'seedmap.exe');
}

/** 跑一条命令，拿到完整 stdout（二进制安全） */
function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let exe;
    try {
      exe = exePath();
    } catch (e) {
      reject(e);
      return;
    }
    if (!fs.existsSync(exe)) {
      reject(new Error('种子地图引擎缺失，请检查安装完整性'));
      return;
    }
    const child = spawn(exe, args.map(String), { windowsHide: true });
    const chunks = [];
    const errChunks = [];
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('种子地图引擎响应超时'));
    }, timeoutMs || 20000);

    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const msg = Buffer.concat(errChunks).toString().trim();
        logger.warn(`seedmap exit ${code}: ${msg}`);
        reject(new Error(msg || `引擎退出码 ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function expectOk(buf) {
  if (buf.length < 3 || buf[0] !== 0x4f || buf[1] !== 0x4b || buf[2] !== 0x0a) {
    throw new Error('引擎返回格式异常');
  }
  return buf.subarray(3);
}

function parsePointLines(buf) {
  const out = [];
  const lines = buf.toString().split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t === 'END') break;
    const parts = t.split(/\s+/);
    if (parts.length >= 3) {
      out.push({ type: parseInt(parts[0], 10), x: parseInt(parts[1], 10), z: parseInt(parts[2], 10) });
    } else if (parts.length === 2) {
      out.push({ x: parseInt(parts[0], 10), z: parseInt(parts[1], 10) });
    }
  }
  return out;
}

/** 生物群系瓦片：返回裸 RGB Buffer（逐像素 3 字节，行优先，z 从上到下）。
 *  大瓦片自动横向切成多条带，并行跑多个引擎进程（TCC 产物单线程较慢，
 *  4 进程可把全屏瓦片从 ~6s 压到 ~1.8s）。 */
async function tile(payload) {
  const { version = '1.20', dim = 0, seed, scale = 4, x = 0, z = 0, w = 128, h = 128 } = payload || {};
  if (seed === undefined || seed === null || seed === '') throw new Error('请先填写种子');
  if (![4, 16, 64, 256].includes(scale)) throw new Error('不支持的缩放级别');
  if (w <= 0 || h <= 0 || w > 4096 || h > 4096) throw new Error('瓦片尺寸非法');

  const maxWorkers = Math.max(1, Math.min(4, os.cpus().length || 1));
  const workers = (w * h > 40000 && maxWorkers > 1) ? Math.min(maxWorkers, Math.max(1, Math.floor(h / 24))) : 1;

  if (workers <= 1) {
    const buf = await run(['tile', version, dim, seed, scale, x, z, w, h]);
    const px = expectOk(buf);
    if (px.length !== w * h * 3) throw new Error('瓦片像素长度异常');
    return { pixels: px, w, h, scale };
  }

  const bandH = Math.floor(h / workers);
  const jobs = [];
  for (let k = 0; k < workers; k++) {
    const bh = k === workers - 1 ? h - bandH * k : bandH;
    const bz = z + bandH * k * scale;
    jobs.push((async () => {
      const buf = await run(['tile', version, dim, seed, scale, x, bz, w, bh]);
      const px = expectOk(buf);
      if (px.length !== w * bh * 3) throw new Error('瓦片分条像素长度异常');
      return px;
    })());
  }
  const bands = await Promise.all(jobs);
  return { pixels: Buffer.concat(bands), w, h, scale };
}

/** 区域内全部结构点（方块坐标） */
async function structures(payload) {
  const { version = '1.20', dim = 0, seed, bx0, bz0, bx1, bz1 } = payload || {};
  if (seed === undefined || seed === null || seed === '') throw new Error('请先填写种子');
  const buf = await run(['structs', version, dim, seed, bx0, bz0, bx1, bz1]);
  return parsePointLines(buf);
}

/** 全部要塞（前若干个，链到世界极限前停止） */
async function strongholds(payload) {
  const { version = '1.20', seed } = payload || {};
  const buf = await run(['stronghold', version, seed]);
  return parsePointLines(buf);
}

/** 世界出生点估算 */
async function spawnPoint(payload) {
  const { version = '1.20', seed } = payload || {};
  const buf = await run(['spawn', version, seed]);
  const t = buf.toString().trim();
  const m = /(-?\d+)\s+(-?\d+)/.exec(t);
  if (!m) throw new Error('出生点解析失败');
  return { x: parseInt(m[1], 10), z: parseInt(m[2], 10) };
}

/** 区块范围内的史莱姆区块 */
async function slime(payload) {
  const { seed, cx0, cz0, cx1, cz1 } = payload || {};
  const buf = await run(['slime', seed, cx0, cz0, cx1, cz1]);
  return parsePointLines(buf);
}

/** 单个坐标的地表群系 id */
async function biome(payload) {
  const { version = '1.20', dim = 0, seed, x, z } = payload || {};
  if (seed === undefined || seed === null || seed === '') throw new Error('请先填写种子');
  const buf = await run(['biome', version, dim, seed, x, z]);
  const id = parseInt(buf.toString().trim(), 10);
  if (Number.isNaN(id)) throw new Error('群系查询解析失败');
  return id;
}

module.exports = { tile, structures, strongholds, spawnPoint, slime, biome, exePath };
