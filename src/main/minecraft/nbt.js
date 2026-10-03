// 零依赖 NBT（Named Binary Tag）读写
// 节点表示：{ t: 标签类型, v: 值 }
//   COMPOUND: v = { 名称: 节点 }
//   LIST:     v = [节点...]，另有 e = 元素标签类型
//   BYTE_ARRAY: v = Buffer
//   INT_ARRAY:  v = Int32Array
//   LONG_ARRAY: v = Array<BigInt>
//   其余数值/字符串：v = 原始值（LONG 为 BigInt）

const TAG = {
  END: 0,
  BYTE: 1,
  SHORT: 2,
  INT: 3,
  LONG: 4,
  FLOAT: 5,
  DOUBLE: 6,
  BYTE_ARRAY: 7,
  STRING: 8,
  LIST: 9,
  COMPOUND: 10,
  INT_ARRAY: 11,
  LONG_ARRAY: 12,
};

const MAX_ELEMS = 1e7; // 防御损坏文件导致的超大长度

/* ---------------- 读取 ---------------- */

class Reader {
  constructor(buf) {
    this.b = buf;
    this.i = 0;
  }
  u8() { return this.b.readUInt8(this.i++); }
  i8() { const v = this.b.readInt8(this.i); this.i += 1; return v; }
  i16() { const v = this.b.readInt16BE(this.i); this.i += 2; return v; }
  u16() { const v = this.b.readUInt16BE(this.i); this.i += 2; return v; }
  i32() { const v = this.b.readInt32BE(this.i); this.i += 4; return v; }
  i64() { const v = this.b.readBigInt64BE(this.i); this.i += 8; return v; }
  f32() { const v = this.b.readFloatBE(this.i); this.i += 4; return v; }
  f64() { const v = this.b.readDoubleBE(this.i); this.i += 8; return v; }
  str() {
    const len = this.u16();
    const s = this.b.toString('utf8', this.i, this.i + len);
    this.i += len;
    return s;
  }
  bytes(n) {
    const b = Buffer.from(this.b.subarray(this.i, this.i + n));
    this.i += n;
    return b;
  }
}

function readPayload(r, tag) {
  switch (tag) {
    case TAG.BYTE: return { t: 1, v: r.i8() };
    case TAG.SHORT: return { t: 2, v: r.i16() };
    case TAG.INT: return { t: 3, v: r.i32() };
    case TAG.LONG: return { t: 4, v: r.i64() };
    case TAG.FLOAT: return { t: 5, v: r.f32() };
    case TAG.DOUBLE: return { t: 6, v: r.f64() };
    case TAG.BYTE_ARRAY: {
      const n = r.i32();
      if (n < 0 || n > MAX_ELEMS) throw new Error('ByteArray 长度异常');
      return { t: 7, v: r.bytes(n) };
    }
    case TAG.STRING: return { t: 8, v: r.str() };
    case TAG.LIST: {
      const e = r.u8();
      const n = r.i32();
      if (n < 0 || n > MAX_ELEMS) throw new Error('List 长度异常');
      const arr = [];
      for (let k = 0; k < n; k++) arr.push(readPayload(r, e));
      return { t: 9, e, v: arr };
    }
    case TAG.COMPOUND: {
      const obj = {};
      for (;;) {
        const t = r.u8();
        if (t === TAG.END) break;
        const name = r.str();
        obj[name] = readPayload(r, t);
      }
      return { t: 10, v: obj };
    }
    case TAG.INT_ARRAY: {
      const n = r.i32();
      if (n < 0 || n > MAX_ELEMS) throw new Error('IntArray 长度异常');
      const a = new Int32Array(n);
      for (let k = 0; k < n; k++) a[k] = r.i32();
      return { t: 11, v: a };
    }
    case TAG.LONG_ARRAY: {
      const n = r.i32();
      if (n < 0 || n > MAX_ELEMS) throw new Error('LongArray 长度异常');
      const a = new Array(n);
      for (let k = 0; k < n; k++) a[k] = r.i64();
      return { t: 12, v: a };
    }
    default:
      throw new Error(`未知 NBT 标签类型：${tag}`);
  }
}

/** 解析已解压的 NBT 缓冲区，返回根 Compound 节点 */
function parseNbt(buf) {
  const r = new Reader(buf);
  const tag = r.u8();
  if (tag !== TAG.COMPOUND) throw new Error('NBT 根标签不是 Compound');
  r.str(); // 根名称（通常为空）
  return readPayload(r, tag);
}

/* ---------------- 写入 ---------------- */

class Writer {
  constructor() {
    this.buf = Buffer.alloc(4096);
    this.i = 0;
  }
  _ensure(n) {
    if (this.i + n > this.buf.length) {
      const size = Math.max(this.buf.length * 2, this.i + n);
      const nb = Buffer.alloc(size);
      this.buf.copy(nb, 0, 0, this.i);
      this.buf = nb;
    }
  }
  u8(v) { this._ensure(1); this.buf.writeUInt8(v & 0xff, this.i); this.i += 1; }
  i8(v) { this._ensure(1); this.buf.writeInt8(v | 0, this.i); this.i += 1; }
  i16(v) { this._ensure(2); this.buf.writeInt16BE(v | 0, this.i); this.i += 2; }
  u16(v) { this._ensure(2); this.buf.writeUInt16BE(v & 0xffff, this.i); this.i += 2; }
  i32(v) { this._ensure(4); this.buf.writeInt32BE(v | 0, this.i); this.i += 4; }
  i64(v) { this._ensure(8); this.buf.writeBigInt64BE(BigInt(v), this.i); this.i += 8; }
  f32(v) { this._ensure(4); this.buf.writeFloatBE(Number(v), this.i); this.i += 4; }
  f64(v) { this._ensure(8); this.buf.writeDoubleBE(Number(v), this.i); this.i += 8; }
  str(s) {
    const b = Buffer.from(String(s), 'utf8');
    this.u16(b.length);
    this.raw(b);
  }
  raw(b) { this._ensure(b.length); b.copy(this.buf, this.i); this.i += b.length; }
  out() { return this.buf.subarray(0, this.i); }
}

function writePayload(w, node) {
  switch (node.t) {
    case TAG.BYTE: w.i8(node.v); break;
    case TAG.SHORT: w.i16(node.v); break;
    case TAG.INT: w.i32(node.v); break;
    case TAG.LONG: w.i64(node.v); break;
    case TAG.FLOAT: w.f32(node.v); break;
    case TAG.DOUBLE: w.f64(node.v); break;
    case TAG.BYTE_ARRAY: w.i32(node.v.length); w.raw(node.v); break;
    case TAG.STRING: w.str(node.v); break;
    case TAG.LIST:
      w.u8(node.e);
      w.i32(node.v.length);
      for (const item of node.v) writePayload(w, item);
      break;
    case TAG.COMPOUND:
      for (const [name, child] of Object.entries(node.v)) {
        w.u8(child.t);
        w.str(name);
        writePayload(w, child);
      }
      w.u8(TAG.END);
      break;
    case TAG.INT_ARRAY:
      w.i32(node.v.length);
      for (let k = 0; k < node.v.length; k++) w.i32(node.v[k]);
      break;
    case TAG.LONG_ARRAY:
      w.i32(node.v.length);
      for (let k = 0; k < node.v.length; k++) w.i64(node.v[k]);
      break;
    default:
      throw new Error(`无法写入的 NBT 标签类型：${node.t}`);
  }
}

/** 序列化根 Compound 节点为 NBT 缓冲区 */
function writeNbt(root, name = '') {
  const w = new Writer();
  w.u8(root.t);
  w.str(name);
  writePayload(w, root);
  return w.out();
}

module.exports = { TAG, parseNbt, writeNbt };