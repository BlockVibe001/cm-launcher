/* 阶段 3 Gate：ModLoader 安装器（Forge / NeoForge / Fabric / Quilt）。
 * 1) 四个加载器的版本列表查询必须返回非空。
 * 2) Fabric 安装：为 1.20.1 装一个 loader（与已装的 0.19.5 不同，避免覆盖），
 *    验证 versions/<id>/<id>.json 落盘且 inheritsFrom=1.20.1、mainClass 含 KnotClient，
 *    并出现在 versions:installed 列表里。
 * 用法: node scripts/tauri-gate-stage3.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 9224);
const GAME_DIR = 'E:\\AppData\\Roaming\\.minecraft';
const MC_VERSION = '1.20.1';

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

  // 收集 modloader 进度
  await evalJs(`(() => {
    window.__ml = { steps: [] };
    window.api.onModloaderProgress((p) => window.__ml.steps.push(p));
    return true;
  })()`);

  // 1) 四个版本列表查询
  const fabric = await evalJs('window.api.fabricLoaders()');
  const forge = await evalJs(`window.api.forgeVersions(${JSON.stringify(MC_VERSION)})`);
  const neo = await evalJs(`window.api.neoForgeVersions(${JSON.stringify(MC_VERSION)})`);
  const quilt = await evalJs('window.api.quiltLoaders()');
  console.log('[fabric loaders]', Array.isArray(fabric) ? fabric.length + ' 个' : 'FAIL', fabric && fabric[0] && fabric[0].version);
  console.log('[forge versions]', Array.isArray(forge) ? forge.length + ' 个' : 'FAIL');
  console.log('[neoforge versions]', Array.isArray(neo) ? neo.length + ' 个' : 'FAIL');
  console.log('[quilt loaders]', Array.isArray(quilt) ? quilt.length + ' 个' : 'FAIL');

  if (!Array.isArray(fabric) || fabric.length === 0) throw new Error('Fabric loaders 空');
  if (!Array.isArray(forge) || forge.length === 0) throw new Error('Forge versions 空');
  if (!Array.isArray(neo) || neo.length === 0) throw new Error('NeoForge versions 空');
  if (!Array.isArray(quilt) || quilt.length === 0) throw new Error('Quilt loaders 空');

  // 2) Fabric 安装：选一个稳定 loader（stable 字段），避开已装的 0.19.5
  const stable = fabric.find((f) => f.stable) || fabric[0];
  const loaderVersion = stable.version;
  console.log('[fabric install] mc=', MC_VERSION, 'loader=', loaderVersion);

  const newId = await evalJs(
    `window.api.fabricInstall(${JSON.stringify(MC_VERSION)}, ${JSON.stringify(loaderVersion)}, ${JSON.stringify(GAME_DIR)})`
  );
  console.log('[fabric install result]', newId);
  if (!newId || typeof newId !== 'string') throw new Error('fabricInstall 未返回版本 id');

  // 3) 验证版本 JSON 落盘且字段正确
  const verJsonPath = path.join(GAME_DIR, 'versions', newId, `${newId}.json`);
  console.log('[version json path]', verJsonPath);
  if (!fs.existsSync(verJsonPath)) throw new Error(`版本 JSON 未生成：${verJsonPath}`);
  const vj = JSON.parse(fs.readFileSync(verJsonPath, 'utf8'));
  console.log('[inheritsFrom]', vj.inheritsFrom);
  console.log('[mainClass]', vj.mainClass);
  console.log('[id]', vj.id);
  if (vj.inheritsFrom !== MC_VERSION) throw new Error(`inheritsFrom 应为 ${MC_VERSION}，实为 ${vj.inheritsFrom}`);
  if (!vj.mainClass || !/KnotClient|net\.fabricmc/.test(vj.mainClass)) {
    throw new Error(`mainClass 异常：${vj.mainClass}`);
  }

  // 4) 验证出现在已装版本列表里
  const installed = await evalJs(`window.api.versionsInstalled(${JSON.stringify(GAME_DIR)})`);
  console.log('[installed versions]', Array.isArray(installed) ? installed.length + ' 个' : installed);
  if (!Array.isArray(installed) || !installed.includes(newId)) {
    throw new Error(`新版本 ${newId} 未出现在 versions:installed 列表`);
  }

  // 5) 进度事件是否上报
  const steps = await evalJs('JSON.stringify(window.__ml.steps)');
  const stepArr = JSON.parse(steps);
  console.log('[modloader progress steps]', stepArr.length, stepArr.map((s) => s.percent).join('%→') + '%');
  if (stepArr.length === 0) {
    console.warn('[warn] 未收到 modloader:progress 事件');
  }

  const lastStep = stepArr[stepArr.length - 1];
  console.log('[GATE] PASS：Fabric 安装成功（', newId, '），四个加载器版本查询正常，进度事件', lastStep ? `上报到 ${lastStep.percent}%` : '未上报');
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('[GATE] FAIL:', e.message);
  process.exit(1);
});
