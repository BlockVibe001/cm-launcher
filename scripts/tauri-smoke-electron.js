/* Electron 侧 CDP 回读验证：确认 Tauri 写过的 config.json 被 Electron 版原样读回 */
const http = require('http');

const PORT = Number(process.argv[2] || 9223);

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
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('no index.html target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const req = (method, params = {}) => new Promise((res) => {
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

  console.log('[api-type]', await evalJs('typeof window.api'));
  const cfg = await evalJs('window.api.configGetAll()');
  console.log('[gameDir]', cfg?.gameDir);
  console.log('[theme/accent]', cfg?.theme, '/', cfg?.accent);
  console.log('[ui]', JSON.stringify(cfg?.ui));
  console.log('[accounts]', (cfg?.accounts || []).length, 'account:', cfg?.account?.username || '(none)');
  console.log('[no-smoke-key]', !('__tauriSmoke' in (cfg || {})));
  const errs = await evalJs('window.__errs || 0');
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('[fail]', e.message); process.exit(1); });
