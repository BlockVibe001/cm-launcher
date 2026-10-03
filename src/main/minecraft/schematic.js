// 投影工坊：解析/编辑/导出结构文件
// 支持：Litematica(.litematic)、Sponge v2/v3(.schem)、MCEdit 经典(.schematic)
const fs = require('fs');
const zlib = require('zlib');
const { TAG, parseNbt, writeNbt } = require('./nbt');
const { createZip } = require('../util/zip');

const AIR = 'minecraft:air';

/* ---------- 工具 ---------- */

function compound(node) { return node && node.t === TAG.COMPOUND ? node.v : null; }

function readGzipNbt(file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  return parseNbt(buf);
}

/** 读取 Sponge 风格的 varint 数组 */
function readVarints(buf, maxCount) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let value = 0;
    let position = 0;
    for (;;) {
      const b = buf[i++];
      value |= (b & 0x7f) << position;
      if ((b & 0x80) === 0) break;
      position += 7;
      if (position > 35) throw new Error('varint 长度异常');
    }
    out.push(value >>> 0);
    if (maxCount && out.length > maxCount) throw new Error('方块数量异常');
  }
  return out;
}

function writeVarints(values) {
  const bytes = [];
  for (const v0 of values) {
    let v = v0 >>> 0;
    while ((v & ~0x7f) !== 0) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v);
  }
  return Buffer.from(bytes);
}

/* ---------- Litematica BitArray ---------- */

function bitWidthFor(paletteSize) {
  let bits = 2;
  while ((1 << bits) < paletteSize) bits++;
  return Math.max(2, bits);
}

/** 从 Litematica 的 long 数组中读取指定索引的调色板下标 */
function litematicaBitGet(arr, bits, index) {
  const b = BigInt(bits);
  const startOffset = BigInt(index) * b;
  const startArrIndex = Number(startOffset >> 6n);
  const endArrIndex = Number(((BigInt(index) + 1n) * b - 1n) >> 6n);
  const startBitOffset = Number(startOffset & 63n);
  const mask = (1n << b) - 1n;
  const a = BigInt.asUintN(64, BigInt(arr[startArrIndex] || 0));
  if (startArrIndex === endArrIndex) return Number((a >> BigInt(startBitOffset)) & mask);
  const endOffset = 64 - startBitOffset;
  const c = BigInt.asUintN(64, BigInt(arr[endArrIndex] || 0));
  return Number(((a >> BigInt(startBitOffset)) | (c << BigInt(endOffset))) & mask);
}

function litematicaBitSet(arr, bits, index, value) {
  const b = BigInt(bits);
  const startOffset = BigInt(index) * b;
  const startArrIndex = Number(startOffset >> 6n);
  const endArrIndex = Number(((BigInt(index) + 1n) * b - 1n) >> 6n);
  const startBitOffset = Number(startOffset & 63n);
  const mask = (1n << b) - 1n;
  const v = BigInt.asUintN(64, BigInt(value));
  if (startArrIndex === endArrIndex) {
    let a = BigInt.asUintN(64, BigInt(arr[startArrIndex] || 0));
    a = (a & ~(mask << BigInt(startBitOffset))) | (v << BigInt(startBitOffset));
    arr[startArrIndex] = BigInt.asIntN(64, a);
    return;
  }
  const endOffset = 64 - startBitOffset;
  let a = BigInt.asUintN(64, BigInt(arr[startArrIndex] || 0));
  a = (a & ~(mask << BigInt(startBitOffset))) | (v << BigInt(startBitOffset));
  arr[startArrIndex] = BigInt.asIntN(64, a);
  let c = BigInt.asUintN(64, BigInt(arr[endArrIndex] || 0));
  c = (c & ~(mask >> BigInt(endOffset))) | (v >> BigInt(endOffset));
  arr[endArrIndex] = BigInt.asIntN(64, c);
}

/* ---------- 从各格式解析出统一结构 ---------- */

function fromLitematic(root) {
  const regions = compound(root.v.Regions);
  if (!regions) throw new Error('litematic 缺少 Regions');
  const meta = compound(root.v.Metadata);

  // 计算总包围盒
  const list = [];
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  for (const [rname, rnode] of Object.entries(regions)) {
    const r = compound(rnode);
    if (!r) continue;
    const pos = compound(r.Position) || {};
    const size = compound(r.Size) || {};
    const px = pos.x ? Number(pos.x.v) : 0;
    const py = pos.y ? Number(pos.y.v) : 0;
    const pz = pos.z ? Number(pos.z.v) : 0;
    const sx = Math.abs(size.x ? Number(size.x.v) : 0);
    const sy = Math.abs(size.y ? Number(size.y.v) : 0);
    const sz = Math.abs(size.z ? Number(size.z.v) : 0);
    list.push({ rname, r, px, py, pz, sx, sy, sz });
    minX = Math.min(minX, px); minY = Math.min(minY, py); minZ = Math.min(minZ, pz);
    maxX = Math.max(maxX, px + sx); maxY = Math.max(maxY, py + sy); maxZ = Math.max(maxZ, pz + sz);
  }
  if (!list.length) throw new Error('litematic 没有可用区域');

  const X = Math.max(1, maxX - minX);
  const Y = Math.max(1, maxY - minY);
  const Z = Math.max(1, maxZ - minZ);

  const nameToIdx = new Map([[AIR, 0]]);
  const palette = [AIR];
  const blocks = new Int32Array(X * Y * Z); // 默认 0 = air

  for (const rg of list) {
    const rawPal = rg.r.BlockStatePalette ? rg.r.BlockStatePalette.v : [];
    const regionPal = [];
    for (const p of rawPal) {
      const c = compound(p) || {};
      const nm = c.Name ? String(c.Name.v) : AIR;
      regionPal.push(nm);
    }
    const states = rg.r.BlockStates ? rg.r.BlockStates.v : [];
    const bits = bitWidthFor(Math.max(2, regionPal.length));

    // 把区域调色板映射到全局调色板
    const gmap = regionPal.map((nm) => {
      if (nameToIdx.has(nm)) return nameToIdx.get(nm);
      const idx = palette.length;
      palette.push(nm);
      nameToIdx.set(nm, idx);
      return idx;
    });

    const rX = rg.sx; const rZ = rg.sz; const rY = rg.sy;
    for (let y = 0; y < rY; y++) {
      for (let z = 0; z < rZ; z++) {
        for (let x = 0; x < rX; x++) {
          const localIdx = (y * rZ + z) * rX + x;
          let pi = 0;
          try { pi = litematicaBitGet(states, bits, localIdx); } catch { pi = 0; }
          const g = gmap[pi] != null ? gmap[pi] : 0;
          if (g === 0) continue;
          const gx = rg.px - minX + x;
          const gy = rg.py - minY + y;
          const gz = rg.pz - minZ + z;
          blocks[(gy * Z + gz) * X + gx] = g;
        }
      }
    }
  }

  return {
    format: 'litematic',
    size: { x: X, y: Y, z: Z },
    palette,
    blocks,
    name: meta && meta.Name ? String(meta.Name.v) : '',
    author: meta && meta.Author ? String(meta.Author.v) : '',
  };
}

function fromSponge(root) {
  // v3: root.Blocks.{Palette,Data}；v2: root.Palette / root.BlockData
  const isV3 = root.v.Blocks && root.v.Blocks.t === TAG.COMPOUND;
  const holder = isV3 ? compound(root.v.Blocks) : root.v;
  const W = Number(holder.Width ? holder.Width.v : 0);
  const H = Number(holder.Height ? holder.Height.v : 0);
  const L = Number(holder.Length ? holder.Length.v : 0);
  if (!W || !H || !L) throw new Error('schem 尺寸缺失');
  const palNode = compound(holder.Palette);
  if (!palNode) throw new Error('schem 缺少 Palette');
  const idxToName = [];
  for (const [nm, idxNode] of Object.entries(palNode)) idxToName[Number(idxNode.v)] = nm;
  const dataNode = isV3 ? holder.Data : holder.BlockData;
  const varints = readVarints(dataNode.v, W * H * L + 8);

  const blocks = new Int32Array(W * H * L);
  for (let i = 0; i < blocks.length; i++) blocks[i] = varints[i] || 0;
  return {
    format: 'sponge',
    size: { x: W, y: H, z: L },
    palette: idxToName.map((n) => n || AIR),
    blocks,
    name: '',
    author: '',
  };
}

// 经典 MCEdit 数字 ID → 名称（常用方块子集）
const LEGACY = {
  0: 'minecraft:air', 1: 'minecraft:stone', 2: 'minecraft:grass_block', 3: 'minecraft:dirt',
  4: 'minecraft:cobblestone', 5: 'minecraft:oak_planks', 7: 'minecraft:bedrock', 8: 'minecraft:water',
  9: 'minecraft:water', 10: 'minecraft:lava', 11: 'minecraft:lava', 12: 'minecraft:sand',
  13: 'minecraft:gravel', 14: 'minecraft:gold_ore', 15: 'minecraft:iron_ore', 16: 'minecraft:coal_ore',
  17: 'minecraft:oak_log', 18: 'minecraft:oak_leaves', 20: 'minecraft:glass', 24: 'minecraft:sandstone',
  35: 'minecraft:white_wool', 41: 'minecraft:gold_block', 42: 'minecraft:iron_block',
  43: 'minecraft:stone_slab', 44: 'minecraft:stone_slab', 45: 'minecraft:bricks',
  46: 'minecraft:tnt', 47: 'minecraft:bookshelf', 48: 'minecraft:mossy_cobblestone',
  49: 'minecraft:obsidian', 50: 'minecraft:torch', 52: 'minecraft:spawner', 53: 'minecraft:oak_stairs',
  54: 'minecraft:chest', 56: 'minecraft:diamond_ore', 57: 'minecraft:diamond_block',
  58: 'minecraft:crafting_table', 61: 'minecraft:furnace', 64: 'minecraft:oak_door',
  65: 'minecraft:ladder', 67: 'minecraft:cobblestone_stairs', 73: 'minecraft:redstone_ore',
  79: 'minecraft:ice', 80: 'minecraft:snow_block', 82: 'minecraft:clay', 85: 'minecraft:oak_fence',
  87: 'minecraft:netherrack', 88: 'minecraft:soul_sand', 89: 'minecraft:glowstone',
  98: 'minecraft:stone_bricks', 102: 'minecraft:glass_pane', 110: 'minecraft:mycelium',
  121: 'minecraft:end_stone', 129: 'minecraft:emerald_ore', 133: 'minecraft:emerald_block',
  152: 'minecraft:redstone_block', 155: 'minecraft:quartz_block', 159: 'minecraft:white_terracotta',
};
function legacyName(id) { return LEGACY[id] || `legacy:${id}`; }

function fromMcedit(root) {
  const W = Number(root.v.Width ? root.v.Width.v : 0);
  const H = Number(root.v.Height ? root.v.Height.v : 0);
  const L = Number(root.v.Length ? root.v.Length.v : 0);
  if (!W || !H || !L) throw new Error('schematic 尺寸缺失');
  const blocksNode = root.v.Blocks;
  if (!blocksNode) throw new Error('schematic 缺少 Blocks');
  const raw = blocksNode.v;
  const add = root.v.AddBlocks ? root.v.AddBlocks.v : null;

  const palette = [];
  const nameToIdx = new Map();
  const idxFor = (nm) => {
    if (nameToIdx.has(nm)) return nameToIdx.get(nm);
    const i = palette.length;
    palette.push(nm);
    nameToIdx.set(nm, i);
    return i;
  };
  const blocks = new Int32Array(W * H * L);
  for (let i = 0; i < blocks.length; i++) {
    let id = raw[i];
    if (add) {
      const hi = i % 2 === 0 ? (add[i >> 1] & 0x0f) : ((add[i >> 1] >> 4) & 0x0f);
      id += hi << 8;
    }
    blocks[i] = idxFor(legacyName(id));
  }
  return { format: 'mcedit', size: { x: W, y: H, z: L }, palette, blocks, name: '', author: '' };
}

/** 读取结构文件（自动识别格式） */
function readSchematic(file) {
  const root = readGzipNbt(file);
  if (root.v.Regions) return fromLitematic(root);
  if (root.v.Blocks && root.v.Blocks.t === TAG.BYTE_ARRAY && root.v.Width) return fromMcedit(root);
  if (root.v.Blocks && root.v.Blocks.t === TAG.COMPOUND) return fromSponge(root);
  if (root.v.Palette && root.v.BlockData) return fromSponge(root);
  throw new Error('无法识别的结构文件格式');
}

/* ---------- 统计 / 替换 / 导出 ---------- */

function countBlocks(sch) {
  const counts = new Array(sch.palette.length).fill(0);
  for (let i = 0; i < sch.blocks.length; i++) counts[sch.blocks[i]]++;
  return counts
    .map((n, i) => ({ name: sch.palette[i] || AIR, count: n }))
    .filter((x) => x.count > 0 && x.name !== AIR)
    .sort((a, b) => b.count - a.count);
}

function replaceBlock(sch, fromName, toName) {
  let changed = 0;
  for (let i = 0; i < sch.blocks.length; i++) {
    if (sch.palette[sch.blocks[i]] === fromName) {
      // 加入调色板（若不存在）
      let idx = sch.palette.indexOf(toName);
      if (idx < 0) { idx = sch.palette.length; sch.palette.push(toName); }
      sch.blocks[i] = idx;
      changed++;
    }
  }
  return changed;
}

/** 导出为 Sponge v2 .schem */
function exportSponge(sch, outPath) {
  const W = sch.size.x; const H = sch.size.y; const L = sch.size.z;
  const paletteComp = {};
  sch.palette.forEach((nm, i) => { paletteComp[nm || AIR] = { t: TAG.INT, v: i }; });
  const data = writeVarints(sch.blocks);
  const root = {
    t: TAG.COMPOUND,
    v: {
      Version: { t: TAG.INT, v: 2 },
      DataVersion: { t: TAG.INT, v: 3465 },
      Width: { t: TAG.SHORT, v: W },
      Height: { t: TAG.SHORT, v: H },
      Length: { t: TAG.SHORT, v: L },
      PaletteMax: { t: TAG.INT, v: sch.palette.length },
      Palette: { t: TAG.COMPOUND, v: paletteComp },
      BlockData: { t: TAG.BYTE_ARRAY, v: data },
    },
  };
  fs.writeFileSync(outPath, zlib.gzipSync(writeNbt(root)));
  return { path: outPath };
}

module.exports = {
  readSchematic,
  countBlocks,
  replaceBlock,
  exportSponge,
};