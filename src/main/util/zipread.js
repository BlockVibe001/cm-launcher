// 极简 ZIP 读取器（支持 stored / deflate，含 Zip64 基础场景），不依赖第三方库
// 用于拖拽识别：判断压缩包类型、解压世界存档、导入整合包 overrides
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

/** 解析中央目录 */
function parseCentralDirectory(buf, offset, size, count) {
  const entries = [];
  let p = offset;
  const end = Math.min(buf.length, offset + size);
  while (p + 46 <= end && entries.length < count) {
    if (buf.readUInt32LE(p) !== SIG_CD) break;
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // Zip64 扩展字段
    if (rawSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (rawSize === 0xffffffff && q + 8 <= extraEnd) { rawSize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff && q + 8 <= extraEnd) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff && q + 8 <= extraEnd) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + len;
      }
    }

    entries.push({ name, method, compSize, rawSize, localOffset, isDir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 打开一个 zip 文件
 * @param {string} zipPath
 * @returns {{ names: string[], entries: any[], read(name: string): Buffer, close(): void }}
 */
function openZip(zipPath) {
  const buf = fs.readFileSync(zipPath);

  // 尾部查找 EOCD
  let eocd = -1;
  const from = Math.max(0, buf.length - (22 + 65535));
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');

  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // Zip64
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locOff = eocd - 20;
    if (locOff >= 0 && buf.readUInt32LE(locOff) === SIG_EOCD64_LOC) {
      const z64 = Number(buf.readBigUInt64LE(locOff + 8));
      if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === SIG_EOCD64) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdSize = Number(buf.readBigUInt64LE(z64 + 40));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = parseCentralDirectory(buf, cdOffset, cdSize, count);
  const index = new Map(entries.map((e) => [e.name, e]));

  function read(name) {
    const e = index.get(name);
    if (!e) throw new Error(`压缩包内不存在：${name}`);
    if (e.localOffset + 30 > buf.length || buf.readUInt32LE(e.localOffset) !== SIG_LOCAL) {
      throw new Error('ZIP 局部文件头损坏');
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`不支持的压缩方式：${e.method}`);
  }

  return {
    names: entries.map((e) => e.name),
    entries,
    read,
    close() { /* 缓冲区由 GC 回收 */ },
  };
}

/** 去掉 zip 内的 .. 与绝对路径，避免解压越界 */
function safeEntryPath(name) {
  const norm = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = [];
  for (const seg of norm.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * 解压 zip 到目录（保留目录层级）
 * @param {string} zipPath
 * @param {string} destDir
 * @param {(done:number,total:number)=>void} [onProgress]
 */
function extractZip(zipPath, destDir, onProgress) {
  const zip = openZip(zipPath);
  fs.mkdirSync(destDir, { recursive: true });
  const total = zip.entries.length;
  let done = 0;
  for (const e of zip.entries) {
    const rel = safeEntryPath(e.name);
    if (rel) {
      const out = path.join(destDir, rel);
      if (e.isDir) {
        fs.mkdirSync(out, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, zip.read(e.name));
      }
    }
    done++;
    if (onProgress && (done % 20 === 0 || done === total)) onProgress(done, total);
  }
  return destDir;
}

module.exports = { openZip, extractZip };