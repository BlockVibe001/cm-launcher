// 陶瓦联机（Terracotta）内置客户端
// 只做三件事：把官方二进制拉起来、问出它的本机端口、用它的官方 HTTP 接口开 / 进 / 退房。
// 按 AGPL 例外条款②，界面里必须署名 Terracotta 与作者，见联机页。
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app } = require('electron');
const logger = require('../logger');
const lan = require('./lan');

const TOOL_ID = 'taohua';

/** 房间号字符集：34 进制，官方故意去掉了容易看错的 I 和 O */
const CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_MOD = 34n ** 16n;

/** /state 里的 exception.type 编号对应的说法 */
const EXCEPTIONS = {
  0: '找不到房主，可能房间号不对或房主已经退出',
  1: '连接被房主中断了',
  2: '本机虚拟网卡启动失败，请检查防火墙 / 杀毒软件',
  3: '房主的虚拟网卡挂了，请让房主重新建房',
  4: '房间里没检测到 Minecraft 的局域网端口，请让房主确认已经「对局域网开放」',
  5: '两边版本不一致或协议被改动，请把启动器都升到最新版',
};

const state = {
  port: 0,          // 陶瓦的 HTTP 端口，0 表示还没起来
  starting: null,   // 正在拉起中的 Promise
  epoch: 0,         // 每次取消 / 新请求都加一，用来中断还在轮询的旧请求
};

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/* ---------- 房间号 ---------- */

/** 官方 from_value：低位在前，每 4 位插一个连字符 */
function formatCode(value) {
  let v = value;
  let code = 'U/';
  for (let i = 0; i < 16; i += 1) {
    if (i === 4 || i === 8 || i === 12) code += '-';
    code += CHARS[Number(v % 34n)];
    v /= 34n;
  }
  return code;
}

/**
 * 把玩家填的「房间名」确定性地折算成官方房间号。
 * 两边填同一个房间名就落到同一个房间；房间号本身也能直接发给别人用。
 */
function roomCodeFromName(name) {
  const digest = crypto.createHash('sha256')
    .update(`blockvibe:${String(name).trim().toUpperCase()}`, 'utf8').digest();
  const seed = BigInt(`0x${digest.subarray(0, 16).toString('hex')}`) % CODE_MOD;
  return formatCode(seed - (seed % 7n));
}

/** 玩家输入可能是房间名，也可能是 U/xxxx-… 房间号，统一成官方房间号 */
function normalizeRoom(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/u\//i.test(s)) {
    const m = /U\/[0-9A-Z-]{16,19}/i.exec(s.toUpperCase());
    return m ? m[0] : '';
  }
  return roomCodeFromName(s);
}

/* ---------- 进程与端口 ---------- */

function exePath() {
  return lan.resolveExe(TOOL_ID);
}

function available() {
  return !!exePath();
}

function portFile() {
  return path.join(app.getPath('userData'), 'terracotta-port.json');
}

/**
 * 官方 --hmcl 模式：父进程派生出无窗口的子进程，子进程把 {"port":N} 原子写进指定文件后父进程退出。
 * 我们照着这个约定拿到端口，之后全部走 HTTP 接口。
 */
function waitPortFile(file, timeout = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (j && Number(j.port) > 0) { resolve(Number(j.port)); return; }
      } catch { /* 还没写完，继续等 */ }
      if (Date.now() - start > timeout) { resolve(0); return; }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function apiGet(port, route, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('陶瓦联机响应超时')));
    req.on('error', reject);
  });
}

/** 端口上还活着一个可用的陶瓦吗（可能已经被玩家自己关掉了） */
async function alive(port) {
  try {
    const r = await apiGet(port, '/state', 1500);
    return r.status === 200 && /"state"/.test(r.text);
  } catch { return false; }
}

/**
 * 确保陶瓦在跑，返回它的 HTTP 端口。
 * 已经在跑就直接复用，省掉一次冷启动。
 */
async function ensureStarted() {
  if (state.port && await alive(state.port)) return state.port;
  if (state.starting) return state.starting;

  state.starting = (async () => {
    const exe = exePath();
    if (!exe) throw new Error('没有找到陶瓦联机的可执行文件');

    const file = portFile();
    try { fs.unlinkSync(file); } catch { /* 本来就没有 */ }
    const child = spawn(exe, ['--hmcl', file], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();   // 父进程写完端口就退了，陶瓦本体由它自己派生，不随启动器一起结束

    const port = await waitPortFile(file);
    if (!port) throw new Error('陶瓦联机没有在预期时间内启动');
    state.port = port;
    logger.info(`陶瓦联机已就绪，本机端口 ${port}`);
    return port;
  })().catch((e) => {
    state.port = 0;
    throw e;
  }).finally(() => { state.starting = null; });

  return state.starting;
}

/* ---------- 房间状态 ---------- */

async function getState() {
  if (!state.port) return { state: 'offline' };
  try {
    const r = await apiGet(state.port, '/state', 3000);
    return JSON.parse(r.text);
  } catch {
    return { state: 'offline' };
  }
}

/** 轮询 /state，直到进入想要的状态；期间把每次变化推给界面 */
async function waitFor(port, want, timeout, onState) {
  const mine = state.epoch;
  const start = Date.now();
  let last = null;
  let fallback = '联机超时了，请再试一次';

  while (Date.now() - start < timeout) {
    if (state.epoch !== mine) throw new Error('已取消');
    const s = await getState();
    if (s && s.state !== 'offline') {
      if (!last || last.index !== s.index || last.state !== s.state) {
        last = s;
        if (onState) onState(s);
      }
      if (want.includes(s.state)) return s;
      if (s.state === 'exception') throw new Error(EXCEPTIONS[s.type] || '联机失败');
    }
    await sleep(600);
  }
  throw new Error(fallback);
}

function buildQuery(room, player) {
  const parts = [`room=${encodeURIComponent(room)}`];
  if (player) parts.push(`player=${encodeURIComponent(player)}`);
  return `?${parts.join('&')}`;
}

/**
 * 建房：一直扫到本机出现 Minecraft 的局域网端口为止，所以要先在游戏里「对局域网开放」。
 * @returns {Promise<{code:string, profiles:Array}>}
 */
async function host({ name, player, onState } = {}) {
  const code = normalizeRoom(name);
  if (!code) throw new Error('请先填一个房间名');
  const port = await ensureStarted();
  const mine = ++state.epoch;

  await apiGet(port, '/state/ide').catch(() => {});   // 先把上一次的房间退干净
  const r = await apiGet(port, `/state/scanning${buildQuery(code, player)}`);
  if (r.status !== 200) throw new Error('陶瓦联机拒绝了建房请求');
  logger.info(`陶瓦联机开始建房：${code}`);

  const s = await waitFor(port, ['host-ok'], 5 * 60 * 1000, onState);
  if (state.epoch !== mine) throw new Error('已取消');
  return { code: s.room || code, profiles: s.profiles || [] };
}

/**
 * 进房：交给陶瓦做 NAT 打洞，成功后拿到本机可直连的服务器地址。
 * @returns {Promise<{url:string, code:string, profiles:Array}>}
 */
async function join({ room, player, onState } = {}) {
  const code = normalizeRoom(room);
  if (!code) throw new Error('请填写房间号或房间名');
  const port = await ensureStarted();
  const mine = ++state.epoch;

  await apiGet(port, '/state/ide').catch(() => {});
  const r = await apiGet(port, `/state/guesting${buildQuery(code, player)}`);
  if (r.status !== 200) throw new Error('房间号格式不对，请检查后重填');
  logger.info(`陶瓦联机开始进房：${code}`);

  const s = await waitFor(port, ['guest-ok'], 6 * 60 * 1000, onState);
  if (state.epoch !== mine) throw new Error('已取消');
  return { url: s.url || '', code: s.room || code, profiles: s.profiles || [] };
}

/** 退房：回到等待状态，陶瓦进程留着，下次点一下就能用 */
async function leave() {
  state.epoch += 1;
  if (!state.port) return false;
  try {
    const r = await apiGet(state.port, '/state/ide', 3000);
    return r.status === 200;
  } catch { return false; }
}

module.exports = {
  available,
  exePath,
  ensureStarted,
  getState,
  host,
  join,
  leave,
  normalizeRoom,
  roomCodeFromName,
  formatCode,
  isRunning: () => !!state.port,
};