// 冒烟测试：启动 + 多页面截图
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { app, BrowserWindow } = require('electron');
const { TAG, writeNbt } = require('./src/main/minecraft/nbt');
const schematic = require('./src/main/minecraft/schematic');
const { createZip } = require('./src/main/util/zip');
const dnd = require('./src/main/minecraft/dnd');
const instancesMod = require('./src/main/minecraft/instances');
const downloads = require('./src/main/system/downloads');
const serverping = require('./src/main/minecraft/serverping');
const config = require('./src/main/config');
const javaMod = require('./src/main/minecraft/java');
const migrateMod = require('./src/main/minecraft/migrate');
const lanMod = require('./src/main/minecraft/lan');
const terracotta = require('./src/main/minecraft/terracotta');
const easytier = require('./src/main/minecraft/easytier');
const browserMod = require('./src/main/system/browser');
const launchMod = require('./src/main/minecraft/launch');
const translator = require('./src/main/minecraft/translate');
const { extractZip } = require('./src/main/util/zipread');
const glassMotion = require('./src/renderer/glass-motion');
const memoryMod = require('./src/main/system/memory');
const net = require('net');
const http = require('http');

// 构造一个临时存档用于测试存档编辑器
function makeTestWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-smoke-world-'));
  const data = {
    t: TAG.COMPOUND,
    v: {
      LevelName: { t: TAG.STRING, v: '冒烟测试世界' },
      GameType: { t: TAG.INT, v: 0 },
      Difficulty: { t: TAG.BYTE, v: 1 },
      allowCommands: { t: TAG.BYTE, v: 0 },
      hardcore: { t: TAG.BYTE, v: 0 },
      RandomSeed: { t: TAG.LONG, v: 8848n },
      DataVersion: { t: TAG.INT, v: 3465 },
      GameRules: { t: TAG.COMPOUND, v: { keepInventory: { t: TAG.STRING, v: 'false' }, randomTickSpeed: { t: TAG.STRING, v: '3' } } },
      Version: { t: TAG.COMPOUND, v: { Name: { t: TAG.STRING, v: '1.20.1' }, Id: { t: TAG.INT, v: 3465 } } },
    },
  };
  fs.writeFileSync(path.join(dir, 'level.dat'), zlib.gzipSync(writeNbt({ t: TAG.COMPOUND, v: { Data: data } })));
  return dir;
}

// 构造一个临时 Sponge .schem 用于测试投影工坊
function makeTestSchem() {
  const W = 9; const H = 4; const L = 9;
  const palette = ['minecraft:air', 'minecraft:stone', 'minecraft:oak_planks', 'minecraft:glass', 'minecraft:gold_block'];
  const blocks = new Int32Array(W * H * L);
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        let pi = 0;
        if (y === 0) pi = 1;                          // 地板
        else if ((x === 0 || x === W - 1 || z === 0 || z === L - 1)) pi = 2; // 墙
        if (y === H - 1 && x > 2 && x < 6 && z > 2 && z < 6) pi = 3;         // 玻璃顶
        if (x === 4 && z === 4 && y === 1) pi = 4;    // 中央金块
        blocks[(y * L + z) * W + x] = pi;
      }
    }
  }
  const out = path.join(os.tmpdir(), `cm-smoke-${Date.now()}.schem`);
  schematic.exportSponge({ size: { x: W, y: H, z: L }, palette, blocks }, out);
  return out;
}

// 构造拖拽识别用的测试文件（模组 / 资源包 / 光影 / 数据包 / 世界 / 整合包）
function makeDndFixtures() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-smoke-dnd-'));
  const gameDir = path.join(base, 'game');
  fs.mkdirSync(path.join(gameDir, 'saves', '已有世界'), { recursive: true });

  const zip = (name, entries) => {
    const out = path.join(base, name);
    createZip(out, entries.map(([n, d]) => ({ name: n, data: Buffer.from(d) })));
    return out;
  };

  const mod = zip('测试模组.jar', [['fabric.mod.json', '{"id":"testmod","version":"1.0.0"}']]);
  const rp = zip('测试资源包.zip', [['pack.mcmeta', '{"pack":{"pack_format":15}}'], ['assets/minecraft/x.json', '{}']]);
  const sp = zip('测试光影.zip', [['shaders/gbuffers_terrain.fsh', 'void main(){}'], ['shaders/shadow.vsh', 'void main(){}']]);
  const dp = zip('测试数据包.zip', [['pack.mcmeta', '{"pack":{"pack_format":15}}'], ['data/test/functions/a.mcfunction', 'say hi']]);
  const world = zip('测试世界.zip', [['MyWorld/level.dat', 'dummy'], ['MyWorld/region/r.0.0.mca', 'x']]);
  const mrpack = zip('测试整合包.mrpack', [[
    'modrinth.index.json',
    JSON.stringify({
      formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: 'SmokePack',
      files: [], dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
    }),
  ]]);

  return { base, gameDir, mod, rp, sp, dp, world, mrpack, all: [mod, rp, sp, dp, world, mrpack] };
}

// 生成一张合法的 64x32 PNG 皮肤，用于皮肤系统测试
function makeSkinPng(w = 64, h = 32, rgb = [60, 200, 120]) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 4;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 本地 HTTP 文件服务（供下载队列测试，避免依赖外网）
function startLocalHttp(payload) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/latest.json') {
      // 更新清单：版本故意高于当前，用来验证「检查更新」的比对与下载通路
      const body = Buffer.from(JSON.stringify({
        version: '99.0.0',
        notes: '冒烟测试用的更新说明',
        publishedAt: '2026-01-01T00:00:00Z',
        installer: '/blob.bin',
        page: '/download',
      }));
      res.writeHead(200, { 'Content-Length': String(body.length), 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url === '/slow') {
      // 慢速流：用于观察下载中的进度条
      res.writeHead(200, { 'Content-Length': String(payload.length), 'Content-Type': 'application/octet-stream' });
      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= payload.length) { clearInterval(timer); res.end(); return; }
        const chunk = payload.subarray(sent, sent + 4096);
        sent += chunk.length;
        res.write(chunk);
      }, 80);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { 'Content-Length': String(payload.length), 'Content-Type': 'application/octet-stream' });
    res.end(payload);
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}

// 假 MC 服务端：收到任意数据就回一个合法的 SLP 状态包
function startFakeMcServer() {
  const varint = (n) => {
    const out = [];
    let v = n >>> 0;
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
    return Buffer.from(out);
  };
  const srv = net.createServer((sock) => {
    sock.on('error', () => { /* ignore */ });
    sock.on('data', () => {
      const json = JSON.stringify({
        version: { name: '1.21', protocol: 767 },
        players: { online: 7, max: 100, sample: [{ name: 'Steve' }] },
        description: { text: '§a冒烟测试服 §7| 全绿' },
        favicon: '',
      });
      const body = Buffer.concat([Buffer.from([0x00]), varint(Buffer.byteLength(json)), Buffer.from(json)]);
      sock.write(Buffer.concat([varint(body.length), body]));
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (_e2, level, message) => {
    if (level >= 2) console.log(`[L${level}] ${message}`);
  });
});

require('./src/main/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(tag) {
  const win = BrowserWindow.getAllWindows()[0];
  const png = await win.capturePage();
  fs.writeFileSync(`shot-${tag}.png`, png.toPNG());
  console.log('shot', tag);
}

async function run() {
  const win = BrowserWindow.getAllWindows()[0];
  const js = (c) => win.webContents.executeJavaScript(c);

  // 跑测时这个窗口常常被别的程序挡在后面。Chromium 对「不可见 / 被遮挡」的页面
  // 会停掉 requestAnimationFrame、把定时器节流到分钟级，于是凡是靠帧推进的用例
  // （h17 ⑩ 指针交互就等 nextFrame）会永远停在 await 上——不是产品坏了，是页面被节流了。
  // 关掉后台节流，让窗口在后台也照常出帧，跑测结果才跟窗口是否可见无关。
  win.webContents.setBackgroundThrottling(false);

  await sleep(4000);
  await js(`
    window.addEventListener('unhandledrejection', (e) => {
      console.error('[UNHANDLED] ' + ((e.reason && e.reason.stack) || e.reason));
    });
    window.addEventListener('error', (e) => {
      console.error('[ERRSTACK] ' + ((e.error && e.error.stack) || e.message));
    });
  `);
  // 本轮开始时的外观快照。各批次会临时改档位 / 通透度，收尾务必回到这里，
  // 否则会把配置留在半路状态，让下一轮冒烟从错误的前提开始（模糊断言整批翻红）。
  const uiBefore = await js('JSON.stringify(state.config.ui)');
  const focusBefore = await js('document.body.dataset.focus || ""');
  await shot('home');

  // 首页小组件桌面（注入日历测试数据）
  // 显式钉住 widget 模式：上一轮若崩在切模式的步骤上，会把 simple 持久化进配置，
  // 导致这里拿不到只有 widget 模式才渲染的 #home-edit 而整轮挂掉。
  const d0 = new Date();
  const todayKey = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  await js(`
    state.config.homeMode = 'widget';
    state.config.playLog = { '${todayKey}': { total: 3, instances: { default: { name: '默认', count: 3 } } } };
    state.config.pinned = { instances: ['default'], servers: [], worlds: [] };
    renderPage('home');
  `);
  await sleep(2000);
  await shot('home-widget');
  await js(`document.querySelector('#home-edit').click()`);
  await sleep(1200);
  await shot('home-edit');
  await js(`document.querySelector('#home-edit').click()`);
  await sleep(700);
  await js(`document.querySelector('[data-home-mode="simple"]').click()`);
  await sleep(1200);
  await shot('home-simple');
  await js(`document.querySelector('[data-home-mode="widget"]').click()`);
  await sleep(900);

  const pages = ['instances', 'versions', 'center', 'account', 'settings'];
  for (const p of pages) {
    await js(`document.querySelector('.nav-item[data-page="${p}"]').click()`);
    await sleep(900);
    await shot(p);
  }

  // 回到实例管理页，再进实例详情各标签
  await js(`document.querySelector('.nav-item[data-page="instances"]').click()`);
  await sleep(900);
  await js(`
    (() => {
      const card = document.querySelector('.inst-card [data-act="detail"]');
      if (card) card.click();
    })()
  `);
  await sleep(1200);
  await shot('instance-mods');
  for (const t of ['resourcepacks', 'shaders', 'saves', 'screenshots', 'logs', 'settings']) {
    await js(`(() => { const b = document.querySelector('.tab[data-tab="${t}"]'); if (b) b.click(); })()`);
    await sleep(1000);
    await shot(`instance-${t}`);
  }

  // 存档编辑器（注入临时存档）
  const tmpWorld = makeTestWorld();
  await js(`
    state.worldSave = { path: ${JSON.stringify(tmpWorld)}, hasLevel: true, name: 'smoke', meta: {} };
    state.worldReturnTo = 'instances';
    renderPage('world');
  `);
  await sleep(1500);
  await shot('world-edit');
  await js(`document.querySelector('.page').scrollTo(0, 620)`);
  await sleep(500);
  await shot('world-rules');

  // Axolotl 实验室：逐个工具截图
  await js(`document.querySelector('.nav-item[data-page="lab"]').click()`);
  await sleep(900);
  for (const t of ['gradient', 'seed', 'schematic', 'recipe', 'translate']) {
    await js(`(() => { const b = document.querySelector('#lab-bar .cat-tab[data-lab="${t}"]'); if (b) b.click(); })()`);
    await sleep(900);
    await shot(`lab-${t}`);
  }

  // 投影工坊：加载临时 .schem 并渲染逐层 / 3D / 材料
  const tmpSchem = makeTestSchem();
  await js(`
    (async () => {
      const r = await api.labSchematicOpen(${JSON.stringify(tmpSchem)});
      schState = r;
      schView = { mode: 'layer', y: Math.floor(r.size.y / 2), rot: 0, spacing: 12 };
      document.querySelector('#lab-bar .cat-tab[data-lab="schematic"]').click();
    })()
  `);
  await sleep(1400);
  await shot('lab-schematic-layer');
  for (const m of ['iso', 'mat']) {
    await js(`(() => { const b = document.querySelector('[data-sv="${m}"]'); if (b) b.click(); })()`);
    await sleep(900);
    await shot(`lab-schematic-${m}`);
  }

  // 回到模组中心，各分类截图
  await js(`document.querySelector('.nav-item[data-page="center"]').click()`);
  await sleep(900);
  const cats = ['modpack', 'shader', 'resourcepack', 'datapack', 'world'];
  for (const c of cats) {
    // 分类走网络（CurseForge 403 时某些分类可能整块不渲染），点不到就跳过并记下来，
    // 别让 null.click() 把整轮冒烟打断 —— 后面的批次都还没跑。
    const ok = await js(`(() => {
      const t = document.querySelector('#cat-bar .cat-tab[data-cat="${c}"]');
      if (!t) return false;
      t.click();
      return true;
    })()`);
    if (!ok) {
      const have = await js(`JSON.stringify([...document.querySelectorAll('#cat-bar .cat-tab')].map((x) => x.dataset.cat))`);
      console.log(`center 分类缺失 ${c}（当前分类栏：${have}）`);
    }
    await sleep(3500);
    await shot(`center-${c}`);
  }

  /* ---------- 拖拽智能识别 ---------- */
  const fx = makeDndFixtures();

  // ① 分类断言（直接跑主进程逻辑）
  const expectKinds = {
    [fx.mod]: 'mod',
    [fx.rp]: 'resourcepack',
    [fx.sp]: 'shaderpack',
    [fx.dp]: 'datapack',
    [fx.world]: 'world',
    [fx.mrpack]: 'modpack',
    [tmpSchem]: 'schematic',
  };
  const classified = dnd.inspect([...fx.all, tmpSchem]);
  let kindBad = 0;
  for (const c of classified) {
    const want = expectKinds[c.path];
    const ok = c.kind === want;
    if (!ok) kindBad++;
    console.log(`dnd classify ${ok ? 'OK ' : 'BAD'} ${c.name} → ${c.kind}（期望 ${want}）`);
  }

  // ② 拖拽遮罩
  await js(`document.querySelector('#drop-overlay').hidden = false`);
  await sleep(500);
  await shot('import-drop');
  await js(`document.querySelector('#drop-overlay').hidden = true`);

  // ③ 导入确认弹窗
  await js(`openImportDialog(${JSON.stringify(fx.all)})`);
  await sleep(1800);
  await shot('import-dialog');
  await js(`document.querySelector('.modal-mask').remove()`);
  await sleep(300);

  // ④ 真实导入 + 结果弹窗
  const items = fx.all.map((p) => ({ path: p, kind: dnd.classify(p).kind }));
  const imp = await js(`
    (async () => {
      const res = await api.dndImport(${JSON.stringify(items)}, {
        gameDir: ${JSON.stringify(fx.gameDir)},
        gameRoot: ${JSON.stringify(fx.gameDir)},
      });
      showImportResult(res);
      return res;
    })()
  `);
  await sleep(1200);
  await shot('import-result');

  // ⑤ 数据包导入到指定世界
  const dpRes = await js(`api.dndImport(
    [{ path: ${JSON.stringify(fx.dp)}, kind: 'datapack' }],
    { gameDir: ${JSON.stringify(fx.gameDir)}, worldDir: ${JSON.stringify(path.join(fx.gameDir, 'saves', '已有世界'))} }
  )`);

  // ⑥ 磁盘校验
  const checks = [
    [path.join(fx.gameDir, 'mods', '测试模组.jar'), 'mod'],
    [path.join(fx.gameDir, 'resourcepacks', '测试资源包.zip'), 'resourcepack'],
    [path.join(fx.gameDir, 'shaderpacks', '测试光影.zip'), 'shaderpack'],
    [path.join(fx.gameDir, 'saves', 'MyWorld', 'level.dat'), 'world/level.dat'],
    [path.join(fx.gameDir, 'instances', 'SmokePack'), 'mrpack 实例目录'],
    [path.join(fx.gameDir, 'saves', '已有世界', 'datapacks', '测试数据包.zip'), 'datapack'],
  ];
  let diskBad = 0;
  for (const [p, label] of checks) {
    const ok = fs.existsSync(p);
    if (!ok) diskBad++;
    console.log(`dnd disk   ${ok ? 'OK ' : 'BAD'} ${label} → ${p}`);
  }
  console.log(`dnd 汇总：分类错误 ${kindBad} · 落盘错误 ${diskBad} · 导入成功 ${imp.ok} / 失败 ${imp.failed} · 数据包 ${dpRes.ok}`);

  // 清理测试期间写入真实配置的实例
  for (const ni of imp.newInstances || []) {
    try { instancesMod.deleteInstance(ni.id); } catch { /* ignore */ }
  }

  // ---- 批次 F 皮肤系统 ----
  let skinBad = 0;
  const skinFile = path.join(fx.base, '测试皮肤.png');
  fs.writeFileSync(skinFile, makeSkinPng());

  // ① 读取本地皮肤（校验 + 预览 dataURL）
  const rd = await js(`api.skinReadLocal(${JSON.stringify(skinFile)})`);
  const rdOk = !!(rd && rd.dim && rd.dim.w === 64 && rd.dim.h === 32 && rd.dataUrl);
  if (!rdOk) skinBad++;
  console.log(`skin readLocal ${rdOk ? 'OK ' : 'BAD'} ${rd.dim ? rd.dim.w + 'x' + rd.dim.h : '—'}`);

  // ② 注入一张皮肤到本地库，渲染皮肤中心
  const skinsDir = path.join(app.getPath('userData'), 'skins');
  fs.mkdirSync(skinsDir, { recursive: true });
  fs.copyFileSync(skinFile, path.join(skinsDir, 'smoke-skin.png'));

  await js(`document.querySelectorAll('.modal-mask').forEach((n) => n.remove()); renderPage('skins')`);
  await sleep(1400);
  const libCells = await js(`document.querySelectorAll('#skin-local .skin-cell').length`);
  const hasPanels = await js(`!!document.getElementById('skin-pick') && !!document.getElementById('skin-fetch') && !!document.getElementById('skin-station')`);
  if (!hasPanels || libCells < 1) skinBad++;
  console.log(`skin 渲染 ${hasPanels ? 'OK ' : 'BAD'} 面板 · 本地库 ${libCells} 项`);
  await shot('skins');

  // ②.5 头像 / 全身：应当是 canvas，并由「我们的皮肤」纹理本地渲染出来
  let sk = { head: false, body: false, tip: '' };
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    sk = JSON.parse(await js(`JSON.stringify((function () {
      var h = document.getElementById('skin-head'), b = document.getElementById('skin-body'), s = document.getElementById('skin-src');
      return {
        head: !!h && h.tagName === 'CANVAS',
        body: !!b && b.tagName === 'CANVAS',
        tip: s ? s.textContent.trim() : ''
      };
    })())`));
    if (sk.head && sk.body && sk.tip && sk.tip !== '正在读取当前皮肤…') break;
  }
  const wired = await js(`typeof api.skinCurrent === 'function' && !!document.getElementById('skin-src-reset')`);
  const canvasOk = sk.head && sk.body && !!sk.tip && sk.tip !== '正在读取当前皮肤…' && wired;
  if (!canvasOk) skinBad++;
  console.log(`skin 头像/全身画布 ${canvasOk ? 'OK ' : 'BAD'} 头像=${sk.head} 全身=${sk.body} 来源="${sk.tip}"`);

  // ②.6 真·用我们的皮肤：本地渲染已知颜色的皮肤，再换一张验证是实时重画
  const tex = await js(`(async () => (await api.skinReadLocal(${JSON.stringify(skinFile)})).dataUrl)()`);
  const pxA = JSON.parse(await js(`(async () => {
    await paintSkinFrom(${JSON.stringify(tex)}, 'classic');
    const g = (c, x, y) => { try { return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data).join(','); } catch (e) { return 'TAINTED'; } };
    return JSON.stringify({
      head: g(document.getElementById('skin-head'), 0, 0),
      bodyHead: g(document.getElementById('skin-body'), 48, 24),
      bodyGap: g(document.getElementById('skin-body'), 2, 2)
    });
  })()`));
  const redSkin = path.join(fx.base, '红皮肤.png');
  fs.writeFileSync(redSkin, makeSkinPng(64, 32, [220, 60, 60]));
  const tex2 = await js(`(async () => (await api.skinReadLocal(${JSON.stringify(redSkin)})).dataUrl)()`);
  const pxRed = await js(`(async () => {
    await paintSkinFrom(${JSON.stringify(tex2)}, 'classic');
    var c = document.getElementById('skin-head');
    try { return Array.from(c.getContext('2d').getImageData(0, 0, 1, 1).data).join(','); } catch (e) { return 'TAINTED'; }
  })()`);
  const paintOk = pxA.head === '60,200,120,255' && pxA.bodyHead === '60,200,120,255'
    && pxA.bodyGap === '0,0,0,0' && pxRed === '220,60,60,255';
  if (!paintOk) skinBad++;
  console.log(`skin 本地渲染 ${paintOk ? 'OK ' : 'BAD'} 头像=${pxA.head} 全身=${pxA.bodyHead} 空处=${pxA.bodyGap} 换图后=${pxRed}`);

  // ③ 非法尺寸应被拒绝
  const badPng = path.join(fx.base, '坏皮肤.png');
  fs.writeFileSync(badPng, makeSkinPng(32, 32));
  let guarded = false;
  try { await js(`api.skinReadLocal(${JSON.stringify(badPng)})`); } catch { guarded = true; }
  if (!guarded) skinBad++;
  console.log(`skin 尺寸校验 ${guarded ? 'OK ' : 'BAD'}`);

  // ④ 最近使用 + 切账号皮肤跟随
  const beforeCfg = await js(`api.configGetAll()`);
  const beforeUuid = beforeCfg.account ? beforeCfg.account.uuid : '';
  const fakeMsUuid = '0600a000000000000000000000000001';

  // 离线账号使用皮肤 → 绑定并进入最近使用
  await js(`(async () => { state.account = await api.authOffline('SmokeSkin') })()`);
  await js(`(async () => { await api.skinUse(${JSON.stringify(skinFile)}) })()`);
  const hist = await js(`api.skinHistory()`);
  const histOk = hist.length >= 1 && hist[0].path === skinFile;
  const curOff = await js(`api.skinCurrent()`);
  const offOk = !!(curOff && curOff.source === 'local');

  // 切到正版：皮肤只能来自服务器，绝不能被离线那张本地皮肤顶替
  await js(`api.configSet('account', { type:'microsoft', uuid:${JSON.stringify(fakeMsUuid)}, username:'FakeMS', accessToken:'x', skinPath:${JSON.stringify(skinFile)} })`);
  const curMs = await js(`api.skinCurrent()`);
  const msOk = !(curMs && curMs.source === 'local');

  // 再回离线：之前绑定的皮肤还在
  await js(`(async () => { state.account = await api.authOffline('SmokeSkin') })()`);
  const curBack = await js(`api.skinCurrent()`);
  const backOk = !!(curBack && curBack.source === 'local');

  // 界面：最近使用面板要渲染出刚用过的皮肤
  await js(`renderPage('skins')`);
  await sleep(1500);
  const histCells = await js(`document.querySelectorAll('#skin-hist .skin-cell').length`);
  const histUiOk = histCells >= 1;

  const followOk = histOk && offOk && msOk && backOk && histUiOk;
  if (!followOk) skinBad++;
  console.log(`skin 最近使用/账号跟随 ${followOk ? 'OK ' : 'BAD'} 历史=${histOk} 离线=${offOk} 正版不被顶替=${msOk} 切回离线=${backOk} 历史面板=${histCells}项`);

  // 清理测试账号，恢复测试前的登录态
  const smokeAcc = await js(`(async () => api.authOffline('SmokeSkin'))()`);
  await js(`api.authRemove(${JSON.stringify(smokeAcc.uuid)})`);
  await js(`api.authRemove(${JSON.stringify(fakeMsUuid)})`);
  if (beforeUuid) {
    try { await js(`api.authSwitch(${JSON.stringify(beforeUuid)})`); } catch { /* ignore */ }
  } else {
    await js(`api.configSet('account', null)`);
  }

  console.log(`skin 汇总：错误 ${skinBad}`);

  try { fs.unlinkSync(path.join(skinsDir, 'smoke-skin.png')); } catch { /* ignore */ }

  // ---- 批次 G 下载队列 / 运行日志 / 服务器状态 ----
  let gBad = 0;

  // ① 本地 HTTP 下载：入队 → 完成 → 校验落盘
  const payload = Buffer.alloc(200 * 1024, 7);
  const { srv: httpSrv, port: httpPort } = await startLocalHttp(payload);
  const dest = path.join(fx.base, 'downloaded.bin');
  const dlId = downloads.enqueue({
    url: `http://127.0.0.1:${httpPort}/blob.bin`,
    name: '冒烟测试文件.bin', kind: 'file', dest,
  });
  let task = null;
  for (let i = 0; i < 80; i++) {
    await sleep(120);
    task = downloads.list().find((t) => t.id === dlId);
    if (task && task.finishedAt) break;
  }
  const dlOk = !!(task && task.status === 'done' && fs.existsSync(dest) && fs.statSync(dest).size === payload.length);
  if (!dlOk) gBad++;
  console.log(`dl 队列 ${dlOk ? 'OK ' : 'BAD'} status=${task && task.status} 落盘=${fs.existsSync(dest) ? fs.statSync(dest).size : -1}/${payload.length}`);

  // ② track 包装（搜索页下载走的通道）
  await downloads.track('追踪测试', 'mod', async () => { await sleep(50); return 1; });
  const tracked = downloads.list().find((t) => t.name === '追踪测试');
  const trackOk = !!(tracked && tracked.status === 'done' && tracked.percent === 100);
  if (!trackOk) gBad++;
  console.log(`dl track ${trackOk ? 'OK ' : 'BAD'}`);

  // ③ 移除 / 清理
  downloads.remove(dlId);
  const removed = !downloads.list().some((t) => t.id === dlId);
  downloads.clearFinished();
  const cleared = downloads.list().length === 0;
  if (!removed || !cleared) gBad++;
  console.log(`dl 移除/清理 ${removed && cleared ? 'OK ' : 'BAD'} removed=${removed} cleared=${cleared}`);

  // ④ 服务器 Ping（假服务端）
  const { srv: mcSrv, port: mcPort } = await startFakeMcServer();
  const pr = await serverping.ping(`127.0.0.1:${mcPort}`);
  const pingOk = !!(pr.online && pr.players.online === 7 && pr.players.max === 100
    && pr.motd.includes('冒烟测试服') && !pr.motd.includes('§') && pr.version === '1.21');
  if (!pingOk) gBad++;
  console.log(`ping ${pingOk ? 'OK ' : 'BAD'} motd="${pr.motd}" 人数=${pr.players && pr.players.online}/${pr.players && pr.players.max} 版本=${pr.version} 延迟=${pr.latency}ms`);

  // ⑤ 渲染下载页 / 日志页（先挂一个慢速任务，便于看进度条）
  const slowId = downloads.enqueue({
    url: `http://127.0.0.1:${httpPort}/slow`, name: '慢速下载示例.bin', kind: 'mod',
    dest: path.join(fx.base, 'slow.bin'),
  });
  await sleep(600);
  await js(`renderPage('downloads')`);
  await sleep(900);
  const dlRows = await js(`document.querySelectorAll('#dl-list .dl-row').length`);
  if (dlRows < 1) gBad++;
  await shot('downloads');

  await js(`document.querySelectorAll('[data-dl]').forEach((b) => { if (b.dataset.dl === 'log') b.click(); })`);
  await sleep(800);
  const logCount = await js(`document.querySelectorAll('#log-stream .log-line').length`);
  if (logCount < 1) gBad++;
  await shot('downloads-log');
  console.log(`g 页面 队列行=${dlRows}（空队列为 0 正常）· 日志行=${logCount}`);

  // ⑥ 联机大厅：注入假服务器并截图
  await js(`state.config.servers = ${JSON.stringify([{ name: '冒烟测试服', address: `127.0.0.1:${mcPort}` }])}; renderPage('servers')`);
  await sleep(1800);
  const svCards = await js(`document.querySelectorAll('.sv-card').length`);
  const svOnline = await js(`document.querySelectorAll('.sv-card.online').length`);
  const svMotd = await js(`(document.querySelector('.sv-motd') || {}).textContent || ''`);
  if (svCards < 1 || svOnline < 1 || !svMotd.includes('冒烟测试服')) gBad++;
  await shot('servers');
  console.log(`g 联机大厅 卡片=${svCards} 在线=${svOnline} MOTD="${svMotd.trim()}"`);

  // ⑦ 截图查看器
  const shotDir = path.join(fx.gameDir, 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(shotDir, '2026-09-30_01.png'), makeSkinPng());
  fs.writeFileSync(path.join(shotDir, '2026-09-30_02.png'), makeSkinPng(64, 64));
  await js(`
    (async () => {
      const items = await api.contentScreenshots(${JSON.stringify(fx.gameDir)});
      openShotViewer(items, 0, ${JSON.stringify(fx.gameDir)});
      return items.length;
    })()
  `);
  await sleep(700);
  const shotOpen = await js(`!!document.getElementById('svv-img') && !!document.getElementById('svv-img').src`);
  if (!shotOpen) gBad++;
  await shot('shot-viewer');
  console.log(`g 截图查看器 ${shotOpen ? 'OK ' : 'BAD'}`);

  downloads.cancel(slowId);

  console.log(`g 汇总：错误 ${gBad}`);

  // ---- 批次 H-1：Java 管理（版本匹配 / 解压 / 托管目录 / 设置页） ----
  let hBad = 0;

  // ① 版本 → 所需 Java 对照表
  const jcases = [
    ['1.20.6', 21], ['1.20.5', 21], ['1.20.4', 17], ['1.20.1', 17],
    ['1.19.4', 17], ['1.17.1', 17], ['1.16.5', 8], ['1.12.2', 8],
    ['1.21', 21], ['24w14a', 21],
  ];
  for (const [v, want] of jcases) {
    const got = javaMod.requiredJava(v).major;
    const ok = got === want;
    if (!ok) hBad++;
    console.log(`java need ${ok ? 'OK ' : 'BAD'} ${v} → Java ${got}（期望 ${want}）`);
  }

  // ② 自动匹配：精确优先，其次最接近的更高版本
  const pool = [{ major: 8, path: 'j8' }, { major: 17, path: 'j17' }, { major: 21, path: 'j21' }];
  for (const [v, want] of [['1.16.5', 8], ['1.20.1', 17], ['1.20.6', 21]]) {
    const p = javaMod.pickFor(v, pool);
    const ok = p && p.major === want;
    if (!ok) hBad++;
    console.log(`java match ${ok ? 'OK ' : 'BAD'} ${v} → Java ${p && p.major}（期望 ${want}）`);
  }
  const fallback = javaMod.pickFor('1.20.1', [{ major: 21, path: 'j21' }]);
  const fbOk = fallback && fallback.major === 21;
  const none = javaMod.pickFor('1.20.1', []);
  if (!fbOk || none !== null) hBad++;
  console.log(`java 兜底 ${fbOk && none === null ? 'OK ' : 'BAD'} 仅有高版本→Java ${fallback && fallback.major} · 空列表→${none}`);

  // ③ zip 解压（模拟 Adoptium 安装包结构）
  const zipSrc = path.join(fx.base, 'jre-test.zip');
  const jExeName = process.platform === 'win32' ? 'java.exe' : 'java';
  createZip(zipSrc, [
    { name: `jdk-17.0.11+9-jre/bin/${jExeName}`, data: Buffer.from('fake') },
    { name: 'jdk-17.0.11+9-jre/lib/modules', data: Buffer.from('lib') },
  ]);
  const zipOut = path.join(fx.base, 'jre-out');
  extractZip(zipSrc, zipOut);
  const exeOk = fs.existsSync(path.join(zipOut, 'jdk-17.0.11+9-jre', 'bin', jExeName));
  const libOk = fs.existsSync(path.join(zipOut, 'jdk-17.0.11+9-jre', 'lib', 'modules'));
  if (!exeOk || !libOk) hBad++;
  console.log(`java 解压 ${exeOk && libOk ? 'OK ' : 'BAD'} exe=${exeOk} lib=${libOk}`);

  // ④ 托管目录扫描与卸载
  const jhome = javaMod.javaHome();
  const fakeBin = path.join(jhome, 'jre-17', 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, process.platform === 'win32' ? 'java.exe' : 'java'), '');
  const listed = javaMod.listInstalled();
  const listOk = listed.some((x) => x.major === 17);
  javaMod.uninstall(17);
  const goneOk = !fs.existsSync(path.join(jhome, 'jre-17'));
  if (!listOk || !goneOk) hBad++;
  console.log(`java 托管 ${listOk && goneOk ? 'OK ' : 'BAD'} 识别=${listOk} 卸载=${goneOk}`);

  // ⑤ 设置页 Java 面板渲染
  await js(`
    state.config.instances.default.versionId = '1.20.1';
    state.selectedInstance = 'default';
    document.querySelectorAll('.modal-mask').forEach((n) => n.remove());
    renderPage('settings');
  `);
  let jItems = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    jItems = await js(`document.querySelectorAll('#java-panel .java-dl-item').length`);
    if (jItems >= 3) break;
  }
  const jMatch = await js(`(document.querySelector('.java-match') || {}).textContent || ''`);
  const panelOk = jItems >= 3 && jMatch.includes('Java 17');
  if (!panelOk) hBad++;
  await shot('settings-java');
  console.log(`java 面板 ${panelOk ? 'OK ' : 'BAD'} 条目=${jItems} 匹配="${jMatch.replace(/\s+/g, ' ').trim()}"`);

  console.log(`h 汇总：错误 ${hBad}`);

  // ---- 批次 H-2：从 PCL2 / HMCL 搬家 ----
  let h2Bad = 0;
  const appData = app.getPath('appData');
  const pclData = path.join(appData, 'PCL');
  const pclMc = path.join(pclData, '.minecraft');
  const hmclData = path.join(appData, 'HMCL');
  const hmclMc = path.join(fx.base, 'hmcl-mc');

  const mkVersion = (root, id, inherits, isolated) => {
    const vdir = path.join(root, 'versions', id);
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(path.join(vdir, `${id}.json`), JSON.stringify({ id, inheritsFrom: inherits }));
    fs.writeFileSync(path.join(vdir, `${id}.jar`), 'jar');
    if (isolated) {
      fs.mkdirSync(path.join(vdir, '.minecraft', 'mods'), { recursive: true });
      fs.writeFileSync(path.join(vdir, '.minecraft', 'mods', 'a.jar'), 'mod');
    }
  };
  const mkWorld = (root, name) => {
    fs.mkdirSync(path.join(root, 'saves', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'saves', name, 'level.dat'), 'nbt');
  };

  mkVersion(pclMc, '1.20.1-fabric', 'fabric-loader-0.15.0-1.20.1', true);
  mkVersion(pclMc, '1.19.2', '', false);
  mkWorld(pclMc, '我的世界');
  fs.writeFileSync(path.join(pclData, 'Setup.ini'), 'RamSet=6144\n');
  fs.mkdirSync(pclData, { recursive: true });

  mkVersion(hmclMc, '1.16.5-forge', 'forge-36.2.34', false);
  mkWorld(hmclMc, 'HMCL世界');
  fs.mkdirSync(hmclData, { recursive: true });
  fs.writeFileSync(path.join(hmclData, 'hmcl.json'), JSON.stringify({ gameDir: hmclMc, maxMemory: 8192 }));

  const detected = migrateMod.detect();
  const pcl = detected.find((l) => l.id === 'pcl2');
  const hmcl = detected.find((l) => l.id === 'hmcl');
  const detOk = !!(pcl && hmcl
    && pcl.gameDirs.some((g) => g.versions.length >= 2 && g.saves.includes('我的世界'))
    && pcl.settings.maxMemory === 6144
    && hmcl.gameDirs.some((g) => g.versions.some((v) => v.modLoader === 'forge'))
    && hmcl.settings.maxMemory === 8192);
  if (!detOk) h2Bad++;
  console.log(`mig 探测 ${detOk ? 'OK ' : 'BAD'} PCL2=${!!pcl}(${pcl && pcl.gameDirs.length}目录) HMCL=${!!hmcl}(${hmcl && hmcl.gameDirs.length}目录)`);

  // 版本解析细节：整合包类型 / 版本隔离
  const fabVer = pcl && pcl.gameDirs[0].versions.find((v) => v.id === '1.20.1-fabric');
  const isoOk = !!(fabVer && fabVer.modLoader === 'fabric' && fabVer.isolated && fabVer.mods === 1);
  if (!isoOk) h2Bad++;
  console.log(`mig 解析 ${isoOk ? 'OK ' : 'BAD'} fabric 隔离实例 mods=${fabVer && fabVer.mods}`);

  // 引用模式导入 + 存档复制
  const mgTarget = path.join(fx.base, 'mg-target');
  const mgRes = await migrateMod.run({
    mode: 'link',
    gameDir: pclMc,
    versions: ['1.20.1-fabric', '1.19.2'],
    saves: ['我的世界'],
    targetGameDir: mgTarget,
    applySettings: true,
    settings: pcl.settings,
  });
  const instOk = mgRes.instances.length === 2 && mgRes.failed.length === 0;
  const saveOk = fs.existsSync(path.join(mgTarget, 'saves', '我的世界', 'level.dat'));
  const setOk = config.get('maxMemory') === 6144;
  const refOk = mgRes.instances.every((i) => {
    const inst = instancesMod.getInstance(i.id);
    return inst && inst.versionId === i.versionId && inst.gameDir;
  });
  if (!instOk || !saveOk || !setOk || !refOk) h2Bad++;
  console.log(`mig 导入 ${instOk && saveOk && setOk && refOk ? 'OK ' : 'BAD'} 实例=${mgRes.instances.length} 存档=${saveOk} 内存=${config.get('maxMemory')} 引用=${refOk}`);

  // 重复导入应被跳过
  const again = await migrateMod.run({ mode: 'link', gameDir: pclMc, versions: ['1.19.2'], targetGameDir: mgTarget });
  const skipOk = again.skipped.length === 1 && again.instances.length === 0;
  if (!skipOk) h2Bad++;
  console.log(`mig 去重 ${skipOk ? 'OK ' : 'BAD'} skipped=${again.skipped.length}`);

  // 弹窗渲染（用探测结果打开搬家对话框）
  await js(`
    document.querySelectorAll('.modal-mask').forEach((n) => n.remove());
    renderPage('settings');
  `);
  await sleep(600);
  const hasBtn = await js(`!!document.getElementById('btn-migrate-scan')`);
  await js(`openMigrateDialog(${JSON.stringify(detected)})`);
  await sleep(700);
  const migUi = await js(`JSON.stringify({
    launchers: document.querySelectorAll('.mig-launcher').length,
    vers: document.querySelectorAll('.mig-ver').length,
    saves: document.querySelectorAll('.mig-save').length
  })`);
  const u = JSON.parse(migUi);
  const uiOk = hasBtn && u.launchers >= 2 && u.vers >= 3 && u.saves >= 2;
  if (!uiOk) h2Bad++;
  await shot('migrate-dialog');
  console.log(`mig 弹窗 ${uiOk ? 'OK ' : 'BAD'} 启动器=${u.launchers} 版本=${u.vers} 存档=${u.saves}`);
  await js(`document.querySelectorAll('.modal-mask').forEach((n) => n.remove())`);

  // 清理：删除导入的实例与假启动器目录
  for (const i of mgRes.instances) { try { instancesMod.deleteInstance(i.id); } catch { /* ignore */ } }
  config.set('maxMemory', 4096);
  try { fs.rmSync(pclData, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(hmclData, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`h2 汇总：错误 ${h2Bad}`);

  // ---- 批次 H-3：联机助手（局域网开房 / 陶瓦·红石联机） ----
  let h3Bad = 0;

  // ① 本机局域网地址
  const ips = lanMod.localIPs();
  const ipsOk = Array.isArray(ips) && ips.every((i) => i.address && i.name
    && !/^127\./.test(i.address));
  if (!ipsOk) h3Bad++;
  console.log(`lan 本机地址 ${ipsOk ? 'OK ' : 'BAD'} ${ips.length} 个（${ips.map((i) => i.address).join(', ') || '无'}）`);

  // ② 工具探测：三个预置 + 自定义
  const toolSet = lanMod.detect();
  const ids = toolSet.tools.map((t) => t.id);
  const toolsOk = ids.includes('taohua') && ids.includes('redstone')
    && ids.includes('sakura') && ids.includes('custom')
    && toolSet.tools.every((t) => t.name && typeof t.found === 'boolean');
  if (!toolsOk) h3Bad++;
  console.log(`lan 工具探测 ${toolsOk ? 'OK ' : 'BAD'} ${ids.join(' / ')}`);

  // ③ 手动登记自定义工具 → 复检 → 清除
  const fakeTool = path.join(fx.base, 'fake-lan-tool.exe');
  fs.writeFileSync(fakeTool, '');
  lanMod.setPath('custom', fakeTool, '测试联机工具');
  const afterSet = lanMod.detect().tools.find((t) => t.id === 'custom');
  const regOk = !!(afterSet && afterSet.found && afterSet.name === '测试联机工具');
  lanMod.setPath('custom', '');
  const lanCleared = !lanMod.detect().tools.find((t) => t.id === 'custom').found;
  if (!regOk || !lanCleared) h3Bad++;
  console.log(`lan 登记工具 ${regOk && lanCleared ? 'OK ' : 'BAD'} 登记=${regOk} 清除=${lanCleared}`);

  // ④ 启动不存在的工具应报错而不是静默失败（本机已装过就跳过，免得把真工具拉起来）
  let lanErr = '';
  const preTaohua = lanMod.detect().tools.find((t) => t.id === 'taohua');
  if (preTaohua && preTaohua.found) {
    lanErr = '（本机已装，跳过）未找到';
  } else {
    try { lanMod.launch('taohua'); } catch (e) { lanErr = e.message; }
  }
  const errOk = lanErr.includes('未找到') || lanErr.includes('不存在');
  if (!errOk) h3Bad++;
  console.log(`lan 启动校验 ${errOk ? 'OK ' : 'BAD'} "${lanErr}"`);

  // ⑤ 联机大厅页面渲染（局域网开房 + 联机工具）
  await js(`document.querySelectorAll('.modal-mask').forEach((n) => n.remove()); renderPage('servers')`);
  let lanUi = { tools: 0, ips: '', instOpts: 0 };
  for (let i = 0; i < 16; i++) {
    await sleep(400);
    lanUi = JSON.parse(await js(`JSON.stringify({
      tools: document.querySelectorAll('.lan-tool').length,
      ips: (document.getElementById('lan-ips') || {}).textContent || '',
      instOpts: document.querySelectorAll('#lan-inst option').length,
      copyBtn: !!document.getElementById('lan-copy'),
      openBtn: !!document.getElementById('lan-open')
    })`));
    if (lanUi.tools >= 4 && lanUi.instOpts >= 1
      && (lanUi.ips.includes('局域网') || lanUi.ips.includes('未检测'))) break;
  }
  const lanUiOk = lanUi.tools >= 4 && lanUi.instOpts >= 1 && lanUi.copyBtn && lanUi.openBtn
    && (lanUi.ips.includes('局域网') || lanUi.ips.includes('未检测'));
  if (!lanUiOk) h3Bad++;
  await shot('servers-lan');
  console.log(`lan 页面 ${lanUiOk ? 'OK ' : 'BAD'} 工具=${lanUi.tools} 实例选项=${lanUi.instOpts} 地址提示="${lanUi.ips.slice(0, 40)}"`);

  console.log(`h3 汇总：错误 ${h3Bad}`);

  // ---- 批次 H-4：翻译 / AI ----
  let h4Bad = 0;

  // ① 服务商预设完整性
  const provs = translator.PROVIDERS;
  const provOk = provs.length >= 6
    && provs.some((p) => p.id === 'openai')
    && provs.some((p) => p.id === 'deepseek')
    && provs.some((p) => p.id === 'ollama')
    && provs.every((p) => p.id && p.name && /^https?:\/\//.test(p.baseUrl) && p.model);
  if (!provOk) h4Bad++;
  console.log(`ai 预设 ${provOk ? 'OK ' : 'BAD'} ${provs.length} 个：${provs.map((p) => p.name).join(' / ')}`);

  // ② 缺 Key / 空文本应给出明确错误
  const guards = [];
  try { await translator.translateText({ baseUrl: 'http://127.0.0.1:1/v1', model: 'x', apiKey: '' }, 'hello'); guards.push('缺Key未拦截'); } catch (e) { guards.push(e.message.includes('API Key') ? '' : '错误文案不符：' + e.message); }
  try { await translator.translateText({ baseUrl: 'http://127.0.0.1:1/v1', model: 'x', apiKey: 'k' }, '   '); guards.push('空文本未拦截'); } catch (e) { guards.push(e.message.includes('翻译的内容') ? '' : '错误文案不符：' + e.message); }
  try { await translator.testConnection({ baseUrl: 'ftp://x' }); guards.push('非法协议未拦截'); } catch (e) { guards.push(e.message.includes('http') ? '' : '错误文案不符：' + e.message); }
  const guardOk = guards.every((g) => !g);
  if (!guardOk) h4Bad++;
  console.log(`ai 参数校验 ${guardOk ? 'OK ' : 'BAD'} ${guardOk ? '全部拦截' : guards.filter(Boolean).join(' | ')}`);

  // ③ 用本地假接口跑通「分段翻译」全链路
  const aiSrv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-a' }, { id: 'fake-b' }] }));
        return;
      }
      let user = '';
      try { user = JSON.parse(body).messages.slice(-1)[0].content; } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `译:${user.slice(0, 12)}` } }] }));
    });
  });
  const aiPort = await new Promise((r) => aiSrv.listen(0, '127.0.0.1', () => r(aiSrv.address().port)));
  const aiCfg = { baseUrl: `http://127.0.0.1:${aiPort}/v1`, model: 'fake', apiKey: 'test' };

  const testRes = await translator.testConnection(aiCfg);
  const connOk = testRes.ok && testRes.models.length === 2;
  if (!connOk) h4Bad++;
  console.log(`ai 连通测试 ${connOk ? 'OK ' : 'BAD'} 模型=${testRes.models.length} 端点=${testRes.endpoint}`);

  const longText = 'A'.repeat(2000) + 'B'.repeat(500);
  const tr = await translator.translateText(aiCfg, longText, '简体中文');
  const trOk = tr.chunks === 2 && tr.text.includes('译:') && tr.text.split('\n').length === 2;
  if (!trOk) h4Bad++;
  console.log(`ai 分段翻译 ${trOk ? 'OK ' : 'BAD'} 段数=${tr.chunks} 行数=${tr.text.split('\n').length}`);

  try { aiSrv.close(); } catch { /* ignore */ }

  // ④ 设置页 AI 面板渲染 + 预设填充
  await js(`document.querySelectorAll('.modal-mask').forEach((n) => n.remove()); renderPage('settings')`);
  let aiUi = { chips: 0, fields: 0 };
  for (let i = 0; i < 16; i++) {
    await sleep(400);
    aiUi = JSON.parse(await js(`JSON.stringify({
      chips: document.querySelectorAll('#ai-presets .ai-chip').length,
      fields: ['ai-base','ai-model','ai-key','ai-text','ai-result'].filter((id) => !!document.getElementById(id)).length,
      save: !!document.getElementById('ai-save'), test: !!document.getElementById('ai-test')
    })`));
    if (aiUi.chips >= 6 && aiUi.fields === 5) break;
  }
  const aiUiOk = aiUi.chips >= 6 && aiUi.fields === 5 && aiUi.save && aiUi.test;
  if (!aiUiOk) h4Bad++;
  console.log(`ai 面板 ${aiUiOk ? 'OK ' : 'BAD'} 预设=${aiUi.chips} 控件=${aiUi.fields}/5`);

  // ⑤ 点击预设应自动填入地址与模型
  const filled = await js(`
    (() => {
      const chip = [...document.querySelectorAll('#ai-presets .ai-chip')]
        .find((b) => b.textContent.includes('DeepSeek'));
      if (!chip) return '';
      chip.click();
      return document.getElementById('ai-base').value + '|' + document.getElementById('ai-model').value;
    })()
  `);
  const fillOk = filled.includes('deepseek.com') && filled.includes('deepseek-chat');
  if (!fillOk) h4Bad++;
  console.log(`ai 预设填充 ${fillOk ? 'OK ' : 'BAD'} ${filled}`);
  await shot('settings-ai');

  console.log(`h4 汇总：错误 ${h4Bad}`);

  // ---- 批次 H-5：外观自定义（通透度滑杆 / 密度 / 氛围 / 自定义背景 / 8K 上限） ----
  let h5Bad = 0;

  // ① 控件渲染齐全
  await js(`document.querySelectorAll('.modal-mask').forEach((n) => n.remove()); renderPage('settings')`);
  await sleep(900);
  // 下面 ②③⑤ 量的是「通透度 ↔ 模糊反向」这条关系，只在自定义档（--glass-blur-k=1）成立；
  // 若停在透明/不透明档（k=0），模糊恒为 0px，断言会假红。先把档位钉到自定义。
  await js(`state.config.ui.glassMaterial = 'custom'; applyGlass()`);
  await sleep(300);
  const opts = JSON.parse(await js(`JSON.stringify({
    slider: !!document.querySelector('#ui-glass[type="range"]'),
    min: (document.querySelector('#ui-glass') || {}).min || '',
    max: (document.querySelector('#ui-glass') || {}).max || '',
    val: (document.querySelector('#ui-glass-val') || {}).textContent || '',
    auto: !!document.querySelector('#ui-glass-auto'),
    density: document.querySelectorAll('#ui-density .ui-opt').length,
    aura: document.querySelectorAll('#ui-aura .ui-opt').length,
    wallInfo: !!document.querySelector('#wall-info'),
    pickBtn: !!document.querySelector('#btn-wall-pick'),
    wallMark: document.body.dataset.wall
  })`));
  const optsOk = opts.slider && opts.min === '0' && opts.max === '100' && opts.auto
    && opts.density === 3 && opts.aura === 4 && opts.wallInfo && opts.pickBtn && opts.wallMark === 'builtin';
  if (!optsOk) h5Bad++;
  console.log(`ui 外观控件 ${optsOk ? 'OK ' : 'BAD'} 滑杆=${opts.min}-${opts.max} 值=${opts.val} 自动=${opts.auto} 密度=${opts.density} 氛围=${opts.aura} 背景标记=${opts.wallMark}`);
  await shot('settings-glass');

  // ② 滑杆拉满 100 → 面板几乎全透、模糊归零，但应用底色必须仍是实心的
  const g100 = await js(`
    (() => {
      const alpha = (c) => {
        const m = String(c).match(/rgba?\\(([^)]+)\\)/);
        if (!m) return 1;
        const p = m[1].split(',').map((x) => x.trim());
        return p.length >= 4 ? parseFloat(p[3]) : 1;
      };
      // 「失焦自动收一档」会跟着窗口焦点改 --g，这里先关掉，断言才只看滑杆本身
      const ck0 = document.querySelector('#ui-glass-auto');
      if (ck0 && ck0.checked) { ck0.checked = false; ck0.dispatchEvent(new Event('change', { bubbles: true })); }
      const s = document.querySelector('#ui-glass');
      s.value = '100';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      const cs = getComputedStyle(document.body);
      const pan = document.querySelector('.panel');
      const bf = pan ? getComputedStyle(pan).backdropFilter : 'none';
      const mb = bf.match(/blur\\(([\\d.]+)px\\)/);
      const title = document.querySelector('.content .page-title');
      const tcs = title ? getComputedStyle(title) : null;
      return {
        g: cs.getPropertyValue('--g').trim(),
        appAlpha: alpha(cs.backgroundColor),
        blur: mb ? parseFloat(mb[1]) : (bf === 'none' ? 0 : -1),
        transparent: document.body.dataset.transparent,
        val: document.querySelector('#ui-glass-val').textContent,
        panels: document.querySelectorAll('.content .panel').length,
        titleColor: tcs ? tcs.color : '',
        titleOpacity: tcs ? tcs.opacity : '',
        titleText: title ? title.textContent : ''
      };
    })()
  `);
  // 拉满 = 卡片与侧栏一点底色都不留，模糊必须归零（亚克力那种糊法是被明确否掉的）；
  // 面板里的文字必须还在，不能连内容一起透没。
  // 但窗口底色恒定实心 —— 不透桌面，截图 / 发布不能带 alpha，这是硬回归守卫。
  const tAlpha = (() => {
    const m = String(g100 && g100.titleColor || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return -1;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return p.length >= 4 ? p[3] : 1;
  })();
  // 拉满 = 卡片/侧栏全透（--panel-a 归零、blur 归零），但窗口底色仍是实心
  const g100Ok = !!(g100 && Math.abs(parseFloat(g100.g) - 1) < 0.001
    && g100.appAlpha >= 0.99 && g100.blur <= 1
    && g100.transparent === '1' && g100.val === '100%'
    && g100.panels > 0 && tAlpha >= 0.9);
  if (!g100Ok) h5Bad++;
  console.log(`ui 通透度拉满 ${g100Ok ? 'OK ' : 'BAD'} g=${g100 && g100.g} 窗口底色alpha=${g100 && g100.appAlpha}(应=1 实心) blur=${g100 && g100.blur}px 标记=${g100 && g100.transparent} 面板数=${g100 && g100.panels} 标题="${g100 && g100.titleText}" 标题色=${g100 && g100.titleColor}`);
  // 等重绘，否则 capturePage 会拍到点击前的旧帧
  await sleep(600);
  await shot('glass-ultra');

  // ③ 滑杆拉到 0 → 完全不透明（模糊与通透度反向，这里应为最大值）
  const g0 = await js(`
    (() => {
      const alpha = (c) => {
        const m = String(c).match(/rgba?\\(([^)]+)\\)/);
        if (!m) return 1;
        const p = m[1].split(',').map((x) => x.trim());
        return p.length >= 4 ? parseFloat(p[3]) : 1;
      };
      const ck1 = document.querySelector('#ui-glass-auto');
      if (ck1 && ck1.checked) { ck1.checked = false; ck1.dispatchEvent(new Event('change', { bubbles: true })); }
      const s = document.querySelector('#ui-glass');
      s.value = '0';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      const cs = getComputedStyle(document.body);
      const pan = document.querySelector('.panel');
      const bf = pan ? getComputedStyle(pan).backdropFilter : 'none';
      const mb = bf.match(/blur\\(([\\d.]+)px\\)/);
      return {
        g: cs.getPropertyValue('--g').trim(),
        appAlpha: alpha(cs.backgroundColor),
        blur: mb ? parseFloat(mb[1]) : (bf === 'none' ? 0 : -1),
        transparent: document.body.dataset.transparent,
        val: document.querySelector('#ui-glass-val').textContent
      };
    })()
  `);
  const g0Ok = !!(g0 && parseFloat(g0.g) === 0 && g0.appAlpha >= 0.99
    && g0.blur > 20 && g0.transparent === '0' && g0.val === '0%');
  if (!g0Ok) h5Bad++;
  console.log(`ui 通透度关闭 ${g0Ok ? 'OK ' : 'BAD'} g=${g0 && g0.g} 底色alpha=${g0 && g0.appAlpha} blur=${g0 && g0.blur}px 标记=${g0 && g0.transparent}`);
  await sleep(600);
  await shot('glass-off');

  // ④ 密度与氛围切换生效
  const dens = await js(`
    (() => {
      const b = [...document.querySelectorAll('#ui-density .ui-opt')].find((x) => x.textContent === '紧凑');
      b && b.click();
      const a = [...document.querySelectorAll('#ui-aura .ui-opt')].find((x) => x.textContent === '关闭');
      a && a.click();
      const blob = document.querySelector('.bg-layer i');
      return {
        density: document.body.dataset.density,
        aura: document.body.dataset.aura,
        radius: getComputedStyle(document.body).getPropertyValue('--radius').trim(),
        blobHidden: blob ? getComputedStyle(blob).display === 'none' : false
      };
    })()
  `);
  const densOk = !!(dens && dens.density === 'compact' && dens.aura === 'off'
    && parseFloat(dens.radius) <= 16 && dens.blobHidden);
  if (!densOk) h5Bad++;
  console.log(`ui 密度氛围 ${densOk ? 'OK ' : 'BAD'} 密度=${dens && dens.density}(${dens && dens.radius}) 氛围=${dens && dens.aura} 光斑隐藏=${dens && dens.blobHidden}`);

  // ⑤ 失焦时「自动」钩选生效，通透度自动收一档
  const auto = await js(`
    (() => {
      const s = document.querySelector('#ui-glass');
      s.value = '80';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      const ck = document.querySelector('#ui-glass-auto');
      ck.checked = true;
      ck.dispatchEvent(new Event('change', { bubbles: true }));
      const blurNow = () => {
        const pan = document.querySelector('.panel');
        const bf = pan ? getComputedStyle(pan).backdropFilter : 'none';
        const mb = bf.match(/blur\\(([\\d.]+)px\\)/);
        return mb ? parseFloat(mb[1]) : 0;
      };
      window.dispatchEvent(new Event('focus'));
      const before = blurNow();
      window.dispatchEvent(new Event('blur'));
      const after = blurNow();
      window.dispatchEvent(new Event('focus'));
      const back = blurNow();
      return { before, after, back, focus: document.body.dataset.focus, auto: ck.checked };
    })()
  `);
  // 失焦收一档 = 更不透明 + 更磨砂，所以 blur 变大
  const autoOk = !!(auto && auto.auto && auto.after > auto.before && auto.back === auto.before);
  if (!autoOk) h5Bad++;
  console.log(`ui 失焦自动 ${autoOk ? 'OK ' : 'BAD'} 前台=${auto && auto.before}px 后台=${auto && auto.after}px 回到前台=${auto && auto.back}px`);
  await js(`applyTheme()`);

  // ⑥ 自定义背景：写入一张真实图片，断言背景层铺开、光斑让位
  const wallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-smoke-wall-'));
  const smallB64 = await js(`(function () {
    var c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    var x = c.getContext('2d');
    x.fillStyle = '#3366ff'; x.fillRect(0, 0, 64, 36);
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  const smallPath = path.join(wallDir, 'smoke-wall.png');
  fs.writeFileSync(smallPath, Buffer.from(smallB64, 'base64'));

  const bgOn = await js(`
    (() => {
      state.config.wallpaperType = 'custom';
      state.config.wallpaperUrl = ${JSON.stringify(smallPath)};
      state.config.wallpaperKind = 'image';
      state.config.wallpaperLive = '';
      applyTheme();
      var img = document.querySelector('#bg-image');
      var vid = document.querySelector('#bg-video');
      return {
        mark: document.body.dataset.wall,
        imgHidden: img.hidden,
        imgSrc: img.getAttribute('src') || '',
        vidHidden: vid.hidden,
        blobs: [...document.querySelectorAll('.bg-layer i')].filter((n) => getComputedStyle(n).display !== 'none').length
      };
    })()
  `);
  // 等图片真正解码完（固定 sleep 在机器繁忙时可能不够）
  let bgLoaded = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    bgLoaded = await js(`(() => { const i = document.querySelector('#bg-image'); return i && i.complete ? i.naturalWidth : 0; })()`);
    if (bgLoaded === 64) break;
  }
  const bgOnOk = !!(bgOn && bgOn.mark === 'custom' && !bgOn.imgHidden
    && bgOn.imgSrc.indexOf('file:///') === 0 && bgOn.vidHidden
    && bgOn.blobs === 0 && bgLoaded === 64);
  if (!bgOnOk) h5Bad++;
  console.log(`背景 自定义铺开 ${bgOnOk ? 'OK ' : 'BAD'} 标记=${bgOn && bgOn.mark} 图片加载宽=${bgLoaded} 光斑残留=${bgOn && bgOn.blobs}`);
  await shot('wall-custom');

  // ⑦ 超过 8K（7680×4320）的图片被判定超限（用刚越界的宽度测边界）
  const bigB64 = await js(`(function () {
    var c = document.createElement('canvas');
    c.width = 7681; c.height = 64;
    var x = c.getContext('2d');
    x.fillStyle = '#123456'; x.fillRect(0, 0, 7681, 64);
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  const bigPath = path.join(wallDir, 'smoke-wall-8k.png');
  fs.writeFileSync(bigPath, Buffer.from(bigB64, 'base64'));
  const bigProbe = await js(`probeMedia(${JSON.stringify('file:///' + bigPath.replace(/\\/g, '/'))}, false)`);
  const bigOk = !!(bigProbe && bigProbe.ok && bigProbe.tooBig && bigProbe.w > 7680);
  if (!bigOk) h5Bad++;
  console.log(`背景 8K 上限 ${bigOk ? 'OK ' : 'BAD'} 尺寸=${bigProbe && bigProbe.w}x${bigProbe && bigProbe.h} 超限=${bigProbe && bigProbe.tooBig}`);

  // ⑧ 通透度偏好应写入配置文件
  await js(`(() => {
    const s = document.querySelector('#ui-glass');
    s.value = '100';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(600);
  const savedUi = config.get('ui');
  const saveUiOk = !!(savedUi && Number(savedUi.glassLevel) === 100);
  if (!saveUiOk) h5Bad++;
  console.log(`ui 持久化 ${saveUiOk ? 'OK ' : 'BAD'} ${JSON.stringify(savedUi)}`);

  // 复原默认 + 清掉临时背景，避免影响后面的巡检截图
  config.set('ui', { glassLevel: 55, glassAuto: true, density: 'normal', aura: 'std' });
  config.set('wallpaperType', 'builtin');
  config.set('wallpaperUrl', '');
  config.set('wallpaperKind', '');
  config.set('wallpaperLive', '');
  await js(`
    state.config.ui = { glassLevel: 55, glassAuto: true, density: 'normal', aura: 'std' };
    state.config.wallpaperType = 'builtin';
    state.config.wallpaperUrl = '';
    state.config.wallpaperKind = '';
    state.config.wallpaperLive = '';
    applyTheme();
  `);
  await sleep(400);
  try { fs.rmSync(wallDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`h5 汇总：错误 ${h5Bad}`);

  // ---- 批次 H-6：侧栏悬停提示不被内容区遮挡 ----
  let h6Bad = 0;
  await js(`document.querySelectorAll('.modal-mask').forEach((n) => n.remove()); renderPage('home')`);
  await sleep(800);

  const navPos = JSON.parse(await js(`(function(){
    var it = document.querySelectorAll('.nav-item')[2];
    var r = it.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`));
  // sendInputEvent 的 mouseMove 不会让渲染进程重算 :hover（顶层元素查出来就是导航项本身），
// 这里改用 CDP 的 Input.dispatchMouseEvent，它走的是真实鼠标输入通道，能稳定触发 :hover。
  const dbg = win.webContents.debugger;
  let dbgErr = '';
  try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch (e) { dbgErr = String(e && e.message); }
  const dbgOn = dbg.isAttached();
  const moveMouse = async (x, y) => {
    if (dbgOn) {
      try {
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
        return;
      } catch (e) { dbgErr = String(e && e.message); }
    }
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  };

  let tipInfo = null;
  win.focus();
  for (let i = 0; i < 4 && !(tipInfo && tipInfo.display === 'block'); i++) {
    await moveMouse(640, 420);
    await sleep(180);
    await moveMouse(navPos.x + (i % 2), navPos.y);
    await sleep(650);
    tipInfo = JSON.parse(await js(`(function(){
      var it = document.querySelectorAll('.nav-item')[2];
      var lbl = it.querySelector('.nav-label');
      var cs = getComputedStyle(lbl);
      var r = lbl.getBoundingClientRect();
      var sn = document.querySelector('.sidenav').getBoundingClientRect();
      lbl.style.pointerEvents = 'auto';
      var cx = Math.round(r.left + r.width / 2);
      var cy = Math.round(r.top + r.height / 2);
      var top = document.elementFromPoint(cx, cy);
      lbl.style.pointerEvents = '';
      var probe = document.elementFromPoint(${navPos.x}, ${navPos.y});
      return JSON.stringify({
        display: cs.display,
        w: Math.round(r.width), h: Math.round(r.height),
        overflows: Math.round(r.right - sn.right),
        onTop: !!top && (top === lbl || lbl.contains(top) || top.contains(lbl)),
        atNav: probe ? (probe.className || probe.tagName) : 'none',
        hovered: it.matches(':hover')
      });
    })()`));
  }
  const tipOk = tipInfo.display === 'block' && tipInfo.w > 0 && tipInfo.h > 0
    && tipInfo.overflows > 10 && tipInfo.onTop;
  if (!tipOk) h6Bad++;
  console.log(`ui 悬停提示 ${tipOk ? 'OK ' : 'BAD'} 显示=${tipInfo.display} 尺寸=${tipInfo.w}x${tipInfo.h} 越出侧栏=${tipInfo.overflows}px 未被遮挡=${tipInfo.onTop} 鼠标点顶层=${tipInfo.atNav} hover态=${tipInfo.hovered} CDP=${dbgOn}${dbgErr ? ' 错误=' + dbgErr : ''}`);
  await shot('nav-tip');

  // 移开鼠标，避免影响后续巡检截图
  await moveMouse(700, 500);
  await sleep(300);
  try { if (dbg.isAttached()) dbg.detach(); } catch { /* ignore */ }

  console.log(`h6 汇总：错误 ${h6Bad}`);

  // ---- 批次 H-7：明暗模式（深色 / 浅色 / OLED / 跟随系统） ----
  let h7Bad = 0;
  await js(`document.querySelectorAll('.modal-mask').forEach((n) => n.remove()); renderPage('settings')`);
  await sleep(900);

  const themeOpts = JSON.parse(await js(`JSON.stringify({
    count: document.querySelectorAll('#ui-theme .ui-opt').length,
    labels: [...document.querySelectorAll('#ui-theme .ui-opt')].map((x) => x.textContent),
    on: (document.querySelector('#ui-theme .ui-opt.on') || {}).textContent || '',
    mode: document.body.dataset.mode
  })`));
  const themeOptsOk = themeOpts.count === 4 && themeOpts.on === '深色'
    && themeOpts.labels.join('/') === '深色/浅色/OLED/跟随系统' && themeOpts.mode === 'dark';
  if (!themeOptsOk) h7Bad++;
  console.log(`模式 档位渲染 ${themeOptsOk ? 'OK ' : 'BAD'} 数量=${themeOpts.count} 当前=${themeOpts.on} 生效=${themeOpts.mode}`);

  // 逐档切换，读取实际生效的背景亮度与文字色
  const probeMode = async (label) => {
    await js(`
      (() => {
        const b = [...document.querySelectorAll('#ui-theme .ui-opt')].find((x) => x.textContent === ${JSON.stringify(label)});
        b && b.click();
      })()
    `);
    await sleep(500);
    return JSON.parse(await js(`(function () {
      var lum = function (c) {
        var m = String(c).match(/rgba?\\(([^)]+)\\)/);
        if (!m) return -1;
        var p = m[1].split(',').map(function (x) { return parseFloat(x); });
        return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
      };
      var cs = getComputedStyle(document.body);
      var title = document.querySelector('.page-title');
      var top = document.querySelector('.topbar');
      var brand = document.querySelector('.brand-name');
      return JSON.stringify({
        mode: document.body.dataset.mode,
        bgLum: Math.round(lum(cs.backgroundColor)),
        textLum: Math.round(lum(getComputedStyle(title || document.body).color)),
        barLum: top ? Math.round(lum(getComputedStyle(top).backgroundColor)) : -1,
        brandLum: brand ? Math.round(lum(getComputedStyle(brand).color)) : -1,
        on: (document.querySelector('#ui-theme .ui-opt.on') || {}).textContent || ''
      });
    })()`));
  };

  const mDark = await probeMode('深色');
  const darkOk = mDark.mode === 'dark' && mDark.bgLum <= 40 && mDark.textLum >= 150
    && mDark.barLum <= 60 && mDark.brandLum >= 150;
  if (!darkOk) h7Bad++;
  console.log(`模式 深色 ${darkOk ? 'OK ' : 'BAD'} 生效=${mDark.mode} 底色=${mDark.bgLum} 标题文字=${mDark.textLum} 顶栏=${mDark.barLum} 品牌文字=${mDark.brandLum}`);
  await shot('mode-dark');

  const mOled = await probeMode('OLED');
  const oledOk = mOled.mode === 'oled' && mOled.bgLum <= 12 && mOled.textLum >= 150 && mOled.barLum <= 12;
  if (!oledOk) h7Bad++;
  console.log(`模式 OLED ${oledOk ? 'OK ' : 'BAD'} 生效=${mOled.mode} 底色=${mOled.bgLum} 标题文字=${mOled.textLum} 顶栏=${mOled.barLum}`);
  await shot('mode-oled');

  const mLight = await probeMode('浅色');
  const lightOk = mLight.mode === 'light' && mLight.bgLum >= 150 && mLight.textLum <= 90
    && mLight.barLum >= 200 && mLight.brandLum <= 90;
  if (!lightOk) h7Bad++;
  console.log(`模式 浅色 ${lightOk ? 'OK ' : 'BAD'} 生效=${mLight.mode} 底色=${mLight.bgLum} 标题文字=${mLight.textLum} 顶栏=${mLight.barLum} 品牌文字=${mLight.brandLum}`);
  await shot('mode-light');

  // 浅色档下逐页截图，确认没有白底白字
  for (const p of ['home', 'instances', 'versions', 'center', 'servers', 'lab', 'account', 'skins', 'downloads', 'settings']) {
    await js(`renderPage('${p}')`);
    await sleep(650);
    await shot(`light-${p}`);
  }
  console.log('模式 浅色巡检截图完成：home / instances / versions / center / servers / lab / account / skins / downloads / settings');

  // 激活态对比度：浅色底上「浅强调底 + 强调色文字」几乎看不见，
  // 这里确认标签页 / 分段按钮 / 在线标签的激活态是「实心强调底 + 白字」。
  const activeBad = [];
  let activeSeen = 0;
  for (const [pg, sel] of [['center', '.cat-tab.active'], ['servers', '.sv-tag.ok'], ['lab', '.seg.active']]) {
    await js(`renderPage('${pg}')`);
    await sleep(650);
    const el = JSON.parse(await js(`(function () {
      var lum = function (c) {
        var m = String(c).match(/rgba?\\(([^)]+)\\)/);
        if (!m) return -1;
        var p = m[1].split(',').map(function (x) { return parseFloat(x); });
        return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
      };
      var n = document.querySelector(${JSON.stringify(sel)});
      if (!n) return 'null';
      var cs = getComputedStyle(n);
      return JSON.stringify({ text: Math.round(lum(cs.color)), grad: /gradient/.test(cs.backgroundImage) });
    })()`));
    if (!el) continue;
    activeSeen++;
    if (el.text < 240 || !el.grad) activeBad.push(`${pg}${sel}`);
  }
  const activeOk = activeSeen > 0 && activeBad.length === 0;
  if (!activeOk) h7Bad++;
  console.log(`模式 浅色激活态 ${activeOk ? 'OK ' : 'BAD'} 检查=${activeSeen} 处 不合格=${activeBad.join(',') || '无'}`);

  // 上面的激活态巡检切走了页面，这里把设置页重新渲染出来，probeMode 才有按钮可点
  await js(`renderPage('settings')`);
  await sleep(700);

  // 跟随系统：应解析成系统当前的明暗，且与 matchMedia 一致
  const mSys = await probeMode('跟随系统');
  const sysWant = await js(`window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`);
  const sysOk = mSys.mode === sysWant && (mSys.mode === 'dark' || mSys.mode === 'light');
  if (!sysOk) h7Bad++;
  console.log(`模式 跟随系统 ${sysOk ? 'OK ' : 'BAD'} 系统=${sysWant} 生效=${mSys.mode}`);

  // 偏好写入配置 + 复原深色
  await sleep(400);
  const savedTheme = config.get('theme');
  const themeSaveOk = savedTheme === 'system';
  if (!themeSaveOk) h7Bad++;
  console.log(`模式 持久化 ${themeSaveOk ? 'OK ' : 'BAD'} theme=${savedTheme}`);
  config.set('theme', 'dark');
  await js(`state.config.theme = 'dark'; applyTheme()`);
  await sleep(400);

  console.log(`h7 汇总：错误 ${h7Bad}`);

  // ---- 批次 H-8：联机工具收纳（装进启动器，免去用户自己找 exe） ----
  let h8Bad = 0;
  const toolsRoot = lanMod.toolsRoot();
  const taohuaDir = path.join(toolsRoot, 'taohua');
  const savedLanTools = { ...(config.get('lanTools') || {}) };

  // 先把用户真实装过的工具备份出来，测完还原，冒烟测试不留痕
  const toolsBackup = path.join(os.tmpdir(), `cm-tools-backup-${Date.now()}`);
  const hadTaohua = fs.existsSync(taohuaDir);
  if (hadTaohua) fs.cpSync(taohuaDir, toolsBackup, { recursive: true });

  try {
    fs.rmSync(taohuaDir, { recursive: true, force: true });
    const lanCfg = { ...savedLanTools };
    delete lanCfg.taohua;
    config.set('lanTools', lanCfg);

    // ① 没配官方直链的预置工具（只给官网下载页那种），必须明确报错，绝不编造下载地址
    let fetchErr = '';
    try { await lanMod.fetchTool('sakura'); } catch (e) { fetchErr = e.message; }
    const fetchOk = fetchErr.includes('下载地址');
    if (!fetchOk) h8Bad++;
    console.log(`收纳 直链缺失提示 ${fetchOk ? 'OK ' : 'BAD'} "${fetchErr}"`);

    // ② 托管目录清空后，靠「随启动器内置」照样可用，而且不往托管目录里写东西
    const bundledDir = path.join(lanMod.bundledRoot(), 'taohua');
    const beforeT = lanMod.detect().tools.find((t) => t.id === 'taohua');
    const beforeOk = !!beforeT && beforeT.found && beforeT.bundled && !beforeT.managed
      && path.resolve(beforeT.path).startsWith(path.resolve(bundledDir));
    if (!beforeOk) h8Bad++;
    console.log(`收纳 未安装态 ${beforeOk ? 'OK ' : 'BAD'} found=${beforeT && beforeT.found} bundled=${beforeT && beforeT.bundled} managed=${beforeT && beforeT.managed}`);

    // ③ 把「安装包」zip 装进启动器：自动解压 + 定位 exe + 托管到 %userData%/tools/
    const pkg = path.join(fx.base, '陶瓦联机-安装包.zip');
    createZip(pkg, [
      { name: '陶瓦联机/陶瓦联机.exe', data: Buffer.from('FAKE-LAN-TOOL') },
      { name: '陶瓦联机/readme.txt', data: Buffer.from('安装说明') },
    ]);
    const ins = lanMod.install('taohua', pkg);
    const installedOk = !!(ins && ins.exe && fs.existsSync(ins.exe)
      && path.resolve(ins.exe).startsWith(path.resolve(taohuaDir))
      && fs.readFileSync(ins.exe, 'utf8') === 'FAKE-LAN-TOOL');
    if (!installedOk) h8Bad++;
    console.log(`收纳 装进启动器 ${installedOk ? 'OK ' : 'BAD'} exe=${ins && ins.exe}`);

    // ④ 探测结果变成「已装入启动器」，且指向托管目录
    const afterT = lanMod.detect().tools.find((t) => t.id === 'taohua');
    const afterOk = !!(afterT && afterT.found && afterT.managed
      && path.resolve(afterT.path).startsWith(path.resolve(taohuaDir)));
    if (!afterOk) h8Bad++;
    console.log(`收纳 托管态 ${afterOk ? 'OK ' : 'BAD'} managed=${afterT && afterT.managed} path=${afterT && afterT.path}`);

    // ⑤ 重复安装仍可用（覆盖式，不会指向错文件）
    const ins2 = lanMod.install('taohua', pkg);
    const reinstallOk = !!(ins2 && ins2.exe && fs.existsSync(ins2.exe));
    if (!reinstallOk) h8Bad++;
    console.log(`收纳 重复安装 ${reinstallOk ? 'OK ' : 'BAD'} exe=${ins2 && ins2.exe}`);
  } finally {
    try { fs.rmSync(taohuaDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (hadTaohua) fs.cpSync(toolsBackup, taohuaDir, { recursive: true });
    try { fs.rmSync(toolsBackup, { recursive: true, force: true }); } catch { /* ignore */ }
    config.set('lanTools', savedLanTools);
  }
  console.log(`h8 汇总：错误 ${h8Bad}`);

  // ---- 批次 H-9：游戏加速 + 公网联机（UPnP / IPv6） ----
  let h9Bad = 0;

  // ① 游戏日志里的开房端口识别
  const portCases = [
    ['[Render thread/INFO]: Local game hosted on port 51234', 51234],
    ['[Server thread/INFO]: Started serving on 0.0.0.0:25565', 25565],
    ['[Server thread/INFO]: Started on port 49999', 49999],
    ['[Server thread/INFO]: Opening to LAN on port 61234', 61234],
    ['[Render thread/INFO]: Setting user: Steve', 0],
    ['[Server thread/INFO]: Stopping server', 0],
  ];
  const portBad = portCases.filter(([line, want]) => lanMod.detectLanPort(line) !== want);
  const portOk = portBad.length === 0;
  if (!portOk) h9Bad++;
  console.log(`加速 开房端口识别 ${portOk ? 'OK ' : 'BAD'} ${portCases.length - portBad.length}/${portCases.length} 命中`
    + (portBad.length ? ` 失败=${portBad.map((c) => `"${c[0]}"→${lanMod.detectLanPort(c[0])}≠${c[1]}`).join(' | ')}` : ''));

  // ② 公网 IPv6 探测：只应返回全局单播，且不抛异常
  let v6 = [];
  let v6Err = '';
  try { v6 = lanMod.publicIPv6s(); } catch (e) { v6Err = e.message; }
  const v6Ok = !v6Err && Array.isArray(v6)
    && v6.every((i) => i.address && !/^(fe80|::1|fc|fd)/i.test(i.address));
  if (!v6Ok) h9Bad++;
  console.log(`加速 公网IPv6 ${v6Ok ? 'OK ' : 'BAD'} ${v6.length} 个（${v6.map((i) => i.address).join(', ') || '无'}）${v6Err}`);

  // ③ UPnP：没有网关时必须安静地返回 null，不能抛
  let upnpNull = 'throw';
  try { upnpNull = await lanMod.upnpMap(25599, { discover: async () => [] }); } catch (e) { upnpNull = `throw:${e.message}`; }
  const upnpNullOk = upnpNull === null;
  if (!upnpNullOk) h9Bad++;
  console.log(`加速 UPnP无网关兜底 ${upnpNullOk ? 'OK ' : 'BAD'} 返回=${JSON.stringify(upnpNull)}`);

  // ④ UPnP：拿一份网关描述 XML 跑通「发现 → 解析 → AddPortMapping → 取公网 IP」整条链路
  const IGD_XML = `<?xml version="1.0"?><root><device><serviceList>
    <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
  </serviceList></device></root>`;
  const soapCalls = [];
  // 网关有服务但压根不认 WANIPConnection 的情况，用来验证会退回 null
  const NO_WAN_XML = '<?xml version="1.0"?><root><device><serviceList><service>'
    + '<serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>'
    + '<controlURL>/l3f</controlURL></service></serviceList></device></root>';

  const gw = [{ location: 'http://192.0.2.1:5000/rootDesc.xml', from: '192.0.2.1' }];
  const fakeSoap = async (url, type, action, body) => {
    soapCalls.push({ url, type, action, body });
    if (action === 'GetExternalIPAddress') return '<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>';
    return '<ok/>';
  };
  let upnpRes = null;
  try {
    upnpRes = await lanMod.upnpMap(25599, {
      discover: async () => gw,
      fetchXml: async () => IGD_XML,
      callSoap: fakeSoap,
      internalIp: '192.168.1.5',
    });
  } catch (e) { upnpRes = { err: e.message }; }
  const addCall = soapCalls.find((c) => c.action === 'AddPortMapping');
  const upnpOk = !!(upnpRes && upnpRes.ip === '203.0.113.7' && upnpRes.port === 25599
    && addCall && /WANIPConnection/.test(addCall.type) && /\/ctl\/IPConn$/.test(addCall.url)
    && /<NewExternalPort>25599<\/NewExternalPort>/.test(addCall.body)
    && /<NewInternalClient>192\.168\.1\.5<\/NewInternalClient>/.test(addCall.body));
  if (!upnpOk) h9Bad++;
  console.log(`加速 UPnP映射链路 ${upnpOk ? 'OK ' : 'BAD'} ip=${upnpRes && upnpRes.ip} 端口=${upnpRes && upnpRes.port} 调用=${soapCalls.map((c) => c.action).join('+')}`);

  // ⑤ 网关不提供 WAN 服务 → 返回 null
  let noWan = 'throw';
  try {
    noWan = await lanMod.upnpMap(25599, {
      discover: async () => gw, fetchXml: async () => NO_WAN_XML, callSoap: fakeSoap, internalIp: '192.168.1.5',
    });
  } catch (e) { noWan = `throw:${e.message}`; }
  const noWanOk = noWan === null;
  if (!noWanOk) h9Bad++;
  console.log(`加速 UPnP无WAN服务 ${noWanOk ? 'OK ' : 'BAD'} 返回=${JSON.stringify(noWan)}`);

  // ⑥ 撤销映射：网关不可达时返回 false 且不抛
  let unmapRes = 'throw';
  try { unmapRes = await lanMod.upnpUnmap(25599, { discover: async () => [] }); } catch (e) { unmapRes = `throw:${e.message}`; }
  const unmapOk = unmapRes === false;
  if (!unmapOk) h9Bad++;
  console.log(`加速 UPnP撤销兜底 ${unmapOk ? 'OK ' : 'BAD'} 返回=${JSON.stringify(unmapRes)}`);

  // ⑦ 启动加速：自适应堆 + 加速参数，且用户自己配了 GC 时不重复加
  const totalMb = Math.floor(os.totalmem() / 1048576);
  const wantMax = Math.max(2048, Math.min(8192, Math.round(totalMb * 0.5)));
  const boosted = launchMod.boostedMax(4096);
  const boostArgs = launchMod.boostArgs();
  // 回归守卫：G1NewSizePercent 前必须有 UnlockExperimentalVMOptions，否则 JDK8/9 上 JVM 直接退出码1
  const unlockBeforeExp = boostArgs.indexOf('-XX:+UnlockExperimentalVMOptions') >= 0
    && boostArgs.indexOf('-XX:+UnlockExperimentalVMOptions') < boostArgs.indexOf('-XX:G1NewSizePercent=30');
  const boostOk = boosted >= wantMax && boosted <= 8192 && boosted >= 4096
    && boostArgs.includes('-XX:+UseG1GC') && boostArgs.length >= 10 && unlockBeforeExp;
  if (!boostOk) h9Bad++;
  console.log(`加速 堆自适应 ${boostOk ? 'OK ' : 'BAD'} 物理=${totalMb}MB 配置=4096 生效=${boosted}MB 参数=${boostArgs.length}条 实验选项解锁=${unlockBeforeExp}`);

  // ⑧ 真正拼进启动命令：开 / 关加速各来一次
  const fakeVj = {
    id: '1.20.1',
    mainClass: 'net.minecraft.client.main.Main',
    libraries: [{ downloads: { artifact: { path: 'com/example/a.jar' } } }],
    assetIndex: { id: '5' },
    arguments: {
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
      game: ['--username', '${auth_player_name}', '--version', '${version_name}',
        '--gameDir', '${game_directory}', '--assetsDir', '${assets_root}',
        '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}',
        '--accessToken', '${auth_access_token}', '--userType', '${user_type}',
        '--versionType', '${version_type}'],
    },
  };
  const fakeAcc = { username: 'Tester', uuid: '00000000000000000000000000000000', accessToken: 'tok', userType: 'msa' };
  let argOn = []; let argOff = []; let argErr = '';
  try {
    argOn = launchMod.buildLaunchArgs(fakeVj, os.tmpdir(), fakeAcc, { speedBoost: true, maxMemory: 4096, minMemory: 512 });
    argOff = launchMod.buildLaunchArgs(fakeVj, os.tmpdir(), fakeAcc, { speedBoost: false, maxMemory: 4096, minMemory: 512 });
  } catch (e) { argErr = e.message; }
  const xmxOn = /^-Xmx(\d+)M$/.exec(argOn.find((a) => a.startsWith('-Xmx')) || '');
  const xmxOff = /^-Xmx(\d+)M$/.exec(argOff.find((a) => a.startsWith('-Xmx')) || '');
  const wiringOk = !argErr
    && !!xmxOn && Number(xmxOn[1]) === boosted
    && !!xmxOff && Number(xmxOff[1]) === 4096
    && argOn.includes('-XX:+UseG1GC') && !argOff.includes('-XX:+UseG1GC');
  if (!wiringOk) h9Bad++;
  console.log(`加速 启动命令拼装 ${wiringOk ? 'OK ' : 'BAD'} 开=${xmxOn && xmxOn[1]}MB(${argOn.includes('-XX:+UseG1GC') ? 'G1' : '无G1'}) 关=${xmxOff && xmxOff[1]}MB(${argOff.includes('-XX:+UseG1GC') ? 'G1' : '无G1'})${argErr}`);

  // ⑨ 用户自己填了 GC 参数时不应该重复追加
  let argUser = [];
  try {
    argUser = launchMod.buildLaunchArgs(fakeVj, os.tmpdir(), fakeAcc, {
      speedBoost: true, maxMemory: 4096, minMemory: 512, jvmArgs: '-XX:+UseG1GC -XX:MaxGCPauseMillis=100',
    });
  } catch { /* 上面已经报过 */ }
  const dupOk = argUser.filter((a) => a === '-XX:+UseG1GC').length === 1;
  if (!dupOk) h9Bad++;
  console.log(`加速 不重复加GC参数 ${dupOk ? 'OK ' : 'BAD'} UseG1GC 出现 ${argUser.filter((a) => a === '-XX:+UseG1GC').length} 次`);

  // ⑨b Fabric/Quilt maven 库（无 downloads.artifact）：坐标转换 + 必须进 classpath
  //     回归守卫：JVM「找不到或无法加载主类 KnotClient」退出码1
  const dlMod2 = require('./src/main/minecraft/downloader');
  const mp1 = dlMod2.mavenLibPath('net.fabricmc:fabric-loader:0.19.5');
  const mp2 = dlMod2.mavenLibPath('net.fabricmc:sponge-mixin:0.17.4+mixin.0.8.7');
  const mp3 = dlMod2.mavenLibPath('only:two');
  const fabricVj = {
    id: 'fabric-loader-0.19.5-1.20',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [
      { name: 'net.fabricmc:fabric-loader:0.19.5', url: 'https://maven.fabricmc.net/' },
      { name: 'net.fabricmc:intermediary:1.20', url: 'https://maven.fabricmc.net/' },
      { downloads: { artifact: { path: 'com/mojang/normal.jar' } } },
    ],
    arguments: { jvm: ['-cp', '${classpath}'], game: [] },
  };
  const fabricArgs = launchMod.buildLaunchArgs(fabricVj, 'E:\\gm', fakeAcc, { speedBoost: false, maxMemory: 2048, minMemory: 512 });
  const cpArg = fabricArgs[fabricArgs.indexOf('-cp') + 1];
  const fabricCpOk = mp1 === 'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar'
    && mp2 === 'net/fabricmc/sponge-mixin/0.17.4+mixin.0.8.7/sponge-mixin-0.17.4+mixin.0.8.7.jar'
    && mp3 === ''
    && cpArg.includes('fabric-loader-0.19.5.jar')
    && cpArg.includes('intermediary-1.20.jar')
    && cpArg.includes('normal.jar');
  if (!fabricCpOk) h9Bad++;
  console.log(`加速 Fabric库进classpath ${fabricCpOk ? 'OK ' : 'BAD'} 坐标转换=${mp1 === 'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar'} 加载器在cp=${cpArg.includes('fabric-loader-0.19.5.jar')}`);

  // ⑩ 联机页应当渲染出公网联机区块
  await js(`renderPage('servers')`);
  let pubUi = { has: false, title: '', state: '', portInput: false, btn: false, copy: false };
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    pubUi = JSON.parse(await js(`JSON.stringify((function () {
      var st = document.getElementById('lan-pub-state');
      return {
        has: !!document.querySelector('.lan-pub'),
        title: (document.querySelector('.lan-pub-title') || {}).textContent || '',
        state: st ? st.textContent.trim() : '',
        portInput: !!document.getElementById('lan-port'),
        btn: !!document.getElementById('lan-pub-open'),
        copy: !!document.getElementById('lan-pub-copy')
      };
    })())`));
    if (pubUi.has && pubUi.state && pubUi.state !== '检测中…') break;
  }
  const pubUiOk = pubUi.has && pubUi.portInput && pubUi.btn && pubUi.copy
    && pubUi.title.includes('公网联机') && !!pubUi.state && pubUi.state !== '检测中…';
  if (!pubUiOk) h9Bad++;
  console.log(`加速 公网联机区块 ${pubUiOk ? 'OK ' : 'BAD'} 标题="${pubUi.title}" 状态="${pubUi.state}" 端口框=${pubUi.portInput} 按钮=${pubUi.btn}`);
  await shot('lan-public');

  console.log(`h9 汇总：错误 ${h9Bad}`);

  // ---- 批次 H-10：账号持久化（登录列表兜底 + 续期回写） ----
  let h10Bad = 0;
  const savedAcc = config.get('account');
  const savedList = config.get('accounts') || [];
  try {
    const probe = { type: 'offline', username: 'smoke-account', uuid: 'smoke-0000-1111-2222-333344445555', accessToken: '0' };
    config.setAccount(probe);
    const hits1 = (config.get('accounts') || []).filter((a) => a && a.uuid === probe.uuid).length;

    // 再存一次同一个账号（令牌换了新的）：应当就地更新，而不是变成两条
    config.setAccount({ ...probe, accessToken: 'new-token' });
    const hits2 = (config.get('accounts') || []).filter((a) => a && a.uuid === probe.uuid);
    const cur = config.get('account');

    const ok = hits1 === 1 && hits2.length === 1 && hits2[0].accessToken === 'new-token'
      && !!cur && cur.uuid === probe.uuid;
    if (!ok) h10Bad++;
    console.log(`h10 账号列表兜底 ${ok ? 'OK ' : 'BAD'} 首次=${hits1}条 复登=${hits2.length}条 令牌=${hits2[0] && hits2[0].accessToken}`);
  } finally {
    // 还原玩家的真实账号，别把冒烟测试的假号留在配置里
    config.set('accounts', savedList);
    config.set('account', savedAcc);
  }
  console.log(`h10 汇总：错误 ${h10Bad}`);

  // ---- 批次 H-11：实例标签页异步竞态（读盘还没回来玩家就切走了页面） ----
  let h11Bad = 0;
  try {
    const savedTab = await js('state.instTab');
    const probeDir = await js('state.config.gameDir || "."');

    // ① 整个页面切走了：body 已从文档摘下，加载回来必须安静退出，不抛错、不写入
    const a = await js(`(async () => {
      const detached = document.createElement('div');
      state.instTab = 'screenshots';
      let err = '';
      try { await loadScreenshotsTab({}, ${JSON.stringify(probeDir)}, detached); } catch (e) { err = e.message; }
      return { err, len: detached.innerHTML.length };
    })()`);
    const ok1 = !a.err && a.len === 0;
    if (!ok1) h11Bad++;
    console.log(`h11 切页后截图不写入 ${ok1 ? 'OK ' : 'BAD'} 异常=${a.err || '无'} 写入长度=${a.len}`);

    // ② body 还在文档里，但玩家已经点了别的标签页：不能把别人的内容覆盖掉
    const marker = '<div class="empty-tip">别的标签页的内容</div>';
    const b = await js(`(async () => {
      const live = document.createElement('div');
      document.getElementById('content').appendChild(live);
      live.innerHTML = ${JSON.stringify(marker)};
      state.instTab = 'logs';
      let err = '';
      try { await loadScreenshotsTab({}, ${JSON.stringify(probeDir)}, live); } catch (e) { err = e.message; }
      const out = { err, same: live.innerHTML === ${JSON.stringify(marker)} };
      live.remove();
      return out;
    })()`);
    const ok2 = !b.err && b.same;
    if (!ok2) h11Bad++;
    console.log(`h11 切标签不覆盖别人 ${ok2 ? 'OK ' : 'BAD'} 异常=${b.err || '无'} 内容未变=${b.same}`);

    // ③ 日志页同理：整页切走后安静退出
    const c = await js(`(async () => {
      const detached = document.createElement('div');
      state.instTab = 'logs';
      let err = '';
      try { await loadLogsTab({}, ${JSON.stringify(probeDir)}, detached); } catch (e) { err = e.message; }
      return { err, len: detached.innerHTML.length };
    })()`);
    const ok3 = !c.err && c.len === 0;
    if (!ok3) h11Bad++;
    console.log(`h11 切页后日志不写入 ${ok3 ? 'OK ' : 'BAD'} 异常=${c.err || '无'} 写入长度=${c.len}`);

    await js(`state.instTab = ${JSON.stringify(savedTab || null)}`);
  } catch (e) {
    h11Bad++;
    console.log(`h11 段异常：${e.message}`);
  }
  console.log(`h11 汇总：错误 ${h11Bad}`);

  // ---- 批次 H-12：皮肤站默认地址纠错（旧配置里的 mcskin.littleservice.cn 会 404） ----
  let h12Bad = 0;
  {
    const list = config.get('skinStations') || [];
    const dead = list.filter((s) => s && typeof s.authUrl === 'string' && /littleservice\.cn/i.test(s.authUrl));
    const skin = list.find((s) => s && /LittleSkin/i.test(s.name));
    const ok = dead.length === 0 && !!skin && skin.authUrl === 'https://littleskin.cn/api/yggdrasil';
    if (!ok) h12Bad++;
    console.log(`h12 皮肤站地址已纠正 ${ok ? 'OK ' : 'BAD'} 残留错误地址=${dead.length}个 LittleSkin=${skin && skin.authUrl}`);
  }
  console.log(`h12 汇总：错误 ${h12Bad}`);

  // ---- 批次 H-13：陶瓦联机内置（二进制 / 房间号推导 / 跟真实进程联调） ----
  let h13Bad = 0;
  {
    // ① 内置二进制就位
    const exe = lanMod.bundledExe('taohua');
    const ok1 = !!exe && fs.existsSync(exe);
    if (!ok1) h13Bad++;
    console.log(`h13 内置陶瓦二进制 ${ok1 ? 'OK ' : 'BAD'} ${exe || '(缺失)'}`);

    // ② 工具卡片能把内置认出来
    const th = lanMod.detect().tools.find((t) => t.id === 'taohua');
    const ok2 = !!th && th.found && th.bundled;
    if (!ok2) h13Bad++;
    console.log(`h13 卡片识别内置 ${ok2 ? 'OK ' : 'BAD'} found=${th && th.found} bundled=${th && th.bundled}`);

    // ③ 房间名 → 房间号：格式、字符集、确定性
    const codeA = terracotta.roomCodeFromName('我的联机小窝');
    const codeB = terracotta.roomCodeFromName('别的房间');
    const shape = /^U\/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
    const ok3 = shape.test(codeA)
      && terracotta.roomCodeFromName('我的联机小窝') === codeA
      && codeA !== codeB
      && !/[IO]/.test(codeA);           // 官方字符集里没有 I 和 O
    if (!ok3) h13Bad++;
    console.log(`h13 房间号推导 ${ok3 ? 'OK ' : 'BAD'} ${codeA} / ${codeB}`);

    // ④ 归一化：房间号原样透传（大小写 / 前后缀都认），房间名走推导
    const ok4 = terracotta.normalizeRoom(codeA.toLowerCase()) === codeA
      && terracotta.normalizeRoom(`房间号是 ${codeA} 谢谢`) === codeA
      && terracotta.normalizeRoom('我的联机小窝') === codeA
      && terracotta.normalizeRoom('   ') === '';
    if (!ok4) h13Bad++;
    console.log(`h13 房间号归一化 ${ok4 ? 'OK ' : 'BAD'}`);

    // ⑤ 跟真实进程联调：官方接受我们推出来的房间号，非法房间号被拒
    try {
      const port = await terracotta.ensureStarted();
      const probe = (p) => new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => req.destroy(new Error('超时')));
      });
      const good = await probe(`/state/guesting?room=${encodeURIComponent(codeA)}&player=SMOKE`);
      const bad = await probe('/state/guesting?room=not-a-room-code');
      await probe('/state/ide');       // 立刻退房，别让冒烟测试挂着一个真房间
      const ok5 = port > 0 && good === 200 && bad === 400;
      if (!ok5) h13Bad++;
      console.log(`h13 官方接口联调 ${ok5 ? 'OK ' : 'BAD'} 端口=${port} 合法号=${good} 非法号=${bad}`);
    } catch (e) {
      h13Bad++;
      console.log(`h13 官方接口联调 BAD 异常=${e.message}`);
    }
  }
  console.log(`h13 汇总：错误 ${h13Bad}`);

  // ---- 批次 H-14：EasyTier 联机内置（二进制 / 房间号推导 / 名字与房间号必须落到同一个网络） ----
  let h14Bad = 0;
  {
    // ① 内置二进制就位（core 负责组网，cli 负责查状态，wintun 是 TUN 模式的驱动）
    const core = easytier.exePath();
    const cli = easytier.cliPath();
    const wintun = core ? path.join(path.dirname(core), 'wintun.dll') : '';
    const ok1 = !!core && fs.existsSync(core) && !!cli && fs.existsSync(cli)
      && !!wintun && fs.existsSync(wintun);
    if (!ok1) h14Bad++;
    console.log(`h14 内置 EasyTier 二进制 ${ok1 ? 'OK ' : 'BAD'} core=${core || '(缺失)'} cli=${cli || '(缺失)'}`);

    // ② 工具卡片能把内置认出来
    const et = lanMod.detect().tools.find((t) => t.id === 'easytier');
    const ok2 = !!et && et.found && et.bundled;
    if (!ok2) h14Bad++;
    console.log(`h14 卡片识别内置 ${ok2 ? 'OK ' : 'BAD'} found=${et && et.found} bundled=${et && et.bundled}`);

    // ③ 房间名 → 房间号：格式合法、确定、互不相同，中文名字也要能推导出来
    const shape = /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
    const netA = easytier.networkOf('我的联机小窝');
    const netA2 = easytier.networkOf('我的联机小窝');
    const netB = easytier.networkOf('别的房间');
    const ok3 = !!netA && shape.test(netA.code) && !/[IO]/.test(netA.code)
      && netA2 && netA.code === netA2.code && netA.name === netA2.name && netA.secret === netA2.secret
      && netB && netB.name !== netA.name;
    if (!ok3) h14Bad++;
    console.log(`h14 房间号推导 ${ok3 ? 'OK ' : 'BAD'} ${netA && netA.code} / ${netB && netB.code}`);

    // ④ 关键回归：房主拿房间名建房、朋友拿「房主发过去的房间号」加入，必须落到同一个网络
    const byCode = easytier.networkOf(netA.code);
    const byLoose = easytier.networkOf(`房间号是 ${netA.code.toLowerCase()} 谢谢`);
    const ok4 = !!byCode && byCode.name === netA.name && byCode.secret === netA.secret && byCode.code === netA.code
      && !!byLoose && byLoose.name === netA.name
      && easytier.networkOf('   ') === null
      && easytier.networkOf('x') === null;
    if (!ok4) h14Bad++;
    console.log(`h14 名字与房间号同网络 ${ok4 ? 'OK ' : 'BAD'} ${byCode && byCode.code}`);

    // ⑤ 公共节点参数：玩家填的排在前面，没填时内置候选顶上
    const pe = easytier.peerArgs('tcp://1.2.3.4:11010, 5.6.7.8:11010');
    const pf = easytier.peerArgs('');
    const ok5 = pe[0] === '-p' && pe[1] === 'tcp://1.2.3.4:11010'
      && pe.join(' ').includes('tcp://5.6.7.8:11010')      // 没写协议头的自动补 tcp://
      && pf.length > 0 && pf.join(' ').includes(easytier.SHARED_NODES[0]);
    if (!ok5) h14Bad++;
    console.log(`h14 公共节点参数 ${ok5 ? 'OK ' : 'BAD'} 自定义=${pe.length / 2} 兜底=${pf.length / 2}`);

    // ⑥ 二进制真的能跑（不是个坏文件）
    try {
      const { execFileSync } = require('child_process');
      const out = String(execFileSync(core, ['--version'], { timeout: 15000, windowsHide: true })).trim();
      const ok6 = /\d+\.\d+\.\d+/.test(out);
      if (!ok6) h14Bad++;
      console.log(`h14 二进制可执行 ${ok6 ? 'OK ' : 'BAD'} ${out}`);
    } catch (e) {
      h14Bad++;
      console.log(`h14 二进制可执行 BAD 异常=${e.message}`);
    }
  }
  console.log(`h14 汇总：错误 ${h14Bad}`);

  // ---- 批次 H-15：内置浏览器（类型分流 / 收藏栏 / 下载保存方式 / 窗口单例） ----
  let h15Bad = 0;
  {
    // ① 网页下载按文件名分流到当前实例的对应目录
    const cases = [
      ['https://x.com/a/Sodium.jar', 'mods'],
      ['https://x.com/a/光影包.zip?t=1', 'shaderpacks'],
      ['https://x.com/datapack/foo.zip', 'datapacks'],
      ['https://x.com/a/Ore.zip', 'resourcepacks'],
      ['https://x.com/a/house.schem', 'schematics'],
      ['https://x.com/a/pack.mrpack', ''],          // 整合包得走导入，不能直接丢进实例
    ];
    const got = cases.map(([u]) => browserMod.classify(u, '').dir);
    const ok1 = got.join('|') === cases.map((c) => c[1]).join('|');
    if (!ok1) h15Bad++;
    console.log(`h15 下载类型分流 ${ok1 ? 'OK ' : 'BAD'} ${got.map((d) => d || '(下载目录)').join(', ')}`);

    // ② 认不出来的东西不许报错，一律落启动器下载目录
    const odd = browserMod.classify('https://x.com/a/readme.txt', '');
    const ok2 = odd.dir === '' && odd.kind === 'file';
    if (!ok2) h15Bad++;
    console.log(`h15 未知类型兜底 ${ok2 ? 'OK ' : 'BAD'} kind=${odd.kind} dir=${odd.dir || '(下载目录)'}`);

    // ③ 默认收藏栏：查资料 / 找资源 / 登录都得有入口
    const marks = browserMod.bookmarks();
    const ok3 = marks.length >= 4
      && marks.some((m) => /mcmod\.cn/.test(m.url))
      && marks.some((m) => /curseforge\.com/.test(m.url))
      && marks.some((m) => /modrinth\.com/.test(m.url))
      && marks.some((m) => /littleskin\.cn/.test(m.url));
    if (!ok3) h15Bad++;
    console.log(`h15 默认收藏栏 ${ok3 ? 'OK ' : 'BAD'} ${marks.map((m) => m.name).join(' / ')}`);

    // ④ 收藏栏可写、脏数据会被滤掉、清空后不被默认值顶回来
    const beforeMarks = config.get('browserBookmarks');
    const saved = browserMod.setBookmarks([
      { name: 'MC 百科', url: 'https://www.mcmod.cn/' },
      { name: '坏数据', url: 'javascript:alert(1)' },
      { name: '缺地址' },
    ]);
    const ok4 = saved.length === 1 && saved[0].url === 'https://www.mcmod.cn/'
      && browserMod.bookmarks().length === 1;
    if (!ok4) h15Bad++;
    console.log(`h15 收藏栏写入与过滤 ${ok4 ? 'OK ' : 'BAD'} 保留=${saved.length}`);
    const ok5 = browserMod.setBookmarks([]).length === 0 && browserMod.bookmarks().length === 0;
    if (!ok5) h15Bad++;
    console.log(`h15 收藏栏可清空 ${ok5 ? 'OK ' : 'BAD'}`);
    config.set('browserBookmarks', beforeMarks);

    // ⑤ 下载保存方式：默认自动分流，非法值要拒绝
    const ok6 = browserMod.MODES.join(',') === 'auto,ask,queue' && browserMod.downloadMode() === 'auto';
    if (!ok6) h15Bad++;
    console.log(`h15 下载保存方式默认值 ${ok6 ? 'OK ' : 'BAD'} ${browserMod.downloadMode()}`);
    const beforeMode = config.get('browserDownloadMode');
    browserMod.setDownloadMode('queue');
    let rejected = false;
    try { browserMod.setDownloadMode('乱填'); } catch { rejected = true; }
    const ok7 = browserMod.downloadMode() === 'queue' && rejected;
    if (!ok7) h15Bad++;
    console.log(`h15 下载保存方式校验 ${ok7 ? 'OK ' : 'BAD'} rejected=${rejected}`);
    config.set('browserDownloadMode', beforeMode);

    // ⑥ 窗口是单例：这会儿不该开着，接口齐全，登录态走持久化分区
    const ok8 = browserMod.isOpen() === false
      && typeof browserMod.open === 'function'
      && typeof browserMod.windowAction === 'function'
      && browserMod.info().partition === 'persist:cmbrowser';
    if (!ok8) h15Bad++;
    console.log(`h15 窗口单例与持久化分区 ${ok8 ? 'OK ' : 'BAD'} ${browserMod.info().partition}`);

    // ⑨ 账号登录走内置浏览器：设备码面板的「打开」按钮不再甩给系统浏览器
    await js(`renderPage('account')`);
    await sleep(400);
    const dc = JSON.parse(await js(`JSON.stringify((function () {
      const btn = document.querySelector('#dc-open');
      return { label: btn ? btn.textContent.trim() : '', hint: (document.querySelector('#device-code-panel div') || {}).textContent || '' };
    })())`));
    const ok9 = dc.label.includes('内置浏览器') && dc.hint.includes('内置浏览器');
    if (!ok9) h15Bad++;
    console.log(`h15 登录走内置浏览器 ${ok9 ? 'OK ' : 'BAD'} 按钮="${dc.label}"`);

    // ⑩ 设备码一到手就自动在内置浏览器打开授权页（只开一次），不再需要玩家再点一次
    const appSrc = require('fs').readFileSync(require('path').join(__dirname, 'src/renderer/app.js'), 'utf8');
    const autoBlock = appSrc.slice(appSrc.indexOf("api.onDeviceCode"), appSrc.indexOf("api.onDeviceCode") + 1400);
    const ok10 = /!autoOpened\s*&&\s*info\.verificationUri/.test(autoBlock)
      && /autoOpened\s*=\s*true/.test(autoBlock)
      && /api\.browserOpen\(info\.verificationUri\)/.test(autoBlock);
    if (!ok10) h15Bad++;
    console.log(`h15 设备码自动开内置浏览器 ${ok10 ? 'OK ' : 'BAD'}`);
  }
  console.log(`h15 汇总：错误 ${h15Bad}`);

  // ---- 批次 H-16：联机优化（公共节点自动优选 / 下载源接线） ----
  let h16Bad = 0;
  {
    // ① 节点清单：玩家填了就只用玩家填的（顺带去重），没填才退回内置候选
    const beforeNodes = config.get('easytierNodes');
    config.set('easytierNodes', []);
    const mine = easytier.nodeList('tcp://1.2.3.4:11010 tcp://1.2.3.4:11010 5.6.7.8:11010');
    const fallback = easytier.nodeList('');
    const ok1 = mine.length === 2 && mine[0] === 'tcp://1.2.3.4:11010'
      && mine[1] === 'tcp://5.6.7.8:11010'
      && !mine.includes(easytier.SHARED_NODES[0])
      && fallback.includes(easytier.SHARED_NODES[0]);
    if (!ok1) h16Bad++;
    console.log(`h16 节点清单去重与兜底 ${ok1 ? 'OK ' : 'BAD'} 自定义=${mine.length} 兜底=${fallback.length}`);
    config.set('easytierNodes', beforeNodes);

    // ② 地址解析：端口缺省补 11010；认不出来的地址返回 null，不许抛
    const pa = easytier.parseNode('tcp://1.2.3.4:1234');
    const pb = easytier.parseNode('udp://example.com');
    const ok2 = pa && pa.host === '1.2.3.4' && pa.port === 1234
      && pb && pb.scheme === 'udp' && pb.port === 11010
      && easytier.parseNode('这不是地址') === null;
    if (!ok2) h16Bad++;
    console.log(`h16 节点地址解析 ${ok2 ? 'OK ' : 'BAD'} ${pa && pa.host}:${pa && pa.port} / 缺省端口 ${pb && pb.port}`);

    // ③ 探测成功路径：拿本机临时端口当节点，连通与延迟都要量出来
    const srvLive = net.createServer((c) => c.end());
    await new Promise((r) => srvLive.listen(0, '127.0.0.1', r));
    const livePort = srvLive.address().port;
    const live = await easytier.probeNode(`tcp://127.0.0.1:${livePort}`, 1500);
    const ok3 = live.ok === true && live.port === livePort && Number.isFinite(live.ms) && live.ms >= 0;
    if (!ok3) h16Bad++;
    console.log(`h16 节点探测成功路径 ${ok3 ? 'OK ' : 'BAD'} ${live.ms}ms`);

    // ④ 探测失败路径：端口关掉后判不通并给出说法，而不是抛异常
    const srvDead = net.createServer((c) => c.end());
    await new Promise((r) => srvDead.listen(0, '127.0.0.1', r));
    const deadPort = srvDead.address().port;
    await new Promise((r) => srvDead.close(r));
    const dead = await easytier.probeNode(`tcp://127.0.0.1:${deadPort}`, 1500);
    const ok4 = dead.ok === false && dead.note === '端口没开';
    if (!ok4) h16Bad++;
    console.log(`h16 节点探测失败路径 ${ok4 ? 'OK ' : 'BAD'} ${dead.note}`);

    // ④b 失败原因要给中文说法，别把 ENOTFOUND 这类错误码直接甩给玩家
    const bogus = await easytier.probeNode('tcp://no-such-node.invalid:11010', 3000);
    const ok4b = bogus.ok === false && !!bogus.note && /[\u4e00-\u9fa5]/.test(bogus.note) && !/^E[A-Z]+$/.test(bogus.note);
    if (!ok4b) h16Bad++;
    console.log(`h16 失败原因中文化 ${ok4b ? 'OK ' : 'BAD'} ${bogus.note}`);

    // ⑤ UDP 节点没法预先握手，只能标「不适用」，不能混作「不通」
    const udp = await easytier.probeNode('udp://1.2.3.4:11010');
    const ok5 = udp.ok === false && udp.unknown === true;
    if (!ok5) h16Bad++;
    console.log(`h16 UDP 节点标记 ${ok5 ? 'OK ' : 'BAD'} unknown=${udp.unknown}`);

    // ⑥ 排序：死的故意放前面，能连的也必须被排到最前
    const urlLive = `tcp://127.0.0.1:${livePort}`;
    const urlDead = `tcp://127.0.0.1:${deadPort}`;
    const ranked = await easytier.probeNodes([urlDead, urlLive]);
    const ok6 = ranked.length === 2 && ranked[0].url === urlLive && ranked[0].ok === true && ranked[1].ok === false;
    if (!ok6) h16Bad++;
    console.log(`h16 节点按连通性排序 ${ok6 ? 'OK ' : 'BAD'} ${ranked.map((p) => (p.ok ? '通' : '死')).join('→')}`);
    await new Promise((r) => srvLive.close(r));

    // ⑦ 全不通时要给出「自己填中转地址」的信号，且状态里带上探测结果
    const sum = await easytier.probe(urlDead);
    const ok7 = sum.probes.length === 1 && sum.allDown === true && sum.manual === true
      && Array.isArray(easytier.getState().probes) && easytier.getState().probes.length === 1;
    if (!ok7) h16Bad++;
    console.log(`h16 全不通提示信号 ${ok7 ? 'OK ' : 'BAD'} allDown=${sum.allDown} manual=${sum.manual}`);

    // ⑧ 下载源接线：红石联机可一键获取，Sakura Frp 只给官方下载页
    const lanTools = lanMod.detect().tools;
    const rs = lanTools.find((t) => t.id === 'redstone') || {};
    const sk = lanTools.find((t) => t.id === 'sakura') || {};
    const ok8 = rs.auto === true && sk.auto !== true && /^https:\/\/www\.natfrp\.com\//.test(sk.page || '');
    if (!ok8) h16Bad++;
    console.log(`h16 下载源接线 ${ok8 ? 'OK ' : 'BAD'} 红石自动=${rs.auto} Sakura页=${sk.page || '(无)'}`);
  }
  console.log(`h16 汇总：错误 ${h16Bad}`);

  // ---- 批次 H-17：玻璃材质三档 + 可拉液态玻璃 ----
  let h17Bad = 0;
  {
    const M = glassMotion.MATERIALS;
    const P = glassMotion.PRESETS;

    // ① 参数表：三档（透明 / 亚克力 / 不透明）。透明档是「完全透明」——
    //    通透度拉满（g=100，面板底色算出来正好 0），轮廓交给样式里的亮边 + 镜面高光。
    const ok1 = P.length === 3 && P.join(',') === 'clear,acrylic,solid' && !('transparent' in M)
      && P.every((id) => Number.isFinite(M[id].g) && M[id].g >= 0 && M[id].g <= 100)
      && M.clear.g === 100 && M.clear.blurK > 0 && M.clear.blurK < 1 && M.clear.grain === false
      && M.acrylic.g === 45 && M.acrylic.blurK > 1 && M.acrylic.grain === true
      && M.solid.blurK === 0 && M.solid.g < 70 && M.acrylic.g < 70
      && M.custom.g === null && M.custom.blurK === 1 && M.custom.grain === false;
    if (!ok1) h17Bad++;
    console.log(`h17 三档参数表 ${ok1 ? 'OK ' : 'BAD'} ${P.map((id) => `${M[id].label} g=${M[id].g} k=${M[id].blurK} 噪点=${M[id].grain}`).join(' · ')}`);

    // ② 档位派生：正好落在代表值才算该档；100→透明、45→亚克力、4→不透明，其余派生不出档
    const ok2 = glassMotion.materialForLevel(100) === 'clear'
      && glassMotion.materialForLevel(85) === null
      && glassMotion.materialForLevel(45) === 'acrylic'
      && glassMotion.materialForLevel(88) === null
      && glassMotion.materialForLevel(4) === 'solid'
      && glassMotion.materialForLevel(55) === null
      && glassMotion.materialForLevel(44) === null;
    if (!ok2) h17Bad++;
    console.log(`h17 档位派生 ${ok2 ? 'OK ' : 'BAD'} 100→${glassMotion.materialForLevel(100)} 85→${glassMotion.materialForLevel(85)} 45→${glassMotion.materialForLevel(45)} 88→${glassMotion.materialForLevel(88)} 55→${glassMotion.materialForLevel(55)} 44→${glassMotion.materialForLevel(44)}`);

    // ③ 非法 / 过时 / 自相矛盾的配置回落（含旧键清理）
    const dirty = config.sanitize({ ui: { glassMaterial: '乱填', glass: 'acrylic', glassLevel: 200 } });
    const legal = config.sanitize({ ui: { glassMaterial: 'acrylic', glassLevel: 45 } });
    const cleared = config.sanitize({ ui: { glassMaterial: 'clear', glassLevel: 100 } });      // 新档：合法，必须留得住
    const gone = config.sanitize({ ui: { glassMaterial: 'transparent', glassLevel: 88 } });   // 早期叫 transparent 的旧档名
    const mismatch = config.sanitize({ ui: { glassMaterial: 'acrylic', glassLevel: 55 } });   // 档位与滑杆打架
    const clearMis = config.sanitize({ ui: { glassMaterial: 'clear', glassLevel: 88 } });     // 透明档与滑杆打架
    const ok3 = dirty.ui.glassMaterial === 'custom' && !('glass' in dirty.ui) && dirty.ui.glassLevel === 100
      && legal.ui.glassMaterial === 'acrylic' && cleared.ui.glassMaterial === 'clear'
      && gone.ui.glassMaterial === 'custom'
      && mismatch.ui.glassMaterial === 'custom' && clearMis.ui.glassMaterial === 'custom'
      && glassMotion.normalizeMaterial('乱填') === 'custom';
    if (!ok3) h17Bad++;
    console.log(`h17 非法配置回落 ${ok3 ? 'OK ' : 'BAD'} ${dirty.ui.glassMaterial} / 旧键已删=${!('glass' in dirty.ui)} / 合法=${legal.ui.glassMaterial} / 透明档=${cleared.ui.glassMaterial} / 旧档名=${gone.ui.glassMaterial} / 档位打架=${mismatch.ui.glassMaterial}/${clearMis.ui.glassMaterial}`);

    // ④ 静止与退化输入
    const still = glassMotion.jellyTransform({ dx: 0, dy: 0, w: 300, h: 200 });
    const zeroSize = glassMotion.jellyTransform({ dx: 40, dy: 0, w: 0, h: 0 });
    const empty = glassMotion.jellyTransform();
    const noNaN = (j) => ['tx', 'ty', 'a', 'b', 'tilt', 'dir'].every((k) => Number.isFinite(j[k]))
      && !/NaN|undefined/.test(j.transform);
    const ok4 = still.a === 1 && still.b === 1 && still.tx === 0 && still.ty === 0 && still.tilt === 0
      && still.transform === 'translate3d(0px, 0px, 0) rotate(0deg) scale(1, 1)'
      && zeroSize.transform === still.transform && empty.transform === still.transform
      && noNaN(still) && noNaN(zeroSize) && noNaN(empty);
    if (!ok4) h17Bad++;
    console.log(`h17 静止与退化输入 ${ok4 ? 'OK ' : 'BAD'} 静止="${still.transform}"`);

    // ⑤ 变形上限
    const W = 300;
    const H = 200;
    const span = Math.hypot(W, H);
    const big = glassMotion.jellyTransform({ dx: 5000, dy: -5000, w: W, h: H });
    const ok5 = big.a <= 1.0301 && big.b >= 0.9799 && Math.abs(big.tilt) <= 0.8
      && Math.abs(big.tx) <= span * 0.04 + 1e-6 && Math.abs(big.ty) <= span * 0.04 + 1e-6;
    if (!ok5) h17Bad++;
    console.log(`h17 变形上限 ${ok5 ? 'OK ' : 'BAD'} scale=${big.a}/${big.b} tilt=${big.tilt} 位移=${big.tx}/${big.ty} 上限=${(span * 0.04).toFixed(2)}`);

    // ⑥ 方向性：横着拖拉宽、竖着拖拉高
    const right = glassMotion.jellyTransform({ dx: 120, dy: 0, w: W, h: H });
    const up = glassMotion.jellyTransform({ dx: 0, dy: -120, w: W, h: H });
    const ok6 = right.tx > 0 && right.ty === 0 && right.a > 1 && right.b < 1
      && up.ty < 0 && up.tx === 0 && up.b > 1 && up.a < 1;
    if (!ok6) h17Bad++;
    console.log(`h17 方向性 ${ok6 ? 'OK ' : 'BAD'} 右拉 a=${right.a} b=${right.b} · 上拉 a=${up.a} b=${up.b}`);

    // ⑦ transform 串一致性
    const ok7 = /^translate3d\(/.test(big.transform)
      && big.transform.includes(`scale(${big.a}, ${big.b})`)
      && !/NaN|undefined/.test(big.transform);
    if (!ok7) h17Bad++;
    console.log(`h17 transform 串 ${ok7 ? 'OK ' : 'BAD'} ${big.transform}`);

    // ⑧⑨ 亚克力接线 / 滑杆微调（真设置页）
    await js(`document.querySelectorAll('.modal-mask, .shot-viewer').forEach((n) => n.remove()); renderPage('settings')`);
    await sleep(700);
    await js(`(() => {
      document.body.dataset.focus = '1';   // 冒烟窗口可能不带焦点，先当作前台算令牌
      const b = document.querySelector('#ui-material [data-material="acrylic"]');
      if (b) b.click();
    })()`);
    await sleep(500);
    const ac = JSON.parse(await js(`JSON.stringify((function () {
      const bs = getComputedStyle(document.body);
      const el = document.querySelector('.panel, .card, .glass');
      const cs = el ? getComputedStyle(el) : null;
      const bf = (cs && (cs.backdropFilter || cs.webkitBackdropFilter)) || '';
      const mi = bf.indexOf('blur(');
      const sp = document.querySelector('#ui-material [data-role="custom"]');
      return {
        material: document.body.getAttribute('data-material'),
        g: bs.getPropertyValue('--g').trim(),
        k: bs.getPropertyValue('--glass-blur-k').trim(),
        transparent: document.body.getAttribute('data-transparent'),
        slider: (document.getElementById('ui-glass') || {}).value,
        val: (document.getElementById('ui-glass-val') || {}).textContent,
        on: Array.from(document.querySelectorAll('#ui-material .ui-opt.on')).map((n) => n.textContent).join(','),
        customHidden: sp ? sp.hidden : null,
        bg: cs ? cs.backgroundImage : '',
        blur: mi >= 0 ? parseFloat(bf.slice(mi + 5)) : -1,
        bf: bf
      };
    })())`));
    const ok8 = ac.material === 'acrylic' && ac.g === '0.45' && ac.k === '1.7' && ac.transparent === '0'
      && ac.slider === '45' && /45%/.test(ac.val || '') && ac.on === '亚克力' && ac.customHidden === true
      && /svg/.test(ac.bg) && ac.blur >= 20 && ac.blur <= 39;
    if (!ok8) h17Bad++;
    console.log(`h17 亚克力接线 ${ok8 ? 'OK ' : 'BAD'} material=${ac.material} g=${ac.g} k=${ac.k} 透明档=${ac.transparent} 滑杆=${ac.slider}(v=${ac.val}) 点亮=${ac.on} 自定义隐藏=${ac.customHidden} 噪点=${/svg/.test(ac.bg)} blur=${ac.blur}`);

    await js(`(() => {
      const s = document.getElementById('ui-glass');
      s.value = '55';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(400);
    const tuned = JSON.parse(await js(`JSON.stringify((function () {
      const bs = getComputedStyle(document.body);
      const sp = document.querySelector('#ui-material [data-role="custom"]');
      return {
        on: document.querySelectorAll('#ui-material .ui-opt.on').length,
        customHidden: sp ? sp.hidden : null,
        k: bs.getPropertyValue('--glass-blur-k').trim(),
        material: document.body.getAttribute('data-material'),
        g: bs.getPropertyValue('--g').trim()
      };
    })())`));
    // 亚克力只认 45% 这个点：滑杆一挪到 55 → 档位熄灭、回落「自定义」，
    // 模糊倍率也跟着回到 custom 的 1（不会留下「写着亚克力、值却是 55%」的矛盾）
    const ok9 = tuned.on === 0 && tuned.customHidden === false
      && tuned.k === '1' && tuned.material === 'custom' && tuned.g === '0.55';
    if (!ok9) h17Bad++;
    console.log(`h17 滑杆微调 ${ok9 ? 'OK ' : 'BAD'} 点亮档数=${tuned.on} 自定义显形=${tuned.customHidden === false} k=${tuned.k} material=${tuned.material} g=${tuned.g}`);

    // ⑫ 三档按钮齐全；「完全透明」指的是卡片与侧栏，不是窗口：
    //    通透度拉满时 --panel-a 算出来正好 0（卡片/侧栏一点底色都不留，背景原样透出来），
    //    而窗口底色恒定实心（不透桌面、截图不带 alpha）。
    //    侧栏还得是苹果那种圆角浮岛：圆角够大 + 四边有描边。
    const tr = JSON.parse(await js(`JSON.stringify((function () {
      const alpha = (c) => {
        const m = String(c).match(/rgba?\\(([^)]+)\\)/);
        if (!m) return 1;
        const p = m[1].split(',').map((x) => parseFloat(x));
        return p.length >= 4 ? p[3] : 1;
      };
      // --panel-a 是没注册的自定义属性，读出来是不化简的表达式（拉满时是 "calc(1 - 1)"），
      // 自己按 +-*/ 算一下。这段在模板字符串里，正则里的反斜杠会被吃掉，所以别用转义。
      const panelA = () => {
        const raw = getComputedStyle(document.body).getPropertyValue('--panel-a').trim();
        if (raw.indexOf('calc(') !== 0 || raw.slice(-1) !== ')') return NaN;
        const body = raw.slice(5, -1).trim();
        const i = body.search(/[-+*/]/);
        const x = parseFloat(body);
        if (i < 0) return x;
        const op = body.charAt(i);
        const y = parseFloat(body.slice(i + 1));
        if (op === '-') return x - y;
        if (op === '+') return x + y;
        if (op === '*') return x * y;
        return x / y;
      };
      const chips = Array.from(document.querySelectorAll('#ui-material [data-material]')).map((b) => b.getAttribute('data-material'));
      const s = document.querySelector('#ui-glass');
      const nav = document.querySelector('.sidenav');
      const snap = () => {
        const bs = getComputedStyle(document.body);
        const ns = nav ? getComputedStyle(nav) : null;
        return {
          appA: bs.getPropertyValue('--app-a').trim(),
          bgAlpha: alpha(bs.backgroundColor),
          panelA: panelA(),
          navAlpha: ns ? alpha(ns.backgroundColor) : -1,
          navRadius: ns ? parseFloat(ns.borderTopLeftRadius) : -1,
          navBorder: ns ? (ns.borderTopStyle + '/' + parseFloat(ns.borderTopWidth)) : ''
        };
      };
      s.value = '100';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      const full = snap();
      // 量完落回 55%，顺便当作「平时仍留底」的守卫样本，也不影响后面的批次
      s.value = '55';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      const norm = snap();
      return {
        chips: chips,
        chipCount: chips.length,
        hasClearBtn: !!document.querySelector('#ui-material [data-material="clear"]'),
        full: full,
        norm: norm
      };
    })())`));
    const ok12 = tr.hasClearBtn && tr.chipCount === 3
      && tr.full.panelA === 0 && tr.full.navAlpha <= 0.01
      && parseFloat(tr.full.appA) === 1 && tr.full.bgAlpha >= 0.99
      && tr.norm.panelA > 0.4 && tr.norm.navAlpha > 0.3
      && tr.norm.navRadius >= 16 && tr.norm.navBorder === 'solid/1';
    if (!ok12) h17Bad++;
    console.log(`h17 卡片/侧栏全透 + 窗口实心 ${ok12 ? 'OK ' : 'BAD'} 档位=${tr.chips.join('/')} 满值 面板底=${tr.full.panelA} 侧栏底alpha=${tr.full.navAlpha} 窗口app-a=${tr.full.appA}/alpha=${tr.full.bgAlpha} 平时 面板底=${tr.norm.panelA} 侧栏底alpha=${tr.norm.navAlpha} 侧栏圆角=${tr.norm.navRadius} 侧栏描边=${tr.norm.navBorder}`);

    // ⑫b 「透明」档实机接线：点一下 → 通透度拉满（面板底色算出来正好 0、侧栏也全透）
    //     + 一圈亮边 + 镜面高光 —— 卡片/侧栏本身全透，轮廓全靠亮边托住
    await js(`(() => {
      document.body.dataset.focus = '1';
      const b = document.querySelector('#ui-material [data-material="clear"]');
      if (b) b.click();
    })()`);
    await sleep(500);
    const cl = JSON.parse(await js(`JSON.stringify((function () {
      const bs = getComputedStyle(document.body);
      const el = document.querySelector('.panel, .card, .glass');
      const cs = el ? getComputedStyle(el) : null;
      const shadow = cs ? cs.boxShadow : '';
      const before = el ? getComputedStyle(el, '::before').backgroundImage : '';
      const m = String(bs.backgroundColor).match(/rgba?\\(([^)]+)\\)/);
      const bgAlpha = m ? (m[1].split(',').map(Number)[3] ?? 1) : 1;
      return {
        material: document.body.getAttribute('data-material'),
        g: bs.getPropertyValue('--g').trim(),
        k: bs.getPropertyValue('--glass-blur-k').trim(),
        sat: bs.getPropertyValue('--glass-sat').trim(),
        transparent: document.body.getAttribute('data-transparent'),
        appA: bs.getPropertyValue('--app-a').trim(),
        // --panel-a 是没注册的自定义属性，读出来是不化简的表达式（拉满时是 "calc(1 - 1)"），
        // 这里自己按 +-*/ 算一下，真正要确认的是「面板底色归零」。
        // 注意这段代码整体在模板字符串里，正则里的反斜杠会被吃掉，所以别用转义。
        paRaw: bs.getPropertyValue('--panel-a').trim(),
        pa: (function () {
          const raw = bs.getPropertyValue('--panel-a').trim();
          if (raw.indexOf('calc(') !== 0 || raw.slice(-1) !== ')') return NaN;
          const body = raw.slice(5, -1).trim();
          const i = body.search(/[-+*/]/);
          const x = parseFloat(body);
          if (i < 0) return x;
          const op = body.charAt(i);
          const y = parseFloat(body.slice(i + 1));
          if (op === '-') return x - y;
          if (op === '+') return x + y;
          if (op === '*') return x * y;
          return x / y;
        })(),
        bgAlpha: bgAlpha,
        slider: (document.getElementById('ui-glass') || {}).value,
        on: Array.from(document.querySelectorAll('#ui-material .ui-opt.on')).map((n) => n.textContent).join(','),
        ring: (shadow.match(/inset/g) || []).length,
        mirror: /0\\.46/.test(before)
      };
    })())`));
    const ok12b = cl.material === 'clear' && cl.g === '1' && cl.k === '0.7'
      && cl.pa === 0
      && cl.transparent === '1' && /95%/.test(cl.sat)
      && parseFloat(cl.appA) === 1 && cl.bgAlpha >= 0.99
      && cl.slider === '100' && cl.on === '透明' && cl.ring >= 2 && cl.mirror === true;
    if (!ok12b) h17Bad++;
    console.log(`h17 透明档接线 ${ok12b ? 'OK ' : 'BAD'} material=${cl.material} g=${cl.g} 面板底色=${cl.paRaw}→${cl.pa} k=${cl.k} 亮边=${cl.ring}段 镜面高光=${cl.mirror} 提饱和=${/95%/.test(cl.sat)} 滑杆=${cl.slider}(${cl.on}) 窗口app-a=${cl.appA}/alpha=${cl.bgAlpha}(应=1 实心)`);
    // 回到「自定义 55%」，后面的批次（弹窗 / 指针）都在自定义档上跑，前提与从前一致
    await js(`(() => {
      const s = document.getElementById('ui-glass');
      s.value = '55';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(250);

    // ⑬ 弹窗也吃同一套玻璃：背景改成跟随 --panel-a 的渐变，且永不超出窗口
    await js(`(() => { askText('外观自检'); })()`);
    await sleep(300);
    const md = JSON.parse(await js(`JSON.stringify((function () {
      const m = document.querySelector('.modal-mask .modal');
      if (!m) return { none: true };
      const cs = getComputedStyle(m);
      // 不比字符串：多层 background-image 的序列化跟单层不同，比不了。
      // 改成行为断言——把 --g 从 0 跳到 1，弹窗背景必须跟着变，
      // 说明它吃的是 --glass-sheen 令牌链而不是写死的底色。
      const body = document.body;
      const gOrig = body.style.getPropertyValue('--g');
      body.style.setProperty('--g', '0');
      const bgSolid = getComputedStyle(m).backgroundImage;
      body.style.setProperty('--g', '1');
      const bgClear = getComputedStyle(m).backgroundImage;
      if (gOrig) body.style.setProperty('--g', gOrig);
      else body.style.removeProperty('--g');
      return {
        gradient: /gradient/.test(bgSolid),
        tokenDriven: bgSolid !== bgClear,
        cleared: /gradient/.test(bgClear),
        bgColor: cs.backgroundColor,
        mhNum: parseFloat(cs.maxHeight),
        vh: window.innerHeight,
        of: cs.overflowY,
        bf: cs.backdropFilter || cs.webkitBackdropFilter || ''
      };
    })())`));
    await js(`document.querySelectorAll('.modal-mask').forEach((n) => n.remove())`);
    const ok13 = md.none !== true && md.gradient === true && md.tokenDriven === true
      && md.cleared === true
      && md.bgColor === 'rgba(0, 0, 0, 0)' && md.mhNum > 0 && md.mhNum <= md.vh - 40
      && md.of === 'auto' && /blur\(/.test(md.bf);
    if (!ok13) h17Bad++;
    console.log(`h17 弹窗玻璃化 ${ok13 ? 'OK ' : 'BAD'} 跟随通透度=${md.tokenDriven} 底色=${md.bgColor} 限高=${md.mhNum}/${md.vh} 溢出=${md.of} blur=${/blur\(/.test(md.bf)}`);

    // ⑩ 指针交互全链路：hover → down → move → up
    const pe = JSON.parse(await js(`(async () => {
      const el = document.querySelector('.panel, .card, .glass');
      if (!el) return JSON.stringify({ skip: true });
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + 40);
      const cy = Math.round(rect.top + 30);
      const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons: 1, pointerId: 91, isPrimary: true,
      }));
      const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      fire('pointermove', cx, cy);
      await nextFrame();
      // 用户要求去掉「鼠标划过玻璃发光」：悬停不该再打高光类 / 写 --mx
      const noGlow = document.querySelectorAll('.jelly-hi').length === 0
        && !el.style.getPropertyValue('--mx') && !el.style.getPropertyValue('--my');
      fire('pointerdown', cx, cy);
      fire('pointermove', cx + 60, cy + 20);
      await nextFrame();
      const tf = el.style.transform;
      const dragging = el.classList.contains('jelly-drag') && tf.indexOf('translate3d(') === 0;
      document.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, clientX: cx + 60, clientY: cy + 20, pointerId: 91, isPrimary: true,
      }));
      await new Promise((r) => setTimeout(r, 40));
      const released = el.style.transform === '' && el.classList.contains('jelly-release');
      return JSON.stringify({ noGlow, dragging, released, tf });
    })()`));
    const ok10 = pe.noGlow === true && pe.dragging === true && pe.released === true;
    if (!ok10) h17Bad++;
    console.log(`h17 指针交互 ${ok10 ? 'OK ' : 'BAD'} 无高光=${pe.noGlow} 拖动=${pe.dragging} 回弹=${pe.released} tf="${pe.tf || ''}"`);

    // ⑪ 控件不抢事件：在按钮上拖 200px 不该出现可拉
    await js(`(() => {
      const btn = document.querySelector('#btn-wall-reset') || document.querySelector('.btn');
      const r = btn.getBoundingClientRect();
      const x = Math.round(r.left + 5);
      const y = Math.round(r.top + 5);
      const fire = (type, px, py) => btn.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons: 1, pointerId: 92, isPrimary: true,
      }));
      fire('pointerdown', x, y);
      fire('pointermove', x + 200, y);
    })()`);
    await sleep(80);
    const dragged = await js(`document.querySelectorAll('.jelly-drag').length`);
    await js(`document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 92, isPrimary: true }))`);
    const ok11 = dragged === 0;
    if (!ok11) h17Bad++;
    console.log(`h17 控件不抢事件 ${ok11 ? 'OK ' : 'BAD'} 拖动中的玻璃元素=${dragged}`);

    // 还原外观配置：冒烟不该改用户的设置
    await js(`(() => {
      state.config.ui = ${uiBefore};
      document.body.dataset.focus = ${JSON.stringify(focusBefore)};
      applyGlass();
    })()`);
    await js(`api.configUpdate({ ui: state.config.ui })`);
    await sleep(200);
  }
  console.log(`h17 汇总：错误 ${h17Bad}`);

  // ---- 批次 H-18：内存清理 / 自动分配 PCL2 化 ----
  let h18Bad = 0;
  {
    // ① 主进程读数单位：早先把 getProcessMemoryInfo 的 KB 当字节又除了两次 1024，
    //    「启动器占用」恒为 0 —— 这里就是那个回归守卫。
    const mi = memoryMod.getMemoryInfo();
    const ok1 = mi.totalMB > 0 && mi.processMB > 0 && mi.processMB <= mi.totalMB
      && mi.usedMB > 0 && mi.freeMB > 0
      && Math.abs(mi.usedMB + mi.freeMB - mi.totalMB) <= 2
      && mi.usedPercent > 0 && mi.usedPercent < 100;
    if (!ok1) h18Bad++;
    console.log(`h18 读数单位 ${ok1 ? 'OK ' : 'BAD'} 总=${mi.totalMB}MB 已用=${mi.usedMB}MB 启动器占用=${mi.processMB}MB（回归守卫：之前恒为0）`);

    // ② 推荐梯度对齐 PCL2：按物理内存分档、封在物理内存一半、向下对齐 256
    const rec = memoryMod.recommendMemory();
    const ladderUp = memoryMod.LADDER.every((s, i, a) => i === 0 || s.mem >= a[i - 1].mem);
    const ok2 = rec.recommended >= 1024 && rec.recommended <= Math.floor(rec.totalMB / 2)
      && rec.recommended % 256 === 0 && rec.minRecommended % 128 === 0
      && rec.minRecommended >= 512 && rec.minRecommended < rec.recommended
      && typeof rec.band === 'string' && rec.band.length > 0
      && rec.totalGB > 0 && ladderUp;
    if (!ok2) h18Bad++;
    console.log(`h18 推荐梯度 ${ok2 ? 'OK ' : 'BAD'} ${rec.totalGB}GB（${rec.band}档）→ 最大=${rec.recommended}MB 最小=${rec.minRecommended}MB 上限=${rec.limitMB}MB 单调=${ladderUp}`);

    // ③ 清理真释放：appBeforeMB 必须是真实读数，freedMB 不能再是恒 0 的假数字
    const cl = await memoryMod.cleanMemory();
    const ok3 = cl.appBeforeMB > 0 && cl.appBeforeMB <= mi.totalMB
      && Number.isFinite(cl.freedMB) && cl.freedMB >= 0 && cl.freedMB <= cl.appBeforeMB
      && Number.isFinite(cl.appAfterMB) && Number.isFinite(cl.systemFreedMB)
      && Array.isArray(cl.actions);
    if (!ok3) h18Bad++;
    console.log(`h18 清理真释放 ${ok3 ? 'OK ' : 'BAD'} ${cl.appBeforeMB}MB → ${cl.appAfterMB}MB 释放=${cl.freedMB}MB 自身进程=${cl.selfTrimmed} 系统=${cl.sysTrimmed} 动作=${cl.actions.join('+') || '(无)'}`);

    // ③-b 指定等级清理（二级：不提权、不弹 UAC；三级起会弹 UAC 不能在自检里跑）
    const cl2 = await memoryMod.cleanMemory(2);
    const ok3b = cl2.level === 2 && cl2.elevated === false && cl2.cancelled === false
      && Number.isFinite(cl2.systemFreedMB) && cl2.systemFreedMB >= 0
      && Array.isArray(cl2.actions) && cl2.actions.includes('workingset');
    if (!ok3b) h18Bad++;
    console.log(`h18 二级清理 ${ok3b ? 'OK ' : 'BAD'} 等级=${cl2.level} 提权=${cl2.elevated} 系统释放=${cl2.systemFreedMB}MB 修剪进程=${cl2.sysTrimmed} 动作=${cl2.actions.join('+') || '(无)'}`);

    // ④ 内存条结构：PCL2 式刻度 / 计划标记 / 百分比徽章都在，占用不再是 0MB
    await js(`renderPage('settings')`);
    await sleep(700);
    const bar = JSON.parse(await js(`JSON.stringify((function () {
      const q = (s) => document.querySelector(s);
      const g = q('#mem-gauge');
      const tick = q('#mem-ticks');
      return {
        hasGauge: !!g, hasTicks: !!tick, hasPlan: !!q('#mem-plan'),
        hasBadge: !!q('.mem-gauge-badge'), hasLegend: !!q('.mem-legend'),
        level: g ? (g.dataset.level || '') : '',
        seg: tick ? tick.style.getPropertyValue('--seg').trim() : '',
        fill: q('#mem-fill') ? q('#mem-fill').style.width : '',
        proc: (q('#mem-proc') && q('#mem-proc').textContent) || '',
        usedNum: (q('#mem-used-num') && q('#mem-used-num').textContent) || '',
        pct: (q('#mem-pct') && q('#mem-pct').textContent) || '',
        oldBar: !!q('.mem-bar')
      };
    })())`));
    const ok4 = bar.hasGauge && bar.hasTicks && bar.hasPlan && bar.hasBadge && bar.hasLegend
      && bar.oldBar === false
      && /^\d+(\.\d+)?%$/.test(bar.seg) && /%$/.test(bar.fill)
      && /%$/.test(bar.pct) && ['ok', 'mid', 'high'].includes(bar.level)
      && !/^(0 MB|—)$/.test(bar.proc) && !/^(0 MB|—)$/.test(bar.usedNum);
    if (!ok4) h18Bad++;
    console.log(`h18 内存条结构 ${ok4 ? 'OK ' : 'BAD'} 刻度=${bar.seg} 填充=${bar.fill} 占用=${bar.proc} 已用=${bar.usedNum} 级别=${bar.level} 旧条已删=${!bar.oldBar}`);

    // ⑤ 计划分配标记：改最大内存，内存条上的竖线跟着走
    const planVal = Math.round(mi.totalMB / 4 / 256) * 256;
    const planPct = (planVal / mi.totalMB) * 100;
    const plan = JSON.parse(await js(`JSON.stringify((function () {
      const el = document.querySelector('#mem-plan');
      const inp = document.querySelector('#set-maxmem');
      if (!el || !inp) return { skip: true };
      inp.value = ${planVal};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        left: el.style.left, disp: el.style.display,
        num: (document.querySelector('#mem-plan-num') || {}).textContent || ''
      };
    })())`));
    const planLeft = parseFloat(plan.left);
    const ok5 = plan.skip !== true && plan.disp !== 'none'
      && Math.abs(planLeft - planPct) < 2 && /GB|MB/.test(plan.num);
    if (!ok5) h18Bad++;
    console.log(`h18 计划分配标记 ${ok5 ? 'OK ' : 'BAD'} 设 ${planVal}MB → 标记 ${plan.left}（期望~${planPct.toFixed(1)}%）文案=${plan.num}`);

    // ⑥ 自动分配按钮：点一下就把推荐值填进最大 / 最小内存
    const recNow = memoryMod.recommendMemory();
    await js(`document.querySelector('#btn-auto-mem').click()`);
    await sleep(600);
    const auto = JSON.parse(await js(`JSON.stringify((function () {
      const tip = document.querySelector('#mem-recommend-tip');
      return {
        max: (document.querySelector('#set-maxmem') || {}).value || '',
        min: (document.querySelector('#set-minmem') || {}).value || '',
        tip: tip ? tip.textContent : '', tipDisp: tip ? tip.style.display : ''
      };
    })())`));
    const ok6 = String(auto.max) === String(recNow.recommended)
      && String(auto.min) === String(recNow.minRecommended)
      && auto.tipDisp === 'block' && auto.tip.includes(recNow.band) && auto.tip.includes('上限');
    if (!ok6) h18Bad++;
    console.log(`h18 自动分配按钮 ${ok6 ? 'OK ' : 'BAD'} 最大=${auto.max}（期望${recNow.recommended}）最小=${auto.min}（期望${recNow.minRecommended}）提示=${auto.tipDisp}`);

    // ⑦ 清理强度等级：6 个按钮，切换后 primary / 说明文案（三级起含 UAC 提示）跟着变
    const lv = JSON.parse(await js(`JSON.stringify((function () {
      const btns = document.querySelectorAll('#mem-levels button');
      const desc = document.querySelector('#mem-level-desc');
      btns[2].click(); // 三级
      const desc3 = desc ? desc.textContent : '';
      const primary3 = btns[2].classList.contains('primary');
      btns[0].click(); // 一级
      const desc1 = desc ? desc.textContent : '';
      return {
        n: btns.length, primary3, primary1: btns[0].classList.contains('primary'),
        descHasUac: desc3.indexOf('UAC') >= 0, descHasBoost: desc3.indexOf('增强') >= 0,
        descHasLight: desc1.indexOf('轻度') >= 0, descHasNoUac: desc1.indexOf('UAC') < 0,
      };
    })())`));
    const ok7 = lv.n === 6 && lv.primary3 && lv.primary1
      && lv.descHasUac && lv.descHasBoost && lv.descHasLight && lv.descHasNoUac;
    if (!ok7) h18Bad++;
    console.log(`h18 清理强度等级 ${ok7 ? 'OK ' : 'BAD'} 按钮=${lv.n} 三级选中=${lv.primary3}/UAC提示=${lv.descHasUac} 一级选中=${lv.primary1}/无UAC=${lv.descHasNoUac}`);

    // 还原：把自检改动的输入改回配置原值，别污染用户设置
    await js(`(() => {
      const m = document.querySelector('#set-maxmem'); if (m) m.value = state.config.maxMemory;
      const n = document.querySelector('#set-minmem'); if (n) n.value = state.config.minMemory;
    })()`);
  }
  console.log(`h18 汇总：错误 ${h18Bad}`);

  // ---- 批次 H-19：卡片可点 / 迁移手动指定 / 世界直链（修「点了没反应」这类投诉） ----
  let h19Bad = 0;
  {
    const nodeFs = require('fs');
    const nodePath = require('path');
    const appSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/renderer/app.js'), 'utf8');
    const mainSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/main/main.js'), 'utf8');

    // ① 版本管理「已安装版本」卡片：回归守卫 —— 以前是死卡片（0 按钮 0 handler），
    //    下载好的版本看得见却用不上。现在必须有三个动作 + 卡片本体 onclick。
    const iList = appSrc.indexOf("$('installed-list')");
    const listBlock = appSrc.slice(iList, iList + 2600);
    const ok1 = iList > 0
      && /data-act="use"/.test(listBlock) && /data-act="launch"/.test(listBlock)
      && /data-act="new"/.test(listBlock) && /card\.onclick\s*=/.test(listBlock)
      && /versionId: id/.test(listBlock);
    if (!ok1) h19Bad++;
    console.log(`h19 版本卡片可操作 ${ok1 ? 'OK ' : 'BAD'}（回归守卫：以前 0 按钮 0 handler）`);

    // ② 实例卡片本体点击进详情（以前只有按钮有 handler，点卡片没反应）
    const ok2 = /card\.onclick = \(e\) => \{[\s\S]{0,160}openInstance\(it\.id\)/.test(appSrc);
    if (!ok2) h19Bad++;
    console.log(`h19 实例卡片本体可点 ${ok2 ? 'OK ' : 'BAD'}`);

    // ③ 首页简洁列表整行可点即启动
    const ok3 = /row\.onclick = \(e\) => \{[\s\S]{0,140}runThis\(\)/.test(appSrc);
    if (!ok3) h19Bad++;
    console.log(`h19 首页简洁列表整行可点 ${ok3 ? 'OK ' : 'BAD'}`);

    // ④ 首页实例下拉切换后重画（换实例时版本 / 启动状态跟着变）
    const ok4 = /sel\.onchange = async \(\) => \{[\s\S]{0,220}renderPage\('home'\)/.test(appSrc);
    if (!ok4) h19Bad++;
    console.log(`h19 首页实例下拉切后重画 ${ok4 ? 'OK ' : 'BAD'}`);

    // ⑤ 迁移：「手动选择目录」入口 + 主进程 detectIn IPC（扫不到时能自己指路）
    const ok5 = /id="btn-migrate-pick"/.test(appSrc) && /api\.migrateDetectIn\(/.test(appSrc)
      && /ipcMain\.handle\('migrate:detectIn'/.test(mainSrc);
    if (!ok5) h19Bad++;
    console.log(`h19 迁移手动指定目录 ${ok5 ? 'OK ' : 'BAD'}`);

    // ⑥ 世界：直链 zip 下载进 saves + 本实例已有世界列表
    const ok6 = /id="world-url-btn"/.test(appSrc) && /api\.worldInstallUrl\(/.test(appSrc)
      && /id="world-mine"/.test(appSrc) && /ipcMain\.handle\('world:installUrl'/.test(mainSrc);
    if (!ok6) h19Bad++;
    console.log(`h19 世界直链下载与已有列表 ${ok6 ? 'OK ' : 'BAD'}`);

    // ⑦ 实机：渲染版本页，确认卡片真的有按钮、真的挂上了 onclick
    //    不依赖这份测试配置里到底装了几个版本（跑测途中有批次会临时换 gameDir），
    //    临时塞一个假的已装版本进去只看卡片结构，看完还回去。
    const live = JSON.parse(await js(`JSON.stringify((function () {
      const keep = state.installed;
      state.installed = ['1.99-smoke'];
      renderPage('versions');
      const cards = [...document.querySelectorAll('#installed-list .card')];
      const r = {
        cards: cards.length,
        withHandler: cards.filter((c) => typeof c.onclick === 'function').length,
        buttons: cards.reduce((a, c) => a + c.querySelectorAll('button').length, 0)
      };
      state.installed = keep;
      return r;
    })())`));
    const ok7 = live.cards === 1 && live.withHandler === 1 && live.buttons >= 3;
    if (!ok7) h19Bad++;
    console.log(`h19 版本页实机 ${ok7 ? 'OK ' : 'BAD'} 卡片=${live.cards} 有handler=${live.withHandler} 按钮=${live.buttons}`);

    // ⑧ 游戏目录跟随设置：默认实例不再快照 C 盘路径；改目录时实例路径整体改写
    //    （回归守卫：设置里改到 E 盘，文件却照样下载到 C 盘）
    const configMod = require('./src/main/config');
    const { app: electronApp } = require('electron');
    const oldDefaultPath = require('path').join(electronApp.getPath('appData'), '.minecraft');
    const sanitized = configMod.sanitize({
      instances: {
        default: { name: '默认', gameDir: oldDefaultPath },
        inst_a: { name: 'A', gameDir: 'C:\\Games\\MC\\instances\\inst_a' },
        inst_b: { name: 'B', gameDir: 'D:\\Elsewhere\\mc' },
      },
    });
    const ok8a = sanitized.instances.default.gameDir === '';

    const rw = migrateMod.rewriteInstanceDirs({
      default: { gameDir: '' },
      root_eq: { gameDir: 'C:\\Games\\MC' },
      inst_a: { gameDir: 'C:\\Games\\MC\\instances\\inst_a' },
      inst_b: { gameDir: 'D:\\Elsewhere\\mc' },
    }, 'C:\\Games\\MC', 'E:\\MC');
    const ok8b = rw.instances.default.gameDir === ''
      && rw.changed.root_eq === 'E:\\MC'
      && rw.changed.inst_a === 'E:\\MC\\instances\\inst_a'
      && rw.instances.inst_b.gameDir === 'D:\\Elsewhere\\mc'
      && !('inst_b' in rw.changed);

    const preloadSrc2 = nodeFs.readFileSync(nodePath.join(__dirname, 'src/main/preload.js'), 'utf8');
    const ok8c = /ipcMain\.handle\('gameDir:change'/.test(mainSrc)
      && preloadSrc2.includes('gameDirChange') && /api\.gameDirChange\(/.test(appSrc);

    const ok8 = ok8a && ok8b && ok8c;
    if (!ok8) h19Bad++;
    console.log(`h19 游戏目录跟随设置 ${ok8 ? 'OK ' : 'BAD'} 默认实例清空=${ok8a} 路径改写=${ok8b}(变更 ${Object.keys(rw.changed).length}) IPC接线=${ok8c}`);

    // ⑨ 下载版本=新建实例（不替换）；所有实例可删（含默认实例），重启后默认实例不复活
    const instancesSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/main/minecraft/instances.js'), 'utf8');
    const configSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/main/config.js'), 'utf8');

    // a) 全链路找不到「默认实例不可删除」；config 记住玩家删除动作
    const ok9a = !instancesSrc.includes('默认实例不可删除')
      && !appSrc.includes('默认实例不可删除')
      && configSrc.includes('defaultRemoved');

    // b) 实例卡片有删除按钮；删除后选中项回落剩余第一个（主进程纯逻辑源码守卫）
    const ok9b = /data-act="delete"/.test(appSrc)
      && /const rest = Object\.keys\(all\)/.test(instancesSrc);

    // c) 版本页按钮改为「下载并新建实例」，走 finalizeNewInstance；旧的「写回当前实例」已移除
    const ok9c = appSrc.includes('下载并新建实例')
      && /async function finalizeNewInstance/.test(appSrc)
      && !appSrc.includes('下载并写入实例');

    // d) helper 行为：全空回 null / 选中项删除后回落第一个
    const helperLive = JSON.parse(await js(`JSON.stringify((function () {
      const map = { a: { name: 'A' }, b: { name: 'B' } };
      return {
        picked: currentInstanceOf(map, 'b') && currentInstanceOf(map, 'b').name,
        fallback: currentInstanceOf(map, 'gone') && currentInstanceOf(map, 'gone').name,
        empty: currentInstanceOf({}, 'x'),
        firstId: firstInstanceId(map),
      };
    })())`));
    const ok9d = helperLive.picked === 'B' && helperLive.fallback === 'A'
      && helperLive.empty === null && helperLive.firstId === 'a';

    const ok9 = ok9a && ok9b && ok9c && ok9d;
    if (!ok9) h19Bad++;
    console.log(`h19 下载即新建且全实例可删 ${ok9 ? 'OK ' : 'BAD'} 可删=${ok9a} 卡片删除=${ok9b} 新建流程=${ok9c} helper=${ok9d}`);
  }
  console.log(`h19 汇总：错误 ${h19Bad}`);

  // ---- 批次 H-20：模组中心默认源切到 Modrinth（CurseForge 已全 403） ----
  let h20Bad = 0;
  {
    const nodeFs = require('fs');
    const nodePath = require('path');
    const appSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/renderer/app.js'), 'utf8');
    const cfSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/main/minecraft/curseforge.js'), 'utf8');

    // ① 模组分类默认落在 Modrinth（默认高亮 + 初始化即渲染在线搜索）
    const modBlock = appSrc.slice(appSrc.indexOf('function renderModCategory'), appSrc.indexOf('/* ---------- 分类：光影'));
    const ok1 = /class="tab active" data-mtab="modrinth"/.test(modBlock)
      && /renderOnline\('modrinth'\)/.test(modBlock)
      && !/class="tab active" data-mtab="local"/.test(modBlock);
    if (!ok1) h20Bad++;
    console.log(`h20 模组默认源=Modrinth ${ok1 ? 'OK ' : 'BAD'}`);

    // ② 世界分类里那个必然 403 的 CurseForge 搜索框已拆掉，只留直链 + 已有世界
    const worldBlock = appSrc.slice(appSrc.indexOf('function renderWorldCategory'), appSrc.indexOf('function formatSize'));
    const ok2 = !/id="world-search"/.test(worldBlock)
      && !/cfSearch\(q, mcVersion, '', 'world'\)/.test(worldBlock)
      && /id="world-url-btn"/.test(worldBlock) && /id="world-mine"/.test(worldBlock)
      && /Modrinth 不收录地图/.test(worldBlock);
    if (!ok2) h20Bad++;
    console.log(`h20 世界不再摆死搜索框 ${ok2 ? 'OK ' : 'BAD'}`);

    // ③ CurseForge 403 不再甩裸状态码，直接告诉玩家改用 Modrinth
    const ok3 = /403），请改用 Modrinth/.test(cfSrc);
    if (!ok3) h20Bad++;
    console.log(`h20 CF 403 文案指向 Modrinth ${ok3 ? 'OK ' : 'BAD'}`);

    // ④ 实机：进模组中心并切回「模组」分类，默认 tab 必须是 Modrinth，搜索框要在
    //    （前面的巡检批次把分类停在「世界」上了，centerCat 是模块级变量，得显式切回来）
    await js(`(() => {
      const c = document.querySelector('.nav-item[data-page="center"]');
      if (c) c.click();
      const t = document.querySelector('.cat-tab[data-cat="mod"]');
      if (t) t.click();
    })()`);
    await sleep(900);
    const live = JSON.parse(await js(`JSON.stringify((function () {
      const act = document.querySelector('#cat-bar .cat-tab.active');
      const tabs = [...document.querySelectorAll('[data-mtab]')];
      const on = tabs.filter((t) => t.classList.contains('active'))[0];
      const inp = document.querySelector('#mod-search');
      return {
        cat: act ? act.dataset.cat : '',
        mtab: on ? on.dataset.mtab : '',
        hasSearch: !!inp,
        placeholder: inp ? inp.placeholder : ''
      };
    })())`));
    const ok4 = live.cat === 'mod' && live.mtab === 'modrinth' && live.hasSearch && /搜索 Mod/.test(live.placeholder);
    if (!ok4) h20Bad++;
    console.log(`h20 模组中心实机 ${ok4 ? 'OK ' : 'BAD'} 分类=${live.cat} 默认源=${live.mtab} 搜索框=${live.hasSearch}`);

    // ⑤ 实机：切到「世界」，确认死搜索框没了、直链与已有世界都在
    await js(`(() => { const t = [...document.querySelectorAll('#cat-bar .cat-tab')].find((x) => x.dataset.cat === 'world'); if (t) t.click(); })()`);
    await sleep(800);
    const w = JSON.parse(await js(`JSON.stringify({
      dead: !!document.querySelector('#world-search'),
      url: !!document.querySelector('#world-url-btn'),
      mine: !!document.querySelector('#world-mine')
    })`));
    const ok5 = w.dead === false && w.url && w.mine;
    if (!ok5) h20Bad++;
    console.log(`h20 世界页实机 ${ok5 ? 'OK ' : 'BAD'} 死搜索框=${w.dead} 直链入口=${w.url} 已有世界=${w.mine}`);
  }
  console.log(`h20 汇总：错误 ${h20Bad}`);

  // ---- 批次 H-21：首页可直接选版本（不用再绕进版本管理） ----
  let h21Bad = 0;
  {
    const nodeFs = require('fs');
    const nodePath = require('path');
    const appSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/renderer/app.js'), 'utf8');

    // ① 源码守卫：首页有版本下拉，且选中后写进当前实例（不是全局版本）
    const ok1 = /id="home-version"/.test(appSrc)
      && /instancesSave\(state\.selectedInstance, \{ versionId: vsel\.value \}\)/.test(appSrc)
      // 选项要按【实例自己的游戏目录】去取：实例可以自带 gameDir，用全局那份会列出别的目录的版本
      && /const instDir = curInst\.gameDir \|\| state\.config\.gameDir/.test(appSrc)
      && /api\.versionsInstalled\(instDir\)/.test(appSrc);
    if (!ok1) h21Bad++;
    console.log(`h21 首页版本下拉接线 ${ok1 ? 'OK ' : 'BAD'}`);

    // ② 实机：下拉要覆盖已装版本，且默认选中当前实例的版本。
    //    这里临时塞两个假的已装版本，免得依赖这份测试配置里到底装了几个。
    const hv = JSON.parse(await js(`JSON.stringify((function () {
      state.__keepInstalled = state.installed;
      state.installed = ['1.99-smoke-a', '1.99-smoke-b'];
      renderPage('home');
      const s = document.querySelector('#home-version');
      if (!s) return { ok: false };
      return {
        ok: true,
        opts: s.options.length,
        cur: s.value,
        hasFakeA: [...s.options].some((o) => o.value === '1.99-smoke-a'),
        // 首页只该有这一个下拉：实例下拉已经合掉，换实例去侧边栏「实例管理」页
        fields: document.querySelectorAll('.hero-actions .sel-field').length,
        instGone: !document.getElementById('home-instance'),
        instVer: ((state.config.instances[state.selectedInstance] || {}).versionId) || ''
      };
    })())`));
    // 假列表里的 a/b 必须在，当前值要等于实例自己记的版本，且实例下拉确实没了
    const ok2 = hv.ok && hv.hasFakeA && hv.cur === hv.instVer
      && hv.fields === 1 && hv.instGone === true;
    if (!ok2) h21Bad++;
    console.log(`h21 首页版本下拉实机 ${ok2 ? 'OK ' : 'BAD'} 选项=${hv.opts} 当前=${hv.cur} 下拉数=${hv.fields} 实例下拉已移除=${hv.instGone}`);

    // ③ 实机：真的换一个版本，实例的 versionId 要跟着变（验完把版本和假列表都还原）
    const target = await js(`(function () {
      const s = document.querySelector('#home-version');
      const t = [...s.options].map((o) => o.value).find((v) => v && v !== s.value);
      if (!t) return '';
      s.value = t;
      s.dispatchEvent(new Event('change'));
      return t;
    })()`);
    await sleep(1100);
    const after = JSON.parse(await js(`JSON.stringify({
      ver: ((state.config.instances[state.selectedInstance] || {}).versionId) || ''
    })`));
    const ok3 = !!target && after.ver === target;
    if (!ok3) h21Bad++;
    console.log(`h21 换版本写回实例 ${ok3 ? 'OK ' : 'BAD'} 目标=${target} 实例=${after.ver}`);
    // 还原：实例版本 + 假列表
    await js(`window.api.instancesSave(state.selectedInstance, { versionId: ${JSON.stringify(hv.instVer)} })`);
    await sleep(400);
    await js(`state.installed = state.__keepInstalled; delete state.__keepInstalled; renderPage('home')`);
    await sleep(300);

    // ④ gameDir 参数确实透到了主进程：空值回落全局目录，带目录时也照样能列出数组
    const plumb = JSON.parse(await js(`(async () => {
      const a = await api.versionsInstalled();
      const b = await api.versionsInstalled('');
      const inst = state.config.instances[state.selectedInstance] || {};
      const c = await api.versionsInstalled(inst.gameDir || state.config.gameDir);
      return JSON.stringify({
        same: JSON.stringify(a) === JSON.stringify(b),
        isArr: Array.isArray(c)
      });
    })()`));
    const ok4 = plumb.same === true && plumb.isArr === true;
    if (!ok4) h21Bad++;
    console.log(`h21 已装版本按目录查 ${ok4 ? 'OK ' : 'BAD'} 空值回落一致=${plumb.same} 带目录返回数组=${plumb.isArr}`);

    // ⑤ 首页只剩一个下拉，且它带着「版本」标签。
    //    以前并排两个、又都没标签，用户直接问「主界面选择版本的，为什么有两个？」——
    //    所以这里同时守住「只有一个」和「这个带标签」两件事。
    const lbl = JSON.parse(await js(`JSON.stringify((function () {
      const fields = [...document.querySelectorAll('.hero-actions .sel-field')];
      return {
        n: fields.length,
        tags: fields.map((f) => {
          const t = f.querySelector('.sel-tag');
          return t ? t.textContent.trim() : '';
        })
      };
    })())`));
    const ok5 = lbl.n === 1 && lbl.tags[0] === '版本';
    if (!ok5) h21Bad++;
    console.log(`h21 首页只剩一个下拉 ${ok5 ? 'OK ' : 'BAD'} 下拉数=${lbl.n} 标签="${lbl.tags.join(',')}"`);
  }
  console.log(`h21 汇总：错误 ${h21Bad}`);

  // ---- 批次 H-22：账号头像显示玩家皮肤（顶栏 + 账号页），不再常年顶着 👤 ----
  let h22Bad = 0;
  {
    const nodeFs = require('fs');
    const nodePath = require('path');
    const appSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/renderer/app.js'), 'utf8');

    // ① 源码守卫：有皮肤头像通路；且 init() 在拿到 state.account 之后补刷了顶栏 ——
    //    顺序错了就会重演「账号页显示已登录、顶栏却写未登录/👤」那个 bug。
    const ok1 = /async function currentAccountHead/.test(appSrc)
      && /async function paintTopAvatar/.test(appSrc)
      && /function resetAccountHead/.test(appSrc)
      && /class="acc-head"/.test(appSrc)
      && /state\.account = state\.config\.account;[\s\S]{0,400}?updateTopUser\(\);/.test(appSrc);
    if (!ok1) h22Bad++;
    console.log(`h22 皮肤头像接线 ${ok1 ? 'OK ' : 'BAD'}`);

    // ② 实机：纹理 → 头像走本地渲染，并把假账号装进顶栏和账号页
    const r22 = JSON.parse(await js(`(async () => {
      // 造一张 64×64 假皮肤：蓝底 + 一块肤色当脸，够 paintSkinHead 裁出正脸
      const cv = document.createElement('canvas');
      cv.width = 64; cv.height = 64;
      const g = cv.getContext('2d');
      g.fillStyle = '#3f7fd0'; g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#e8c39e'; g.fillRect(8, 8, 8, 8);
      g.fillStyle = '#2b1a0e'; g.fillRect(8, 8, 8, 2);
      const head = await headDataUrlFromSkin(cv.toDataURL('image/png'));

      const keepAcc = state.account;
      const keepList = state.accounts;
      const keepPage = state.currentPage;
      const keepCache = Object.assign({}, headCache);

      // 顶栏：塞假账号 + 预先填好头像缓存，免得真去联网取皮肤
      Object.keys(headCache).forEach((k) => delete headCache[k]);
      state.account = { uuid: 'smoke-h22', username: 'SmokePlayer', type: 'microsoft' };
      state.accounts = [state.account];
      headCache['smoke-h22'] = head;
      updateTopUser();
      await new Promise((r) => setTimeout(r, 350));

      const av = document.getElementById('top-avatar');
      const nameEl = document.getElementById('top-username');
      const typeEl = document.getElementById('top-usertype');
      const bg = av ? (av.style.backgroundImage || '') : '';
      const top = {
        hasSkin: !!(av && av.classList.contains('has-skin')),
        bgPng: bg.indexOf('data:image/png') >= 0,
        text: av ? av.textContent : 'X',
        name: nameEl ? nameEl.textContent : '',
        type: typeEl ? typeEl.textContent : ''
      };

      // 账号页：当前账号那张头像要换成皮肤头，也不能停在破图态
      renderPage('account');
      await new Promise((r) => setTimeout(r, 450));
      const cur = [...document.querySelectorAll('img.acc-head')]
        .find((im) => im.dataset.uuid === 'smoke-h22');
      const acc = {
        count: document.querySelectorAll('img.acc-head').length,
        srcPng: !!(cur && (cur.src || '').indexOf('data:image/png') === 0),
        bad: !!(cur && cur.classList.contains('bad'))
      };

      // 还原现场
      state.account = keepAcc;
      state.accounts = keepList;
      Object.keys(headCache).forEach((k) => delete headCache[k]);
      Object.assign(headCache, keepCache);
      updateTopUser();
      renderPage(keepPage || 'home');
      await new Promise((r) => setTimeout(r, 300));

      return JSON.stringify({ headPng: (head || '').indexOf('data:image/png;base64,') === 0, top, acc });
    })()`));
    const ok2 = r22.headPng && r22.top.hasSkin && r22.top.bgPng && r22.top.text === ''
      && r22.top.name === 'SmokePlayer' && r22.top.type === '微软账号';
    if (!ok2) h22Bad++;
    console.log(`h22 顶栏换皮肤头 ${ok2 ? 'OK ' : 'BAD'} 头像=${r22.top.hasSkin ? '皮肤' : '👤'} 名字=${r22.top.name} 类型=${r22.top.type} 背景=${r22.top.bgPng}`);
    const ok3 = r22.acc.count >= 1 && r22.acc.srcPng && !r22.acc.bad;
    if (!ok3) h22Bad++;
    console.log(`h22 账号页头像 ${ok3 ? 'OK ' : 'BAD'} 头像数=${r22.acc.count} 皮肤头=${r22.acc.srcPng} 破图=${r22.acc.bad}`);
  }
  console.log(`h22 汇总：错误 ${h22Bad}`);

  // ---- 批次 H-23：启动器自动更新（版本比较 / 读清单 / 流式下载 / 免安装版降级） ----
  let h23Bad = 0;
  {
    const nodeFs = require('fs');
    const nodePath = require('path');
    const updater = require('./src/main/minecraft/updater');
    const cur = updater.currentVersion();

    // ① 源码守卫：主进程有更新模块与 IPC，渲染层有更新区块和版本号运行时注入
    const updaterSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/main/minecraft/updater.js'), 'utf8');
    const mainSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/main/main.js'), 'utf8');
    const preSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/main/preload.js'), 'utf8');
    const appSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/renderer/app.js'), 'utf8');
    const ok1 = /function compareVersion/.test(updaterSrc)
      // --force-run 是静默安装后自动拉起启动器的唯一开关，漏了它玩家装完就只剩一个空桌面
      && /--force-run/.test(updaterSrc)
      && /ipcMain\.handle\('update:check'/.test(mainSrc)
      && /ipcMain\.handle\('update:download'/.test(mainSrc)
      && /ipcMain\.handle\('update:install'/.test(mainSrc)
      && /update:progress/.test(mainSrc)
      && /updaterCheck:/.test(preSrc) && /onUpdateProgress:/.test(preSrc)
      && /id="up-block"/.test(appSrc)
      && /\$\('foot-ver'\)/.test(appSrc) && /foot-status/.test(appSrc);
    if (!ok1) h23Bad++;
    console.log(`h23 更新接线 ${ok1 ? 'OK ' : 'BAD'}`);

    // ② 版本比较：必须按数字段比，按字符串比会把 1.10.0 判成小于 1.9.0
    const cmp = [
      [updater.compareVersion('1.10.0', '1.9.0'), 1],
      [updater.compareVersion('1.0.0', '1.0.0'), 0],
      [updater.compareVersion('v1.2.3', '1.2.3'), 0],
      [updater.compareVersion('2.0', '1.9.9'), 1],
      [updater.compareVersion('1.0.0', '1.0.1'), -1],
    ];
    const ok2 = cmp.every(([got, want]) => got === want);
    if (!ok2) h23Bad++;
    console.log(`h23 版本比较 ${ok2 ? 'OK ' : 'BAD'} ${cmp.map(([g]) => g).join(',')}`);

    // ③ 读清单：本地 /latest.json 版本故意更高 → hasUpdate；非 http(s) 地址要被挡下
    const man = await updater.check(`http://127.0.0.1:${httpPort}/latest.json`);
    let badUrlCaught = false;
    try { await updater.check('file:///etc/passwd'); } catch { badUrlCaught = true; }
    const ok3 = man.hasUpdate === true && man.latest === '99.0.0' && man.installer === '/blob.bin'
      && man.notes === '冒烟测试用的更新说明' && man.page === '/download'
      && man.current === cur && badUrlCaught;
    if (!ok3) h23Bad++;
    console.log(`h23 读清单 ${ok3 ? 'OK ' : 'BAD'} 当前=${man.current} 最新=${man.latest} 有新版=${man.hasUpdate} 非法地址拦截=${badUrlCaught}`);

    // ④ 流式下载 + 进度回调（真包 98MB，不能整块进内存；这里验落盘大小与末次 100%）
    const ticks = [];
    const dl = await updater.download(
      { installer: `http://127.0.0.1:${httpPort}/blob.bin` },
      (p) => ticks.push(p),
    );
    const onDisk = nodeFs.existsSync(dl.path) && nodeFs.statSync(dl.path).size;
    const ok4 = dl.size === payload.length && onDisk === payload.length
      && ticks.length >= 1 && ticks[ticks.length - 1].percent === 100
      && ticks.some((t) => t.total === payload.length);
    if (!ok4) h23Bad++;
    console.log(`h23 流式下载 ${ok4 ? 'OK ' : 'BAD'} 落盘=${onDisk}/${payload.length} 进度回调=${ticks.length} 末次=${ticks.length ? ticks[ticks.length - 1].percent : -1}%`);
    try { nodeFs.unlinkSync(dl.path); } catch { /* ignore */ }

    // ⑤ 免安装版降级：install() 必须当场拒绝，不能真去 spawn 替换只读的临时副本
    process.env.PORTABLE_EXECUTABLE_DIR = 'E:\\smoke-portable';
    let portableCaught = '';
    try { updater.install('whatever.exe'); } catch (e) { portableCaught = e.message; }
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    const ok5 = !!portableCaught && updater.isPortable() === false;
    if (!ok5) h23Bad++;
    console.log(`h23 免安装版降级 ${ok5 ? 'OK ' : 'BAD'} 拒绝语=${portableCaught || '(未拦截)'}`);

    // ⑥ sha256：清单给了哈希就得校验，对了才落盘，错了要把 .part 丢掉
    const nodeCrypto = require('crypto');
    const good = nodeCrypto.createHash('sha256').update(payload).digest('hex');
    const dl2 = await updater.download({ installer: `http://127.0.0.1:${httpPort}/blob.bin`, sha256: good.toUpperCase() });
    const okGood = dl2.size === payload.length && nodeFs.existsSync(dl2.path);
    let hashCaught = '';
    try {
      await updater.download({ installer: `http://127.0.0.1:${httpPort}/blob.bin`, sha256: 'deadbeef' });
    } catch (e) { hashCaught = e.message; }
    const partLeft = nodeFs.existsSync(`${dl2.path}.part`);
    const ok6 = okGood && !!hashCaught && !partLeft;
    if (!ok6) h23Bad++;
    console.log(`h23 安装包校验 ${ok6 ? 'OK ' : 'BAD'} 正确哈希落盘=${dl2.size} 错误哈希拦截=${!!hashCaught} 残留临时文件=${partLeft}`);
    try { nodeFs.unlinkSync(dl2.path); } catch { /* ignore */ }

    // ⑦ 实机：设置页更新区块在、版本号是运行时注入的；免安装版只给「打开下载页」，安装版才给「立即更新」
    const r23 = JSON.parse(await js(`(async () => {
      const keepInfo = state.updateInfo;
      const keepPending = pendingUpdate;
      const snap = () => {
        const action = document.getElementById('up-action');
        const pageBtn = document.getElementById('up-page');
        return {
          block: !!document.getElementById('up-block'),
          url: !!document.getElementById('up-url'),
          check: !!document.getElementById('up-check'),
          progress: !!document.getElementById('up-progress'),
          cur: (document.getElementById('up-cur') || {}).textContent || '',
          actionHidden: action ? action.hidden : null,
          actionLabel: action ? action.textContent : '',
          pageHidden: pageBtn ? pageBtn.hidden : null,
        };
      };

      state.updateInfo = { version: '${cur}', portable: true };
      pendingUpdate = { current: '${cur}', latest: '99.0.0', hasUpdate: true, installer: 'http://x/blob.bin', page: 'http://x/download', notes: 'n' };
      renderPage('settings');
      await new Promise((r) => setTimeout(r, 250));
      const portableUI = snap();

      // 安装版：同一份清单应把「立即更新」露出来
      state.updateInfo = { version: '${cur}', portable: false };
      renderPage('settings');
      await new Promise((r) => setTimeout(r, 250));
      const setupUI = snap();

      // 顶栏红点 + 首页徽章 + 侧栏版本号
      paintUpdateDot();
      const av = document.getElementById('top-avatar');
      renderPage('home');
      await new Promise((r) => setTimeout(r, 200));
      const badge = document.getElementById('hero-badge-update');
      portableUI.dot = !!(av && av.classList.contains('has-update'));
      portableUI.badge = !!(badge && !badge.hidden);
      portableUI.foot = (document.getElementById('foot-ver') || {}).textContent || '';

      state.updateInfo = keepInfo;
      pendingUpdate = keepPending;
      paintUpdateDot();
      renderPage('settings');
      await new Promise((r) => setTimeout(r, 150));
      return JSON.stringify({ portableUI, setupUI });
    })()`));
    const p = r23.portableUI;
    const s = r23.setupUI;
    const footWant = `v${cur} · 运行正常`;
    const ok7 = p.block && p.url && p.check && p.progress && p.cur === `v${cur}`
      && p.actionHidden === true && p.pageHidden === false
      && s.actionHidden === false && s.actionLabel === '立即更新' && s.pageHidden === false
      && p.dot === true && p.badge === true && p.foot === footWant;
    if (!ok7) h23Bad++;
    console.log(`h23 界面接线 ${ok7 ? 'OK ' : 'BAD'} 区块=${p.block} 版本=${p.cur} 免安装版动作隐藏=${p.actionHidden}/下载页=${p.pageHidden === false} 安装版动作=${s.actionLabel}/${s.actionHidden} 红点=${p.dot} 徽章=${p.badge} 侧栏=${p.foot}`);
  }
  console.log(`h23 汇总：错误 ${h23Bad}`);

  // ---- 批次 H-24：下载版本流程重做（二级菜单前置加载器 → 下载成功才建实例 → 资源中心前置） ----
  let h24Bad = 0;
  {
    const nodeFs = require('fs');
    const nodeOs = require('os');
    const nodePath = require('path');
    const appSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/renderer/app.js'), 'utf8');
    const msSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/main/auth/microsoft.js'), 'utf8');
    const versionsMod = require('./src/main/minecraft/versions');

    // ① 源码守卫：二级菜单 / 随机名 / 仅下载 IPC / 资源中心前置 都要在
    const ok1 = /async function openVersionInstaller/.test(appSrc)
      && /function randomInstanceName/.test(appSrc)
      && /async function ensureRuntime/.test(appSrc)
      && /api\.versionsDownload\(sel\.mcVersion, gameDir\)/.test(appSrc)
      // 失败不留残实例：统一收尾 finalizeNewInstance 必须在下载 await 之后（两处调用都守）
      && /const versionId = await downloadVersionWithLoader[\s\S]{0,800}?await finalizeNewInstance\(versionId/.test(appSrc)
      // 首页「＋ 安装新版本」直接开二级菜单，不再跳版本管理页
      && /\$\('hero-badge-new'\)\.onclick = \(\) => openVersionInstaller\(\)/.test(appSrc);
    if (!ok1) h24Bad++;
    console.log(`h24 二级菜单流程接线 ${ok1 ? 'OK ' : 'BAD'}`);

    // ② mergeInherited：子版本覆盖 mainClass、库去重（子版本盖父版本）、继承 assetIndex
    const parent = {
      id: '1.20', mainClass: 'net.Default', type: 'release',
      libraries: [{ name: 'a:a:1' }, { name: 'c:c:1' }],
      arguments: { jvm: ['-P'], game: ['--g'] },
      assetIndex: { id: '5' }, assets: '5',
    };
    const childA = { name: 'a:a:1', tag: 'child' };   // 与父版本同名：应被子版本整对象覆盖
    const child = {
      id: '1.20-fabric-0.16', inheritsFrom: '1.20', mainClass: 'KnotClient',
      libraries: [{ name: 'b:b:1' }, childA],
      arguments: { jvm: ['-DFabric'] },
    };
    const merged = versionsMod.mergeInherited(child, parent);
    const libs = merged.libraries.map((l) => l.name);
    const ok2 = merged.id === '1.20-fabric-0.16'
      && merged.mainClass === 'KnotClient'
      && JSON.stringify(libs) === JSON.stringify(['a:a:1', 'c:c:1', 'b:b:1'])
      && merged.libraries.find((l) => l.name === 'a:a:1') === childA
      && merged.arguments.jvm.includes('-P') && merged.arguments.jvm.includes('-DFabric')
      && merged.arguments.game.includes('--g')
      && merged.assetIndex.id === '5' && merged.type === 'release';
    if (!ok2) h24Bad++;
    console.log(`h24 子版本清单合并 ${ok2 ? 'OK ' : 'BAD'} 库序=${libs.join(',')}`);

    // ③ resolveVersionDetail 走本地：child 带 inheritsFrom，解析结果应已合并父版本
    const tdir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'cm-smoke-ver-'));
    nodeFs.mkdirSync(nodePath.join(tdir, 'versions', '1.20'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(tdir, 'versions', '1.20', '1.20.json'), JSON.stringify(parent));
    nodeFs.mkdirSync(nodePath.join(tdir, 'versions', child.id), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(tdir, 'versions', child.id, `${child.id}.json`), JSON.stringify(child));
    const resolved = await versionsMod.resolveVersionDetail(child.id, tdir);
    const ok3 = resolved.mainClass === 'KnotClient'
      && resolved.libraries.some((l) => l.name === 'b:b:1')
      && resolved.assetIndex.id === '5';
    if (!ok3) h24Bad++;
    console.log(`h24 本地加载器版本解析 ${ok3 ? 'OK ' : 'BAD'} mainClass=${resolved.mainClass}`);
    try { nodeFs.rmSync(tdir, { recursive: true, force: true }); } catch { /* ignore */ }

    // ④ 登录 bug 修复守卫：OAuth 错误码挂在 err.code 上（不是从英文 description 里猜），
    //    且 slow_down 会把间隔加大
    const ok4 = /err\.code = data\.error/.test(msSrc)
      && /code\.includes\('slow_down'\)/.test(msSrc)
      && /pollInterval \+= 5000/.test(msSrc);
    if (!ok4) h24Bad++;
    console.log(`h24 设备码错误码识别 ${ok4 ? 'OK ' : 'BAD'}`);

    // ⑤ 仅下载通路：launch.prepare 必须存在（供 versions:download IPC 用）
    const ok5 = typeof launchMod.prepare === 'function';
    if (!ok5) h24Bad++;
    console.log(`h24 仅下载不启动接口 ${ok5 ? 'OK ' : 'BAD'}`);

    // ⑥ 实机：开二级菜单 → 加载器 4 项 + 版本下拉有值 → 取消后 Promise 落 null；
    //    ensureRuntime 遇到已有版本的实例直接放行、不弹窗
    const live = JSON.parse(await js(`(async () => {
      const p = openVersionInstaller();
      await new Promise((r) => setTimeout(r, 250));
      const modal = document.querySelector('.modal-mask .modal');
      const loaders = [...document.querySelectorAll('#vi-loaders .tab')].map((t) => t.dataset.loader);
      const vsel = document.getElementById('vi-version');
      const verCount = vsel ? vsel.options.length : 0;
      document.getElementById('vi-cancel').click();
      const cancelVal = await p;
      const ready = await ensureRuntime({ name: '已有版本', versionId: '1.20.1' });
      const modalLeft = document.querySelectorAll('.modal-mask').length;
      return JSON.stringify({
        hasModal: !!modal, loaders, verCount, cancelVal,
        passthrough: ready && ready.versionId === '1.20.1', modalLeft,
      });
    })()`));
    const ok6 = live.hasModal
      && JSON.stringify(live.loaders) === JSON.stringify(['vanilla', 'forge', 'fabric', 'quilt'])
      && live.verCount > 0 && live.cancelVal === null
      && live.passthrough === true && live.modalLeft === 0;
    if (!ok6) h24Bad++;
    console.log(`h24 二级菜单实机 ${ok6 ? 'OK ' : 'BAD'} 加载器=${live.loaders.join(',')} 版本数=${live.verCount} 取消=${live.cancelVal === null} 已有版本放行=${live.passthrough}`);
  }
  console.log(`h24 汇总：错误 ${h24Bad}`);

  // ---- 批次 H-25：通知浮岛（实验功能开关 + 顶部胶囊两段式弹出/收起） ----
  let h25Bad = 0;
  {
    const nodeFs = require('fs');
    const nodePath = require('path');
    const appSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/renderer/app.js'), 'utf8');
    const htmlSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/renderer/index.html'), 'utf8');
    const cssSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/renderer/styles.css'), 'utf8');
    const configMod = require('./src/main/config');

    // ① 源码守卫：开关 / 容器 / 两段式类名 / 设置接线
    const ok1 = /id="notify-island"/.test(htmlSrc)
      && /id="island-pill"/.test(htmlSrc)
      && /function islandNotify/.test(appSrc)
      && /pill\.classList\.add\('pop'\)/.test(appSrc)
      && /pill\.classList\.add\('expanded'\)/.test(appSrc)
      && /id="set-island"/.test(appSrc)
      && /id="btn-island-test"/.test(appSrc)
      && /\.island-pill\.pop/.test(cssSrc)
      && /\.island-pill\.expanded/.test(cssSrc)
      // 开关默认关闭
      && configMod.getAll().islandEnabled === false;
    if (!ok1) h25Bad++;
    console.log(`h25 浮岛接线与默认关闭 ${ok1 ? 'OK ' : 'BAD'}`);

    // ② 实机：关着 → notify 静默无效；打开 → 先 pop 后 expanded，文字正确，结束自动隐藏
    const live = JSON.parse(await js(`(async () => {
      const host = document.getElementById('notify-island');
      const pill = document.getElementById('island-pill');
      state.config.islandEnabled = false;
      islandNotify({ title: '不该出现' });
      await new Promise((r) => setTimeout(r, 120));
      const ignored = host.hidden;

      state.config.islandEnabled = true;
      islandState.queue.length = 0;
      islandNotify({ ico: '🧪', title: '冒烟浮岛', desc: '测试描述', hold: 180 });
      await new Promise((r) => setTimeout(r, 120));
      const popped = pill.classList.contains('pop') && !pill.classList.contains('expanded');
      await new Promise((r) => setTimeout(r, 260));
      const expanded = pill.classList.contains('expanded')
        && document.getElementById('island-title').textContent === '冒烟浮岛'
        && document.getElementById('island-ico').textContent === '🧪';
      // 等完整生命周期结束（220 + 180 + 300 + 300）
      await new Promise((r) => setTimeout(r, 720));
      const hiddenAgain = host.hidden && !pill.classList.contains('pop');
      return JSON.stringify({ ignored, popped, expanded, hiddenAgain });
    })()`));
    const ok2 = live.ignored && live.popped && live.expanded && live.hiddenAgain;
    if (!ok2) h25Bad++;
    console.log(`h25 两段式弹出与自动收起 ${ok2 ? 'OK ' : 'BAD'} 关闭态静默=${live.ignored} 先弹出=${live.popped} 再展开=${live.expanded} 自动隐藏=${live.hiddenAgain}`);

    // ③ 连续相同标题去重 + 设置页开关在
    const dedup = JSON.parse(await js(`(async () => {
      islandState.queue.length = 0;
      islandState.busy = true;   // 假装正在播：让新消息留在队列里，才能验去重
      islandNotify({ title: '同一条', hold: 100 });
      islandNotify({ title: '同一条', hold: 100 });
      const q1 = islandState.queue.length;
      islandState.queue.length = 0;
      islandState.busy = false;
      renderPage('settings');
      await new Promise((r) => setTimeout(r, 150));
      const toggle = document.getElementById('set-island');
      const testBtn = document.getElementById('btn-island-test');
      state.config.islandEnabled = false;
      return JSON.stringify({ q1, hasToggle: !!toggle, hasTest: !!testBtn });
    })()`));
    const ok3 = dedup.q1 === 1 && dedup.hasToggle && dedup.hasTest;
    if (!ok3) h25Bad++;
    console.log(`h25 重复去重与设置开关 ${ok3 ? 'OK ' : 'BAD'} 队列=${dedup.q1} 开关=${dedup.hasToggle} 试弹按钮=${dedup.hasTest}`);
  }
  console.log(`h25 汇总：错误 ${h25Bad}`);

  // ---- 批次 H-26：下载 / 登录自动弹浮岛 + 所有网页收进内置浏览器 ----
  let h26Bad = 0;
  {
    const nodeFs = require('fs');
    const nodePath = require('path');
    const mainSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/main/main.js'), 'utf8');
    const appSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/renderer/app.js'), 'utf8');

    // ① 源码守卫：shell:open 与 update:open 的 http(s) 都走 browser.open
    const shellBlock = mainSrc.match(/ipcMain\.handle\('shell:open'[\s\S]*?\}\);/)[0];
    const updBlock = mainSrc.match(/ipcMain\.handle\('update:open'[\s\S]*?\}\);/)[0];
    const ok1 = /\^https\?:\\\/\\\//.test(shellBlock) && /browser\.open\(u\)/.test(shellBlock)
      && /browser\.open\(u\)/.test(updBlock)
      // 下载开始 / 登录开始的浮岛调用都在
      && /开始下载 \$\{sel\.mcVersion\}/.test(appSrc)
      && /正在登录微软账号/.test(appSrc)
      && /离线登录成功：\$\{state\.account\.username\}/.test(appSrc);
    if (!ok1) h26Bad++;
    console.log(`h26 网页收进内置浏览器与浮岛埋点 ${ok1 ? 'OK ' : 'BAD'}`);

    // ② 实机：api.openUrl(https) 开的是内置浏览器窗口，不是系统浏览器
    await js(`(async () => { await api.openUrl('https://www.example.com/?smoke=1'); })()`);
    await new Promise((r) => setTimeout(r, 900));
    const openedInside = browserMod.isOpen();
    const wins = require('electron').BrowserWindow.getAllWindows();
    const hasBrowserWin = wins.some((w) => w.title.includes('CM 浏览器'));
    if (openedInside) browserMod.close();
    await new Promise((r) => setTimeout(r, 400));
    const closedOk = !browserMod.isOpen();
    const ok2 = openedInside && hasBrowserWin && closedOk;
    if (!ok2) h26Bad++;
    console.log(`h26 外链走内置浏览器窗口 ${ok2 ? 'OK ' : 'BAD'} 打开=${openedInside} 窗口标题对=${hasBrowserWin} 可关闭=${closedOk}`);

    // ③ 实机：开启浮岛后走一遍离线登录（纯本地、不触网），浮岛应自动弹出登录成功
    const live = JSON.parse(await js(`(async () => {
      state.config.islandEnabled = true;
      islandState.queue.length = 0;
      renderPage('account');
      await new Promise((r) => setTimeout(r, 150));
      document.getElementById('off-name').value = 'SmokeTester';
      document.getElementById('off-login').click();
      await new Promise((r) => setTimeout(r, 500));
      const pill = document.getElementById('island-pill');
      const title = document.getElementById('island-title').textContent;
      const ico = document.getElementById('island-ico').textContent;
      const popped = pill.classList.contains('pop');
      // 收尾：删掉这个测试账号，关掉浮岛
      const uuid = state.account && state.account.uuid;
      if (uuid) await api.authRemove(uuid);
      islandState.queue.length = 0;
      document.getElementById('notify-island').hidden = true;
      pill.classList.remove('pop', 'expanded');
      state.config.islandEnabled = false;
      return JSON.stringify({ title, ico, popped });
    })()`));
    const ok3 = live.popped && live.ico === '✅' && live.title.includes('离线登录成功：SmokeTester');
    if (!ok3) h26Bad++;
    console.log(`h26 登录成功自动弹浮岛 ${ok3 ? 'OK ' : 'BAD'} 弹出=${live.popped} 图标=${live.ico} 标题=${live.title}`);
  }
  console.log(`h26 汇总：错误 ${h26Bad}`);

  // ---- 批次 H-27：内置陶瓦 / EasyTier 不再直接启动 exe 强开系统浏览器 ----
  let h27Bad = 0;
  {
    const nodeFs = require('fs');
    const nodePath = require('path');
    const appSrc = nodeFs.readFileSync(nodePath.join(__dirname, 'src/renderer/app.js'), 'utf8');

    // ① 源码守卫：卡片锚点 + bundled 不走 data-lan-run + 改为 data-lan-goto 引导
    const ok1 = appSrc.includes('id="lan-card-taohua"')
      && appSrc.includes('id="lan-card-easytier"')
      && /t\.found && !t\.bundled \? `[^`]*data-lan-run/.test(appSrc)
      && /t\.bundled \? `[^`]*data-lan-goto="\$\{t\.id\}">↑ 用上面卡片/.test(appSrc)
      && /querySelectorAll\('\[data-lan-goto\]'\)/.test(appSrc)
      && /scrollIntoView/.test(appSrc);
    if (!ok1) h27Bad++;
    console.log(`h27 内置工具改为引导而非直启 ${ok1 ? 'OK ' : 'BAD'}`);

    // ② 实机：联机页工具区，内置的陶瓦 / EasyTier 无「启动」、有「↑ 用上面卡片」；
    //    红石（托管但非内置）仍保留「启动」
    const live = JSON.parse(await js(`(async () => {
      renderPage('servers');
      // renderTools 由 lanDetect 异步填充，等它几轮
      let tries = 0;
      while (tries++ < 20 && !document.querySelector('[data-lan-goto], [data-lan-run]')) {
        await new Promise((r) => setTimeout(r, 150));
      }
      const cardTao = !!document.getElementById('lan-card-taohua');
      const cardEt = !!document.getElementById('lan-card-easytier');
      const runTao = !!document.querySelector('[data-lan-run="taohua"]');
      const runEt = !!document.querySelector('[data-lan-run="easytier"]');
      const gotoTao = document.querySelector('[data-lan-goto="taohua"]');
      const gotoEt = document.querySelector('[data-lan-goto="easytier"]');
      // 点陶瓦的引导：不应产生新窗口进程，只滚动
      if (gotoTao) gotoTao.click();
      await new Promise((r) => setTimeout(r, 100));
      return JSON.stringify({
        cardTao, cardEt, runTao, runEt,
        gotoTao: !!gotoTao, gotoEt: !!gotoEt,
      });
    })()`));
    const ok2 = live.cardTao && live.cardEt
      && !live.runTao && !live.runEt
      && live.gotoTao && live.gotoEt;
    if (!ok2) h27Bad++;
    console.log(`h27 工具区按钮形态 ${ok2 ? 'OK ' : 'BAD'} 陶瓦直启=${live.runTao}(应false) 陶瓦引导=${live.gotoTao} ET直启=${live.runEt}(应false) ET引导=${live.gotoEt}`);
  }
  console.log(`h27 汇总：错误 ${h27Bad}`);

  // ---- 批次 H-28：种子地图升级为完整群系/结构地图（cubiomes 引擎） ----
  let h28Bad = 0;
  {
    const nodeFs = require('fs');
    const nodePath = require('path');
    const read = (p) => nodeFs.readFileSync(nodePath.join(__dirname, p), 'utf8');
    const appSrc = read('src/renderer/app.js');
    const mainSrc = read('src/main/main.js');
    const preloadSrc = read('src/main/preload.js');

    // ① 接线与文件守卫：引擎模块 / IPC / preload / exe 全部就位
    const mapcliSrc = read('resources/tools/seedmap/cubiomes-src/mapcli.c');
    const exeFile = nodePath.join(__dirname, 'resources/tools/seedmap/seedmap.exe');
    const ok1 = nodeFs.existsSync(exeFile) && nodeFs.statSync(exeFile).size > 100000
      && nodeFs.existsSync(nodePath.join(__dirname, 'src/main/minecraft/seedmap-engine.js'))
      && mainSrc.includes("handle('lab:seedTile'") && mainSrc.includes("handle('lab:seedBiome'")
      && preloadSrc.includes('labSeedTile') && appSrc.includes('api.labSeedTile')
      && appSrc.includes('BIOME_NAMES') && appSrc.includes('STRUCT_META')
      && nodeFs.existsSync(nodePath.join(__dirname, 'resources/tools/seedmap/LICENSE.txt'))
      && nodeFs.existsSync(nodePath.join(__dirname, 'resources/tools/seedmap/cubiomes-src/mapcli.c'))
      // 要塞 bug 守卫：先 nextStronghold 再打印 sh.pos，不能 do-while 先打印（否则首点恒为假 0 0）
      && /while\s*\(nextStronghold\(&sh,\s*NULL\)\s*>\s*0\)/.test(mapcliSrc)
      && !/do\s*\{\s*printf\("%d %d\\n",\s*sh\.pos/.test(mapcliSrc)
      // chunkbase 外链必须把 seed 一起传过去
      && preloadSrc.includes("invoke('lab:chunkbase', seed, version)");
    if (!ok1) h28Bad++;
    console.log(`h28 引擎接线与分发文件 ${ok1 ? 'OK ' : 'BAD'} exe=${nodeFs.existsSync(exeFile)}`);

    // ② 实机：种子地图渲染、坐标 HUD、维度切换、图例
    const live = JSON.parse(await js(`(async () => {
      renderPage('lab');
      document.querySelector('#lab-bar [data-lab="seed"]').click();
      await new Promise((r) => setTimeout(r, 200));
      const canvas = document.getElementById('sd-canvas');
      const cctx = canvas.getContext('2d');
      document.getElementById('sd-seed').value = '12345';
      document.getElementById('sd-gen').click();
      // 等瓦片：中心区域出现非背景色
      let tries = 0;
      let varied = false;
      while (tries++ < 30) {
        await new Promise((r) => setTimeout(r, 200));
        const d = cctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < d.length; i += 16) {
          if (d[i] > 12 || d[i + 1] > 12 || d[i + 2] > 24) { varied = true; break; }
        }
        if (varied) break;
      }
      const hudText = document.getElementById('sd-hud').textContent;
      const legendN = document.getElementById('sd-legend').children.length;

      // 切到下界
      const nethBtn = document.querySelector('#sd-dims [data-dim="-1"]');
      nethBtn.click();
      await new Promise((r) => setTimeout(r, 1200));
      const nethActive = nethBtn.classList.contains('primary');
      const nethVaried = (() => {
        const d = cctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < d.length; i += 16) {
          if (d[i] > 40) return true;
        }
        return false;
      })();

      // 回主世界
      const owBtn = document.querySelector('#sd-dims [data-dim="0"]');
      owBtn.click();
      await new Promise((r) => setTimeout(r, 800));

      // 要塞守卫：128 个点里不能出现假的原点标记
      const shPts = await api.labSeedStrongholds({ version: '1.20', seed: '12345' });
      const shCount = shPts.length;
      const shAnyZero = shPts.some((p) => p.x === 0 && p.z === 0);

      return JSON.stringify({ varied, hudText, legendN, nethActive, nethVaried, shCount, shAnyZero });
    })()`));
    const ok2 = live.varied && /X -?\d/.test(live.hudText) && live.legendN >= 10
      && live.nethActive && live.nethVaried
      && live.shCount >= 120 && !live.shAnyZero;
    if (!ok2) h28Bad++;
    console.log(`h28 地图实机交互 ${ok2 ? 'OK ' : 'BAD'} 群系图=${live.varied} HUD="${live.hudText}" 图例=${live.legendN} 下界=${live.nethActive}/${live.nethVaried} 要塞=${live.shCount}/假原点=${live.shAnyZero}`);
  }
  console.log(`h28 汇总：错误 ${h28Bad}`);

  // ---- UI 巡检：逐页截图，确认液态玻璃 / 美西螈风格 ----
  const accInfo = await js('document.body.getAttribute("data-accent") + " / " + getComputedStyle(document.body).getPropertyValue("--accent")');
  console.log(`ui 主题 accent = ${accInfo}`);
  for (const p of ['home', 'instances', 'servers', 'downloads', 'skins', 'settings']) {
    await js(`document.querySelectorAll('.modal-mask, .shot-viewer').forEach((n) => n.remove()); renderPage('${p}')`);
    await sleep(750);
    await shot(`ui-${p}`);
  }
  console.log('ui 巡检截图完成：home / instances / servers / downloads / skins / settings');

  try { httpSrv.close(); } catch { /* ignore */ }
  try { mcSrv.close(); } catch { /* ignore */ }

  // 先收掉透明窗口再退进程：直接 app.exit 时 GPU/合成器拆栈偶发 0xC0000005，
  // 会把退出码污染成崩溃码，让 CI 误判成测试失败。
  BrowserWindow.getAllWindows().forEach((w) => { try { w.destroy(); } catch { /* ignore */ } });
  await sleep(300);

  app.exit(kindBad || diskBad || skinBad || gBad || hBad || h2Bad || h3Bad || h4Bad || h5Bad || h6Bad || h7Bad || h8Bad || h9Bad || h10Bad || h11Bad || h12Bad || h13Bad || h14Bad || h15Bad || h16Bad || h17Bad || h18Bad || h19Bad || h20Bad || h21Bad || h22Bad || h23Bad || h24Bad || h25Bad || h26Bad || h27Bad || h28Bad ? 1 : 0);
}

setTimeout(() => run().catch((e) => { console.log('ERR', e.message); app.exit(1); }), 1500);
