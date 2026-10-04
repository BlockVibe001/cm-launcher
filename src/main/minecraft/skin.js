// 皮肤系统：正版 ID 扒皮肤、皮肤上传（微软官方 / 皮肤站 / 本地库）、皮肤库浏览
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const config = require('../config');
const logger = require('../logger');

const UA = 'BlockVibeLauncher/1.0.0 (minecraft launcher)';

/* ---------- 工具 ---------- */

function skinDir() {
  const dir = path.join(app.getPath('userData'), 'skins');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function fetchWithTimeout(url, opts = {}, timeout = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 读取 PNG 尺寸（用于校验皮肤文件） */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function validatePng(buf) {
  const size = pngSize(buf);
  if (!size) throw new Error('不是有效的 PNG 图片');
  // 允许 64x32/64x64 原版皮肤与 64 倍数的 HD 皮肤
  if (size.w % 64 !== 0 || (size.h !== size.w / 2 && size.h !== size.w)) {
    throw new Error(`皮肤尺寸异常（${size.w}×${size.h}），应为 64×32 / 64×64 或其整数倍`);
  }
  return size;
}

function toDataUrl(buf) {
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function safeName(s) {
  return String(s || 'skin').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'skin';
}

/* ---------- ① 玩家 ID → UUID ---------- */

async function resolveUuid(name) {
  const q = String(name || '').trim();
  if (!q) throw new Error('请输入玩家 ID');
  const clean = q.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(clean)) return { uuid: clean.toLowerCase(), name: '' };

  try {
    const res = await fetchWithTimeout(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(q)}`);
    if (res.ok) {
      const d = await res.json();
      if (d && d.id) return { uuid: d.id, name: d.name || q };
    }
  } catch { /* 尝试备用源 */ }

  try {
    const res = await fetchWithTimeout(`https://playerdb.co/api/player/minecraft/${encodeURIComponent(q)}`);
    if (res.ok) {
      const d = await res.json();
      const p = d && d.data && d.data.player;
      if (p && p.id) return { uuid: String(p.id).replace(/-/g, ''), name: p.username || q };
    }
  } catch { /* 全部失败 */ }

  throw new Error(`找不到玩家「${q}」（可能拼写有误或网络不可达）`);
}

/* ---------- ② 抓取正版皮肤 ---------- */

function decodeTextures(propValue) {
  try {
    const json = JSON.parse(Buffer.from(propValue, 'base64').toString('utf8'));
    const t = json.textures || {};
    return {
      skin: t.SKIN ? t.SKIN.url : '',
      cape: t.CAPE ? t.CAPE.url : '',
      model: t.SKIN && t.SKIN.metadata && t.SKIN.metadata.model === 'slim' ? 'slim' : 'classic',
    };
  } catch {
    return { skin: '', cape: '', model: 'classic' };
  }
}

/** 按玩家 ID 或 UUID 查询正版皮肤 */
async function fetchOfficialSkin(nameOrUuid, timeout = 15000) {
  let uuid = String(nameOrUuid || '').trim();
  let name = '';
  if (!/^[0-9a-fA-F]{32}$/.test(uuid.replace(/-/g, ''))) {
    const r = await resolveUuid(uuid);
    uuid = r.uuid;
    name = r.name;
  }
  const id = uuid.replace(/-/g, '').toLowerCase();

  let skinUrl = '';
  let capeUrl = '';
  let model = 'classic';
  try {
    const res = await fetchWithTimeout(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`, {}, timeout);
    if (res.ok) {
      const d = await res.json();
      name = d.name || name;
      const tex = (d.properties || []).find((p) => p.name === 'textures');
      if (tex) {
        const t = decodeTextures(tex.value);
        skinUrl = t.skin; capeUrl = t.cape; model = t.model;
      }
    }
  } catch { /* 退回第三方渲染源 */ }

  if (!skinUrl) skinUrl = `https://crafatar.com/skins/${id}`;
  return { uuid: id, name, skinUrl, capeUrl, model };
}

/* ---------- ③ 下载 / 本地皮肤库 ---------- */

async function downloadSkin(url, label) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 30000);
  if (!res.ok) throw new Error(`下载皮肤失败（HTTP ${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  const size = validatePng(buf);
  const file = path.join(skinDir(), `${safeName(label)}-${Date.now()}.png`);
  fs.writeFileSync(file, buf);
  logger.info(`皮肤已保存：${file}`);
  return { path: file, name: path.basename(file), size: buf.length, dim: size, dataUrl: toDataUrl(buf) };
}

/** 读取本地皮肤文件（校验 PNG 尺寸并返回预览用 dataURL） */
function readLocal(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('文件不存在');
  const buf = fs.readFileSync(filePath);
  const dim = validatePng(buf);
  const name = path.basename(filePath);
  return { path: filePath, name, size: buf.length, dim, dataUrl: toDataUrl(buf) };
}

function listLocal() {
  const dir = skinDir();
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.png$/i.test(f)) continue;
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    let dataUrl = '';
    if (st.size <= 512 * 1024) {
      try { dataUrl = toDataUrl(fs.readFileSync(full)); } catch { /* ignore */ }
    }
    out.push({ name: f, path: full, size: st.size, mtime: st.mtimeMs, dataUrl });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function deleteLocal(name) {
  const full = path.resolve(path.join(skinDir(), name));
  if (!full.startsWith(path.resolve(skinDir()))) throw new Error('非法路径');
  if (!fs.existsSync(full)) throw new Error('文件不存在');
  fs.unlinkSync(full);
  return true;
}

/* ---------- ④ 上传皮肤 ---------- */

/** 微软正版：POST /minecraft/profile/skins（multipart） */
async function uploadOfficial(filePath, variant) {
  const account = config.get('account');
  if (!account || account.type !== 'microsoft') {
    throw new Error('只有已登录的微软正版账号才能上传到官方服务器');
  }
  const buf = fs.readFileSync(filePath);
  validatePng(buf);

  const form = new FormData();
  form.append('variant', variant === 'slim' ? 'slim' : 'classic');
  form.append('file', new Blob([buf], { type: 'image/png' }), 'skin.png');

  const res = await fetchWithTimeout('https://api.minecraftservices.com/minecraft/profile/skins', {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.accessToken}` },
    body: form,
  }, 40000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.errorMessage || data.message || `上传失败（HTTP ${res.status}）`);
  }
  return { ok: true, variant: variant === 'slim' ? 'slim' : 'classic', profile: data };
}

/** 皮肤站（Blessing Skin）：PUT /api/v1/user/profile/{uuid}/skin */
async function uploadYggdrasil(filePath, variant) {
  const account = config.get('account');
  if (!account || account.type !== 'yggdrasil') {
    throw new Error('请先用皮肤站账号登录');
  }
  const base = String(account.stationUrl || '')
    .replace(/\/api\/yggdrasil\/?$/i, '')
    .replace(/\/+$/, '');
  if (!base) throw new Error('皮肤站地址缺失，请在设置中检查');

  const buf = fs.readFileSync(filePath);
  validatePng(buf);

  const form = new FormData();
  form.append('model', variant === 'slim' ? 'alex' : 'steve');
  form.append('file', new Blob([buf], { type: 'image/png' }), 'skin.png');

  const res = await fetchWithTimeout(`${base}/api/v1/user/profile/${account.uuid}/skin`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${account.accessToken}`, Accept: 'application/json' },
    body: form,
  }, 40000);
  if (!res.ok) {
    let msg = `上传失败（HTTP ${res.status}）`;
    try {
      const d = await res.json();
      msg = d.message || d.error || msg;
    } catch { /* 无 JSON */ }
    throw new Error(msg);
  }
  return { ok: true, variant: variant === 'slim' ? 'slim' : 'classic', station: base };
}

/* ---------- ⑤ 皮肤库浏览 ---------- */

/**
 * 抓取皮肤站公开皮肤库列表（Blessing Skin 的 /skinlib 页面 → /raw/{hash} 纹理）
 * base 可传皮肤站根地址或 yggdrasil 地址
 */
async function browseLibrary(stationBase, query, page) {
  const root = String(stationBase || 'https://littleskin.cn')
    .replace(/\/api\/yggdrasil\/?$/i, '')
    .replace(/\/+$/, '');
  const p = Math.max(1, Number(page) || 1);
  const url = `${root}/skinlib?filter=${encodeURIComponent(query || '')}&sort=time&page=${p}`;

  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } }, 20000);
  if (!res.ok) throw new Error(`皮肤库打开失败（HTTP ${res.status}）`);
  const html = await res.text();

  const hashes = [...new Set((html.match(/\/raw\/[0-9a-f]{64}/gi) || []).map((s) => s.slice(-64)))];
  return {
    root,
    url,
    page: p,
    items: hashes.map((h) => ({ hash: h, url: `${root}/raw/${h}` })),
  };
}

/* ---------- ⑥ 读取「我的皮肤」 ---------- */

/** 把纹理地址抓成 dataURL（不落盘，专供界面本地渲染头像/全身用） */
async function fetchTexture(url, timeout = 8000) {
  if (!url) throw new Error('缺少纹理地址');
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, timeout);
  if (!res.ok) throw new Error(`纹理下载失败（HTTP ${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!pngSize(buf)) throw new Error('纹理不是 PNG');
  return toDataUrl(buf);
}

/**
 * 读取当前登录账号在服务器上的实时皮肤纹理，不落盘。
 * 正版走 Mojang profile textures，皮肤站走 Blessing Skin 的 Yggdrasil profile。
 * 拿不到就返回 null，界面自行退回备用源。
 */
async function currentSkin() {
  const account = config.get('account');
  if (!account || !account.uuid) return null;
  const fallbackName = account.username || '';

  // 离线账号：游戏不连皮肤服务器，显示它自己绑定过的本地皮肤。
  // 正版/皮肤站账号不走这里 —— 它们的皮肤永远以服务器实时数据为准，
  // 这样从离线切回正版时，皮肤会自动换回正版那一套。
  if (account.type === 'offline' && account.skinPath && fs.existsSync(account.skinPath)) {
    try {
      const buf = fs.readFileSync(account.skinPath);
      validatePng(buf);
      return {
        dataUrl: toDataUrl(buf),
        model: account.skinModel || 'classic',
        name: fallbackName,
        source: 'local',
      };
    } catch (e) {
      logger.warn(`离线账号绑定皮肤读取失败：${e.message}`);
    }
  }
  try {
    if (account.type === 'microsoft') {
      const info = await fetchOfficialSkin(account.uuid, 6000);
      if (info.skinUrl) {
        return {
          dataUrl: await fetchTexture(info.skinUrl),
          model: info.model,
          name: info.name || fallbackName,
          source: 'mojang',
        };
      }
    } else if (account.type === 'yggdrasil') {
      const root = String(account.stationUrl || '').replace(/\/+$/, '');
      const id = String(account.uuid).replace(/-/g, '').toLowerCase();
      if (root) {
        const res = await fetchWithTimeout(
          `${root}/sessionserver/session/minecraft/profile/${id}`,
          { headers: { 'User-Agent': UA } },
          6000,
        );
        if (res.ok) {
          const d = await res.json();
          const tex = (d.properties || []).find((p) => p.name === 'textures');
          if (tex) {
            const t = decodeTextures(tex.value);
            if (t.skin) {
              return {
                dataUrl: await fetchTexture(t.skin),
                model: t.model,
                name: d.name || fallbackName,
                source: 'yggdrasil',
              };
            }
          }
        }
      }
    }
  } catch (e) {
    logger.warn(`读取当前皮肤失败：${e.message}`);
  }
  return null;
}

/* ---------- ⑦ 最近使用 ---------- */

/**
 * 使用一张皮肤：校验后写入「最近使用」（去重置顶、保留 12 条），
 * 并绑定到当前账号。离线账号的皮肤中心预览 / 顶栏头像随后就显示它；
 * 正版账号虽然也记了绑定，但 currentSkin 只认服务器皮肤，切回来自动恢复正版外观。
 */
function useSkin(filePath) {
  const full = path.resolve(String(filePath || ''));
  if (!fs.existsSync(full)) throw new Error('皮肤文件不存在');
  const buf = fs.readFileSync(full);
  validatePng(buf);
  const name = path.basename(full);

  let hist = (config.get('skinHistory') || []).filter((h) => h && h.path !== full);
  hist.unshift({ path: full, name, t: Date.now() });
  config.set('skinHistory', hist.slice(0, 12));

  const account = config.get('account');
  if (account) config.setAccount({ ...account, skinPath: full });

  logger.info(`使用皮肤：${full}`);
  return { path: full, name, dataUrl: toDataUrl(buf) };
}

/** 读取最近使用列表：顺手剔除已经被删掉的文件，预览图直接读本地 PNG */
function history() {
  const hist = config.get('skinHistory') || [];
  const out = [];
  for (const h of hist) {
    if (!h || !h.path || !fs.existsSync(h.path)) continue;
    let dataUrl = '';
    try {
      const st = fs.statSync(h.path);
      if (st.size <= 512 * 1024) dataUrl = toDataUrl(fs.readFileSync(h.path));
    } catch { continue; }
    out.push({ path: h.path, name: h.name || path.basename(h.path), t: h.t, dataUrl });
  }
  return out;
}

module.exports = {
  resolveUuid,
  fetchOfficialSkin,
  fetchTexture,
  currentSkin,
  downloadSkin,
  readLocal,
  listLocal,
  deleteLocal,
  uploadOfficial,
  uploadYggdrasil,
  browseLibrary,
  useSkin,
  history,
};