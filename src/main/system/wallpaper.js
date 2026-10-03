const fs = require('fs');
const path = require('path');

// 可用的背景媒体扩展名 → 类别
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp'];
const ANIM_EXT = ['.gif', '.apng'];
const VIDEO_EXT = ['.mp4', '.webm', '.mkv', '.mov', '.m4v'];
const LIVE_EXT = ['.heic', '.heif'];

/** 判断一个文件属于哪一类背景媒体 */
function classify(file) {
  const ext = path.extname(file).toLowerCase();
  if (ANIM_EXT.includes(ext)) return 'animated';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (LIVE_EXT.includes(ext)) return 'live';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return 'unknown';
}

/** 供设置页显示的基础信息 */
function describe(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* 读不到就算了 */ }
  return {
    name: path.basename(file),
    ext: path.extname(file).toLowerCase(),
    kind: classify(file),
    sizeMB: Math.round((size / 1048576) * 10) / 10,
    dir: path.dirname(file),
  };
}

/**
 * 在 JPEG 里找追加在末尾的 MP4（Google/安卓实况照片 Motion Photo）。
 * 优先用 XMP 里的 MicroVideoOffset，找不到就回退到扫描 ftyp box。
 */
function findMotionOffset(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 262144)).toString('latin1');
  const m = head.match(/MicroVideoOffset\s*=\s*"(\d+)"/);
  if (m) {
    const off = Number(m[1]);
    const start = buf.length - off;
    if (start > 0 && start + 8 < buf.length && buf.toString('latin1', start + 4, start + 8) === 'ftyp') {
      return start;
    }
  }
  const sig = Buffer.from('ftyp', 'latin1');
  for (let i = buf.length - 8; i >= 4; i--) {
    if (buf[i] === sig[0] && buf[i + 1] === sig[1] && buf[i + 2] === sig[2] && buf[i + 3] === sig[3]) {
      const size = buf.readUInt32BE(i - 4);
      // 末尾这一段的长度应当能容纳声明的 box
      if (size >= 8 && i - 4 + size <= buf.length + 8) return i - 4;
    }
  }
  return -1;
}

/**
 * 实况照片 → 可播放的视频文件。
 * - .jpg/.jpeg：抽出内嵌 MP4
 * - .heic/.heif：Chromium 解不了，改为找同目录同名的 .mov/.mp4 视频帧
 * - 其它视频扩展名：本身就是视频
 * 返回 { video: 绝对路径 | null, reason }
 */
function resolveLivePhoto(file, outDir) {
  const kind = classify(file);
  if (kind === 'video') return { video: file, reason: '直接作为视频播放' };

  const ext = path.extname(file).toLowerCase();

  if (ext === '.jpg' || ext === '.jpeg') {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { return { video: null, reason: `读取失败：${e.message}` }; }
    const start = findMotionOffset(buf);
    if (start < 0) return { video: null, reason: '这张照片里没有嵌入动态片段（不是实况照片）' };
    const out = path.join(outDir, 'wallpaper-live.mp4');
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(out, buf.subarray(start));
    } catch (e) {
      return { video: null, reason: `写出动态片段失败：${e.message}` };
    }
    return { video: out, reason: `抽出动态片段 ${Math.round((buf.length - start) / 1048576 * 10) / 10}MB` };
  }

  if (ext === '.heic' || ext === '.heif') {
    const base = path.join(path.dirname(file), path.basename(file, path.extname(file)));
    for (const cand of ['.mov', '.MOV', '.mp4', '.MP4']) {
      if (fs.existsSync(base + cand)) return { video: base + cand, reason: '配对找到实况照片的视频帧' };
    }
    return { video: null, reason: 'HEIC 无法直接解码，也没找到同名的 .mov 视频帧' };
  }

  return { video: null, reason: '这个格式不支持作为实况照片' };
}

module.exports = { classify, describe, resolveLivePhoto, findMotionOffset };