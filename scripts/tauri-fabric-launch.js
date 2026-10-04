/* 阶段 3 补充验证：启动 meta-API 安装的 Fabric 版本到主菜单。
 * 目标版本：fabric-loader-0.19.5-1.20.1（继承 1.20.1，需下载 1.20.1 client jar）。
 * 用法: node scripts/tauri-fabric-launch.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.argv[2] || 9224);
const INST_ID = 'inst_gate_fabric_meta';
const MC_VERSION = 'fabric-loader-0.19.5-1.20.1';
const GAME_DIR = 'E:\\AppData\\Roaming\\.minecraft';

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
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };

  await new Promise((res) => (ws.onopen = res));
  await req('Runtime.enable');

  await evalJs(`(() => {
    const nonce = Math.random();
    window.__gate = { nonce, logs: [], started: 0, exitCode: null, lastProgress: null };
    window.api.onLog((e) => { if (window.__gate.nonce === nonce) window.__gate.logs.push(e.message); });
    window.api.onProgress((p) => { if (window.__gate.nonce === nonce) window.__gate.lastProgress = p; });
    window.api.onGameStarted(() => { if (window.__gate.nonce === nonce) window.__gate.started++; });
    window.api.onGameExit((code) => { if (window.__gate.nonce === nonce) window.__gate.exitCode = code; });
    return true;
  })()`);

  await evalJs(`window.api.instancesSave(${JSON.stringify(INST_ID)}, {
    name: 'Gate Fabric meta',
    versionId: ${JSON.stringify(MC_VERSION)},
    modLoader: 'fabric',
    loaderVersion: '0.19.5',
    gameDir: ${JSON.stringify(GAME_DIR)},
    icon: '🧵'
  })`);

  const t0 = Date.now();
  const ok = await evalJs(`window.api.launch(${JSON.stringify(INST_ID)})`);
  console.log('[launch]', ok, `(${(Date.now() - t0) / 1000}s)`);
  if (!ok) throw new Error('launch 返回 false');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MENU_RE = /atlas\/mob_effects\.png-atlas/;
  const CRASH_RE = /Minecraft Crash Report|Crash report saved|Failed to start game|UnsupportedClassVersionError|Could not find or load main class|主类/i;
  let reachedMenu = false, crashLine = null;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const g = JSON.parse(await evalJs('JSON.stringify(window.__gate)'));
    const joined = g.logs.join('\n');
    if (CRASH_RE.test(joined)) { crashLine = joined.match(CRASH_RE)[0]; break; }
    if (MENU_RE.test(joined)) { reachedMenu = true; await sleep(5000); break; }
    if (g.exitCode !== null) break;
    const p = g.lastProgress;
    if (p) process.stdout.write(`\r[dl] ${p.completed}/${p.total} ${p.percent}%   `);
  }
  process.stdout.write('\n');

  const g = JSON.parse(await evalJs('JSON.stringify(window.__gate)'));
  console.log('[started]', g.started, '[log lines]', g.logs.length);
  g.logs.slice(-8).forEach((l) => console.log('   |', l));

  let shotOk = false;
  if (reachedMenu) {
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool S(IntPtr h); [DllImport("user32.dll")] public static extern bool SW(IntPtr h, int n); }
"@;
$p = Get-Process java -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
if ($p) { [W]::SW($p.MainWindowHandle, 9) | Out-Null; [W]::S($p.MainWindowHandle) | Out-Null }`], { stdio: 'inherit' });
      await sleep(1500);
    } catch (e) { console.log('[focus]', e.message); }
    const shot = path.join(__dirname, '..', 'tauri', 'gate-fabric-meta.png');
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
       $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
       $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;
       $g=[System.Drawing.Graphics]::FromImage($bmp);
       $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);
       $bmp.Save(${JSON.stringify(shot)});`], { stdio: 'inherit' });
    shotOk = fs.existsSync(shot);
    console.log('[screenshot]', shot, shotOk ? 'OK' : 'MISSING');
  }

  if (g.exitCode === null) {
    console.log('[wait-exit] 请关闭 Minecraft 窗口…');
    const dl = Date.now() + 300000;
    while (Date.now() < dl) {
      await sleep(3000);
      const c = await evalJs('window.__gate.exitCode');
      if (c !== null) { g.exitCode = c; break; }
    }
  }
  console.log('[exit-code]', g.exitCode, '[crash]', crashLine);
  const passed = reachedMenu && shotOk && !crashLine;
  console.log(passed ? '[PASS] meta-API Fabric 版本成功启动到主菜单' : '[FAIL]');
  ws.close();
  process.exit(passed ? 0 : 1);
}

main().catch((e) => { console.error('[fail]', e.message); process.exit(1); });
