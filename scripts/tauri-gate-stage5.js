/* 阶段 5 Gate：联机功能（服务器 Ping / 局域网 / 陶瓦 Terracotta / EasyTier）。
 * 只做只读 / 纯计算验证，不真正开房、不拉进程：
 *  1) lan:ips / lan:detect 返回本机网卡与工具探测结果
 *  2) scaffold:info / easytier:info 能定位内置 exe（available:true）
 *  3) 房间号纯本地派生稳定（同名同房号、带 U/ 前缀）
 *  4) server:ping 链路通（返回 online/error 字段，不断言某台服务器必在线）
 * 用法: node scripts/tauri-gate-stage5.js [port]
 */
const http = require('http');

const PORT = Number(process.argv[2] || 9224);

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json`, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === 'page' && t.url && !t.url.startsWith('chrome-extension'));
  if (!page) throw new Error('no page target');
  console.log('[target]', page.title, '|', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const req = (method, params = {}) =>
    new Promise((res) => {
      const i = id++;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evalJs = async (expression) => {
    const r = await req('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails));
    }
    return r.result?.result?.value;
  };

  await new Promise((res) => (ws.onopen = res));
  await req('Runtime.enable');

  let failures = 0;
  const check = (cond, label, extra) => {
    console.log((cond ? '[PASS] ' : '[FAIL] ') + label + (extra !== undefined ? '  ' + extra : ''));
    if (!cond) failures++;
  };

  // 1) 本机 IP
  const ips = await evalJs('window.api.lanIps()');
  check(Array.isArray(ips) && ips.some((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v.address)),
    'lan:ips 返回本机 IPv4', JSON.stringify(ips.map((v) => v.address)));

  // 2) 局域网工具探测
  const det = await evalJs('window.api.lanDetect()');
  const tools = det && det.tools;
  check(!!tools && tools.length >= 4, 'lan:detect 返回工具列表', tools && tools.map((t) => `${t.id}:${t.found}`).join(' '));
  const taohua = tools && tools.find((t) => t.id === 'taohua');
  const et0 = tools && tools.find((t) => t.id === 'easytier');
  check(!!taohua && !!taohua.found, '陶瓦工具已定位', taohua && taohua.path);
  check(!!et0 && !!et0.found, 'EasyTier 工具已定位', et0 && et0.path);
  check(Array.isArray(det.ips), 'lan:detect 带 ips');
  check(Array.isArray(det.ipv6), 'lan:detect 带 ipv6', det.ipv6 && det.ipv6.length + ' 个公网IPv6');

  // 3) info
  const scInfo = await evalJs('window.api.scaffoldInfo()');
  check(scInfo && scInfo.available === true && !!scInfo.exe, 'scaffold:info available', scInfo && scInfo.exe);
  const etInfo = await evalJs('window.api.easytierInfo()');
  check(etInfo && etInfo.available === true && !!etInfo.exe, 'easytier:info available', etInfo && etInfo.exe);
  check(etInfo && etInfo.hostIp === '10.126.126.1' && etInfo.mcPort === 25565, 'easytier 虚拟网段/端口正确');

  // 4) 房间号派生（纯本地）
  const codeA = await evalJs(`window.api.scaffoldCodeOf(${JSON.stringify('测试房间')})`);
  const codeB = await evalJs(`window.api.scaffoldCodeOf(${JSON.stringify('测试房间')})`);
  const codeC = await evalJs(`window.api.scaffoldCodeOf(${JSON.stringify('另一个房间')})`);
  check(typeof codeA === 'string' && /^U\/[0-9A-Z-]+$/.test(codeA), '陶瓦房间号格式 U/xxxx', codeA);
  check(codeA === codeB && codeA !== codeC, '陶瓦同名同房号、异名不同房号');

  const ecodeA = await evalJs(`window.api.easytierCodeOf(${JSON.stringify('测试房间')})`);
  const ecodeB = await evalJs(`window.api.easytierCodeOf(${JSON.stringify('测试房间')})`);
  check(typeof ecodeA === 'string' && /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(ecodeA), 'EasyTier 房间码派生', ecodeA);
  check(ecodeA === ecodeB, 'EasyTier 同名同网络名');

  // 5) 服务器 Ping（不断言在线，只验证字段与不抛错）
  const pr = await evalJs(`window.api.serverPing(${JSON.stringify('mc.hypixel.net')})`);
  check(pr && typeof pr.online === 'boolean',
    'server:ping 返回结构', pr.online ? `online latency=${pr.latency} players=${pr.players && pr.players.online}` : `offline error=${pr.error}`);

  console.log('\n' + (failures === 0 ? '阶段 5 Gate 全部通过 ✅' : `阶段 5 Gate 有 ${failures} 项失败 ❌`));
  ws.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
