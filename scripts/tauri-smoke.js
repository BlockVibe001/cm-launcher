/* Tauri 版 CDP 冒烟脚本（阶段 1 验证用）：
 * 连 --remote-debugging-port 暴露的页面，验证 window.api 就绪、config 读取、截图存档。
 * 用法: node scripts/tauri-smoke.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

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
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };

  await new Promise((res) => (ws.onopen = res));
  await req('Runtime.enable');
  await req('Page.enable');

  console.log('[title]', await evalJs('document.title'));
  console.log('[api-exists]', await evalJs('typeof window.api'));
  console.log('[body]', await evalJs("document.body.getAttribute('data-accent') + ' / ' + document.body.getAttribute('data-mode')"));
  console.log('[brand]', await evalJs("document.querySelector('.brand-name')?.innerText"));

  const cfg = await evalJs('window.api.configGetAll()');
  const keys = Object.keys(cfg || {});
  console.log('[config-keys]', keys.length, 'keys');
  console.log('[config-gameDir]', cfg?.gameDir);
  console.log('[config-ui]', JSON.stringify(cfg?.ui));
  console.log('[config-theme]', cfg?.theme, '/', cfg?.accent);

  // 配置写入回环：写测试键 → 读回 → 删除（save 会真实落盘，验证与 Electron 版共用同一文件）
  await evalJs("window.api.configSet('__tauriSmoke', { t: 42 })");
  const back = await evalJs('window.api.configGetAll()');
  console.log('[write-roundtrip]', JSON.stringify(back?.__tauriSmoke));

  const filePath = path.join(process.env.APPDATA, 'cm-minecraft-launcher', 'config.json');
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log('[on-disk]', JSON.stringify(onDisk.__tauriSmoke), '| total keys:', Object.keys(onDisk).length);
  // 清理测试键并恢复
  delete onDisk.__tauriSmoke;
  fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2));
  await evalJs("window.api.configSet('__tauriSmoke', null)").catch(() => {});

  // 日志通道
  const logs = await evalJs('window.api.logHistory()');
  console.log('[logs]', Array.isArray(logs) ? `${logs.length} entries, last: ${logs[logs.length - 1]?.message}` : logs);

  // 截图
  const ss = await req('Page.captureScreenshot');
  if (ss.result?.data) {
    const out = path.join(__dirname, '..', 'tauri', 'smoke-screenshot.png');
    fs.writeFileSync(out, Buffer.from(ss.result.data, 'base64'));
    console.log('[screenshot]', out);
  }
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('[fail]', e.message);
  process.exit(1);
});
