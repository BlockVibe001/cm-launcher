// 种子地图：史莱姆区块计算 + 存档种子读取 + 结构查询外链
const path = require('path');
const { TAG, parseNbt } = require('./nbt');
const fs = require('fs');
const zlib = require('zlib');

/* ---------- Java Random（48 位 LCG） ---------- */
function javaRandom(seed) {
  let s = (BigInt.asIntN(64, BigInt(seed)) ^ 0x5deece66dn) & ((1n << 48n) - 1n);
  return {
    next(bits) {
      s = (s * 0x5deece66dn + 0xbn) & ((1n << 48n) - 1n);
      return Number(s >> BigInt(48 - bits));
    },
    nextInt(bound) {
      if (bound <= 0) throw new Error('bound 必须为正');
      if ((bound & -bound) === bound) {
        return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
      }
      let bits;
      let val;
      do {
        bits = this.next(31);
        val = bits % bound;
      } while (bits - val + (bound - 1) < 0);
      return val;
    },
  };
}

/**
 * 判断某个区块是否为史莱姆区块
 * 公式（Minecraft Wiki / 官方实现）：
 *   seed + x*x*4987142 + x*5947611 + z*z*4392871 + z*389711 ^ 987234911
 *   Random(该值).nextInt(10) === 0
 */
function isSlimeChunk(worldSeed, x, z) {
  const bx = BigInt.asIntN(64, BigInt(x));
  const bz = BigInt.asIntN(64, BigInt(z));
  const mixed = BigInt.asIntN(64, BigInt(worldSeed))
    + bx * bx * 4987142n
    + bx * 5947611n
    + bz * bz * 4392871n
    + bz * 389711n;
  const seed = BigInt.asIntN(64, mixed ^ 987234911n);
  return javaRandom(seed).nextInt(10) === 0;
}

/**
 * 返回区块范围内的史莱姆区块分布
 * @returns {Array<[number, number]>} 命中区块的 [cx, cz] 列表
 */
function slimeChunks(worldSeed, cx0, cz0, w, h) {
  const out = [];
  for (let dz = 0; dz < h; dz++) {
    for (let dx = 0; dx < w; dx++) {
      const cx = cx0 + dx;
      const cz = cz0 + dz;
      if (isSlimeChunk(worldSeed, cx, cz)) out.push([cx, cz]);
    }
  }
  return out;
}

/** 从存档 level.dat 读取世界种子 */
function seedFromSave(saveDir) {
  const file = path.join(saveDir, 'level.dat');
  if (!fs.existsSync(file)) throw new Error('找不到 level.dat');
  const root = parseNbt(zlib.gunzipSync(fs.readFileSync(file)));
  const data = root.v && root.v.Data ? root.v.Data.v : null;
  if (!data) throw new Error('level.dat 结构异常');
  return data.RandomSeed ? String(data.RandomSeed.v) : '0';
}

/** 生成 Chunk Base 查询链接（群系 / 结构 / 村庄 / 神殿） */
function chunkbaseUrl(seed, version) {
  const v = version || '1.20';
  return `https://www.chunkbase.com/apps/seed-map#seed=${encodeURIComponent(seed)}&platform=java_${encodeURIComponent(v)}`;
}

module.exports = { isSlimeChunk, slimeChunks, seedFromSave, chunkbaseUrl };