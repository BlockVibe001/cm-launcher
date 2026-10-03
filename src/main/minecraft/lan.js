// 联机助手：局域网开房、公网联机（UPnP 自动开端口 / IPv6 直连）、第三方工具收纳与启动
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');
const { spawn } = require('child_process');
const { app } = require('electron');
const config = require('../config');
const logger = require('../logger');
const downloads = require('../system/downloads');
const { extractZip } = require('../util/zipread');

/**
 * 预置联机工具。
 * url 留空表示「没有可验证的官方直链」，此时卡片走「装进启动器」——
 * 选一次安装包，由启动器自己解压、定位 exe 并托管，之后永久一键启动。
 * 填上 url 后同一颗按钮会改成自动下载安装。
 * resources/tools/<id>/ 里放了东西的话属于「随启动器内置」，不用下载也不用安装。
 */
const PRESETS = [
  {
    id: 'taohua',
    name: '陶瓦联机',
    icon: '🏺',
    desc: '虚拟局域网联机工具，支持房间号直连',
    // 随启动器内置；下面两条只在内置文件缺失 / 损坏时才用得上
    url: 'https://github.com/burningtnt/Terracotta/releases/download/v0.4.2/terracotta-0.4.2-windows-x86_64-pkg.tar.gz',
    mirrors: ['https://gitee.com/burningtnt/Terracotta/releases/download/v0.4.2/terracotta-0.4.2-windows-x86_64-pkg.tar.gz'],
    exes: ['terracotta.exe', 'terracotta-0.4.2-windows-x86_64.exe', '陶瓦联机.exe', 'taohua联机.exe'],
    folders: ['陶瓦联机', 'Terracotta', 'Taohua', 'TaohuaLan'],
  },
  {
    id: 'easytier',
    name: 'EasyTier',
    icon: '🛰️',
    desc: '去中心化组网，跨网络联机；也可当通用内网穿透',
    // 随启动器内置；下面两条只在内置文件缺失 / 损坏时才用得上
    url: 'https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/easytier-windows-x86_64-v2.6.4.zip',
    mirrors: [],
    exes: ['easytier-core.exe'],
    folders: ['easytier', 'EasyTier'],
  },
  {
    id: 'redstone',
    name: '红石联机',
    icon: '🔺',
    desc: '国内常用的 MC 内网穿透联机工具',
    // 官网的 webui 下载接口：给的是不带扩展名的裸 exe，所以要显式声明包型和落地文件名
    url: 'https://hongshi.site/api/download/webui?platform=windows&arch=amd64',
    pkg: 'exe',
    file: 'hongshi-windows-amd64.exe',
    exes: ['hongshi-windows-amd64.exe', '红石联机.exe', 'redstonelan.exe', 'RedstoneLan.exe', '红石.exe'],
    folders: ['红石联机', 'RedstoneLan', 'Redstone'],
  },
  {
    id: 'sakura',
    name: 'Sakura Frp',
    icon: '🌸',
    desc: '通用内网穿透，可自行映射 25565 端口',
    // 官方只提供安装程序（不是绿色包），装进启动器反而添乱，所以只给个下载页
    url: '',
    page: 'https://www.natfrp.com/tunnel/download',
    exes: ['SakuraFrpLauncher.exe', 'SakuraLauncher.exe', 'SakuraFrp.exe'],
    folders: ['SakuraFrpLauncher', 'SakuraFrp'],
  },
];

const CUSTOM_ID = 'custom';

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function subdirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

/* ---------- 本机局域网地址 ---------- */

function localIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces || [])) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' && net.family !== 4) continue;
      if (net.internal) continue;
      out.push({ name, address: net.address, netmask: net.netmask });
    }
  }
  // 常见家用网段优先
  const rank = (a) => (a.address.startsWith('192.168.') ? 0
    : a.address.startsWith('10.') ? 1
      : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

/* ---------- 公网联机：UPnP 自动端口映射 + IPv6 直连 ---------- */
/*
 * 目标是不依赖任何第三方工具、也不下载任何东西就能让朋友连进来：
 *   ① UPnP：开房时向家用路由自动申请把端口映射到本机，拿到公网 IPv4；
 *   ② IPv6：运营商普遍已下发公网 IPv6，直接给对方 [地址]:端口 即可绕过 NAT。
 * 两者都失败时才需要退回「装进启动器」那套外部工具。
 */

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const IGD_ST = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1';

/** 本机第一个可用的局域网 IPv4，作为 UPnP 映射的内网目标 */
function localIPv4() {
  const l = localIPs();
  return (l[0] && l[0].address) || '';
}

/**
 * 本机可用于直连的公网 IPv6。
 * 只保留全局单播（2000::/3），排除回环、fe80:: 链路本地和 IPv4 映射地址；
 * 家宽的 IPv6 一般就在这里面，对方用 [地址]:端口 直接连，全程不需要任何工具。
 */
function publicIPv6s() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces() || {})) {
    for (const net of list || []) {
      if (net.family !== 'IPv6' && net.family !== 6) continue;
      if (net.internal) continue;
      const address = String(net.address).split('%')[0];
      if (!/^[23]/.test(address)) continue;   // 2000::/3，公网全局单播
      out.push({ name, address });
    }
  }
  return out;
}

/** SSDP 广播找网关（IGD）设备，返回它们描述文件的 LOCATION */
function ssdpDiscover(timeout = 1500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* 已关闭 */ }
      resolve(found);
    };
    const search = (st) =>
      `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n`
      + 'MAN: "ssdp:discover"\r\nMX: 1\r\n'
      + `ST: ${st}\r\n\r\n`;

    sock.on('message', (msg, rinfo) => {
      const loc = /LOCATION:\s*(\S+)/i.exec(msg.toString('utf8'));
      if (loc && !found.some((f) => f.location === loc[1])) {
        found.push({ location: loc[1].trim(), from: rinfo.address });
      }
    });
    sock.on('error', finish);
    sock.bind(() => {
      try {
        for (const st of [IGD_ST, 'upnp:rootdevice']) {
          const buf = Buffer.from(search(st));
          sock.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR);
        }
      } catch { finish(); }
      setTimeout(finish, timeout);
    });
  });
}

function httpGet(url, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('读取网关描述超时')));
  });
}

/** 从网关描述 XML 里挑出 WAN 连接服务（负责端口映射的那个） */
function parseWanService(xml, baseUrl) {
  const blocks = String(xml).match(/<service>[\s\S]*?<\/service>/gi) || [];
  for (const block of blocks) {
    const type = (/<serviceType>([\s\S]*?)<\/serviceType>/i.exec(block) || [])[1] || '';
    if (!/WAN(IP|PPP)Connection/i.test(type)) continue;
    const ctrl = (/<controlURL>([\s\S]*?)<\/controlURL>/i.exec(block) || [])[1] || '';
    if (!ctrl.trim()) continue;
    try {
      return { serviceType: type.trim(), controlURL: new URL(ctrl.trim(), baseUrl).toString() };
    } catch { /* 控制地址不合法，继续找 */ }
  }
  return null;
}

/** 发一条 UPnP SOAP 指令 */
function soap(controlURL, serviceType, action, body, timeout = 3500) {
  return new Promise((resolve, reject) => {
    const payload = '<?xml version="1.0"?>'
      + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
      + 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
      + `<u:${action} xmlns:u="${serviceType}">${body}</u:${action}>`
      + '</s:Body></s:Envelope>';
    const u = new URL(controlURL);
    const req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${serviceType}#${action}"`,
        'Content-Length': Buffer.byteLength(payload),
        Connection: 'close',
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`UPnP 返回 HTTP ${res.statusCode}`));
        else resolve(text);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('UPnP 请求超时')));
    req.end(payload);
  });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 让路由器把这个端口映射到本机。
 * @returns {Promise<{port:number, ip:string, gateway:string, desc:string}|null>} 失败返回 null（不抛）
 */
async function upnpMap(port, opts = {}) {
  const discover = opts.discover || ssdpDiscover;
  const fetchXml = opts.fetchXml || httpGet;
  const callSoap = opts.callSoap || soap;
  const internal = opts.internalIp || localIPv4();
  const desc = opts.description || 'BlockVibeLauncher';
  if (!port || !internal) return null;

  let gateways = [];
  try { gateways = await discover(opts.timeout || 1500); } catch { return null; }

  for (const gw of gateways) {
    try {
      const xml = await fetchXml(gw.location);
      const svc = parseWanService(xml, gw.location);
      if (!svc) continue;
      await callSoap(svc.controlURL, svc.serviceType, 'AddPortMapping',
        '<NewRemoteHost></NewRemoteHost>'
        + `<NewExternalPort>${port}</NewExternalPort>`
        + '<NewProtocol>TCP</NewProtocol>'
        + `<NewInternalPort>${port}</NewInternalPort>`
        + `<NewInternalClient>${esc(internal)}</NewInternalClient>`
        + '<NewEnabled>1</NewEnabled>'
        + `<NewPortMappingDescription>${esc(desc)}</NewPortMappingDescription>`
        + '<NewLeaseDuration>0</NewLeaseDuration>');
      let ip = '';
      try {
        const r = await callSoap(svc.controlURL, svc.serviceType, 'GetExternalIPAddress',
          '<NewRemoteHost></NewRemoteHost>');
        const m = /<NewExternalIPAddress>([\s\S]*?)<\/NewExternalIPAddress>/i.exec(r);
        ip = m ? m[1].trim() : '';
      } catch { /* 部分路由器不给查，忽略 */ }
      logger.info(`UPnP 端口映射成功：${internal}:${port} → ${ip || '公网 IP 未知'}`);
      return { port, ip, gateway: gw.from, internal, desc };
    } catch { /* 这台网关不行，试下一个 */ }
  }
  logger.info('UPnP 端口映射失败：没有找到支持 UPnP 的网关');
  return null;
}

/** 撤销上面那条映射（退出时清理，避免路由器里越积越多） */
async function upnpUnmap(port, opts = {}) {
  const discover = opts.discover || ssdpDiscover;
  const fetchXml = opts.fetchXml || httpGet;
  const callSoap = opts.callSoap || soap;
  if (!port) return false;
  let gateways = [];
  try { gateways = await discover(opts.timeout || 1200); } catch { return false; }
  for (const gw of gateways) {
    try {
      const svc = parseWanService(await fetchXml(gw.location), gw.location);
      if (!svc) continue;
      await callSoap(svc.controlURL, svc.serviceType, 'DeletePortMapping',
        '<NewRemoteHost></NewRemoteHost>'
        + `<NewExternalPort>${port}</NewExternalPort>`
        + '<NewProtocol>TCP</NewProtocol>');
      return true;
    } catch { /* 试下一个 */ }
  }
  return false;
}

/**
 * 汇总一个端口上所有可用的公网入口。
 * @returns {Promise<{port:number, ipv6:string[], ipv4:object|null}>}
 */
async function publicEndpoints(port, opts = {}) {
  const ipv6 = publicIPv6s();
  const ipv4 = ipv6.length ? null : await upnpMap(port, opts);
  return { port, ipv6: ipv6.map((i) => i.address), ipv4 };
}

/* ---------- 游戏日志里的开房端口 ---------- */

/** 从一行游戏日志里识别「已对局域网开放」的端口，识别不到返回 0 */
function detectLanPort(line) {
  const s = String(line || '');
  const pats = [
    /Local game hosted on port (\d{2,5})/i,
    /Started serving on (?:[0-9a-fA-F:.]+:)?(\d{2,5})/i,
    /Started on port (\d{2,5})/i,
    /Opening (?:LAN|to LAN) on port (\d{2,5})/i,
    /Listening on .*:(\d{2,5})/i,
  ];
  for (const re of pats) {
    const m = re.exec(s);
    if (m) {
      const p = Number(m[1]);
      if (p >= 1024 && p <= 65535) return p;
    }
  }
  return 0;
}

/* ---------- 工具探测 ---------- */

function searchRoots() {
  const home = app.getPath('home');
  const roots = [];
  const push = (p) => { if (p && isDir(p) && !roots.includes(p)) roots.push(p); };
  for (const key of ['appData', 'userData', 'temp', 'desktop', 'documents', 'downloads']) {
    try { push(app.getPath(key)); } catch { /* 某些平台无此目录 */ }
  }
  if (process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'Programs'));
  if (process.env.ProgramFiles) push(process.env.ProgramFiles);
  if (process.env['ProgramFiles(x86)']) push(process.env['ProgramFiles(x86)']);
  push(path.join(home, 'Desktop'));
  push(path.join(home, 'Downloads'));
  return roots;
}

/** 在目录中按文件名匹配查找 exe（深度受限） */
function findExe(root, exeNames, depth = 3) {
  if (depth < 0) return null;
  let items = [];
  try { items = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const it of items) {
    const full = path.join(root, it.name);
    if (it.isFile()) {
      if (exeNames.some((n) => n.toLowerCase() === it.name.toLowerCase())) return full;
    }
  }
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const found = findExe(path.join(root, it.name), exeNames, depth - 1);
    if (found) return found;
  }
  return null;
}

function detectOne(preset, roots) {
  // ① 先看预设的目录名
  for (const root of roots) {
    for (const folder of preset.folders) {
      const dir = path.join(root, folder);
      if (!isDir(dir)) continue;
      const exe = findExe(dir, preset.exes, 2);
      if (exe) return exe;
    }
  }
  // ② 再在整个搜索根里找同名 exe
  for (const root of roots) {
    const exe = findExe(root, preset.exes, 2);
    if (exe) return exe;
  }
  return '';
}

/* ---------- 收纳到启动器自己的工具目录 ---------- */

/** 启动器托管的工具根目录：%userData%/tools/<id>/ */
function toolsRoot() {
  return path.join(app.getPath('userData'), 'tools');
}

function toolDir(id) {
  const dir = path.join(toolsRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 兜底：目录里任意一个可执行文件（不知道确切文件名时用） */
function firstExe(root, depth = 3) {
  if (depth < 0) return '';
  let items = [];
  try { items = fs.readdirSync(root, { withFileTypes: true }); } catch { return ''; }
  for (const it of items) {
    if (it.isFile() && /\.(exe|bat|cmd)$/i.test(it.name)) return path.join(root, it.name);
  }
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const found = firstExe(path.join(root, it.name), depth - 1);
    if (found) return found;
  }
  return '';
}

/** 在托管目录里找该工具的 exe */
function managedExe(id) {
  const dir = path.join(toolsRoot(), id);
  if (!isDir(dir)) return '';
  const preset = PRESETS.find((p) => p.id === id);
  return findExe(dir, (preset && preset.exes) || [], 3) || firstExe(dir, 3);
}

/* ---------- 随启动器一起分发的内置工具 ---------- */

/**
 * 内置工具目录：开发时是仓库里的 resources/tools，打包后是安装目录的 resources/tools。
 * 放在这里的工具点一下就能用，不需要下载，也不需要玩家自己准备安装包。
 */
function bundledRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools')
    : path.join(__dirname, '..', '..', '..', 'resources', 'tools');
}

function bundledExe(id) {
  const preset = PRESETS.find((p) => p.id === id);
  const dir = path.join(bundledRoot(), id);
  if (!isDir(dir)) return '';
  return findExe(dir, (preset && preset.exes) || [], 2) || firstExe(dir, 2);
}

/**
 * 统一的 exe 解析顺序：
 * 手动指定 → 启动器托管（装进来的）→ 随包内置 → 本机已装的同款软件。
 */
function resolveExe(id) {
  const saved = (config.get('lanTools') || {})[id] || {};
  if (saved.path && exists(saved.path)) return saved.path;
  if (id === CUSTOM_ID) return '';
  const preset = PRESETS.find((p) => p.id === id);
  return managedExe(id) || bundledExe(id) || (preset ? detectOne(preset, searchRoots()) : '');
}

/** 极简 tar 解包：只取普通文件（官方绿色包就这个形态），不做链接 / 权限 */
function untar(buf, dir) {
  let off = 0;
  const out = [];
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '').trim();
    if (!name) break;   // 连续两个全零块表示归档结束
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim(), 8) || 0;
    const type = header[156];
    const dataOff = off + 512;
    if (type === 0 || type === 48) {   // '0' = 普通文件
      const safe = path.normalize(name).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
      const dest = path.join(dir, safe);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf.subarray(dataOff, dataOff + size));
      out.push(safe);
    }
    off = dataOff + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** 把安装包（zip / tar.gz / exe / bat）解压收纳进托管目录，并自动定位 exe */
function install(id, file) {
  if (!exists(file)) throw new Error('安装包不存在');
  const dir = toolDir(id);
  const preset = PRESETS.find((p) => p.id === id);
  // 下载接口给的是裸 exe，统一改成 preset 声明的名字，方便之后按名字定位
  const keep = (preset && preset.file) || path.basename(file);
  if (/\.zip$/i.test(file)) {
    extractZip(file, dir);
  } else if (/\.tar\.gz$|\.tgz$/i.test(file)) {
    untar(zlib.gunzipSync(fs.readFileSync(file)), dir);
  } else {
    const dest = path.join(dir, keep);
    // 包已经在托管目录里（就是下载落地的位置）时复制自己会报错，跳过即可
    if (path.resolve(dest) !== path.resolve(file)) fs.copyFileSync(file, dest);
    else if (path.basename(file) !== keep) fs.renameSync(file, dest);
  }
  const exe = managedExe(id);
  if (exe) setPath(id, exe);
  logger.info(exe ? `联机工具已收纳：${id} → ${exe}` : `联机工具已收纳但未找到可执行文件：${id}`);
  return { dir, exe };
}

/** 配置了 url 的预置工具：启动器自己下载并收纳（大陆优先走镜像） */
async function fetchTool(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error('未知的联机工具');

  const already = managedExe(id);
  if (already) return { dir: path.dirname(already), exe: already };

  const urls = [preset.url, ...(preset.mirrors || [])].filter(Boolean);
  if (!urls.length) throw new Error(`${preset.name} 没有配置下载地址，请改用「装进启动器」选择安装包`);

  const dir = toolDir(id);
  // 收纳时要靠扩展名判断怎么解包；下载地址不带扩展名的（如官网接口）由 preset.pkg 说了算
  const kind = preset.pkg || (/\.zip(\?|$)/i.test(urls[0]) ? 'zip' : /\.tar\.gz(\?|$)|\.tgz(\?|$)/i.test(urls[0]) ? 'targz' : 'exe');
  const name = kind === 'zip' ? 'package.zip' : kind === 'targz' ? 'package.tar.gz' : (preset.file || 'package.exe');
  const pkg = path.join(dir, name);
  await downloads.track(`获取 ${preset.name}`, 'tool', async (onProgress) => {
    let lastErr = null;
    for (const u of urls) {
      try {
        const res = await fetch(u, { headers: { 'User-Agent': 'BlockVibeLauncher/1.0.0' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(pkg, buf);
        if (onProgress) onProgress({ percent: 100, received: buf.length, total: total || buf.length });
        return pkg;
      } catch (e) {
        lastErr = e;
        logger.info(`下载 ${preset.name} 失败，换下一个源：${u}（${e.message}）`);
      }
    }
    throw new Error(`下载失败：${lastErr ? lastErr.message : '所有下载源都不可用'}`);
  }, { url: urls[0], dest: pkg });

  return install(id, pkg);
}

function detect() {
  const saved = config.get('lanTools') || {};
  const roots = searchRoots();
  const tools = PRESETS.map((p) => {
    const manual = (saved[p.id] && saved[p.id].path) || '';
    const managed = managedExe(p.id);
    const bundled = bundledExe(p.id);
    const path0 = (manual && exists(manual) ? manual : '')
      || managed
      || bundled
      || detectOne(p, roots);
    return {
      id: p.id,
      name: p.name,
      icon: p.icon,
      desc: p.desc,
      path: path0,
      found: !!path0,
      manual: !!manual,
      managed: !!managed,
      bundled: !!bundled,
      auto: !!p.url,
      page: p.page || '',
      custom: false,
    };
  });

  const customPath = (saved[CUSTOM_ID] && saved[CUSTOM_ID].path) || '';
  tools.push({
    id: CUSTOM_ID,
    name: (saved[CUSTOM_ID] && saved[CUSTOM_ID].name) || '自定义工具',
    icon: '🧩',
    desc: '添加任意可执行文件（其他联机工具 / 自己写的脚本）',
    path: customPath,
    found: !!customPath && exists(customPath),
    manual: !!customPath,
    custom: true,
  });

  return { tools, ips: localIPs(), ipv6: publicIPv6s() };
}

function setPath(id, p, name) {
  const all = { ...(config.get('lanTools') || {}) };
  if (!p) delete all[id];
  else all[id] = { path: p, name: name || all[id]?.name || '' };
  config.set('lanTools', all);
  logger.info(p ? `登记联机工具 ${id}：${p}` : `清除联机工具 ${id}`);
  return all;
}

function launch(id) {
  const exe = resolveExe(id);
  if (!exe) throw new Error('未找到该工具的可执行文件，请先手动指定');
  if (!exists(exe)) throw new Error('可执行文件不存在，请重新指定');

  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  logger.info(`启动联机工具：${exe}`);
  return { path: exe, pid: child.pid };
}

module.exports = {
  detect,
  localIPs,
  publicIPv6s,
  upnpMap,
  upnpUnmap,
  publicEndpoints,
  detectLanPort,
  parseWanService,
  setPath,
  launch,
  install,
  fetchTool,
  toolsRoot,
  bundledRoot,
  bundledExe,
  resolveExe,
  managedExe,
  PRESETS,
};