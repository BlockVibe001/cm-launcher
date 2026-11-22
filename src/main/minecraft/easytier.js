// EasyTier 联机（内置客户端）
// 只做四件事：把官方二进制拉起来（房主需要建虚拟网卡，所以要管理员）、
// 用房间名派生网络名与密钥、轮询节点状态、以及退出房间时收摊。
// 按 LGPL-3.0 要求，界面里署名 EasyTier，见联机页；许可证原文在 resources/tools/easytier/LICENSE.txt。
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { app } = require('electron');
const config = require('../config');
const logger = require('../logger');
const lan = require('./lan');
const pcl = require('./pcl');
const npcap = require('./npcap');

const TOOL_ID = 'easytier';

/** 虚拟网段固定下来，两边地址才是确定的，玩家可以直接照着填 */
const HOST_IP = '10.126.126.1';
const GUEST_IP = '10.126.126.2';
const MC_PORT = 25565;
/** RPC 只监听本机，别把管理口暴露到网络上 */
const RPC = '127.0.0.1:15888';
const CLI_TIMEOUT = 8000;

/**
 * 内置的公共共享节点（社区公益提供，随时可能失效）。
 * 只要是对等节点能互相发现的地址都行：官方共享节点、自己搭的服务器、
 * 甚至同一个局域网里房主的「本机地址」都可以填在这里。
 */
const SHARED_NODES = [
  // 2026-11 社区公共节点监控里仍可连通的几个（官方 public.easytier.cn 在部分网络已 DNS 失效）
  'tcp://easytier.weiai.org.cn:11010',
  'tcp://183.230.36.171:11010',
  'tcp://et.sumnight.top:11010',
  'tcp://225284.xyz:11010',
];

const CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const state = {
  phase: 'offline',   // offline | starting | online
  role: '',           // host | guest
  code: '',
  address: '',
  peers: [],
  error: '',
  mode: 'nebula',   // nebula | pcl
  pclCode: '',
  child: null,        // join 时自己拉起来的进程
  elevated: false,    // host 时是提权进程，只能靠停止标记让它自己退
  stopFlag: '',
  watcher: null,      // 轮询 cli 的定时器
  probes: [],         // 最近一次节点连通性探测结果，界面拿来显示
};

/** 探测结果缓存：刚在联机页探测过，建房时就不用再等一轮 */
let probeCache = { at: 0, key: '', probes: [] };

/* ---------- 工具位置 ---------- */

function exePath() {
  return lan.resolveExe(TOOL_ID);
}

function cliPath() {
  const core = exePath();
  if (!core) return '';
  const cli = path.join(path.dirname(core), 'easytier-cli.exe');
  try {
    fs.accessSync(cli);
    return cli;
  } catch { return ''; }
}

function available() {
  return !!exePath();
}

/* ---------- 房间名 → 网络名 / 密钥 ---------- */

function digest(text) {
  return crypto.createHash('sha256').update(`blockvibe:easytier:${text}`, 'utf8').digest('hex');
}

/** 把一段摘要折成 12 位房间号（只含数字和大写字母，去掉了 I/O 这种容易认错的） */
function foldCode(hex) {
  let out = '';
  for (let i = 0; i < 3; i += 1) {
    const n = parseInt(hex.slice(i * 8, i * 8 + 8), 16);
    for (let j = 0; j < 4; j += 1) out += CHARS[(n >>> (j * 5)) % 32];
  }
  return out;
}

/** 12 位房间号 → 带横杠的展示形式 */
function dashed(code) {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

/** 输入本身就是别人给的房间号（12 位、字符集内）时，原样认出来 */
function asCode(text) {
  const s = String(text || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return s.length === 12 && [...s].every((c) => CHARS.includes(c)) ? s : '';
}

/**
 * 房间名或房间号 → 统一的 12 位房间号。
 * 名字按摘要折出来（所以中文也认），号直接认；两边只要填同一个名字或同一个号就落到同一个网络。
 */
function codeOf(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const hit = asCode(raw);
  if (hit) return hit;
  if (raw.length < 2) return '';
  return foldCode(digest(`name:${raw.replace(/\s+/g, ' ').toLowerCase()}`));
}

/**
 * 玩家填的可能是自拟的房间名，也可能是别人给的房间号，统一成一对网络名 / 密钥。
 * 网络名与密钥都由「房间号」派生，所以房主把房间号发给朋友，朋友填号就能进。
 */
function networkOf(input) {
  const code = codeOf(input);
  if (!code) return null;
  const name = `cm${digest(`net:${code}`).slice(0, 16)}`;
  const secret = digest(`key:${code}`).slice(0, 32);
  return { name, secret, code: dashed(code) };
}

/* ---------- 公共节点列表 ---------- */

/** 配置里存的公共节点，留空表示用内置候选；旧版默认节点已失效，自动丢弃 */
function savedNodes() {
  const v = config.get('easytierNodes');
  if (!Array.isArray(v)) return [];
  return v.filter(Boolean).filter((u) => !/public\.easytier\.cn|39\.108\.52\.138/i.test(String(u)));
}

/** 解析玩家填的一串地址：换行、逗号、空格、分号都能当分隔符 */
function parseNodes(text) {
  return String(text || '')
    .split(/[\s,;，、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^[a-z]+:\/\//i.test(s) ? s : `tcp://${s}`));
}

/**
 * 该用的节点清单：玩家这次填的优先；没填就用配置里存的；再补内置候选兜底。
 * 玩家自己填了就不再塞内置的，免得混进一堆用不上的地址拖慢握手。
 */
function nodeList(text) {
  const mine = parseNodes(text);
  const saved = savedNodes();
  const all = mine.length ? mine : (saved.length ? saved : SHARED_NODES);
  const uniq = [];
  for (const u of all) if (!uniq.includes(u)) uniq.push(u);
  return uniq;
}

/* ---------- 节点连通性探测 ---------- */
/*
 * 内置那些公共节点是社区公益提供的，说没就没；玩家填错一个字母也一样。
 * 与其让他干等到超时，不如开打之前先握一次手：连得上的排前面，全不通就直接讲清楚。
 */

/** 节点地址拆成 scheme / host / port */
function parseNode(url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^:/]+|\[[^\]]+\])(?::(\d+))?/i.exec(String(url || '').trim());
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3]) || 11010 };
}

/** 探测失败时给玩家看的说法，别把 ENOTFOUND 这种错误码直接甩过去 */
const PROBE_NOTES = {
  ENOTFOUND: '域名解析失败',
  ECONNREFUSED: '端口没开',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
};

/** 探一个节点：TCP 握一次手，顺便量出延迟 */
function probeNode(url, timeout = 2000) {
  const p = parseNode(url);
  if (!p) return Promise.resolve({ url, ok: false, ms: 0, note: '地址格式不对' });
  if (p.scheme === 'udp') {
    return Promise.resolve({ url, host: p.host, port: p.port, ok: false, unknown: true, ms: 0, note: 'UDP 没法预先探测' });
  }
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = net.connect({ host: p.host, port: p.port });
    let done = false;
    const finish = (ok, note) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* 已经断了 */ }
      resolve({ url, host: p.host, port: p.port, ok, ms: ok ? Date.now() - start : 0, note: note || '' });
    };
    sock.setTimeout(timeout, () => finish(false, '连接超时'));
    sock.on('connect', () => finish(true));
    sock.on('error', (e) => finish(false, PROBE_NOTES[e.code] || '连不上'));
  });
}

/** 并发探一批，能连上的排前面，同样是通的按延迟从低到高 */
async function probeNodes(list) {
  const urls = [...new Set((list || []).filter(Boolean))];
  const results = await Promise.all(urls.map((u) => probeNode(u)));
  return results.sort((a, b) => (Number(b.ok) - Number(a.ok)) || (a.ms - b.ms));
}

/** 探测一轮并排序；一分钟内探过同一批就直接复用，别让建房白等一次握手 */
async function rankNodes(text) {
  const list = nodeList(text);
  const key = list.join(' ');
  if (probeCache.key === key && Date.now() - probeCache.at < 60000) {
    state.probes = probeCache.probes;
    return probeCache.probes;
  }
  const probes = await probeNodes(list);
  probeCache = { at: Date.now(), key, probes };
  state.probes = probes;
  return probes;
}

/** 真正传给 easytier-core 的 -p 参数 */
function peerArgsOf(list) {
  return (list || []).flatMap((u) => ['-p', u]);
}

/** 探测结果里优先用连得上的；UDP 无法预探测但也保留。全都不通时仍然全部交给核心自己试。 */
function rankedPeerUrls(ranked) {
  const usable = (ranked || []).filter((p) => p.ok || p.unknown).map((p) => p.url);
  return usable.length ? usable : (ranked || []).map((p) => p.url);
}

function peerArgs(text) {
  return peerArgsOf(nodeList(text));
}

/**
 * 给界面用：探一遍当前要用的节点，并告诉我们是不是全都连不上。
 * allDown 为真就意味着跨网络联机基本没戏，得让玩家自己填一个中转地址。
 */
async function probe(text) {
  const probes = await rankNodes(text || '');
  return {
    probes,
    allDown: probes.length > 0 && probes.every((p) => !p.ok && !p.unknown),
    manual: parseNodes(text).length > 0,
  };
}

/* ---------- 进程 ---------- */

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * 以管理员身份拉起 easytier-core（房主要建虚拟网卡）。
 * 提权进程没法从外面直接杀，所以让一个提权 PowerShell 守着，看到停止标记就把子进程收掉。
 */
function spawnElevated(args) {
  const core = exePath();
  const flag = path.join(app.getPath('userData'), 'easytier-stop.flag');
  const ps1 = path.join(app.getPath('userData'), 'easytier-host.ps1');
  try { fs.unlinkSync(flag); } catch { /* 本来就没有 */ }

  const list = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const npcapPath = npcap.pathPrefix();
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    ...(npcapPath ? [`$env:PATH = '${npcapPath.replace(/'/g, "''")};' + $env:PATH`] : []),
    `$p = Start-Process -FilePath '${core.replace(/'/g, "''")}' -WorkingDirectory '${path.dirname(core).replace(/'/g, "''")}'`
      + ` -ArgumentList @(${list}) -PassThru -WindowStyle Hidden`,
    `$flag = '${flag.replace(/'/g, "''")}'`,
    'while ($p -and -not $p.HasExited) {',
    '  if (Test-Path $flag) { $p.Kill(); break }',
    '  Start-Sleep -Milliseconds 400',
    '}',
    'Remove-Item $flag -Force',
  ].join('\n');
  // Windows PowerShell 5.1 按 ANSI 解析无 BOM 的脚本，路径含中文时要用带 BOM 的 UTF-8
  fs.writeFileSync(ps1, '\ufeff' + script, 'utf8');

  const runner = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(runner, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-Command',
    `Start-Process -FilePath '${runner}' -Verb RunAs -WindowStyle Hidden`
      + ` -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"${ps1.replace(/"/g, '""')}"')`,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  state.elevated = true;
  state.stopFlag = flag;
  return child;
}

/** 普通身份拉起（加入方走 --no-tun，不需要管理员） */
function spawnPlain(args) {
  const core = exePath();
  const child = spawn(core, args, {
    cwd: path.dirname(core),
    env: npcap.childEnv(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  child.on('exit', (code) => {
    if (state.phase !== 'offline') logger.info(`EasyTier 进程退出（${code}）`);
    if (state.child === child) { state.child = null; state.phase = 'offline'; }
  });
  state.child = child;
  return child;
}

/* ---------- 状态查询 ---------- */

function cli(args, timeout = CLI_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const exe = cliPath();
    if (!exe) { reject(new Error('缺少 easytier-cli')); return; }
    execFile(exe, ['--rpc-portal', RPC, ...args], { timeout, windowsHide: true, env: npcap.childEnv() },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout || ''));
      });
  });
}

/** 读节点是否起来了（能拿到虚拟 IP 就算起来了） */
async function nodeInfo() {
  try {
    const out = await cli(['-o', 'json', 'node'], 4000);
    const j = JSON.parse(out);
    return j && j.ipv4_addr ? j : null;
  } catch { return null; }
}

/** 读对端表，用来判断对面到底有没有进来 */
async function peerList() {
  try {
    const out = await cli(['-o', 'json', 'peer'], 4000);
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function snapshot() {
  return {
    phase: state.phase,
    role: state.role,
    mode: state.mode,
    code: state.code,
    pclCode: state.pclCode,
    address: state.address,
    peers: state.peers,
    error: state.error,
    elevated: state.elevated,
    probes: state.probes,
  };
}

function emit(onState) {
  if (onState) onState(snapshot());
}

/** 轮询对端表：有别人进来就更新状态，顺带把「对面是谁」告诉界面 */
function startWatch(onState) {
  stopWatch();
  const want = state.role === 'host' ? GUEST_IP : HOST_IP;
  state.watcher = setInterval(async () => {
    if (state.phase === 'offline') return;
    const [info, peers] = await Promise.all([nodeInfo(), peerList()]);
    if (!info) return;   // 刚起来还没就绪，下一次再看
    const others = peers.filter((p) => p && p.ipv4 && p.ipv4 !== info.ipv4_addr.replace(/\/.*$/, ''));
    state.peers = others.map((p) => ({
      hostname: p.hostname || '未知设备',
      ipv4: String(p.ipv4).replace(/\/.*$/, ''),
      cost: p.cost || '',
      lat: p.lat_ms || '',
      loss: p.loss_rate || '',
      tunnel: p.tunnel_proto || '',
      direct: /p2p|direct|local/i.test(String(p.cost || '')),
    }));
    // PCL 模式：房主不知道客人会拿到哪个 DHCP 地址，有 Client-* 进来就算连上；
    // 客人则等固定房主 10.114.114.114。
    const ready = state.mode === 'pcl'
      ? (state.role === 'host'
        ? state.peers.some((p) => /^client/i.test(String(p.hostname)))
        : state.peers.some((p) => p.ipv4 === pcl.HOST_IP))
      : state.peers.some((p) => p.ipv4 === want);
    const next = ready ? 'online' : 'starting';
    if (next !== state.phase) {
      state.phase = next;
      logger.info(`EasyTier ${state.role === 'host' ? '建房' : '加入'}：${ready ? '对面已进网' : '等待对面进网'}`);
    }
    emit(onState);
  }, 2000);
}

function stopWatch() {
  if (state.watcher) { clearInterval(state.watcher); state.watcher = null; }
}

/** 等节点把虚拟 IP 挂上 */
async function waitReady(timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await nodeInfo()) return true;
    await sleep(700);
  }
  return false;
}

/* ---------- 对外接口 ---------- */

/** 建房公共流程：提权拉起 EasyTier，等虚拟网卡就绪，再开始轮询对端 */
async function beginHost({ args, code, address, mode, pclCode, onState } = {}) {
  npcap.ensure(exePath());
  await leave();
  state.role = 'host';
  state.mode = mode || 'nebula';
  state.code = code || '';
  state.pclCode = pclCode || '';
  state.address = address || '';
  state.error = '';
  state.phase = 'starting';
  emit(onState);

  logger.info(`EasyTier 建房：${code || ''}`);
  spawnElevated([...args, '--rpc-portal', RPC]);

  if (!await waitReady()) {
    // 启动失败（常见于用户取消了 UAC）：把已拉起的提权进程和 stop 标记收掉，
    // 否则 RPC 端口会被占住，下一次建房直接冲突
    await leave();
    emit(onState);
    throw new Error('EasyTier 没有在预期时间内启动（如果刚才取消了管理员授权，请再点一次）');
  }
  state.phase = 'starting';
  startWatch(onState);
  emit(onState);
  return { code: state.code, address: state.address };
}

/** 加入公共流程：普通权限拉起，--no-tun 不走虚拟网卡，只用端口转发 */
async function beginJoin({ args, code, address, mode, pclCode, onState } = {}) {
  npcap.ensure(exePath());
  await leave();
  state.role = 'guest';
  state.mode = mode || 'nebula';
  state.code = code || '';
  state.pclCode = pclCode || '';
  state.address = address || '';
  state.error = '';
  state.phase = 'starting';
  emit(onState);

  logger.info(`EasyTier 加入：${code || ''}`);
  spawnPlain([...args, '--rpc-portal', RPC]);

  if (!await waitReady()) {
    state.phase = 'offline';
    emit(onState);
    throw new Error('EasyTier 没有在预期时间内启动');
  }
  state.phase = 'starting';
  startWatch(onState);
  emit(onState);
  return { code: state.code, address: state.address };
}

/**
 * 星云房间名 / 房间号建房：需要管理员（要建虚拟网卡）。
 * 别人用 10.126.126.1:25565 就能直接连进来。
 */
async function host({ room, nodes, onState } = {}) {
  const net = networkOf(room);
  if (!net) throw new Error('请先填一个房间名（至少 2 个字）');
  if (!available()) throw new Error('没有找到内置的 EasyTier 文件');

  // 先按连通性排一遍：连得上的排前面，先跟它握手，别让死地址拖住开局
  const ranked = await rankNodes(nodes);
  const args = [
    '--network-name', net.name,
    '--network-secret', net.secret,
    '--hostname', 'cm-host',
    '-i', HOST_IP,
    ...peerArgsOf(rankedPeerUrls(ranked)),
  ];
  return beginHost({
    args, code: net.code, address: `${HOST_IP}:${MC_PORT}`, mode: 'nebula', onState,
  });
}

/**
 * 星云房间名 / 房间号加入：只需要 --no-tun 再加一条端口转发，
 * 把本机 127.0.0.1:25565 指到房主，游戏里连 localhost 就行，全程不需要管理员。
 */
async function join({ room, nodes, onState } = {}) {
  const net = networkOf(room);
  if (!net) throw new Error('请填写房间号或房间名');
  if (!available()) throw new Error('没有找到内置的 EasyTier 文件');

  const ranked = await rankNodes(nodes);
  const args = [
    '--network-name', net.name,
    '--network-secret', net.secret,
    '--hostname', 'cm-guest',
    '-i', GUEST_IP,
    '--no-tun',
    '--port-forward', `tcp://127.0.0.1:${MC_PORT}/${HOST_IP}:${MC_PORT}`,
    ...peerArgsOf(rankedPeerUrls(ranked)),
  ];
  return beginJoin({
    args, code: net.code, address: `127.0.0.1:${MC_PORT}`, mode: 'nebula', onState,
  });
}

/**
 * 手动参数建房：给其他 EasyTier 工具用，玩家自己填网络名、密钥、中继。
 * 不生成星云房间号，只按原样组网。
 */
async function manualHost({ name, secret, port = MC_PORT, nodes, onState } = {}) {
  const netName = String(name || '').trim();
  const netSecret = String(secret || '').trim();
  if (!netName || !netSecret) throw new Error('请填网络名称和网络密钥');
  if (!available()) throw new Error('没有找到内置的 EasyTier 文件');
  const mcPort = Number(port) || MC_PORT;

  const ranked = await rankNodes(nodes);
  const args = [
    '--network-name', netName,
    '--network-secret', netSecret,
    '--hostname', 'cm-host',
    '-i', HOST_IP,
    '--tcp-whitelist', String(mcPort),
    '--udp-whitelist', String(mcPort),
    ...peerArgsOf(rankedPeerUrls(ranked)),
  ];
  return beginHost({
    args, code: netName, address: `${HOST_IP}:${mcPort}`, mode: 'manual', onState,
  });
}

/**
 * 手动参数加入：同样只做端口转发，不需要管理员。
 */
async function manualJoin({ name, secret, remotePort = MC_PORT, localPort = MC_PORT, nodes, onState } = {}) {
  const netName = String(name || '').trim();
  const netSecret = String(secret || '').trim();
  if (!netName || !netSecret) throw new Error('请填网络名称和网络密钥');
  if (!available()) throw new Error('没有找到内置的 EasyTier 文件');
  const rp = Number(remotePort) || MC_PORT;
  const lp = Number(localPort) || MC_PORT;

  const ranked = await rankNodes(nodes);
  const args = [
    '--network-name', netName,
    '--network-secret', netSecret,
    '--hostname', 'cm-guest',
    '--no-tun',
    '-d',
    ...['tcp', 'udp'].flatMap((proto) => [
      `--port-forward=${proto}://127.0.0.1:${lp}/${HOST_IP}:${rp}`,
      `--port-forward=${proto}://[::1]:${lp}/${HOST_IP}:${rp}`,
    ]),
    '--tcp-whitelist=0',
    '--udp-whitelist=0',
    ...peerArgsOf(rankedPeerUrls(ranked)),
  ];
  return beginJoin({
    args, code: netName, address: `127.0.0.1:${lp}`, mode: 'manual', onState,
  });
}

/**
 * PCL 通用邀请码建房：按 PCL 约定固定房主 10.114.114.114，只放行 MC 端口。
 * 生成邀请码后直接拉起 EasyTier，返回码给界面复制。
 */
async function pclHost({ port = MC_PORT, nodeId, nodeAddr, name, onState } = {}) {
  if (!available()) throw new Error('没有找到内置的 EasyTier 文件');
  const mcPort = Number(port) || MC_PORT;
  let node;

  // 自定义节点按 PCL 约定写 000，双方必须填同一个地址
  const custom = pcl.normalizeNodeAddr(nodeAddr);
  if (custom) {
    node = { id: 0, address: custom };
  } else if (nodeId !== undefined && nodeId !== null && nodeId !== '') {
    const addr = await pcl.nodeAddress(nodeId);
    if (!addr) throw new Error(`节点 ${nodeId} 没有可用地址，请填自定义节点地址`);
    node = { id: Number(nodeId), address: addr };
  } else {
    node = await pcl.pickNode();
  }
  if (!node.address) throw new Error('没有拿到可用的 EasyTier 节点地址');

  const code = pcl.generate(mcPort, node.id);
  const args = pcl.hostArgs(code, node.address, mcPort, name);
  await beginHost({
    args, code, address: `${pcl.HOST_IP}:${mcPort}`, mode: 'pcl', pclCode: code, onState,
  });
  return { code, node, address: `${pcl.HOST_IP}:${mcPort}` };
}

/**
 * PCL 通用邀请码加入：解析邀请码里的端口 / 网络名 / 密钥 / 节点 ID，
 * 本地转发到 127.0.0.1:<localPort>，游戏里连本机地址。
 */
async function pclJoin({ code, localPort = MC_PORT, nodeAddr, name, onState } = {}) {
  if (!available()) throw new Error('没有找到内置的 EasyTier 文件');
  const d = pcl.parse(code);
  const custom = pcl.normalizeNodeAddr(nodeAddr);
  const nodeAddrResolved = custom || await pcl.nodeAddress(d.nodeID);
  if (!nodeAddrResolved) {
    throw new Error(d.nodeID === 0
      ? '这个邀请码用的是自定义节点，请填房主相同的节点地址'
      : `邀请码里的节点 ${d.nodeID} 没有可用地址，请填节点地址或让房主换节点`);
  }
  const lp = Number(localPort) || MC_PORT;
  const args = pcl.guestArgs(d.code, nodeAddrResolved, lp, name);
  await beginJoin({
    args, code: d.code, address: `127.0.0.1:${lp}`, mode: 'pcl', pclCode: d.code, onState,
  });
  return { code: d.code, port: d.port, localPort: lp, nodeID: d.nodeID, nodeAddr: nodeAddrResolved, address: `127.0.0.1:${lp}` };
}

/** 退出：提权进程让它自己看标记退，普通进程直接收掉 */
async function leave() {
  stopWatch();
  const wasElevated = state.elevated;
  const flag = state.stopFlag;
  const child = state.child;

  state.phase = 'offline';
  state.role = '';
  state.mode = 'nebula';
   state.code = '';
  state.pclCode = '';
   state.address = '';
  state.peers = [];
  state.elevated = false;
  state.stopFlag = '';
  state.child = null;

  if (wasElevated && flag) {
    try { fs.writeFileSync(flag, 'stop'); } catch { /* 权限不够就随它去 */ }
  } else if (child) {
    try { child.kill(); } catch { /* 已经没了 */ }
  }
  // 等 RPC 口真的松手，避免下一次启动抢不到端口
  for (let i = 0; i < 12; i += 1) {
    if (!await nodeInfo()) break;
    await sleep(500);
  }
  try { fs.unlinkSync(flag); } catch { /* 提权进程自己会删 */ }
  return true;
}

/** 启动器退出时把进程一起带走 */
async function shutdown() {
  return leave();
}

module.exports = {
  TOOL_ID,
  HOST_IP,
  GUEST_IP,
  MC_PORT,
  SHARED_NODES,
  available,
  exePath,
  cliPath,
  networkOf,
  codeOf,
  parseNodes,
  nodeList,
  parseNode,
  probeNode,
  probeNodes,
  rankNodes,
  probe,
  peerArgs,
  getState: () => snapshot(),
  host,
  join,
  manualHost,
  manualJoin,
  pclHost,
  pclJoin,
   leave,
   shutdown,
  pcl,
   isRunning: () => state.phase !== 'offline',
};