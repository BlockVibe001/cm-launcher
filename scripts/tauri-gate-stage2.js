/* 阶段 2 Gate：1.20.1 + Fabric 启动到主菜单（Tauri 2 / CDP 真机）。
 * 流程：创建 Fabric 实例（复用 Electron 版已下载的 1.20.1-Fabric_0.19.5）→
 *      监听 game:started / log / game:exit → 检测主菜单日志信号 → 桌面截图 → 等退出码。
 * 用法: node scripts/tauri-gate-stage2.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.argv[2] || 9224);
const INST_ID = 'inst_gate_fabric';
const MC_VERSION = '1.20.1-Fabric_0.19.5';
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
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };

  await new Promise((res) => (ws.onopen = res));
  await req('Runtime.enable');

  // 1) 安装事件采集器（nonce 隔离历次运行遗留的旧监听器）
  await evalJs(`(() => {
    const nonce = Math.random();
    window.__gate = { nonce, logs: [], started: 0, exitCode: null, lastProgress: null, t0: Date.now() };
    window.api.onLog((e) => { if (window.__gate.nonce === nonce) window.__gate.logs.push(e.message); });
    window.api.onProgress((p) => { if (window.__gate.nonce === nonce) window.__gate.lastProgress = p; });
    window.api.onGameStarted(() => { if (window.__gate.nonce === nonce) window.__gate.started++; });
    window.api.onGameExit((code) => { if (window.__gate.nonce === nonce) window.__gate.exitCode = code; });
    return true;
  })()`);

  // 2) 创建 Fabric 实例（走正式命令 instances:save）
  const saved = await evalJs(`window.api.instancesSave(${JSON.stringify(INST_ID)}, {
    name: 'Gate Fabric 验证',
    versionId: ${JSON.stringify(MC_VERSION)},
    modLoader: 'fabric',
    loaderVersion: '0.19.5',
    gameDir: ${JSON.stringify(GAME_DIR)},
    icon: '🧵'
  })`);
  console.log('[instance]', JSON.stringify(saved));

  // 3) 启动（launch 在 spawn 成功后 resolve true；下载/刷新都在这之前）
  const tLaunch = Date.now();
  const ok = await evalJs(`window.api.launch(${JSON.stringify(INST_ID)})`);
  console.log('[launch-return]', ok, `(${(Date.now() - tLaunch) / 1000}s)`);
  if (!ok) throw new Error('launch 返回 false');

  // 4) 轮询等待主菜单信号
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 1.20.1 没有 gui.png 图集（1.20.2 才引入）；资源重载最后 stitch 的是 mob_effects，
  // 其后 1~2 秒标题画面渲染。
  const MENU_RE = /atlas\/mob_effects\.png-atlas/;
  const CRASH_RE = /Minecraft Crash Report|Crash report saved|Failed to start game|UnsupportedClassVersionError|Could not find or load main class|主类/i;
  let state = null;
  let reachedMenu = false;
  let crashLine = null;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    await sleep(2500);
    state = await evalJs('JSON.stringify(window.__gate)');
    const g = JSON.parse(state);
    const joined = g.logs.join('\n');
    if (CRASH_RE.test(joined)) {
      const m = joined.match(CRASH_RE);
      crashLine = m && m[0];
      break;
    }
    if (MENU_RE.test(joined)) {
      reachedMenu = true;
      // gui atlas 出现即主菜单渲染；再稳 5 秒让画面完全绘制
      await sleep(5000);
      break;
    }
    if (g.exitCode !== null) break;
    const p = g.lastProgress;
    if (p) process.stdout.write(`\r[dl] ${p.completed}/${p.total} ${p.percent}% ${(p.current || '').slice(0, 30)}   `);
  }
  process.stdout.write('\n');

  state = await evalJs('JSON.stringify(window.__gate)');
  const g = JSON.parse(state);
  console.log('[game:started count]', g.started);
  console.log('[log lines]', g.logs.length);
  console.log('[last 25 log lines]');
  g.logs.slice(-25).forEach((l) => console.log('   |', l));

  // 5) 桌面截图（游戏窗口在前台；PowerShell + System.Drawing）
  let shotOk = false;
  if (reachedMenu) {
    // 把 Minecraft 窗口切到前台（进程名 java），否则截图拍到的是别的窗口
    try {
      execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@;
$p = Get-Process java -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
if ($p) { [Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }`,
      ], { stdio: 'inherit' });
      await sleep(1500);
    } catch (e) {
      console.log('[focus] failed:', e.message);
    }

    const shot = path.join(__dirname, '..', 'tauri', 'gate-menu.png');
    try {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
           $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
           $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;
           $g=[System.Drawing.Graphics]::FromImage($bmp);
           $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);
           $bmp.Save(${JSON.stringify(shot)});
           $bmp.Dispose();`,
        ],
        { stdio: 'inherit' },
      );
      shotOk = fs.existsSync(shot);
      console.log('[screenshot]', shot, shotOk ? 'OK' : 'MISSING');
    } catch (e) {
      console.log('[screenshot] failed:', e.message);
    }
  }

  // 保存启动器侧完整日志片段
  const dumpLog = path.join(__dirname, '..', 'tauri', 'gate-launcher-logs.json');
  fs.writeFileSync(dumpLog, JSON.stringify(g.logs, null, 2));

  // 6) 等待游戏退出（请手动关闭 Minecraft 窗口），最多 5 分钟
  if (g.exitCode === null) {
    console.log('[wait-exit] 请关闭 Minecraft 窗口以核对退出码（最多等待 5 分钟）…');
    const exitDeadline = Date.now() + 300000;
    while (Date.now() < exitDeadline) {
      await sleep(3000);
      const code = await evalJs('window.__gate.exitCode');
      if (code !== null) {
        g.exitCode = code;
        break;
      }
    }
  }
  console.log('[exit-code]', g.exitCode);
  console.log('[crash-line]', crashLine);

  const passed = reachedMenu && shotOk && !crashLine;
  console.log(passed ? '[GATE] PASS：1.20.1 + Fabric 已启动到主菜单' : '[GATE] FAIL');
  ws.close();
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('[fail]', e.message);
  process.exit(1);
});
