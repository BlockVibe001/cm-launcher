const $ = (id) => document.getElementById(id);
const ce = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
};

const state = {
  config: null,
  manifest: null,
  installed: [],
  currentPage: 'home',
  account: null,
  selectedInstance: null,
  busy: false,
};

const ACCENTS = [
  { id: 'axolotl', color: '#f472b6' },
  { id: 'emerald', color: '#27bd5eff' },
  { id: 'cyan', color: '#22d3ee' },
  { id: 'violet', color: '#a78bfa' },
  { id: 'rose', color: '#fb7185' },
  { id: 'amber', color: '#fbbf24' },
  { id: 'sky', color: '#46c5fcff' },
];

/* ========== 初始化 ========== */

async function init() {
  state.config = await api.configGetAll();
  applyTheme();
  bindWindowControls();
  bindNav();
  bindTopbar();
  bindGlobalEvents();
  bindGlassAuto();
  bindSystemTheme();

  // 首屏只依赖本地配置：实例选择 / 账号都在这里同步确定，然后立刻渲染首页。
  // 版本清单是网络请求，以前 await 它，网络一慢启动后空白近 10 秒 —— 改为后台加载。
  const instances0 = state.config.instances || {};
  const selId = state.config.selectedInstance in instances0
    ? state.config.selectedInstance
    : firstInstanceId(instances0);
  state.selectedInstance = selId;
  state.account = state.config.account;
  state.accounts = state.config.accounts || [];
  // 顶栏用户区读的是 state.account，而 bindTopbar() 跑在上面那两行之前 ——
  // 那时 state.account 还是空的，只能画成「未登录」。所以这里必须再刷一次，
  // 否则重启启动器后顶栏永远是「未登录 / 👤」，跟账号页显示的登录态对不上。
  updateTopUser();

  renderPage('home');

  // 版本清单 / 已装版本后台补齐：
  // 不主动重渲染页面（会打断玩家正在进行的操作），首页版本下拉有自己的局部刷新，
  // 版本页等在渲染时若发现 manifest 缺失会自取。
  api.versionsManifest(true).then(async (m) => {
    state.manifest = m;
    state.installed = await api.versionsInstalled();
  }).catch((e) => toast(`版本清单加载失败：${e.message}`, true));

  // 侧栏底部的版本号写死在 HTML 里，打包换版本就会对不上，改成读真实版本；点它跳更新设置
  api.updaterVersion().then((uv) => {
    state.updateInfo = uv;
    const foot = $('foot-status');
    if (foot) {
      foot.title = `CM Minecraft Launcher v${uv.version}${uv.portable ? '（免安装版）' : ''} · 点这里检查更新`;
      foot.onclick = openUpdateSettings;
      const ver = $('foot-ver');
      if (ver) ver.textContent = `v${uv.version} · 运行正常`;
    }
  }).catch(() => {});

  // 下载进度只有这一个监听口，DOM 不在（没停在设置页更新区）就什么都不做
  api.onUpdateProgress((p) => {
    const fill = $('up-fill');
    if (!fill) return;
    const track = $('up-progress');
    if (track) track.hidden = false;
    fill.style.width = `${p.percent || 0}%`;
    const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
    const st = $('up-status');
    if (st) {
      st.textContent = `下载中 ${p.percent}% · ${mb(p.received)}${p.total ? ` / ${mb(p.total)}` : ''}`
        + (p.speed ? ` · ${(p.speed / 1048576).toFixed(1)} MB/s` : '');
    }
  });

  // 后台静默查更新，不挡界面
  autoCheckUpdate();
}

/** 从主进程刷新账号列表 */
async function refreshAccounts() {
  state.config = await api.configGetAll();
  state.accounts = state.config.accounts || [];
  state.account = state.config.account;
  updateTopUser();
}

/** 把「通透度 0–100」写进 CSS 令牌：100 = 卡片与侧栏一点底色都不留，背景原样透出来 */
function applyGlass() {
  const ui = state.config.ui || {};
  let g = Number(ui.glassLevel);
  if (!Number.isFinite(g)) g = 55;
  g = Math.max(0, Math.min(100, g));
  // 「自动」开启且窗口失焦时收一点，省电、不抢眼
  if (ui.glassAuto !== false && document.body.dataset.focus === '0') g = Math.max(0, g - 18);
  // 材质（模糊倍率 + 颗粒噪点）与通透度解耦，两条令牌各写各的
  const mat = GlassMotion.materialOf(ui.glassMaterial);
  document.body.style.setProperty('--g', String(g / 100));
  document.body.style.setProperty('--glass-blur-k', String(mat.blurK));
  document.body.setAttribute('data-material', mat.id);
  document.body.setAttribute('data-transparent', g >= 70 ? '1' : '0');
}

function applyTheme() {
  document.body.setAttribute('data-accent', state.config.accent);
  document.body.setAttribute('data-mode', resolveMode());
  const ui = Object.assign(
    { glassLevel: 55, glassAuto: true, density: 'normal', aura: 'std' },
    state.config.ui || {},
  );
  document.body.setAttribute('data-density', ui.density);
  document.body.setAttribute('data-aura', ui.aura);
  applyGlass();
  applyWallpaper();
}

/* ---------- 明暗模式：深色 / 浅色 / OLED / 跟随系统 ---------- */

const THEME_OPTS = [
  { id: 'dark', label: '深色' },
  { id: 'light', label: '浅色' },
  { id: 'oled', label: 'OLED' },
  { id: 'system', label: '跟随系统' },
];

/** 把「跟随系统」解析成实际生效的 dark / light */
function resolveMode() {
  const t = state.config.theme || 'dark';
  if (t === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return t;
}

function bindThemeOpts() {
  const box = $('ui-theme');
  if (!box) return;
  const cur = state.config.theme || 'dark';
  THEME_OPTS.forEach((o) => {
    const b = ce('button', 'ui-opt' + (o.id === cur ? ' on' : ''));
    b.type = 'button';
    b.textContent = o.label;
    b.onclick = () => {
      box.querySelectorAll('.ui-opt').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.config.theme = o.id;
      applyTheme();
      api.configUpdate({ theme: o.id });
    };
    box.appendChild(b);
  });
}

/** 选了「跟随系统」时，系统切换明暗要实时跟上 */
function bindSystemTheme() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if ((state.config.theme || 'dark') === 'system') applyTheme();
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

/** 液态玻璃「自动」：窗口失焦时自动收一档 */
function bindGlassAuto() {
  const sync = (focused) => {
    document.body.setAttribute('data-focus', focused ? '1' : '0');
    applyGlass();
  };
  sync(document.hasFocus());
  window.addEventListener('focus', () => sync(true));
  window.addEventListener('blur', () => sync(false));
}

/* ---------- 外观自定义：界面密度 / 背景氛围 ---------- */
const UI_OPTS = {
  density: [
    { id: 'compact', label: '紧凑' },
    { id: 'normal', label: '标准' },
    { id: 'cozy', label: '宽松' },
  ],
  aura: [
    { id: 'off', label: '关闭' },
    { id: 'soft', label: '弱' },
    { id: 'std', label: '标准' },
    { id: 'strong', label: '强' },
  ],
};

function bindUiPrefs() {
  for (const key of Object.keys(UI_OPTS)) {
    const box = $(`ui-${key}`);
    if (!box) continue;
    const opts = UI_OPTS[key];
    const cur = (state.config.ui && state.config.ui[key]) || opts[0].id;

    opts.forEach((o) => {
      const b = ce('button', 'ui-opt' + (o.id === cur ? ' on' : ''));
      b.type = 'button';
      b.textContent = o.label;
      b.onclick = () => {
        box.querySelectorAll('.ui-opt').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        state.config.ui = Object.assign({}, state.config.ui, { [key]: o.id });
        applyAndSave({ ui: state.config.ui });
      };
      box.appendChild(b);
    });
  }
  bindGlassMaterial();
  bindGlassSlider();
  bindThemeOpts();
  bindWallpaperPanel();
}

/* ---------- 液态玻璃：0–100 连续滑杆 ---------- */

function glassHint(n) {
  if (n <= 0) return '完全不透明，背景被整个挡住，文字最锐利';
  if (n < 30) return '厚实的磨砂玻璃，几乎看不见背后';
  if (n < 70) return '标准的液态玻璃：能隐约看见背景，但不抢文字';
  if (n < 100) return '清透玻璃：背景清晰可辨，只剩一圈亮边托住轮廓（苹果「透明」档就是这个区间）';
  return '完全透明：面板一点底色都不留，模糊归零，背景原样透出来，只剩一圈亮边托住轮廓（窗口本身仍是实心）';
}

function bindGlassSlider() {
  const s = $('ui-glass');
  if (!s) return;
  const v = $('ui-glass-val');
  const auto = $('ui-glass-auto');
  const hint = $('ui-glass-hint');
  const ui = state.config.ui || {};
  const init = Number.isFinite(Number(ui.glassLevel)) ? Number(ui.glassLevel) : 55;
  s.value = String(init);
  if (v) v.textContent = init + '%';
  if (auto) auto.checked = ui.glassAuto !== false;
  if (hint) hint.textContent = glassHint(init);

  const paint = (n) => {
    if (v) v.textContent = n + '%';
    if (hint) hint.textContent = glassHint(n);
    syncGlassMaterialRow(n);
  };
  const commit = (save) => {
    const n = Math.max(0, Math.min(100, Math.round(Number(s.value) || 0)));
    paint(n);
    // 滑杆一动就重算档位：正好落在亚克力 / 不透明的代表值上就点亮该档，否则回落「自定义」。
    // 只改 glassLevel 会留下「档位写不透明、值却是 59%」的矛盾配置，模糊倍率也会跟着用错。
    state.config.ui = Object.assign({}, state.config.ui, {
      glassLevel: n,
      glassMaterial: GlassMotion.materialForLevel(n) || 'custom',
    });
    applyGlass();
    if (save) api.configUpdate({ ui: state.config.ui });
  };
  s.oninput = () => commit(false);
  s.onchange = () => commit(true);

  if (auto) {
    auto.onchange = () => {
      state.config.ui = Object.assign({}, state.config.ui, { glassAuto: auto.checked });
      applyGlass();
      api.configUpdate({ ui: state.config.ui });
    };
  }
  syncGlassMaterialRow(init);
}

/* ---------- 玻璃材质档：透明 / 亚克力 / 不透明（快捷预设，不取代滑杆） ---------- */

/** 当前通透度是否正好落在某一档上；落在哪一档就点亮哪一档 */
function syncGlassMaterialRow(level) {
  const box = $('ui-material');
  if (!box) return;
  const id = GlassMotion.materialForLevel(level);
  box.querySelectorAll('.ui-opt[data-material]').forEach((b) => {
    b.classList.toggle('on', b.dataset.material === id);
  });
  const custom = box.querySelector('.ui-opt[data-role="custom"]');
  if (custom) custom.hidden = !!id;
}

/** 点档位：材质与通透度一起跳到该档代表值，滑杆仍可继续微调 */
function applyGlassMaterialPreset(id) {
  const m = GlassMotion.materialOf(id);
  if (m.g === null) return;
  state.config.ui = Object.assign({}, state.config.ui, { glassMaterial: m.id, glassLevel: m.g });
  const s = $('ui-glass');
  if (s) s.value = String(m.g);
  const v = $('ui-glass-val');
  if (v) v.textContent = m.g + '%';
  const hint = $('ui-glass-hint');
  if (hint) hint.textContent = `${m.label}档 · ${glassHint(m.g)}`;
  syncGlassMaterialRow(m.g);
  applyGlass();
  api.configUpdate({ ui: state.config.ui });
}

function bindGlassMaterial() {
  const box = $('ui-material');
  if (!box) return;
  GlassMotion.PRESETS.forEach((id) => {
    const m = GlassMotion.MATERIALS[id];
    const b = ce('button', 'ui-opt');
    b.type = 'button';
    b.dataset.material = m.id;
    b.textContent = m.label;
    b.title = `跳到 ${m.g}% 通透度`;
    b.onclick = () => applyGlassMaterialPreset(m.id);
    box.appendChild(b);
  });
  // 「自定义」是派生出来的状态，只是个提示，span 天生不可点
  const custom = ce('span', 'ui-opt');
  custom.dataset.role = 'custom';
  custom.textContent = '自定义';
  custom.hidden = true;
  box.appendChild(custom);
}

/* ---------- 自定义背景：图片 / 动图 / 视频 / 实况照片 ---------- */

const WALL_KIND = { image: '静态图片', animated: '动图', video: '视频', live: '实况照片', unknown: '文件' };
const WALL_MAX_W = 7680;   // 8K 硬性上限
const WALL_MAX_H = 4320;

/** 绝对路径 → file:// URL（Windows 反斜杠要转正斜杠） */
function toFileUrl(p) {
  if (!p) return '';
  const norm = String(p).replace(/\\/g, '/');
  return 'file:///' + norm.replace(/^\/+/, '');
}

/** 读媒体真实分辨率；超过 8K 判定超限 */
function probeMedia(url, isVideo) {
  return new Promise((resolve) => {
    const el = isVideo ? document.createElement('video') : new Image();
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => finish({ ok: false }), 8000);
    const ok = () => {
      clearTimeout(timer);
      const w = isVideo ? el.videoWidth : el.naturalWidth;
      const h = isVideo ? el.videoHeight : el.naturalHeight;
      finish({ ok: w > 0 && h > 0, w, h, tooBig: w > WALL_MAX_W || h > WALL_MAX_H });
    };
    if (isVideo) { el.onloadedmetadata = ok; el.muted = true; } else { el.onload = ok; }
    el.onerror = () => { clearTimeout(timer); finish({ ok: false }); };
    el.src = url;
  });
}

function setBgMedia(el, url, show) {
  if (!el) return;
  if (show && url) {
    if (el.dataset.src !== url) { el.dataset.src = url; el.src = url; }
    el.hidden = false;
  } else {
    el.hidden = true;
    el.removeAttribute('src');
    delete el.dataset.src;
  }
}

/** 依据配置把背景铺到 .bg-layer */
function applyWallpaper() {
  const img = $('bg-image');
  const vid = $('bg-video');
  if (!img || !vid) return;
  const c = state.config;
  const active = c.wallpaperType === 'custom' && !!c.wallpaperUrl;
  document.body.setAttribute('data-wall', active ? 'custom' : 'builtin');
  if (!active) {
    setBgMedia(img, '', false);
    setBgMedia(vid, '', false);
    return;
  }
  const kind = c.wallpaperKind || '';
  const useVideo = kind === 'video' || (kind === 'live' && !!c.wallpaperLive);
  if (useVideo) {
    setBgMedia(vid, toFileUrl(c.wallpaperLive || c.wallpaperUrl), true);
    setBgMedia(img, '', false);
    const p = vid.play();
    if (p && p.catch) p.catch(() => {});
  } else {
    setBgMedia(img, toFileUrl(c.wallpaperUrl), true);
    setBgMedia(vid, '', false);
  }
}

function baseName(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

function paintWallInfo(info, dim) {
  const box = $('wall-info');
  if (!box) return;
  if (info) {
    const res = dim && dim.ok ? `${dim.w}×${dim.h}` : '分辨率未知';
    box.innerHTML =
      `<span class="wall-name">${escapeHtml(info.name)}</span>` +
      `<span class="wall-tag">${WALL_KIND[info.kind] || '文件'}</span>` +
      `<span>${res}</span><span>${info.sizeMB}MB</span>`;
    return;
  }
  if (state.config.wallpaperType === 'custom' && state.config.wallpaperUrl) {
    box.innerHTML =
      `<span class="wall-name">${escapeHtml(baseName(state.config.wallpaperUrl))}</span>` +
      `<span class="wall-tag">${WALL_KIND[state.config.wallpaperKind] || '自定义'}</span>` +
      `<span>已启用</span>`;
  } else {
    box.innerHTML = '<span>当前为内置渐变背景</span>';
  }
}

async function pickWallpaper() {
  const info = await api.wallpaperPick();
  if (!info) return;

  // 实况照片 / JPEG：先解析出可播放的动态片段
  let livePath = '';
  if (info.kind === 'live' || info.ext === '.jpg' || info.ext === '.jpeg') {
    const r = await api.wallpaperLive(info.path);
    if (r && r.path) livePath = r.path;
    if (!livePath) {
      toast(`实况照片解析失败：${(r && r.reason) || '没有找到动态片段'}`, true);
      if (info.kind === 'live') return;
    }
  }

  // 硬性限制 8K：超过 7680×4320 直接拒绝
  const useVideo = info.kind === 'video' || (info.kind === 'live' && !!livePath);
  const dim = await probeMedia(useVideo ? toFileUrl(livePath || info.path) : info.url, useVideo);
  if (dim.ok && dim.tooBig) {
    toast(`分辨率 ${dim.w}×${dim.h} 超过 8K 上限（${WALL_MAX_W}×${WALL_MAX_H}），已拒绝`, true);
    return;
  }

  applyAndSave({
    wallpaperType: 'custom',
    wallpaperUrl: info.path,
    wallpaperKind: info.kind,
    wallpaperLive: livePath,
  });
  paintWallInfo(info, dim);
  toast(`已应用背景：${info.name}`);
}

function bindWallpaperPanel() {
  paintWallInfo(null);
  const pick = $('btn-wall-pick');
  const reset = $('btn-wall-reset');
  if (pick) pick.onclick = () => pickWallpaper();
  if (reset) {
    reset.onclick = () => {
      applyAndSave({ wallpaperType: 'builtin', wallpaperUrl: '', wallpaperKind: '', wallpaperLive: '' });
      paintWallInfo(null);
      toast('已恢复内置背景');
    };
  }
}

/* ========== 顶栏 ========== */

function bindTopbar() {
  updateTopUser();
  $('top-user').onclick = () => renderPage('account');
  $('top-browser').onclick = () => api.browserOpen();
  $('top-launch').onclick = () => {
    if (state.currentPage !== 'home') renderPage('home');
    setTimeout(() => $('home-play') && $('home-play').click(), 80);
  };
  $('top-search').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      if (!q) return;
      renderPage('center');
      setTimeout(() => {
        const input = $('mod-search') || $('res-search') || $('mp-search');
        if (input) { input.value = q; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); }
      }, 120);
    }
  };
  // Ctrl+K 聚焦搜索
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      $('top-search').focus();
    }
  });
}

/* ---------- 皮肤头像：把账号的皮肤纹理裁成头像，顶栏 / 账号页共用 ---------- */
// 头像缓存：key = 账号 uuid。换账号或换皮肤后由 resetAccountHead() 清掉重取。
const headCache = Object.create(null);
let headBusy = '';

/** 把一段皮肤纹理裁成正方形头像，返回 dataURL；取不到返回空串 */
function headDataUrlFromSkin(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = 64;
        cv.height = 64;
        paintSkinHead(cv, im);
        resolve(cv.toDataURL('image/png'));
      } catch { resolve(''); }
    };
    im.onerror = () => resolve('');
    im.src = src;
  });
}

/**
 * 当前账号的皮肤头像 dataURL（带缓存）。
 * 纹理由主进程去取（正版走 Mojang、皮肤站走 Blessing Skin），
 * 不用 crafatar / minotar 这类境外图床 —— 它们在部分网络下根本加载不出来，
 * 界面上就只剩一个破图。
 */
async function currentAccountHead() {
  const acc = state.account;
  if (!acc || !acc.uuid) return '';
  if (headCache[acc.uuid] !== undefined) return headCache[acc.uuid];
  if (headBusy === acc.uuid) return '';
  headBusy = acc.uuid;
  let url = '';
  try {
    const r = await api.skinCurrent();
    if (r && r.dataUrl) url = await headDataUrlFromSkin(r.dataUrl);
  } catch { /* 没登录 / 网络不通：退回占位头像 */ }
  headBusy = '';
  headCache[acc.uuid] = url;
  return url;
}

/** 换账号 / 换皮肤后把头像缓存清掉，让顶栏重新取一次 */
function resetAccountHead() {
  Object.keys(headCache).forEach((k) => delete headCache[k]);
  updateTopUser();
}

/** 顶栏头像：登录后换成玩家皮肤头，取不到才退回 👤 */
async function paintTopAvatar() {
  const el = $('top-avatar');
  if (!el) return;
  const acc = state.account;
  if (!acc) {
    el.textContent = '👤';
    el.style.backgroundImage = '';
    el.classList.remove('has-skin');
    return;
  }
  const mine = acc.uuid;
  const url = await currentAccountHead();
  // 异步回来时账号可能已经切走、页面也可能重建过了
  if (!el.isConnected || !state.account || state.account.uuid !== mine) return;
  if (url) {
    el.textContent = '';
    el.style.backgroundImage = `url("${url}")`;
    el.classList.add('has-skin');
  } else {
    el.textContent = '👤';
    el.style.backgroundImage = '';
    el.classList.remove('has-skin');
  }
}

function updateTopUser() {
  const nameEl = $('top-username');
  const typeEl = $('top-usertype');
  if (!nameEl) return;
  if (state.account) {
    nameEl.textContent = state.account.username;
    typeEl.textContent = state.account.type === 'microsoft' ? '微软账号'
      : state.account.type === 'yggdrasil' ? '外置登录' : '离线账号';
  } else {
    nameEl.textContent = '未登录';
    typeEl.textContent = '点击登录';
  }
  paintTopAvatar();
}

/* ========== 窗口控制 ========== */

function bindWindowControls() {
  $('win-min').onclick = () => api.minimize();
  $('win-max').onclick = () => api.toggleMaximize();
  $('win-close').onclick = () => api.close();
}

/* ========== 导航 ========== */

function bindNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.onclick = () => renderPage(btn.dataset.page);
  });
}

function renderPage(page) {
  // 切换页面时清理定时器
  if (state._memTimer) { clearInterval(state._memTimer); state._memTimer = null; }
  liquidFinish();   // 页面即将重建，先把可能的拖动手势收回
  state.currentPage = page;
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === page);
  });
  const content = $('content');
  content.innerHTML = '';
  const pageEl = ce('div', 'page');
  content.appendChild(pageEl);

  const renderers = {
    home: renderHome,
    instances: renderInstances,
    instance: renderInstanceDetail,
    world: renderWorldEditor,
    versions: renderVersions,
    center: renderCenter,
    lab: renderLab,
    servers: renderServers,
    account: renderAccount,
    skins: renderSkins,
    downloads: renderDownloads,
    settings: renderSettings,
  };
  (renderers[page] || renderHome)(pageEl);
}

/* ========== 通用：文本输入弹窗（Electron 不支持 prompt） ========== */

function askText(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    const mask = ce('div', 'modal-mask');
    mask.innerHTML = `
      <div class="modal">
        <div class="modal-title">${title}</div>
        <input class="input" id="modal-input" placeholder="${placeholder}">
        <div class="modal-actions">
          <button class="btn ghost" id="modal-cancel">取消</button>
          <button class="btn primary" id="modal-ok">确定</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);
    const input = mask.querySelector('#modal-input');
    input.value = value;
    setTimeout(() => { input.focus(); input.select(); }, 30);

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      mask.remove();
      resolve(v);
    };
    mask.querySelector('#modal-ok').onclick = () => finish(input.value.trim());
    mask.querySelector('#modal-cancel').onclick = () => finish(null);
    mask.onclick = (e) => { if (e.target === mask) finish(null); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') finish(input.value.trim());
      if (e.key === 'Escape') finish(null);
    };
  });
}

/* ========== 选择弹窗 ========== */

/**
 * 通用二选一弹窗，风格与 askText 一致。
 * @param {string} title
 * @param {Array<{value:string,label:string,desc?:string}>} options 2~3 项
 * @returns {Promise<string|null>} 选中的 value，取消为 null
 */
function askChoice(title, options) {
  return new Promise((resolve) => {
    const mask = ce('div', 'modal-mask');
    const items = options.map((o, i) => `
      <button class="btn ${i === 0 ? 'primary' : ''}" data-v="${o.value}"
        style="width:100%;text-align:left;margin-bottom:10px;padding:12px 14px">
        <span style="display:block;font-size:13.5px">${o.label}</span>
        ${o.desc ? `<span class="hint-text" style="display:block;margin-top:5px;line-height:1.6">${o.desc}</span>` : ''}
      </button>
    `).join('');
    mask.innerHTML = `
      <div class="modal">
        <div class="modal-title">${title}</div>
        <div style="margin:14px 0 6px">${items}</div>
        <div class="modal-actions">
          <button class="btn ghost" id="modal-cancel">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      mask.remove();
      resolve(v);
    };
    mask.querySelectorAll('[data-v]').forEach((b) => {
      b.onclick = () => finish(b.dataset.v);
    });
    mask.querySelector('#modal-cancel').onclick = () => finish(null);
    mask.onclick = (e) => { if (e.target === mask) finish(null); };
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape' && done === false && document.body.contains(mask)) {
        finish(null);
        document.removeEventListener('keydown', esc);
      }
    });
  });
}

/* ========== 实例管理 ========== */

const LOADERS = [
  { id: 'vanilla', name: '原版' },
  { id: 'fabric', name: 'Fabric' },
  { id: 'forge', name: 'Forge' },
  { id: 'neoforge', name: 'NeoForge' },
  { id: 'quilt', name: 'Quilt' },
];

function loaderName(id) {
  const l = LOADERS.find((x) => x.id === id);
  return l ? l.name : (id || '原版');
}

/**
 * 从 versionId 提取 MC 版本号。Fabric/Quilt 的 id 以 loader 版本开头
 * （fabric-loader-0.15.0-1.20.1），不能用开头数字；NeoForge 的 id
 * （neoforge-21.1.93）里没有 MC 版本，要求版本号前不能紧跟数字/点，
 * 防止把 21.1.93 截出 1.1.93。提不出来返回 ''，搜索时不带版本过滤。
 */
function mcVerOf(versionId) {
  const m = String(versionId || '').match(/(?:^|[^\d.])(1\.\d+(?:\.\d+)?)/);
  return m ? m[1] : '';
}

function instGameDir(inst) {
  return (inst && inst.gameDir) || state.config.gameDir;
}

/** 实例表中的第一个 id（key 顺序），没有实例时为 ''。default 已可被删除，不能再写死兜底。 */
function firstInstanceId(map) {
  const ks = Object.keys(map || {});
  return ks[0] || '';
}

/** 当前选中实例；选中项已被删时回落到第一个实例，全空时为 null。 */
function currentInstanceOf(map, id) {
  return (map && map[id]) || (map && map[firstInstanceId(map)]) || null;
}

async function refreshConfig() {
  state.config = await api.configGetAll();
}

function timeAgo(ms) {
  if (!ms) return '从未';
  const d = Date.now() - ms;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  if (d < 2592000000) return `${Math.floor(d / 86400000)} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}

function renderInstances(page) {
  const instances = state.config.instances || {};
  const f = state.instFilter || (state.instFilter = { q: '', loader: 'all', group: 'all' });
  if (!state.instSelected) state.instSelected = new Set();
  const sel = state.instSelected;

  const all = Object.entries(instances).map(([id, v]) => ({ id, ...v }));
  const groupNames = [...new Set(all.map((i) => i.group || ''))];

  let list = all;
  if (f.q) list = list.filter((i) => (i.name || '').toLowerCase().includes(f.q.toLowerCase()));
  if (f.loader !== 'all') list = list.filter((i) => (i.modLoader || 'vanilla') === f.loader);
  if (f.group !== 'all') list = list.filter((i) => (i.group || '') === f.group);

  const byGroup = {};
  for (const i of list) {
    const g = i.group || '未分组';
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(i);
  }

  page.innerHTML = `
    <div class="page-title">实例管理</div>
    <div class="page-sub">每个实例拥有独立的模组、存档与配置，互不干扰</div>

    <div class="inst-toolbar">
      <input class="input" id="inst-q" placeholder="搜索实例…" value="${f.q}">
      <select class="input" id="inst-loader">
        <option value="all">全部加载器</option>
        ${LOADERS.map((l) => `<option value="${l.id}"${f.loader === l.id ? ' selected' : ''}>${l.name}</option>`).join('')}
      </select>
      <select class="input" id="inst-group">
        <option value="all">全部分组</option>
        ${groupNames.map((g) => `<option value="${g}"${f.group === g ? ' selected' : ''}>${g || '未分组'}</option>`).join('')}
      </select>
      <button class="btn primary" id="inst-new">＋ 新建实例</button>
    </div>

    <div class="batch-bar" id="batch-bar" style="display:none">
      <span id="batch-count"></span>
      <button class="btn sm" id="batch-group">归入分组</button>
      <button class="btn sm" id="batch-export">导出整合包</button>
      <button class="btn sm danger" id="batch-delete">删除</button>
      <button class="btn sm ghost" id="batch-clear">取消选择</button>
    </div>

    <div id="inst-groups"></div>
  `;

  const groupsEl = $('inst-groups');
  if (!list.length) {
    groupsEl.innerHTML = '<div class="empty-tip">没有符合条件的实例</div>';
  } else {
    for (const [g, items] of Object.entries(byGroup)) {
      const sec = ce('div', 'inst-group');
      sec.innerHTML = `<div class="inst-group-head"><span class="inst-group-name">${g}</span><span class="inst-group-count">${items.length}</span></div>`;
      const grid = ce('div', 'inst-grid');
      for (const it of items) grid.appendChild(instCard(it, sel));
      sec.appendChild(grid);
      groupsEl.appendChild(sec);
    }
  }

  $('inst-q').oninput = (e) => {
    f.q = e.target.value;
    renderInstances(page);
    const el = $('inst-q');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  };
  $('inst-loader').onchange = (e) => { f.loader = e.target.value; renderInstances(page); };
  $('inst-group').onchange = (e) => { f.group = e.target.value; renderInstances(page); };
  $('inst-new').onclick = () => createInstance(page);

  const syncBatch = () => {
    const bar = $('batch-bar');
    if (!bar) return;
    bar.style.display = sel.size ? 'flex' : 'none';
    if (sel.size) $('batch-count').textContent = `已选择 ${sel.size} 个实例`;
  };
  syncBatch();

  $('batch-clear').onclick = () => { sel.clear(); renderInstances(page); };
  $('batch-group').onclick = async () => {
    const g = await askText('归入分组', '', '输入分组名，留空表示移出分组');
    if (g === null) return;
    for (const id of sel) {
      const data = instances[id];
      if (data) await api.instancesSave(id, { ...data, group: g });
    }
    sel.clear();
    await refreshConfig();
    toast(`已归入「${g || '未分组'}」`);
    renderInstances(page);
  };
  $('batch-export').onclick = async () => {
    const ids = [...sel];
    if (ids.length !== 1) return toast('导出整合包一次只能选 1 个实例', true);
    await doExport(ids[0]);
  };
  $('batch-delete').onclick = async () => {
    const ids = [...sel];
    if (!ids.length) return toast('请先选择要删除的实例', true);
    const ok = window.confirm(`确定删除这 ${ids.length} 个实例吗？\n（只移除实例记录，不会删除游戏文件）`);
    if (!ok) return;
    for (const id of ids) await api.instancesDelete(id);
    sel.clear();
    await refreshConfig();
    toast('已删除');
    renderInstances(page);
  };
}

function instCard(it, sel) {
  const checked = sel.has(it.id);
  const isCurrent = state.selectedInstance === it.id;
  const card = ce('div', 'inst-card' + (checked ? ' selected' : ''));

  card.innerHTML = `
    <div class="inst-card-top">
      <label class="inst-check"><input type="checkbox"${checked ? ' checked' : ''}></label>
      <div class="inst-icon">${it.icon || '⛏️'}</div>
      <div class="inst-info">
        <div class="inst-name">${it.name}${isCurrent ? '<span class="badge">使用中</span>' : ''}</div>
        <div class="inst-meta">${it.versionId || '未选版本'} · ${loaderName(it.modLoader)}</div>
      </div>
    </div>
    <div class="inst-card-actions">
      <button class="btn sm primary" data-act="launch">启动</button>
      <button class="btn sm" data-act="detail">详情</button>
      <button class="btn sm" data-act="folder">目录</button>
      <button class="btn sm ghost" data-act="rename">重命名</button>
      <button class="btn sm danger" data-act="delete">删除</button>
    </div>
  `;

  // 卡片本体也能点：以前只有按钮有 handler，玩家点卡片一片死寂。
  // 勾选区 / 按钮区各自处理，别抢它们的点击。
  card.onclick = (e) => {
    if (e.target.closest('input, label, button')) return;
    openInstance(it.id);
  };

  const box = card.querySelector('input[type=checkbox]');
  box.onchange = () => {
    if (box.checked) sel.add(it.id); else sel.delete(it.id);
    card.classList.toggle('selected', box.checked);
    renderPage('instances');
  };

  card.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'launch') {
        state.selectedInstance = it.id;
        await api.configSet('selectedInstance', it.id);
        renderPage('home');
        setTimeout(() => $('home-play') && $('home-play').click(), 80);
      } else if (act === 'detail') {
        openInstance(it.id);
      } else if (act === 'folder') {
        api.openPath(instGameDir(it));
      } else if (act === 'rename') {
        const name = await askText('重命名实例', it.name);
        if (!name) return;
        await api.instancesSave(it.id, { ...it, id: undefined, name });
        await refreshConfig();
        renderPage('instances');
      } else if (act === 'delete') {
        if (!window.confirm(`删除实例「${it.name}」？\n（只移除实例记录，不会删除游戏文件）`)) return;
        await api.instancesDelete(it.id);
        await refreshConfig();
        renderPage('instances');
      }
    };
  });

  return card;
}

async function createInstance(page) {
  const name = await askText('新建实例', '', '例如：1.20.1 生存专用');
  if (!name) return;
  const id = `inst_${Date.now().toString(36)}`;
  const baseDir = state.config.gameDir;
  await api.instancesSave(id, {
    name,
    versionId: '',
    gameDir: `${baseDir}/instances/${id}`,
    modLoader: 'vanilla',
    loaderVersion: '',
    javaPath: '',
    memory: null,
    jvmArgs: '',
    icon: '⛏',
    group: '',
  });
  await refreshConfig();
  toast(`实例「${name}」已创建，去版本管理选个版本吧`);
  openInstance(id);
}

async function doExport(id) {
  try {
    showLoading('正在导出整合包…');
    const r = await api.instancesExport(id);
    hideLoading();
    if (r && r.canceled) return;
    toast(`导出完成，共 ${r.total} 个文件（${r.resolvedMods} 个模组走在线下载）`);
  } catch (e) {
    hideLoading();
    toast('导出失败：' + e.message, true);
  }
}

/* ---------- 实例详情 ---------- */

function openInstance(id) {
  state.currentInstanceId = id;
  state.instTab = 'mods';
  state.instTabCache = {};
  renderPage('instance');
}

function renderInstanceDetail(page) {
  const instances = state.config.instances || {};
  const id = state.currentInstanceId;
  const inst = instances[id];
  if (!inst) { renderPage('instances'); return; }

  const gameDir = instGameDir(inst);
  const tab = state.instTab || 'mods';
  const TABS = [
    { id: 'mods', name: '模组' },
    { id: 'resourcepacks', name: '资源包' },
    { id: 'shaders', name: '光影' },
    { id: 'saves', name: '存档' },
    { id: 'screenshots', name: '截图' },
    { id: 'logs', name: '日志' },
    { id: 'settings', name: '设置' },
  ];

  page.innerHTML = `
    <button class="btn sm ghost" id="inst-back" style="margin-bottom:14px">← 返回实例列表</button>

    <div class="inst-head">
      <div class="inst-icon big">${inst.icon || '⛏️'}</div>
      <div class="inst-head-info">
        <div class="inst-head-name">${inst.name}</div>
        <div class="inst-head-meta">${inst.versionId || '未选版本'} · ${loaderName(inst.modLoader)}${inst.loaderVersion ? ' ' + inst.loaderVersion : ''}</div>
      </div>
      <div class="row">
        <button class="btn primary" id="inst-launch">启动游戏</button>
        <button class="btn" id="inst-export">导出整合包</button>
        <button class="btn" id="inst-open">打开目录</button>
      </div>
    </div>

    <div class="tabs" id="inst-tabs">
      ${TABS.map((t) => `<button class="tab${t.id === tab ? ' active' : ''}" data-tab="${t.id}">${t.name}</button>`).join('')}
    </div>

    <div id="inst-tab-body"></div>
  `;

  $('inst-back').onclick = () => renderPage('instances');
  $('inst-open').onclick = () => api.openPath(gameDir);
  $('inst-export').onclick = () => doExport(id);
  $('inst-launch').onclick = async () => {
    state.selectedInstance = id;
    await api.configSet('selectedInstance', id);
    renderPage('home');
    setTimeout(() => $('home-play') && $('home-play').click(), 80);
  };

  page.querySelectorAll('#inst-tabs .tab').forEach((b) => {
    b.onclick = () => {
      state.instTab = b.dataset.tab;
      page.querySelectorAll('#inst-tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
      loadInstTab(inst, gameDir, b.dataset.tab);
    };
  });

  loadInstTab(inst, gameDir, tab);
}

function loadInstTab(inst, gameDir, tab) {
  const body = $('inst-tab-body');
  if (!body) return;
  // 把当前标签页落到 state 上，各标签页的异步加载回来时据此判断自己是否已经过气
  state.instTab = tab;
  body.innerHTML = '<div class="empty-tip">加载中…</div>';
  const loaders = {
    mods: loadModsTab,
    resourcepacks: loadResourcePacksTab,
    shaders: loadShadersTab,
    saves: loadSavesTab,
    screenshots: loadScreenshotsTab,
    logs: loadLogsTab,
    settings: loadInstanceSettings,
  };
  (loaders[tab] || loadModsTab)(inst, gameDir, body);
}

/* ---------- 模组 ---------- */

async function loadModsTab(inst, gameDir, body) {
  body.innerHTML = `
    <div class="row" style="margin-bottom:12px;flex-wrap:wrap">
      <button class="btn sm" id="mods-refresh">刷新</button>
      <button class="btn sm" id="mods-check">检查更新</button>
      <button class="btn sm" id="mods-open">打开 mods 文件夹</button>
      <span id="mods-hint" class="hint-text"></span>
    </div>
    <div class="card-list" id="mods-list"></div>
  `;
  $('mods-open').onclick = () => api.openPath(`${gameDir}/mods`);

  const render = async () => {
    const items = await api.modsList(gameDir);
    const list = $('mods-list');
    if (!list) return;
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="empty-tip">mods 文件夹为空，去资源中心装几个吧</div>';
      return;
    }
    for (const m of items) {
      const row = ce('div', 'mod-card');
      row.innerHTML = `
        <div class="mod-info">
          <div class="mod-name">${m.name}</div>
          <div class="mod-meta">${formatSize(m.size)}${m.disabled ? ' · 已禁用' : ''}</div>
        </div>
        <div class="mod-actions">
          <label class="switch"><input type="checkbox"${m.disabled ? '' : ' checked'}><span class="slider"></span></label>
          <button class="btn sm" data-act="rollback">版本</button>
          <button class="btn sm danger" data-act="del">删除</button>
        </div>
      `;
      row.querySelector('input[type=checkbox]').onchange = async (e) => {
        try {
          await api.modsEnable(gameDir, m.name, e.target.checked);
          render();
        } catch (err) { toast(err.message, true); }
      };
      row.querySelector('[data-act=del]').onclick = async () => {
        if (!window.confirm(`删除 ${m.name}？`)) return;
        await api.modsDelete(gameDir, m.name);
        render();
      };
      row.querySelector('[data-act=rollback]').onclick = () => showModVersions(inst, gameDir, m.name);
      list.appendChild(row);
    }
  };

  $('mods-refresh').onclick = render;
  $('mods-check').onclick = async () => {
    const hint = $('mods-hint');
    hint.textContent = '正在比对 Modrinth…';
    try {
      const res = await api.modsCheckUpdates(gameDir, inst.versionId, inst.modLoader);
      const upd = res.filter((r) => r.updateAvailable);
      state.modUpdates = {};
      for (const r of res) if (r.known) state.modUpdates[r.file] = r;
      hint.textContent = `共 ${res.length} 个，${upd.length} 个可更新`;
      if (!upd.length) return;
      const list = $('mods-list');
      for (const u of upd) {
        const box = ce('div', 'update-row');
        box.innerHTML = `
          <div class="mod-info">
            <div class="mod-name">${u.projectName}</div>
            <div class="mod-meta">${u.currentVersion} → <b style="color:var(--accent)">${u.latestVersion}</b></div>
          </div>
          <button class="btn sm primary">更新</button>
        `;
        box.querySelector('button').onclick = async () => {
          try {
            showLoading('正在更新…');
            await api.modsInstallVersion(u.projectId, u.latestVersionId, gameDir, u.file);
            hideLoading();
            toast(`${u.projectName} 已更新到 ${u.latestVersion}`);
            render();
          } catch (e) { hideLoading(); toast(e.message, true); }
        };
        list.insertBefore(box, list.firstChild);
      }
    } catch (e) {
      hint.textContent = '';
      toast('检查更新失败：' + e.message, true);
    }
  };

  render();
}

async function showModVersions(inst, gameDir, fileName) {
  try {
    showLoading('正在查询历史版本…');
    const info = await api.modsResolve(gameDir, fileName);
    if (!info) { hideLoading(); return toast('该 Mod 不在 Modrinth 上，无法回滚', true); }
    const versions = await api.modsVersions(info.projectId, inst.versionId, inst.modLoader);
    hideLoading();
    if (!versions.length) return toast('没有找到适配当前版本的其它版本', true);

    const mask = ce('div', 'modal-mask');
    mask.innerHTML = `
      <div class="modal wide">
        <div class="modal-title">${info.projectName} · 选择版本</div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px">当前：${info.currentVersion}　（更新崩了可以退回旧版本）</div>
        <div class="ver-list" id="ver-list"></div>
        <div class="modal-actions"><button class="btn ghost" id="ver-close">关闭</button></div>
      </div>
    `;
    document.body.appendChild(mask);
    const list = mask.querySelector('#ver-list');
    for (const v of versions) {
      const row = ce('div', 'ver-row');
      const isCur = v.versionNumber === info.currentVersion;
      row.innerHTML = `
        <div class="mod-info">
          <div class="mod-name">${v.versionNumber}${isCur ? '<span class="badge">当前</span>' : ''}</div>
          <div class="mod-meta">${v.versionType} · ${new Date(v.date).toLocaleDateString('zh-CN')} · ${v.filename || ''}</div>
        </div>
        <button class="btn sm${isCur ? ' ghost' : ' primary'}"${isCur ? ' disabled' : ''}>${isCur ? '使用中' : '切换'}</button>
      `;
      if (!isCur) {
        row.querySelector('button').onclick = async () => {
          try {
            showLoading('正在下载…');
            await api.modsInstallVersion(info.projectId, v.id, gameDir, fileName);
            hideLoading();
            mask.remove();
            toast(`已切换到 ${v.versionNumber}`);
            renderPage('instances');
            openInstance(state.currentInstanceId);
          } catch (e) { hideLoading(); toast(e.message, true); }
        };
      }
      list.appendChild(row);
    }
    mask.querySelector('#ver-close').onclick = () => mask.remove();
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
  } catch (e) {
    hideLoading();
    toast(e.message, true);
  }
}

/* ---------- 资源包 ---------- */

async function loadResourcePacksTab(inst, gameDir, body) {
  const items = await api.contentResourcePacks(gameDir);
  body.innerHTML = `
    <div class="hint-text" style="margin-bottom:12px">启用的资源包会写入 options.txt，进游戏直接生效</div>
    <div class="card-list" id="rp-list"></div>
  `;
  const list = $('rp-list');
  if (!items.length) {
    list.innerHTML = '<div class="empty-tip">还没有资源包，去资源中心「资源包」分类下载</div>';
    return;
  }
  for (const p of items) {
    const row = ce('div', 'mod-card');
    row.innerHTML = `
      <div class="mod-icon">${p.icon ? `<img src="file:///${p.icon.replace(/\\/g, '/')}">` : '🎨'}</div>
      <div class="mod-info">
        <div class="mod-name">${p.name}</div>
        <div class="mod-meta">${p.type === 'folder' ? '文件夹' : 'ZIP'} · ${formatSize(p.size)}</div>
      </div>
      <div class="mod-actions">
        <label class="switch"><input type="checkbox"${p.enabled ? ' checked' : ''}><span class="slider"></span></label>
        <button class="btn sm danger" data-act="del">删除</button>
      </div>
    `;
    row.querySelector('input[type=checkbox]').onchange = async (e) => {
      await api.contentResourcePackToggle(gameDir, p.name, e.target.checked);
      toast(e.target.checked ? `已启用 ${p.name}` : `已禁用 ${p.name}`);
    };
    row.querySelector('[data-act=del]').onclick = async () => {
      if (!window.confirm(`删除资源包 ${p.name}？`)) return;
      await api.contentDelete(gameDir, 'resourcepacks', p.name);
      loadResourcePacksTab(inst, gameDir, body);
    };
    list.appendChild(row);
  }
}

/* ---------- 光影 ---------- */

async function loadShadersTab(inst, gameDir, body) {
  const items = await api.contentShaders(gameDir);
  body.innerHTML = `
    <div class="hint-text" style="margin-bottom:12px">需要安装 Iris 或 OptiFine 才能加载光影</div>
    <div class="card-list" id="sh-list"></div>
  `;
  const list = $('sh-list');
  if (!items.length) {
    list.innerHTML = '<div class="empty-tip">还没有光影包，去资源中心「光影」分类下载</div>';
    return;
  }
  for (const p of items) {
    const row = ce('div', 'mod-card');
    row.innerHTML = `
      <div class="mod-icon">✨</div>
      <div class="mod-info">
        <div class="mod-name">${p.name}</div>
        <div class="mod-meta">${formatSize(p.size)}${p.enabled ? ' · 正在使用' : ''}</div>
      </div>
      <div class="mod-actions">
        <button class="btn sm${p.enabled ? ' ghost' : ' primary'}" data-act="use"${p.enabled ? ' disabled' : ''}>${p.enabled ? '使用中' : '启用'}</button>
        <button class="btn sm danger" data-act="del">删除</button>
      </div>
    `;
    row.querySelector('[data-act=use]').onclick = async () => {
      await api.contentShaderEnable(gameDir, p.name);
      toast(`已启用光影 ${p.name}`);
      loadShadersTab(inst, gameDir, body);
    };
    row.querySelector('[data-act=del]').onclick = async () => {
      if (!window.confirm(`删除光影 ${p.name}？`)) return;
      await api.contentDelete(gameDir, 'shaderpacks', p.name);
      loadShadersTab(inst, gameDir, body);
    };
    list.appendChild(row);
  }
}

/* ---------- 存档 ---------- */

async function loadSavesTab(inst, gameDir, body) {
  const items = await api.worldList(gameDir);
  body.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <button class="btn sm" id="sv-open">打开 saves 文件夹</button>
      <span class="hint-text">共 ${items.length} 个存档 · 支持改名 / 模式 / 难度 / 作弊 / 种子 / 游戏规则</span>
    </div>
    <div class="save-grid" id="sv-grid"></div>
  `;
  $('sv-open').onclick = () => api.openPath(`${gameDir}/saves`);
  const grid = $('sv-grid');
  if (!items.length) {
    grid.innerHTML = '<div class="empty-tip">没有存档，进游戏创建世界后会出现在这里</div>';
    return;
  }
  for (const s of items) {
    const m = s.meta;
    const modeName = m ? (GAMEMODE_NAMES[m.gameType] || '未知') : '';
    const diffName = m ? (DIFFICULTY_NAMES[m.difficulty] || '') : '';
    const card = ce('div', 'save-card');
    card.innerHTML = `
      <div class="save-thumb">${s.icon ? `<img src="file:///${s.icon.replace(/\\/g, '/')}">` : '🌍'}</div>
      <div class="save-name">${escapeHtml(m ? m.name : s.name)}</div>
      <div class="save-meta">${timeAgo(s.lastPlayed)} · ${formatSize(s.size)}</div>
      ${m ? `<div class="save-meta2">${m.version ? `MC ${escapeHtml(m.version.name)} · ` : ''}${modeName} · ${diffName}${m.hardcore ? ' · 硬核' : ''}</div>` : ''}
      <div class="save-actions">
        <button class="btn sm primary" data-act="edit"${s.hasLevel ? '' : ' disabled'}>编辑</button>
        <button class="btn sm" data-act="folder">目录</button>
        <button class="btn sm danger" data-act="del">删除</button>
      </div>
    `;
    if (s.hasLevel) card.querySelector('[data-act=edit]').onclick = () => openWorldEditor(s);
    card.querySelector('[data-act=folder]').onclick = () => api.openPath(s.path);
    card.querySelector('[data-act=del]').onclick = async () => {
      if (!window.confirm(`删除存档「${m ? m.name : s.name}」？此操作不可恢复！`)) return;
      await api.contentDelete(gameDir, 'saves', s.name);
      loadSavesTab(inst, gameDir, body);
    };
    grid.appendChild(card);
  }
}

/* ---------- 存档（世界）编辑器 ---------- */

const GAMEMODE_NAMES = { 0: '生存', 1: '创造', 2: '冒险', 3: '旁观' };
const DIFFICULTY_NAMES = { 0: '和平', 1: '简单', 2: '普通', 3: '困难' };

let worldSchemaCache = null;

async function openWorldEditor(save) {
  state.worldSave = save;
  state.worldReturnTo = state.currentPage === 'world' ? state.worldReturnTo : state.currentPage;
  state.instTabCache = state.instTabCache || {};
  renderPage('world');
}

async function renderWorldEditor(page) {
  const save = state.worldSave;
  if (!save) { renderPage('instances'); return; }

  if (!worldSchemaCache) {
    try { worldSchemaCache = await api.worldSchema(); } catch { worldSchemaCache = { gamemodes: [], difficulties: [], gamerules: [] }; }
  }
  let info;
  try {
    info = await api.worldInfo(save.path);
  } catch (e) {
    // 上面几个 await 期间用户可能已经切页，page 已被拆下；这时 $('w-back') 是 null
    if (!page.isConnected) return;
    page.innerHTML = `<button class="btn sm" id="w-back">← 返回</button>
      <div class="empty-tip" style="margin-top:16px">读取失败：${escapeHtml(e.message)}</div>`;
    $('w-back').onclick = () => renderPage(state.worldReturnTo || 'instance');
    return;
  }
  if (!page.isConnected) return;   // 同上：读完了但页面早被切走，后面的 $() 查找都会落空

  const modeOpts = worldSchemaCache.gamemodes.map(
    (g) => `<option value="${g.id}"${g.id === info.gameType ? ' selected' : ''}>${g.name}</option>`
  ).join('');
  const diffOpts = worldSchemaCache.difficulties.map(
    (d) => `<option value="${d.id}"${d.id === info.difficulty ? ' selected' : ''}>${d.name}</option>`
  ).join('');

  const rules = info.gamerules || {};
  const ruleRows = worldSchemaCache.gamerules.map((r) => {
    const cur = rules[r.key];
    if (r.type === 'bool') {
      const on = cur === 'true' || cur === '1';
      return `
        <div class="rule-row">
          <div class="rule-label">${r.label}<span class="rule-key">${r.key}</span></div>
          <label class="switch"><input type="checkbox" data-rule="${r.key}" data-type="bool"${on ? ' checked' : ''}><span class="slider"></span></label>
        </div>`;
    }
    const val = cur != null ? cur : '0';
    return `
      <div class="rule-row">
        <div class="rule-label">${r.label}<span class="rule-key">${r.key}</span></div>
        <input class="input sm" type="number" data-rule="${r.key}" data-type="int" value="${escapeHtml(val)}">
      </div>`;
  }).join('');

  page.innerHTML = `
    <button class="btn sm" id="w-back" style="margin-bottom:14px">← 返回</button>
    <div class="inst-head">
      <div class="inst-icon big">🌍</div>
      <div class="inst-head-info">
        <div class="inst-name">${escapeHtml(info.name)}</div>
        <div class="inst-meta">${info.version ? `MC ${escapeHtml(info.version.name)}` : '未知版本'}${info.hardcore ? ' · 硬核模式' : ''} · 文件夹 ${escapeHtml(info.dirName)}</div>
      </div>
    </div>

    <div class="panel" style="padding:22px;margin-bottom:18px">
      <div class="section-title">基础设置</div>
      <div class="grid-2">
        <div class="field">
          <label>存档名称</label>
          <input class="input" id="w-name" value="${escapeHtml(info.name)}">
        </div>
        <div class="field">
          <label>世界种子</label>
          <input class="input" id="w-seed" value="${escapeHtml(info.seed)}" placeholder="整数">
        </div>
        <div class="field">
          <label>游戏模式</label>
          <select class="input" id="w-gametype">${modeOpts}</select>
        </div>
        <div class="field">
          <label>难度</label>
          <select class="input" id="w-difficulty">${diffOpts}</select>
        </div>
      </div>
      <div class="grid-2">
        <div class="field check">
          <label>允许作弊（使用指令）</label>
          <label class="switch"><input type="checkbox" id="w-cheats"${info.allowCommands ? ' checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="field check">
          <label>硬核模式（死亡即删档）</label>
          <label class="switch"><input type="checkbox" id="w-hardcore"${info.hardcore ? ' checked' : ''}><span class="slider"></span></label>
        </div>
      </div>
      <div class="hint-text">种子改动只影响新生成的地形，已探索区域不会改变；写入前会自动备份为 level.dat_old</div>
    </div>

    <div class="panel" style="padding:22px;margin-bottom:18px">
      <div class="section-title">游戏规则（gamerule）</div>
      <div class="rule-grid">${ruleRows}</div>
    </div>

    <div class="row">
      <button class="btn primary" id="w-save">保存修改</button>
      <button class="btn ghost" id="w-cancel">取消</button>
    </div>
  `;

  $('w-back').onclick = () => renderPage(state.worldReturnTo || 'instance');
  $('w-cancel').onclick = () => renderPage(state.worldReturnTo || 'instance');
  $('w-save').onclick = async () => {
    const patch = {
      name: $('w-name').value,
      gameType: Number($('w-gametype').value),
      difficulty: Number($('w-difficulty').value),
      seed: $('w-seed').value,
      allowCommands: $('w-cheats').checked,
      hardcore: $('w-hardcore').checked,
      gamerules: {},
    };
    page.querySelectorAll('[data-rule]').forEach((el) => {
      if (el.dataset.type === 'bool') patch.gamerules[el.dataset.rule] = el.checked ? 'true' : 'false';
      else patch.gamerules[el.dataset.rule] = String(el.value === '' ? 0 : el.value);
    });
    try {
      showLoading('正在写入 level.dat…');
      const updated = await api.worldUpdate(save.path, patch);
      hideLoading();
      toast('存档已更新');
      state.worldSave = { ...save, meta: { ...(save.meta || {}), ...updated } };
      renderPage('world');
    } catch (e) {
      hideLoading();
      toast('保存失败：' + e.message, true);
    }
  };
}

/* ---------- 截图 ---------- */

/** 截图灯箱：大图预览 + 上一张/下一张 + 删除 + 打开/复制路径 */
function openShotViewer(items, start, gameDir, onChanged) {
  let idx = start;
  const mask = ce('div', 'modal-mask shot-viewer');
  mask.innerHTML = `
    <div class="modal shot-modal">
      <div class="shot-view-head">
        <span class="shot-view-name" id="svv-name"></span>
        <span class="shot-view-idx" id="svv-idx"></span>
        <button class="btn sm ghost" id="svv-close" type="button">✕</button>
      </div>
      <div class="shot-view-body">
        <button class="shot-nav" id="svv-prev" type="button">‹</button>
        <img id="svv-img" alt="">
        <button class="shot-nav" id="svv-next" type="button">›</button>
      </div>
      <div class="modal-actions shot-view-acts">
        <span class="hint-text" id="svv-meta"></span>
        <button class="btn sm" id="svv-open" type="button">用系统程序打开</button>
        <button class="btn sm" id="svv-copy" type="button">复制路径</button>
        <button class="btn sm danger" id="svv-del" type="button">删除</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const show = () => {
    const s = items[idx];
    if (!s) return close();
    $('svv-img').src = `file:///${s.path.replace(/\\/g, '/')}`;
    $('svv-name').textContent = s.name;
    $('svv-idx').textContent = `${idx + 1} / ${items.length}`;
    $('svv-meta').textContent = `${formatSize(s.size)} · ${new Date(s.mtime).toLocaleString('zh-CN')}`;
    $('svv-prev').disabled = idx === 0;
    $('svv-next').disabled = idx === items.length - 1;
  };
  const close = () => mask.remove();

  $('svv-prev').onclick = () => { if (idx > 0) { idx--; show(); } };
  $('svv-next').onclick = () => { if (idx < items.length - 1) { idx++; show(); } };
  $('svv-close').onclick = close;
  $('svv-open').onclick = () => api.openPath(items[idx].path);
  $('svv-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(items[idx].path);
      toast('路径已复制');
    } catch { toast('复制失败', true); }
  };
  $('svv-del').onclick = async () => {
    const s = items[idx];
    try {
      await api.contentDelete(gameDir, 'screenshots', s.name);
      items.splice(idx, 1);
      toast('截图已删除');
      if (!items.length) { close(); onChanged && onChanged(); return; }
      if (idx >= items.length) idx = items.length - 1;
      show();
      onChanged && onChanged();
    } catch (e) {
      toast('删除失败：' + e.message, true);
    }
  };
  mask.onclick = (e) => { if (e.target === mask) close(); };
  mask.onkeydown = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft' && idx > 0) { idx--; show(); }
    if (e.key === 'ArrowRight' && idx < items.length - 1) { idx++; show(); }
  };
  mask.tabIndex = 0;
  mask.focus();
  show();
}

async function loadScreenshotsTab(inst, gameDir, body) {
  const items = await api.contentScreenshots(gameDir);
  // 读取期间玩家可能切了标签页或整个页面：此时 body 已不属于本次调用，
  // 再往下写会把新页面的内容覆盖掉，取 #sc-open 也会拿到 null
  if (!body.isConnected || state.instTab !== 'screenshots') return;
  body.innerHTML = `
    <div class="row" style="margin-bottom:12px;flex-wrap:wrap;gap:10px">
      <button class="btn sm" id="sc-open">打开 screenshots 文件夹</button>
      <span class="hint-text">共 ${items.length} 张 · 点击缩略图进入查看器</span>
    </div>
    <div class="shot-grid" id="sc-grid"></div>
  `;
  $('sc-open').onclick = () => api.openPath(`${gameDir}/screenshots`);
  const grid = $('sc-grid');
  if (!items.length) {
    grid.innerHTML = '<div class="empty-tip">没有截图，游戏里按 F2 截图</div>';
    return;
  }
  items.forEach((s, i) => {
    const url = `file:///${s.path.replace(/\\/g, '/')}`;
    const cell = ce('div', 'shot-cell');
    cell.innerHTML = `<img src="${url}" loading="lazy"><div class="shot-meta">${new Date(s.mtime).toLocaleDateString('zh-CN')}</div>`;
    cell.onclick = () => openShotViewer(items, i, gameDir, () => loadScreenshotsTab(inst, gameDir, body));
    grid.appendChild(cell);
  });
}

/* ---------- 日志 ---------- */

async function loadLogsTab(inst, gameDir, body) {
  const items = await api.contentLogs(gameDir);
  // 同截图页：读取期间切走了就安静退出，别覆盖新页面、也别往 null 上挂事件
  if (!body.isConnected || state.instTab !== 'logs') return;
  body.innerHTML = `
    <div class="log-layout">
      <div class="log-list" id="log-list"></div>
      <div class="log-view" id="log-view"><div class="empty-tip">选择左侧日志文件查看内容</div></div>
    </div>
  `;
  const list = $('log-list');
  if (!items.length) {
    list.innerHTML = '<div class="empty-tip">还没有日志</div>';
    return;
  }
  const kindName = { log: '运行日志', crash: '崩溃报告', jvm: 'JVM 崩溃' };
  for (const f of items) {
    const row = ce('div', 'log-item');
    row.innerHTML = `
      <div class="log-item-name">${f.name}</div>
      <div class="log-item-meta">${kindName[f.kind] || ''} · ${formatSize(f.size)} · ${timeAgo(f.mtime)}</div>
    `;
    row.onclick = async () => {
      list.querySelectorAll('.log-item').forEach((x) => x.classList.toggle('active', x === row));
      try {
        const text = await api.contentLogRead(gameDir, f.rel);
        const view = $('log-view');
        if (!view || !view.isConnected) return; // 读取期间切走了页面，丢弃结果
        view.innerHTML = `<pre class="log-pre">${escapeHtml(text)}</pre>`;
      } catch (e) {
        const view = $('log-view');
        if (view && view.isConnected) view.innerHTML = `<div class="empty-tip">读取失败：${e.message}</div>`;
        else toast('读取日志失败：' + e.message, true);
      }
    };
    list.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- 实例设置 ---------- */

async function loadInstanceSettings(inst, gameDir, body) {
  const javas = await api.javaList().catch(() => []);
  body.innerHTML = `
    <div class="panel" style="padding:20px">
      <div class="field">
        <label>实例名称</label>
        <input class="input" id="is-name" value="${inst.name || ''}">
      </div>
      <div class="grid-2">
        <div class="field">
          <label>游戏版本</label>
          <select class="input" id="is-version">
            <option value="">未选择</option>
            ${(state.installed || []).map((v) => `<option value="${v}"${inst.versionId === v ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Mod 加载器</label>
          <select class="input" id="is-loader">
            ${LOADERS.map((l) => `<option value="${l.id}"${(inst.modLoader || 'vanilla') === l.id ? ' selected' : ''}>${l.name}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label>游戏目录</label>
        <div class="row">
          <input class="input grow" id="is-dir" value="${gameDir}">
          <button class="btn" id="is-dir-pick">选择</button>
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label>最大内存 (MB)</label>
          <input class="input" type="number" id="is-max" value="${inst.memory ? inst.memory.max : (state.config.maxMemory || 4096)}">
        </div>
        <div class="field">
          <label>Java 路径</label>
          <select class="input" id="is-java">
            <option value="">跟随全局设置</option>
            ${javas.map((j) => `<option value="${j.path}"${inst.javaPath === j.path ? ' selected' : ''}>Java ${j.version || ''} · ${j.path}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label>JVM 参数（留空则用全局）</label>
        <input class="input" id="is-jvm" value="${inst.jvmArgs || ''}" placeholder="-XX:+UseG1GC …">
      </div>
      <div class="row">
        <button class="btn primary" id="is-save">保存设置</button>
        <button class="btn" id="is-export">导出整合包</button>
        <button class="btn danger" id="is-delete">删除实例</button>
      </div>
    </div>
  `;

  $('is-dir-pick').onclick = async () => {
    const d = await api.pickDir();
    if (d) $('is-dir').value = d;
  };
  $('is-save').onclick = async () => {
    const max = parseInt($('is-max').value, 10) || 4096;
    await api.instancesSave(inst.id || state.currentInstanceId, {
      ...inst,
      name: $('is-name').value.trim() || inst.name,
      versionId: $('is-version').value,
      modLoader: $('is-loader').value,
      gameDir: $('is-dir').value,
      memory: { max, min: Math.min(512, max) },
      javaPath: $('is-java').value,
      jvmArgs: $('is-jvm').value,
    });
    await refreshConfig();
    toast('实例设置已保存');
    renderPage('instance');
  };
  $('is-export').onclick = () => doExport(state.currentInstanceId);
  $('is-delete').onclick = async () => {
    if (!window.confirm(`删除实例「${inst.name}」？\n（只移除实例记录，不会删除游戏文件）`)) return;
    await api.instancesDelete(state.currentInstanceId);
    await refreshConfig();
    renderPage('instances');
  };
}

/* ========== 主页 ========== */

function renderHome(page) {
  const cfg = state.config;
  const instances = cfg.instances || {};
  const mode = cfg.homeMode || 'widget';
  const greeting = getGreeting();
  const accName = state.account ? state.account.username : '未登录';
  const accType = state.account
    ? (state.account.type === 'microsoft' ? '微软账号' : state.account.type === 'yggdrasil' ? '外置登录' : '离线账号')
    : '点击登录';

  page.innerHTML = `
    <div class="home-head">
      <div class="seg-group">
        <button class="seg ${mode === 'widget' ? 'active' : ''}" data-home-mode="widget">🧩 小组件桌面</button>
        <button class="seg ${mode === 'simple' ? 'active' : ''}" data-home-mode="simple">☰ 简洁列表</button>
      </div>
      <div class="home-head-right">
        ${mode === 'widget' ? `<button class="btn sm" id="home-edit">${homeEdit ? '✓ 完成编辑' : '✏ 编辑小组件'}</button>` : '<span class="hint-text">PCL / HMCL 风格实例列表</span>'}
      </div>
    </div>

    <div class="hero">
      <div class="hero-inner">
        <div class="hero-welcome">✨ ${greeting}，欢迎回来</div>
        <div class="hero-title">准备进入方块世界</div>
        <div class="hero-desc">汇聚国内外启动器优点 · 多账号 · 全离线模式 · 极致兼容</div>
        <div class="hero-badges">
          <button class="hero-badge accent" id="hero-badge-new">＋ 安装新版本</button>
          <button class="hero-badge" id="hero-badge-acc">👤 ${accName}</button>
          <button class="hero-badge accent" id="hero-badge-update" hidden>⬆ 发现新版本</button>
        </div>
        <div class="hero-server-row">
          <input class="hero-server-input" id="hero-server" placeholder="可选：填写服务器 IP 直接进入（暂存，启动后生效）">
        </div>
        <div class="hero-actions">
          <!-- 首页只保留一个下拉：选版本。实例切换交给侧边栏「实例管理」——
               以前这里并排摆着「实例」「版本」两个下拉，看着像两个都在选版本。 -->
          <label class="sel-field">
            <span class="sel-tag">版本</span>
            <select class="instance-select" id="home-version"></select>
          </label>
          <button class="play-btn" id="home-play"><span class="play-ico"></span>立即启动</button>
          <button class="btn-ghost-hero" id="hero-options">🔧 启动选项</button>
        </div>
      </div>
      <div class="hero-statusbar">系统状态<b>一切正常</b></div>
    </div>

    <div class="panel" id="home-progress" style="margin-bottom:18px;padding:18px;display:none">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px">
        <span id="home-progress-label" style="font-size:13px;color:var(--text-dim)"></span>
        <span id="home-progress-percent" style="font-size:13px;font-weight:700;color:var(--accent)"></span>
      </div>
      <div class="progress-track"><div class="progress-fill" id="home-progress-fill"></div></div>
      <button class="btn ghost" id="home-cancel" style="margin-top:12px;float:right">取消</button>
    </div>

    <div id="home-body"></div>

    <div class="section-title">快捷操作</div>
    <div class="quick-actions">
      <div class="quick-action" id="qa-ver"><div class="qa-icon">▦</div><div class="qa-label">版本管理</div></div>
      <div class="quick-action" id="qa-res"><div class="qa-icon">✿</div><div class="qa-label">资源中心</div></div>
      <div class="quick-action" id="qa-srv"><div class="qa-icon">☷</div><div class="qa-label">联机大厅</div></div>
      <div class="quick-action" id="qa-set"><div class="qa-icon">⚙</div><div class="qa-label">设置</div></div>
    </div>
  `;

  // 首页只留这一个下拉：选版本。实例不在这里选了 —— 换实例走侧边栏「实例管理」，
  // 首页只盯「用哪个版本启动」这一件事，就不会再有两个下拉并排、看着像重复的问题。

  // 首页直接换版本：版本是记在实例上的（启动只看 versionId），
  // 以前必须进「版本管理」才能换，首页只看得到一个数字。这里补一个下拉。
  //
  // 选项必须按【当前实例自己的游戏目录】来列：实例可以自带 gameDir（启动时用的就是实例那份），
  // 直接拿启动时那份全局已装列表会出现「列了别的游戏目录里的版本」，选中它启动必然找不到 jar。
  const vsel = $('home-version');
  const curInst = instances[state.selectedInstance] || {};
  const instDir = curInst.gameDir || state.config.gameDir || '';
  const wantInst = state.selectedInstance;
  const fillVersion = (list) => {
    vsel.innerHTML = '';
    const ids = (list || []).slice();
    // 实例当前用的版本不一定在「已安装」里（比如手搓的目录），也得能显示出来
    if (curInst.versionId && !ids.includes(curInst.versionId)) ids.unshift(curInst.versionId);
    if (ids.length === 0) {
      vsel.innerHTML = '<option value="">无已装版本</option>';
      vsel.disabled = true;
      return;
    }
    vsel.disabled = false;
    if (!curInst.versionId) {
      const o = ce('option');
      o.value = '';
      o.textContent = '未选版本';
      vsel.appendChild(o);
    }
    ids.forEach((id) => {
      const o = ce('option');
      o.value = id;
      o.textContent = id;
      vsel.appendChild(o);
    });
    vsel.value = curInst.versionId || '';
  };
  fillVersion(state.installed);      // 先用启动时那份垫一下，首屏秒出
  api.versionsInstalled(instDir).then((list) => {
    if (state.selectedInstance !== wantInst) return;   // 期间用户切了实例就别回填了
    fillVersion(list);
  }).catch(() => {});
  vsel.onchange = async () => {
    if (!vsel.value) return;
    await api.instancesSave(state.selectedInstance, { versionId: vsel.value });
    await refreshConfig();
    renderPage('home');
  };

  $('home-play').onclick = () => {
    // 所有实例都被删光时：不发空启动，引导安装（顶部「＋ 安装新版本」也能点）
    if (!Object.keys(instances).length) {
      toast('还没有实例，点「＋ 安装新版本」下载一个吧', true);
      return;
    }
    onPlay();
  };
  $('home-cancel').onclick = () => {
    api.cancel();
    hideHomeProgress();
  };
  $('hero-badge-new').onclick = () => openVersionInstaller();
  $('hero-badge-acc').onclick = () => renderPage('account');
  $('hero-badge-update').onclick = openUpdateSettings;
  // 模板重建后徽章的 hidden 是初始值，得按当前是否查到新版再摆一次
  paintUpdateDot();
  $('hero-options').onclick = () => renderPage('settings');
  $('qa-ver').onclick = () => renderPage('versions');
  $('qa-res').onclick = () => renderPage('center');
  $('qa-srv').onclick = () => renderPage('servers');
  $('qa-set').onclick = () => renderPage('settings');

  // 模式切换
  document.querySelectorAll('[data-home-mode]').forEach((b) => {
    b.onclick = () => {
      state.config.homeMode = b.dataset.homeMode;
      api.configSet('homeMode', b.dataset.homeMode);
      renderPage('home');
    };
  });
  const editBtn = $('home-edit');
  if (editBtn) {
    editBtn.onclick = () => { homeEdit = !homeEdit; renderPage('home'); };
  }
  renderHomeBody();
}

/* ---------- 首页：两种模式 ---------- */

const HOME_WIDGETS = [
  { id: 'greeting', name: '问候语', ico: '👋' },
  { id: 'pinnedInstances', name: '固定实例', ico: '📌' },
  { id: 'pinnedWorlds', name: '固定世界', ico: '🌍' },
  { id: 'pinnedServers', name: '固定服务器', ico: '🌐' },
  { id: 'recentWorlds', name: '最近世界', ico: '🕘' },
  { id: 'calendar', name: '游玩日历', ico: '📅' },
  { id: 'news', name: 'MC 新闻', ico: '📰' },
  { id: 'stats', name: '统计概览', ico: '📊' },
];

const HOME_QUOTES = [
  '今天也要挖到钻石哦',
  '苦力怕已经被你甩在身后了',
  '先撸一棵树，梦想从方块开始',
  '红石工程师的一天开始了',
  '别忘了给村民留个门',
  '下界合金，永不掉耐久',
  '带上床，别在末地过夜',
];

let homeEdit = false;
let homeRecentSaves = null;   // 缓存当前实例的存档列表

function homeWidgets() {
  const w = state.config.homeWidgets;
  const base = Array.isArray(w) && w.length
    ? w.slice()
    : HOME_WIDGETS.map((d) => ({ id: d.id, visible: true, span: (d.id === 'greeting' || d.id === 'stats') ? 2 : 1 }));
  const ids = base.map((x) => x.id);
  for (const d of HOME_WIDGETS) if (!ids.includes(d.id)) base.push({ id: d.id, visible: true, span: 1 });
  return base;
}

function saveHomeWidgets(list) {
  state.config.homeWidgets = list;
  api.configSet('homeWidgets', list);
}

function pinnedCfg() {
  const p = state.config.pinned || {};
  return { instances: p.instances || [], servers: p.servers || [], worlds: p.worlds || [] };
}

function savePinnedCfg(p) {
  state.config.pinned = p;
  api.configSet('pinned', p);
}

/** 汇总每个实例的累计启动次数与最近启动日期 */
function playStats() {
  const log = state.config.playLog || {};
  const stat = {};
  for (const [date, e] of Object.entries(log)) {
    for (const [id, v] of Object.entries((e && e.instances) || {})) {
      if (!stat[id]) stat[id] = { count: 0, last: '' };
      stat[id].count += v.count || 0;
      if (date > stat[id].last) stat[id].last = date;
    }
  }
  return stat;
}

function instanceDesc(v) {
  const ver = v.versionId || '未选版本';
  const ld = v.modLoader && v.modLoader !== 'vanilla' ? ` · ${v.modLoader}` : '';
  return `${ver}${ld}`;
}

function renderHomeBody() {
  const host = $('home-body');
  if (!host) return;
  host.innerHTML = '';
  if ((state.config.homeMode || 'widget') === 'simple') renderSimpleBody(host);
  else renderWidgetBody(host);
}

/* ---- 简洁模式：PCL / HMCL 风格实例列表 ---- */
function renderSimpleBody(host) {
  const instances = state.config.instances || {};
  const stat = playStats();
  const pin = pinnedCfg();

  const list = Object.entries(instances).map(([id, v]) => ({ id, ...v }));
  list.sort((a, b) => {
    const pa = pin.instances.includes(a.id) ? 1 : 0;
    const pb = pin.instances.includes(b.id) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const la = (stat[a.id] && stat[a.id].last) || '';
    const lb = (stat[b.id] && stat[b.id].last) || '';
    if (la !== lb) return lb.localeCompare(la);
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const wrap = ce('div', 'simple-home');
  const head = ce('div', 'simple-head');
  head.innerHTML = `<span>共 ${list.length} 个实例</span>`;
  const news = ce('div', 'simple-head-news');
  news.innerHTML = `<span class="link" id="simple-news-open">📰 看看 MC 新闻</span>`;
  head.appendChild(news);
  wrap.appendChild(head);

  list.forEach((it) => {
    const s = stat[it.id] || { count: 0, last: '' };
    const isPin = pin.instances.includes(it.id);
    const row = ce('div', 'simple-row');
    row.innerHTML = `
      <div class="simple-ico">${it.icon || '⛏'}</div>
      <div class="simple-info">
        <div class="simple-name">${escapeHtml(it.name || it.id)}${isPin ? ' <span class="pin-mark">📌</span>' : ''}</div>
        <div class="simple-meta">${escapeHtml(instanceDesc(it))} · 启动 ${s.count} 次${s.last ? ` · 最近 ${s.last}` : ''}</div>
      </div>
      <button class="simple-pin ${isPin ? 'on' : ''}" title="固定到桌面">📌</button>
      <button class="btn sm simple-run">▶ 启动</button>
    `;
    const runThis = () => {
      state.selectedInstance = it.id;
      api.configSet('selectedInstance', it.id);
      onPlay();
    };
    // 整行可点即启动：以前只有右侧「▶ 启动」按钮有反应，点行本身没动静
    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      runThis();
    };
    row.querySelector('.simple-run').onclick = (e) => {
      e.stopPropagation();
      runThis();
    };
    row.querySelector('.simple-pin').onclick = () => {
      const p = pinnedCfg();
      p.instances = isPin ? p.instances.filter((x) => x !== it.id) : [...p.instances, it.id];
      savePinnedCfg(p);
      renderHomeBody();
    };
    wrap.appendChild(row);
  });

  host.appendChild(wrap);

  const tip = ce('div', 'daily-tip');
  tip.innerHTML = '<span class="tip-ico">💡</span><span>每日一贴：每次大版本更新后，等待 1-2 周再安装通常能避开初始 Bug。</span>';
  host.appendChild(tip);

  news.querySelector('#simple-news-open').onclick = () => {
    state.config.homeMode = 'widget';
    api.configSet('homeMode', 'widget');
    homeEdit = false;
    renderPage('home');
  };
}

/* ---- 小组件模式 ---- */
function renderWidgetBody(host) {
  const list = homeWidgets();
  const grid = ce('div', 'widget-grid');
  if (homeEdit) grid.classList.add('editing');
  if (homeEdit) {
    const bar = ce('div', 'widget-edit-bar');
    bar.innerHTML = `<span>拖动卡片调整顺序 · ↔ 切换宽度 · 👁 显示/隐藏</span>
      <button class="btn sm ghost" id="widget-reset">恢复默认布局</button>`;
    host.appendChild(bar);
    bar.querySelector('#widget-reset').onclick = () => {
      const def = HOME_WIDGETS.map((d) => ({ id: d.id, visible: true, span: (d.id === 'greeting' || d.id === 'stats') ? 2 : 1 }));
      saveHomeWidgets(def);
      renderHomeBody();
    };
  }

  if (!homeEdit && !list.some((w) => w.visible)) {
    const empty = ce('div', 'glass widget-all-hidden');
    empty.textContent = '所有小组件都被隐藏了，点上方「编辑小组件」恢复显示。';
    host.appendChild(empty);
    return;
  }

  host.appendChild(grid);
  list.forEach((w) => {
    if (!w.visible && !homeEdit) return;
    const def = HOME_WIDGETS.find((d) => d.id === w.id) || { name: w.id, ico: '▦' };
    const card = ce('div', 'widget');
    card.dataset.wid = w.id;
    card.style.gridColumn = `span ${w.span === 2 ? 2 : 1}`;
    if (!w.visible) card.classList.add('hidden-widget');

    const head = ce('div', 'widget-head');
    head.innerHTML = `${homeEdit ? '<span class="widget-grip">⠿</span>' : `<span class="widget-ico">${def.ico}</span>`}
      <span class="widget-name">${def.name}</span>`;
    if (homeEdit) {
      const tools = ce('div', 'widget-tools');
      const spanBtn = ce('button', 'wbtn');
      spanBtn.textContent = w.span === 2 ? '↔ 半宽' : '↔ 全宽';
      spanBtn.onclick = (ev) => { ev.stopPropagation(); w.span = w.span === 2 ? 1 : 2; saveHomeWidgets(list); renderHomeBody(); };
      const visBtn = ce('button', 'wbtn');
      visBtn.textContent = w.visible ? '👁 隐藏' : '🚫 已隐藏';
      visBtn.onclick = (ev) => { ev.stopPropagation(); w.visible = !w.visible; saveHomeWidgets(list); renderHomeBody(); };
      tools.append(spanBtn, visBtn);
      head.appendChild(tools);
    }
    card.appendChild(head);

    const body = ce('div', 'widget-body');
    body.innerHTML = '<div class="widget-empty">…</div>';
    card.appendChild(body);
    grid.appendChild(card);
    renderHomeWidget(w.id, body, list, head);

    if (homeEdit) {
      card.draggable = true;
      bindWidgetDrag(card, list);
    }
  });
}

let dragWid = null;
function bindWidgetDrag(card, list) {
  card.ondragstart = (e) => {
    dragWid = card.dataset.wid;
    card.classList.add('dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  };
  card.ondragend = () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.widget').forEach((c) => c.classList.remove('over'));
  };
  card.ondragover = (e) => { e.preventDefault(); card.classList.add('over'); };
  card.ondragleave = () => card.classList.remove('over');
  card.ondrop = (e) => {
    e.preventDefault();
    card.classList.remove('over');
    const target = card.dataset.wid;
    if (!dragWid || dragWid === target) return;
    const from = list.findIndex((x) => x.id === dragWid);
    const to = list.findIndex((x) => x.id === target);
    if (from < 0 || to < 0) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    dragWid = null;
    saveHomeWidgets(list);
    renderHomeBody();
  };
}

function widgetManageBtn(head, label, onClick) {
  const b = ce('button', 'wbtn');
  b.textContent = label;
  b.onclick = (ev) => { ev.stopPropagation(); onClick(); };
  head.appendChild(b);
}

function renderHomeWidget(id, host, list, head) {
  if (id === 'greeting') return widgetGreeting(host, list);
  if (id === 'pinnedInstances') return widgetPinnedInstances(host, list, head);
  if (id === 'pinnedWorlds') return widgetPinnedWorlds(host, list, head);
  if (id === 'pinnedServers') return widgetPinnedServers(host, list, head);
  if (id === 'recentWorlds') return widgetRecentWorlds(host);
  if (id === 'calendar') return widgetCalendar(host);
  if (id === 'news') return widgetNews(host);
  if (id === 'stats') return widgetStats(host);
  host.innerHTML = '<div class="widget-empty">未知组件</div>';
}

function widgetGreeting(host, list) {
  const q = HOME_QUOTES[new Date().getDate() % HOME_QUOTES.length];
  const acc = state.account;
  const days = Object.keys(state.config.playLog || {}).length;
  host.innerHTML = `
    <div class="wg-greet">
      <div class="wg-greet-hi">${getGreeting()}，${acc ? escapeHtml(acc.username) : '冒险者'} 👋</div>
      <div class="wg-greet-quote">「${q}」</div>
      <div class="wg-greet-meta">${days ? `你已经陪伴方块世界 ${days} 天` : '今天开始记录你的方块时光吧'}</div>
    </div>
  `;
}

function widgetPinnedInstances(host, list, head) {
  const instances = state.config.instances || {};
  const p = pinnedCfg();
  const stat = playStats();
  host.innerHTML = '';
  if (head && !homeEdit) {
    head.innerHTML = '<span class="widget-ico">📌</span><span class="widget-name">固定实例</span>';
    widgetManageBtn(head, '＋ 管理', () => openPinManager('instances'));
  }

  if (!p.instances.length) {
    host.innerHTML = '<div class="widget-empty">还没有固定实例，点右上「管理」把常玩的整合包钉在这里。</div>';
    return;
  }
  const wrap = ce('div', 'wg-list');
  p.instances.forEach((id) => {
    const v = instances[id];
    if (!v) return;
    const s = stat[id] || { count: 0 };
    const row = ce('div', 'wg-item');
    row.innerHTML = `
      <div class="wg-item-ico">${v.icon || '⛏'}</div>
      <div class="wg-item-info">
        <div class="wg-item-name">${escapeHtml(v.name || id)}</div>
        <div class="wg-item-meta">${escapeHtml(instanceDesc(v))} · ${s.count} 次</div>
      </div>
      <button class="btn sm primary">▶</button>
    `;
    row.querySelector('button').onclick = () => {
      state.selectedInstance = id;
      api.configSet('selectedInstance', id);
      onPlay();
    };
    wrap.appendChild(row);
  });
  host.appendChild(wrap);
}

function widgetPinnedWorlds(host, list, head) {
  const p = pinnedCfg();
  if (head && !homeEdit) {
    head.innerHTML = '<span class="widget-ico">🌍</span><span class="widget-name">固定世界</span>';
    widgetManageBtn(head, '＋ 管理', () => openPinManager('worlds'));
  }

  if (!p.worlds.length) {
    host.innerHTML = '<div class="widget-empty">把常玩的存档钉在这里，点一下直接进那个世界（需 1.20+）。</div>';
    return;
  }
  const wrap = ce('div', 'wg-list');
  p.worlds.forEach((w) => {
    const row = ce('div', 'wg-item');
    row.innerHTML = `
      <div class="wg-item-ico">🌍</div>
      <div class="wg-item-info">
        <div class="wg-item-name">${escapeHtml(w.name || '未命名存档')}</div>
        <div class="wg-item-meta">${escapeHtml(w.instName || '')}</div>
      </div>
      <button class="btn sm primary">▶</button>
    `;
    row.querySelector('button').onclick = () => quickLaunchWorld(w);
    wrap.appendChild(row);
  });
  host.appendChild(wrap);
}

function widgetPinnedServers(host, list, head) {
  const p = pinnedCfg();
  const servers = state.config.servers || [];
  if (head && !homeEdit) {
    head.innerHTML = '<span class="widget-ico">🌐</span><span class="widget-name">固定服务器</span>';
    widgetManageBtn(head, '＋ 管理', () => openPinManager('servers'));
  }

  if (!p.servers.length) {
    host.innerHTML = '<div class="widget-empty">把常玩的服务器钉在这里，一键直连。</div>';
    return;
  }
  const wrap = ce('div', 'wg-list');
  p.servers.forEach((idx) => {
    const s = servers[idx];
    if (!s) return;
    const row = ce('div', 'wg-item');
    row.innerHTML = `
      <div class="wg-item-ico">🌐</div>
      <div class="wg-item-info">
        <div class="wg-item-name">${escapeHtml(s.name)}</div>
        <div class="wg-item-meta">${escapeHtml(s.address)}</div>
      </div>
      <button class="btn sm primary">▶</button>
    `;
    row.querySelector('button').onclick = () => {
      if (!state.account) { toast('请先登录账号', true); renderPage('account'); return; }
      state.busy = false;
      showHomeProgress('正在连接服务器…', 0);
      onPlay({ quickPlayServer: s.address });
    };
    wrap.appendChild(row);
  });
  host.appendChild(wrap);
}

function widgetRecentWorlds(host) {
  host.innerHTML = '<div class="widget-empty">读取中…</div>';
  const instances = state.config.instances || {};
  const inst = currentInstanceOf(instances, state.selectedInstance);
  const gameDir = (inst && inst.gameDir) || state.config.gameDir;
  api.contentSaves(gameDir).then((saves) => {
    if (!host.isConnected) return;
    homeRecentSaves = saves || [];
    if (!saves || !saves.length) {
      host.innerHTML = '<div class="widget-empty">这个实例还没有存档。</div>';
      return;
    }
    const wrap = ce('div', 'wg-list');
    saves.slice(0, 5).forEach((s) => {
      const row = ce('div', 'wg-item');
      row.innerHTML = `
        <div class="wg-item-ico">🗺</div>
        <div class="wg-item-info">
          <div class="wg-item-name">${escapeHtml(s.name)}</div>
          <div class="wg-item-meta">${timeAgo(s.lastPlayed)}${s.hasLevel ? '' : ' · 缺少 level.dat'}</div>
        </div>
        <button class="btn sm primary">▶</button>
      `;
      row.querySelector('button').onclick = () => quickLaunchWorld({
        name: s.name, saveDir: s.path, instId: state.selectedInstance, instName: inst && inst.name,
      });
      wrap.appendChild(row);
    });
    host.innerHTML = '';
    host.appendChild(wrap);
  }).catch((e) => {
    if (!host.isConnected) return;
    host.innerHTML = `<div class="widget-empty">存档读取失败：${escapeHtml(e.message)}</div>`;
  });
}

function widgetCalendar(host) {
  const log = state.config.playLog || {};
  if (state.calMonth == null) state.calMonth = new Date().getMonth();
  if (state.calYear == null) state.calYear = new Date().getFullYear();
  const year = state.calYear;
  const month = state.calMonth;

  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dateKey(new Date());

  let cells = '';
  for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const e = log[key];
    const cls = ['cal-cell'];
    if (e) cls.push('played');
    if (key === todayKey) cls.push('today');
    cells += `<div class="${cls.join(' ')}" data-day="${key}" title="${e ? `启动 ${e.total} 次` : ''}">
      <span class="cal-num">${d}</span>${e ? `<span class="cal-dot">${e.total}</span>` : ''}</div>`;
  }

  host.innerHTML = `
    <div class="cal-head">
      <button class="wbtn" id="cal-prev">‹</button>
      <span class="cal-title">${year} 年 ${month + 1} 月</span>
      <button class="wbtn" id="cal-next">›</button>
    </div>
    <div class="cal-grid cal-dow">
      <div>日</div><div>一</div><div>二</div><div>三</div><div>四</div><div>五</div><div>六</div>
    </div>
    <div class="cal-grid" id="cal-days">${cells}</div>
    <div class="cal-detail" id="cal-detail">点日期查看那天玩了什么</div>
  `;
  host.querySelector('#cal-prev').onclick = () => {
    state.calMonth -= 1;
    if (state.calMonth < 0) { state.calMonth = 11; state.calYear -= 1; }
    widgetCalendar(host);
  };
  host.querySelector('#cal-next').onclick = () => {
    state.calMonth += 1;
    if (state.calMonth > 11) { state.calMonth = 0; state.calYear += 1; }
    widgetCalendar(host);
  };
  host.querySelectorAll('.cal-cell[data-day]').forEach((c) => {
    c.onclick = () => {
      const key = c.dataset.day;
      const e = log[key];
      const detail = host.querySelector('#cal-detail');
      if (!e) { detail.textContent = `${key}：没有游玩记录`; return; }
      const parts = Object.values(e.instances || {}).map((v) => `${v.name} ×${v.count}`);
      detail.textContent = `${key}：启动 ${e.total} 次 · ${parts.join('、')}`;
    };
  });
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function widgetNews(host) {
  host.innerHTML = '<div class="widget-empty">新闻加载中…</div>';
  const render = (data) => {
    if (!host.isConnected) return;
    const items = (data && data.items) || [];
    if (!items.length) { host.innerHTML = '<div class="widget-empty">暂无新闻</div>'; return; }
    host.innerHTML = '';
    const wrap = ce('div', 'news-list');
    const draw = (limit) => {
      wrap.innerHTML = '';
      items.slice(0, limit).forEach((n) => {
        const card = ce('div', 'news-card');
        card.innerHTML = `
          ${n.image ? `<img class="news-img" src="${n.image}" loading="lazy" onerror="this.style.display='none'">` : ''}
          <div class="news-info">
            <div class="news-title">${escapeHtml(n.title)}</div>
            <div class="news-meta">${escapeHtml(n.date || '')}${n.tag ? ' · ' + escapeHtml(n.tag) : ''}</div>
            <div class="news-text">${escapeHtml(n.text)}</div>
          </div>
        `;
        card.onclick = () => api.openUrl(n.url);
        wrap.appendChild(card);
      });
      const toggle = ce('div', 'news-toggle');
      if (limit < items.length) {
        toggle.innerHTML = `<span class="link">展开更多（还有 ${items.length - limit} 条）▾</span>`;
        toggle.querySelector('.link').onclick = () => draw(items.length);
      } else if (items.length > 3) {
        toggle.innerHTML = '<span class="link">收起 ▴</span>';
        toggle.querySelector('.link').onclick = () => draw(3);
      }
      wrap.appendChild(toggle);
    };
    draw(3);
    host.appendChild(wrap);
    if (data.errors && data.errors.length) {
      const warn = ce('div', 'hint-text');
      warn.textContent = '部分来源加载失败：' + data.errors.join('；');
      host.appendChild(warn);
    }
  };

  api.homeNews().then(render).catch((e) => {
    if (!host.isConnected) return;
    host.innerHTML = `<div class="widget-empty">新闻加载失败：${escapeHtml(e.message)}
      <button class="btn sm" id="news-retry" style="margin-left:8px">重试</button></div>`;
    const b = host.querySelector('#news-retry');
    if (b) b.onclick = () => {
      host.innerHTML = '<div class="widget-empty">重新加载中…</div>';
      api.homeNews(true).then(render).catch((e2) => {
        if (!host.isConnected) return;
        host.innerHTML = `<div class="widget-empty">仍然失败：${escapeHtml(e2.message)}</div>`;
      });
    };
  });
}

function widgetStats(host) {
  const instances = state.config.instances || {};
  const accName = state.account ? state.account.username : '未登录';
  const accType = state.account
    ? (state.account.type === 'microsoft' ? '微软账号' : state.account.type === 'yggdrasil' ? '外置登录' : '离线账号')
    : '点击登录';
  const totalPlays = Object.values(state.config.playLog || {}).reduce((n, e) => n + (e.total || 0), 0);
  host.innerHTML = `
    <div class="stat-row">
      <div class="stat-card"><div class="stat-icon">🗂</div><div class="stat-body">
        <div class="stat-label">游戏实例</div><div class="stat-value">${Object.keys(instances).length}</div><div class="stat-sub">个实例</div></div></div>
      <div class="stat-card"><div class="stat-icon blue">▦</div><div class="stat-body">
        <div class="stat-label">已装版本</div><div class="stat-value">${state.installed.length}</div><div class="stat-sub">已安装</div></div></div>
      <div class="stat-card"><div class="stat-icon amber">▶</div><div class="stat-body">
        <div class="stat-label">累计启动</div><div class="stat-value">${totalPlays}</div><div class="stat-sub">次</div></div></div>
      <div class="stat-card"><div class="stat-icon violet">👤</div><div class="stat-body">
        <div class="stat-label">当前账号</div><div class="stat-value" style="font-size:15px">${escapeHtml(accName)}</div><div class="stat-sub">${accType}</div></div></div>
    </div>
  `;
}

/* ---- 固定项管理弹窗 ---- */
async function openPinManager(kind) {
  const p = pinnedCfg();
  let items = [];
  if (kind === 'instances') {
    items = Object.entries(state.config.instances || {}).map(([id, v]) => ({ key: id, title: `${v.icon || '⛏'} ${v.name}`, sub: instanceDesc(v) }));
  } else if (kind === 'servers') {
    items = (state.config.servers || []).map((s, i) => ({ key: String(i), title: s.name, sub: s.address }));
  } else {
    // 世界：需要读当前实例的存档
    const instances = state.config.instances || {};
    const inst = currentInstanceOf(instances, state.selectedInstance);
    const gameDir = (inst && inst.gameDir) || state.config.gameDir;
    let saves = homeRecentSaves;
    if (!saves) {
      try { saves = await api.contentSaves(gameDir); homeRecentSaves = saves; } catch { saves = []; }
    }
    items = (saves || []).map((s) => ({
      key: s.path,
      title: s.name,
      sub: s.path,
      instId: state.selectedInstance,
      instName: inst && inst.name,
    }));
  }
  if (!items.length) {
    toast(kind === 'servers' ? '还没有收藏的服务器，请先去「联机大厅」添加' : '暂无可选项', true);
    return;
  }
  const selected = new Set(p[kind]);

  const mask = ce('div', 'modal-mask');
  mask.innerHTML = `
    <div class="modal wide">
      <div class="modal-title">管理${kind === 'instances' ? '固定实例' : kind === 'servers' ? '固定服务器' : '固定世界'}</div>
      <div class="pin-list" id="pin-list"></div>
      <div class="modal-actions">
        <button class="btn ghost" id="pin-cancel">取消</button>
        <button class="btn primary" id="pin-ok">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  const listEl = mask.querySelector('#pin-list');
  items.forEach((it) => {
    const row = ce('div', 'pin-row');
    const on = selected.has(it.key);
    row.innerHTML = `
      <span class="pin-check ${on ? 'on' : ''}">${on ? '✓' : ''}</span>
      <div class="pin-info"><div class="pin-title">${escapeHtml(it.title)}</div><div class="pin-sub">${escapeHtml(it.sub || '')}</div></div>
    `;
    it._instId = it.instId;
    it._instName = it.instName;
    row.onclick = () => {
      if (selected.has(it.key)) selected.delete(it.key);
      else selected.add(it.key);
      const c = row.querySelector('.pin-check');
      c.classList.toggle('on', selected.has(it.key));
      c.textContent = selected.has(it.key) ? '✓' : '';
    };
    listEl.appendChild(row);
  });

  const close = () => mask.remove();
  mask.querySelector('#pin-cancel').onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };
  mask.querySelector('#pin-ok').onclick = () => {
    const np = pinnedCfg();
    if (kind === 'worlds') {
      np.worlds = items.filter((it) => selected.has(it.key)).map((it) => ({
        name: it.title, saveDir: it.key, instId: it._instId, instName: it._instName,
      }));
    } else {
      np[kind] = items.filter((it) => selected.has(it.key)).map((it) => it.key);
    }
    savePinnedCfg(np);
    close();
    renderHomeBody();
  };
}

/* ---- 快速进入某个世界 ---- */
function quickLaunchWorld(w) {
  if (!state.account) { toast('请先登录账号', true); renderPage('account'); return; }
  const instId = w.instId || state.selectedInstance;
  const instances = state.config.instances || {};
  const inst = instances[instId];
  if (!inst || !inst.versionId) { toast('该实例还没有选择游戏版本', true); renderPage('versions'); return; }
  state.selectedInstance = instId;
  api.configSet('selectedInstance', instId);
  onPlay({ quickPlayWorld: w.name });
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function onPlay(extra) {
  if (state.busy) return;
  if (!state.account) {
    toast('请先登录账号', true);
    renderPage('account');
    return;
  }
  const instance = state.config.instances[state.selectedInstance];
  if (!instance || !instance.versionId) {
    toast('请先在「版本管理」中为该实例选择版本', true);
    renderPage('versions');
    return;
  }
  showHomeProgress('准备中…', 0);
  state.busy = true;
  $('home-play').disabled = true;
  $('home-play').textContent = '准备中…';

  const launchOpts = { ...(extra || {}) };
  const serverInput = $('hero-server');
  const serverAddr = serverInput ? serverInput.value.trim() : '';
  if (!launchOpts.quickPlayServer && !launchOpts.quickPlayWorld && serverAddr) {
    launchOpts.quickPlayServer = serverAddr;
  }

  api.launch(state.selectedInstance, Object.keys(launchOpts).length ? launchOpts : null).then(() => {
    // 已启动
  }).catch((e) => {
    hideHomeProgress();
    state.busy = false;
    $('home-play').disabled = false;
    $('home-play').innerHTML = '<span class="play-ico"></span>立即启动';
    if (!/已取消/.test(e.message)) toast(e.message, true);
  });
}

function showHomeProgress(label, pct) {
  const panel = $('home-progress');
  if (!panel) return;
  panel.style.display = 'block';
  $('home-progress-label').textContent = label;
  $('home-progress-percent').textContent = pct + '%';
  $('home-progress-fill').style.width = pct + '%';
}

function hideHomeProgress() {
  const panel = $('home-progress');
  if (panel) panel.style.display = 'none';
}

/* ========== 下载版本（二级菜单：加载器前置 → 版本 → 一起下载） ========== */

const RANDOM_INST_WORDS = ['方块世界', '橡木小屋', '下界探险', '红石工坊', '钻石矿洞', '末地远征', '蘑菇岛', '雪原营地', '深海神殿', '丛林秘境'];

function randomInstanceName() {
  const w = RANDOM_INST_WORDS[Math.floor(Math.random() * RANDOM_INST_WORDS.length)];
  return `${w}-${Math.floor(1000 + Math.random() * 9000)}`;
}

/**
 * 下载一个游戏版本，必要时把 Mod 加载器也装好。
 * 返回可直接写进实例的版本号（原版就是 MC 版本号，带加载器就是加载器自己的版本号）。
 */
async function downloadVersionWithLoader(sel, gameDir, onStep) {
  islandNotify({
    ico: '⬇️',
    title: `开始下载 ${sel.mcVersion}`,
    desc: sel.loader === 'vanilla'
      ? '原版游戏文件'
      : `游戏文件 + ${loaderName(sel.loader)} 加载器`,
  });
  onStep(`下载 ${sel.mcVersion} 游戏文件…`);
  await api.versionsDownload(sel.mcVersion, gameDir);

  if (sel.loader === 'vanilla' || !sel.loaderVersion) return sel.mcVersion;

  onStep(`安装 ${loaderName(sel.loader)} ${sel.loaderVersion}…`);
  let versionId = '';
  if (sel.loader === 'forge') {
    let javaPath = state.config.javaPath;
    if (!javaPath) {
      const m = await api.javaMatch(sel.mcVersion).catch(() => null);
      javaPath = m && m.picked && m.picked.path;
    }
    if (!javaPath) throw new Error('安装 Forge 需要 Java，请先在设置里下载或指定 Java');
    versionId = await api.forgeInstall(sel.mcVersion, sel.loaderVersion, gameDir, javaPath);
  } else if (sel.loader === 'fabric') {
    versionId = await api.fabricInstall(sel.mcVersion, sel.loaderVersion, gameDir);
  } else if (sel.loader === 'quilt') {
    versionId = await api.quiltInstall(sel.mcVersion, sel.loaderVersion, gameDir);
  } else {
    throw new Error(`${loaderName(sel.loader)} 暂不支持自动安装`);
  }

  // 加载器自己的库也一起下好，否则第一次启动还得现场下载几分钟
  if (versionId) {
    onStep('下载加载器依赖…');
    await api.versionsDownload(versionId, gameDir);
  }
  return versionId || sel.mcVersion;
}

/**
 * 版本下载成功后的统一收尾：新建一个随机名实例并选中，弹窗允许改名，然后跳到实例管理。
 * 下载失败时不要调用，保证不留残实例。
 * @returns {Promise<string>} 新实例 id
 */
async function finalizeNewInstance(versionId, loader, loaderVersion, gameDir) {
  // 下载成功才建实例：失败不留残实例
  const id = `inst_${Date.now().toString(36)}`;
  const autoName = randomInstanceName();
  await api.instancesSave(id, {
    name: autoName,
    versionId,
    gameDir,
    modLoader: loader,
    loaderVersion: loaderVersion || '',
    javaPath: '',
    memory: null,
    jvmArgs: '',
    icon: '⛏',
    group: '',
  });
  await api.configSet('selectedInstance', id);
  await refreshConfig();
  state.selectedInstance = id;

  const renamed = await askText('实例已创建，可以改个名字', autoName, '给这个实例起个名字');
  if (renamed && renamed !== autoName) {
    await api.instancesSave(id, { name: renamed });
    await refreshConfig();
  }
  toast(`已下载 ${versionId}，实例已建好`);
  renderPage('instances');
  return id;
}

/**
 * 模组下载二级菜单：列出该模组的所有版本（默认自动选中与当前实例匹配的
 * 最新一版），实时检测所选版本的前置模组（必装依赖），确认后连同前置
 * 一起下载到实例的 mods 目录。已在本地存在的前置文件会自动跳过。
 */
async function openModVersionPicker(m, inst) {
  const gv = mcVerOf(inst.versionId);
  const gl = inst.modLoader && inst.modLoader !== 'vanilla' ? inst.modLoader : 'fabric';
  const gdir = instGameDir(inst);

  const mask = ce('div', 'modal-mask');
  mask.innerHTML = `
    <div class="modal wide">
      <div class="modal-title">下载 ${escapeHtml(m.name)}</div>
      <div class="hint-text" id="mvp-hint">正在获取版本列表…</div>
      <div class="field">
        <label>选择版本</label>
        <div id="mvp-versions" style="max-height:260px;overflow:auto"></div>
      </div>
      <div class="field" id="mvp-deps-field" style="display:none">
        <label>前置模组检测</label>
        <div id="mvp-deps" style="font-size:13px"></div>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="mvp-cancel">取消</button>
        <button class="btn primary" id="mvp-ok" disabled>下载</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('#mvp-cancel').onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };

  const hintEl = mask.querySelector('#mvp-hint');
  const listEl = mask.querySelector('#mvp-versions');
  const depsField = mask.querySelector('#mvp-deps-field');
  const depsEl = mask.querySelector('#mvp-deps');
  const okBtn = mask.querySelector('#mvp-ok');

  // 版本列表：优先当前实例的 MC 版本+加载器，一条都没有时退到全部版本
  let vers = [];
  try {
    vers = await api.mrVersions(m.id, gv, gl);
    if (vers.length === 0) {
      vers = await api.mrVersions(m.id, '', '');
      hintEl.textContent = `该模组没有匹配 ${inst.versionId || '当前实例'} 的版本，以下显示全部版本（注意兼容性）。`;
    } else {
      hintEl.textContent = `已按当前实例（${inst.versionId} · ${loaderName(inst.modLoader)}）过滤，默认选中最新匹配版。`;
    }
  } catch (e) {
    hintEl.textContent = '获取版本列表失败：' + e.message;
    return;
  }
  if (vers.length === 0) { hintEl.textContent = '该模组还没有发布任何版本。'; return; }

  // 前置项目名缓存，避免同一弹窗里重复请求
  const projCache = new Map();
  const projectName = async (pid) => {
    if (!projCache.has(pid)) {
      projCache.set(pid, api.mrProject(pid).then((p) => p.title || pid).catch(() => pid));
    }
    return projCache.get(pid);
  };

  let picked = vers[0];
  const renderDeps = async (v) => {
    const required = (v.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id);
    const optional = (v.dependencies || []).filter((d) => d.dependency_type === 'optional' && d.project_id);
    if (required.length === 0 && optional.length === 0) {
      depsField.style.display = 'none';
      return;
    }
    depsField.style.display = '';
    depsEl.innerHTML = '<div style="color:var(--text-dim)">检测前置中…</div>';
    const rows = [];
    for (const d of required) rows.push(`<div>🧩 <b>${escapeHtml(await projectName(d.project_id))}</b> <span style="color:#fbbf24">必装 · 将一并下载</span></div>`);
    for (const d of optional) rows.push(`<div>🧩 ${escapeHtml(await projectName(d.project_id))} <span style="color:var(--text-dim)">可选 · 不下载</span></div>`);
    depsEl.innerHTML = rows.join('');
  };

  listEl.innerHTML = vers.map((v, i) => `
    <label class="glass" style="display:flex;align-items:center;gap:10px;padding:8px 12px;margin-bottom:6px;cursor:pointer">
      <input type="radio" name="mvp-v" value="${i}" ${i === 0 ? 'checked' : ''}>
      <span style="flex:1">
        <div>${escapeHtml(v.versionNumber)} <span style="color:var(--text-dim);font-size:12px">${escapeHtml(v.name || '')}</span></div>
        <div style="color:var(--text-dim);font-size:12px">${v.gameVersions.join(' / ')} · ${(v.loaders || []).map(loaderName).join(' / ')}</div>
      </span>
    </label>
  `).join('');
  listEl.querySelectorAll('input[name="mvp-v"]').forEach((r) => {
    r.onchange = () => { picked = vers[Number(r.value)]; renderDeps(picked); };
  });
  okBtn.disabled = false;
  renderDeps(picked);

  okBtn.onclick = async () => {
    const file = picked.files.find((f) => f.primary) || picked.files[0];
    if (!file) { toast('该版本没有可下载的文件', true); return; }
    okBtn.disabled = true;
    try {
      showLoading(`下载 ${m.name}…`);
      await api.mrDownload(file, gdir, 'mod');

      // 必装前置：解析到同 MC 版本+加载器的最新文件，mods 里已有同名文件就跳过
      const required = (picked.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id);
      const depNotes = [];
      if (required.length > 0) {
        const existing = new Set((await api.modsList(gdir).catch(() => [])).map((x) => x.name));
        for (const d of required) {
          const name = await projectName(d.project_id);
          try {
            const dvers = await api.mrVersions(d.project_id, gv, gl);
            const dv = dvers[0];
            const dfile = dv && (dv.files.find((f) => f.primary) || dv.files[0]);
            if (!dfile) { depNotes.push(`${name}（无匹配版本，需手动安装）`); continue; }
            if (existing.has(dfile.name)) { depNotes.push(`${name}（已存在，跳过）`); continue; }
            await api.mrDownload(dfile, gdir, 'mod');
            depNotes.push(`${name} ✓`);
          } catch {
            depNotes.push(`${name}（下载失败，需手动安装）`);
          }
        }
      }
      close();
      toast(depNotes.length > 0 ? `${m.name} 下载成功。前置：${depNotes.join('、')}` : `${m.name} 下载成功`);
    } catch (e) {
      toast(e.message, true);
      okBtn.disabled = false;
    } finally {
      hideLoading();
    }
  };
}

/**
 * 二级菜单：先选 Mod 加载器（前置），再选游戏版本与加载器版本，确认后一起下载。
 * 返回 { versionId, modLoader, loaderVersion }，取消或失败返回 null。
 */
async function openVersionInstaller(opts = {}) {
  const mode = opts.mode || 'new';
  const targetId = opts.instanceId || state.selectedInstance;
  const gameDir = opts.gameDir || state.config.gameDir || '';
  const title = opts.title || (mode === 'fill' ? '先补齐版本与加载器' : '下载游戏版本');

  if (!state.manifest) {
    try { state.manifest = await api.versionsManifest(false); }
    catch (e) { toast('版本清单还没加载好：' + e.message, true); return null; }
  }

  let vtype = 'release';
  let loader = opts.loader || 'vanilla';

  const mask = ce('div', 'modal-mask');
  mask.innerHTML = `
    <div class="modal wide">
      <div class="modal-title">${title}</div>
      <div class="field">
        <label>① Mod 加载器</label>
        <div class="tabs" id="vi-loaders">
          <button class="tab" data-loader="vanilla">原版</button>
          <button class="tab" data-loader="forge">Forge</button>
          <button class="tab" data-loader="neoforge">NeoForge</button>
          <button class="tab" data-loader="fabric">Fabric</button>
          <button class="tab" data-loader="quilt">Quilt</button>
        </div>
      </div>
      <div class="field">
        <label>② 游戏版本</label>
        <div class="tabs" id="vi-vtype">
          <button class="tab" data-vtype="release">正式版</button>
          <button class="tab" data-vtype="snapshot">快照版</button>
          <button class="tab" data-vtype="all">全部</button>
        </div>
        <select class="input" id="vi-version" style="margin-top:10px"></select>
      </div>
      <div class="field" id="vi-loaderbox"></div>
      <div class="hint-text" id="vi-hint" style="margin-bottom:6px">
        ${mode === 'fill'
          ? '补齐后会自动写进当前实例，然后继续下载。'
          : '下载完成后会自动在「实例管理」建一个随机名实例，名字随时可以改。'}
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="vi-cancel">取消</button>
        <button class="btn primary" id="vi-ok">开始下载</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);

  // 取消 / 确认都必须 resolve：以前取消只移除弹窗，Promise 一直挂着，
  // 调用方 await 永远不返回（资源中心下载会整个卡死）。
  let resolver = null;
  const resultP = new Promise((r) => { resolver = r; });

  const close = () => mask.remove();
  const cancelInstaller = () => { close(); if (resolver) resolver(null); };
  mask.querySelector('#vi-cancel').onclick = cancelInstaller;
  mask.onclick = (e) => { if (e.target === mask) cancelInstaller(); };
  const fail = (msg) => { toast(msg, true); resolver(null); };

  const pickTabs = (sel, attr, value) => {
    mask.querySelectorAll(`${sel} .tab`).forEach((x) => x.classList.toggle('active', x.dataset[attr] === value));
  };

  const fillVersions = () => {
    const sel = mask.querySelector('#vi-version');
    const prev = sel.value;
    let list = (state.manifest && state.manifest.versions) || [];
    if (vtype === 'release') list = list.filter((v) => v.type === 'release');
    else if (vtype === 'snapshot') list = list.filter((v) => v.type === 'snapshot');
    sel.innerHTML = '';
    list.forEach((v) => {
      const o = ce('option');
      o.value = v.id;
      o.textContent = v.id;
      sel.appendChild(o);
    });
    if (list.some((v) => v.id === prev)) sel.value = prev;
  };

  const renderLoaderBox = async () => {
    const box = mask.querySelector('#vi-loaderbox');
    if (loader === 'vanilla') {
      box.innerHTML = '<label>③ 加载器版本</label><div class="hint-text">原版不带 Mod 加载器，进游戏也装不了模组</div>';
      return;
    }
    box.innerHTML = '<label>③ 加载器版本</label><div class="hint-text">加载中…</div>';
    const mc = mask.querySelector('#vi-version').value;
    try {
      let list;
      if (loader === 'forge') {
        list = (await api.forgeVersions(mc)).map((v) => ({ v: v.version, tag: v.isRecommended ? '（推荐）' : v.isLatest ? '（最新）' : '' }));
      } else if (loader === 'neoforge') {
        list = (await api.neoForgeVersions(mc)).map((v) => ({ v: v.version, tag: '' }));
      } else if (loader === 'fabric') {
        list = (await api.fabricLoaders()).map((v) => ({ v: v.version, tag: v.stable ? '（稳定）' : '' }));
      } else {
        list = (await api.quiltLoaders()).map((v) => ({ v: v.version, tag: v.stable ? '（稳定）' : '' }));
      }
      if (!list.length) {
        box.innerHTML = `<label>③ 加载器版本</label><div class="hint-text">${mc} 没有可用的 ${loaderName(loader)} 版本，换个游戏版本或加载器试试</div>`;
        return;
      }
      box.innerHTML = '<label>③ 加载器版本</label><select class="input" id="vi-lv"></select>';
      const ls = box.querySelector('#vi-lv');
      list.forEach((x) => {
        const o = ce('option');
        o.value = x.v;
        o.textContent = x.v + x.tag;
        ls.appendChild(o);
      });
    } catch (e) {
      box.innerHTML = `<label>③ 加载器版本</label><div class="hint-text" style="color:#fca5a5">加载失败：${e.message}</div>`;
    }
  };

  mask.querySelectorAll('#vi-loaders .tab').forEach((t) => {
    t.onclick = () => { loader = t.dataset.loader; pickTabs('#vi-loaders', 'loader', loader); renderLoaderBox(); };
  });
  mask.querySelectorAll('#vi-vtype .tab').forEach((t) => {
    t.onclick = () => {
      vtype = t.dataset.vtype;
      pickTabs('#vi-vtype', 'vtype', vtype);
      fillVersions();
      renderLoaderBox();
    };
  });
  mask.querySelector('#vi-version').onchange = () => renderLoaderBox();

  pickTabs('#vi-loaders', 'loader', loader);
  pickTabs('#vi-vtype', 'vtype', vtype);
  fillVersions();
  renderLoaderBox();

  mask.querySelector('#vi-ok').onclick = async () => {
      const mcVersion = mask.querySelector('#vi-version').value;
      if (!mcVersion) return fail('先选一个游戏版本');
      let loaderVersion = '';
      if (loader !== 'vanilla') {
        const lv = mask.querySelector('#vi-lv');
        if (!lv) return fail(`${loaderName(loader)} 的版本还没准备好`);
        loaderVersion = lv.value;
      }
      const sel = { mcVersion, loader, loaderVersion };

      close();
      const onStep = (t) => {
        state.installStep = t;
        if (state.currentPage === 'home' && $('home-progress')) showHomeProgress(t, 0);
        else showLoading(t);
      };
      try {
        onStep('正在下载游戏文件…');
        const versionId = await downloadVersionWithLoader(sel, gameDir, onStep);
        hideLoading();
        hideHomeProgress();
        state.installStep = '';
        const result = { versionId, modLoader: sel.loader, loaderVersion: sel.loaderVersion };

        if (mode === 'fill') {
          await api.instancesSave(targetId, {
            versionId,
            modLoader: sel.loader,
            loaderVersion: sel.loaderVersion,
          });
          await refreshConfig();
          toast(`已为实例配好 ${versionId}`);
          resolver(result);
          return;
        }

        // 下载成功才建实例（统一收尾）：失败不留残实例
        await finalizeNewInstance(versionId, sel.loader, sel.loaderVersion, gameDir);
        resolver(result);
      } catch (e) {
        hideLoading();
        hideHomeProgress();
        state.installStep = '';
        resolver(null);
        toast('下载失败：' + e.message, true);
      }
    };

  return resultP;
}

/**
 * 资源中心下载前置：实例还没配好版本就先把二级菜单弹出来补齐。
 * 返回「补齐后」的实例对象；用户取消则返回 null（调用方应中止下载）。
 */
async function ensureRuntime(inst, loaderHint) {
  if (inst && inst.versionId) return inst;
  const id = state.selectedInstance;
  const loader = loaderHint
    || (inst && inst.modLoader !== 'vanilla' ? inst.modLoader : 'fabric');
  const r = await openVersionInstaller({
    mode: 'fill',
    instanceId: id,
    gameDir: instGameDir(inst),
    loader,
  });
  if (!r) return null;
  return state.config.instances[id] || inst;
}

/* ========== 版本管理 ========== */

function renderVersions(page) {
  const instances = state.config.instances || {};
  const inst = currentInstanceOf(instances, state.selectedInstance);

  // 一个实例都没有时（默认实例也被删了）：不硬套实例，直接给下载入口
  if (!inst) {
    page.innerHTML = `
      <div class="page-title">版本管理</div>
      <div class="glass" style="padding:36px;text-align:center">
        <div style="font-size:42px;margin-bottom:12px">📦</div>
        <div style="font-size:15px;margin-bottom:6px">还没有任何实例</div>
        <div class="hint-text" style="margin-bottom:20px">下载一个游戏版本，会自动为你建好实例</div>
        <button class="btn primary" id="ver-empty-download">下载游戏版本</button>
      </div>
    `;
    $('ver-empty-download').onclick = async () => {
      const r = await openVersionInstaller({ mode: 'new' });
      if (r) renderPage('versions');
    };
    return;
  }

  // manifest 还在后台加载时（首屏不再等它）：版本下拉先空，好了自取刷新一次
  if (!state.manifest) {
    api.versionsManifest(false).then((m) => {
      state.manifest = m;
      if (state.currentPage === 'versions') renderPage('versions');
    }).catch(() => {});
  }

  page.innerHTML = `
    <div class="page-title">版本管理</div>
    <div class="page-sub">为实例「${inst.name}」选择游戏版本与 Mod 加载器 · 下载完成后会新建一个实例，不替换本实例</div>

    <div class="glass" style="padding:22px;margin-bottom:18px">
      <div class="field">
        <label>游戏版本</label>
        <div class="tabs" id="vertype-tabs" style="margin-bottom:12px">
          <button class="tab active" data-vtype="release">正式版</button>
          <button class="tab" data-vtype="snapshot">快照版</button>
          <button class="tab" data-vtype="old">远古版</button>
          <button class="tab" data-vtype="all">全部</button>
        </div>
        <div class="row">
          <select class="input grow" id="ver-select"></select>
          <button class="btn" id="ver-refresh">刷新列表</button>
        </div>
      </div>
      <div class="field">
        <label>Mod 加载器</label>
        <div class="tabs" id="loader-tabs">
          <button class="tab active" data-loader="vanilla">原版</button>
          <button class="tab" data-loader="forge">Forge</button>
          <button class="tab" data-loader="fabric">Fabric</button>
          <button class="tab" data-loader="quilt">Quilt</button>
        </div>
      </div>
      <div id="loader-config"></div>
      <div class="row" style="margin-top:8px">
        <button class="btn primary" id="ver-save">下载并新建实例</button>
        <button class="btn" id="ver-open-dir">打开游戏目录</button>
      </div>
    </div>

    <div class="page-title" style="font-size:18px">已安装版本</div>
    <div class="card-list" id="installed-list" style="margin-top:14px"></div>
  `;

  const sel = $('ver-select');
  let currentVType = 'release';

  const typeLabel = (t) => ({
    release: '正式版',
    snapshot: '快照',
    old_alpha: '远古 Alpha',
    old_beta: '远古 Beta',
  })[t] || t;

  const fillVersionOptions = () => {
    const prev = sel.value;
    sel.innerHTML = '';
    let versions = state.manifest ? state.manifest.versions : [];
    if (currentVType === 'release') versions = versions.filter((v) => v.type === 'release');
    else if (currentVType === 'snapshot') versions = versions.filter((v) => v.type === 'snapshot');
    else if (currentVType === 'old') versions = versions.filter((v) => v.type === 'old_alpha' || v.type === 'old_beta');
    versions.forEach((v) => {
      const opt = ce('option');
      opt.value = v.id;
      const tag = currentVType === 'all' ? `（${typeLabel(v.type)}）` : '';
      opt.textContent = (state.installed.includes(v.id) ? `${v.id}（已安装）` : v.id) + tag;
      sel.appendChild(opt);
    });
    sel.value = versions.some((v) => v.id === prev) ? prev
      : versions.some((v) => v.id === inst.versionId) ? inst.versionId
      : (versions[0] && versions[0].id) || '';
  };
  fillVersionOptions();

  document.querySelectorAll('#vertype-tabs .tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('#vertype-tabs .tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      currentVType = t.dataset.vtype;
      fillVersionOptions();
      renderLoaderConfig();
    };
  });

  let currentLoader = inst.modLoader || 'vanilla';

  const renderLoaderConfig = async () => {
    const box = $('loader-config');
    box.innerHTML = '';
    const mcVersion = sel.value;
    if (currentLoader === 'vanilla') {
      box.innerHTML = '<div style="color:var(--text-dim);font-size:13px">原版 Minecraft，无 Mod 支持</div>';
      return;
    }
    box.innerHTML = '<div class="loading-inline" style="color:var(--text-dim);font-size:13px">加载中…</div>';
    try {
      if (currentLoader === 'forge') {
        const list = await api.forgeVersions(mcVersion);
        const rec = list.find((v) => v.isRecommended) || list[0];
        box.innerHTML = `
          <div class="field">
            <label>Forge 版本</label>
            <select class="input" id="forge-select"></select>
          </div>
          <div style="font-size:12px;color:var(--text-dim)">推荐版本：${rec ? rec.version : '无'}</div>
        `;
        const fs = $('forge-select');
        list.forEach((v) => {
          const o = ce('option');
          o.value = v.version;
          o.textContent = v.version + (v.isRecommended ? '（推荐）' : v.isLatest ? '（最新）' : '');
          fs.appendChild(o);
        });
        if (rec) fs.value = rec.version;
        if (inst.loaderVersion) fs.value = inst.loaderVersion;
      } else {
        const list = currentLoader === 'fabric' ? await api.fabricLoaders() : await api.quiltLoaders();
        box.innerHTML = `
          <div class="field">
            <label>${currentLoader === 'fabric' ? 'Fabric' : 'Quilt'} Loader 版本</label>
            <select class="input" id="loader-select"></select>
          </div>
        `;
        const ls = $('loader-select');
        list.forEach((v) => {
          const o = ce('option');
          o.value = v.version;
          o.textContent = v.version + (v.stable ? '（稳定）' : '');
          ls.appendChild(o);
        });
        if (inst.loaderVersion) ls.value = inst.loaderVersion;
      }
    } catch (e) {
      box.innerHTML = `<div style="color:#fca5a5;font-size:13px">加载失败：${e.message}</div>`;
    }
  };

  document.querySelectorAll('#loader-tabs .tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('#loader-tabs .tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      currentLoader = t.dataset.loader;
      renderLoaderConfig();
    };
  });

  // 还原加载器标签
  document.querySelectorAll('#loader-tabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.loader === currentLoader);
  });
  renderLoaderConfig();
  sel.onchange = renderLoaderConfig;

  $('ver-refresh').onclick = async () => {
    try {
      state.manifest = await api.versionsManifest(true);
      state.installed = await api.versionsInstalled();
      renderPage('versions');
      toast('版本列表已刷新');
    } catch (e) { toast(e.message, true); }
  };

  $('ver-save').onclick = async () => {
    const mcVersion = sel.value;
    if (!mcVersion) return toast('先选一个游戏版本', true);
    let loaderVersion = '';
    if (currentLoader === 'forge') loaderVersion = $('forge-select').value;
    else if (currentLoader !== 'vanilla') loaderVersion = $('loader-select').value;

    // 下载完成后「新建一个实例」，不再写回/替换当前实例 —— 下载版本即添置新实例。
    // 与首页「下载版本」流程保持同一行为，文件统一进全局游戏目录。
    const gameDir = state.config.gameDir;
    try {
      showLoading(`下载 ${mcVersion}…`);
      const versionId = await downloadVersionWithLoader(
        { mcVersion, loader: currentLoader, loaderVersion },
        gameDir,
        (t) => { if ($('loading-text')) $('loading-text').textContent = t; },
      );
      hideLoading();
      state.installed = await api.versionsInstalled(gameDir);
      await finalizeNewInstance(versionId, currentLoader, loaderVersion, gameDir);
    } catch (e) {
      hideLoading();
      toast('下载失败：' + e.message, true);
    }
  };

  $('ver-open-dir').onclick = () => api.openPath(instGameDir(inst));

  // 已安装列表
  // 这些卡片以前是死的（没 handler、没按钮）：下载好的版本在这里看得见却用不上。
  // 现在每张卡都能「用此版本」把版本号写进当前实例、或直接启动、或另建一个实例。
  const list = $('installed-list');
  const versionsDir = `${instGameDir(inst)}/versions`.replace(/\\/g, '/');

  const useVersion = async (id, launch) => {
    await api.instancesSave(state.selectedInstance, {
      versionId: id,
      modLoader: 'vanilla',
      loaderVersion: '',
    });
    await refreshConfig();
    if (launch) {
      renderPage('home');
      setTimeout(() => $('home-play') && $('home-play').click(), 80);
    } else {
      toast(`实例「${inst.name}」已选用 ${id}`);
      renderPage('versions');
    }
  };

  state.installed.forEach((id) => {
    const inUse = inst.versionId === id;
    const card = ce('div', 'card glass');
    card.innerHTML = `
      <div class="card-icon">📦</div>
      <div class="card-body">
        <div class="card-title">${id}${inUse ? ' <span class="badge">实例使用中</span>' : ''}</div>
        <div class="card-desc">${versionsDir}/${id}</div>
      </div>
      <div class="row" style="gap:8px">
        <button class="btn sm primary" data-act="use">用此版本</button>
        <button class="btn sm" data-act="launch">用它启动</button>
        <button class="btn sm ghost" data-act="new">新建实例</button>
      </div>
    `;
    card.onclick = () => { if (!inUse) useVersion(id, false); };
    card.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        try {
          if (act === 'use') return await useVersion(id, false);
          if (act === 'launch') return await useVersion(id, true);
          if (act === 'new') {
            const name = await askText('新建实例', `${id} 专用`);
            if (!name) return;
            const nid = `inst_${Date.now().toString(36)}`;
            await api.instancesSave(nid, {
              name,
              versionId: id,
              gameDir: `${state.config.gameDir}/instances/${nid}`,
              modLoader: 'vanilla',
              loaderVersion: '',
              javaPath: '',
              memory: null,
              jvmArgs: '',
              icon: '⛏',
              group: '',
            });
            await api.configSet('selectedInstance', nid);
            await refreshConfig();
            state.selectedInstance = nid;
            toast(`实例「${name}」已建好（${id}），可以直接启动`);
            renderPage('instances');
          }
        } catch (err) {
          toast(err.message, true);
        }
      };
    });
    list.appendChild(card);
  });
  if (state.installed.length === 0) {
    list.innerHTML = '<div class="glass" style="padding:24px;text-align:center;color:var(--text-dim)">暂无已安装版本</div>';
  }
}

/* ========== 模组中心 ========== */

const CENTER_CATS = [
  { id: 'mod',          name: '模组',   ico: '🧩' },
  { id: 'modpack',      name: '整合包', ico: '🗃️' },
  { id: 'shader',       name: '光影',   ico: '✨' },
  { id: 'resourcepack', name: '资源包', ico: '🎨' },
  { id: 'datapack',     name: '数据包', ico: '📜' },
  { id: 'world',        name: '世界',   ico: '🌍' },
];

let centerCat = 'mod';

function renderCenter(page) {
  const instances = state.config.instances || {};
  const inst = currentInstanceOf(instances, state.selectedInstance);

  // 没有实例时下载内容无处安放：先引导下载版本建实例
  if (!inst) {
    page.innerHTML = `
      <div class="page-title">模组中心</div>
      <div class="glass" style="padding:36px;text-align:center">
        <div style="font-size:42px;margin-bottom:12px">🧩</div>
        <div style="font-size:15px;margin-bottom:6px">还没有任何实例</div>
        <div class="hint-text" style="margin-bottom:20px">先下载一个游戏版本建好实例，再来下载模组和资源</div>
        <button class="btn primary" id="center-empty-download">下载游戏版本</button>
      </div>
    `;
    $('center-empty-download').onclick = async () => {
      const r = await openVersionInstaller({ mode: 'new' });
      if (r) renderPage('center');
    };
    return;
  }

  page.innerHTML = `
    <div class="page-title">模组中心</div>
    <div class="page-sub">当前实例「${inst.name}」· 下载内容自动放入该实例对应目录
      <button class="btn ghost sm" id="center-import" type="button" style="margin-left:10px">📥 本地导入</button>
      <span class="hint-text" style="margin-left:8px">也可以直接把文件拖进窗口</span>
    </div>

    <div class="cat-bar glass" id="cat-bar">
      ${CENTER_CATS.map((c) => `
        <button class="cat-tab ${c.id === centerCat ? 'active' : ''}" data-cat="${c.id}" type="button">
          <span class="cat-ico">${c.ico}</span><span>${c.name}</span>
        </button>`).join('')}
    </div>
    <div id="center-body"></div>
  `;

  const renderCatBody = () => {
    const box = $('center-body');
    box.innerHTML = '';
    if (centerCat === 'mod') renderModCategory(inst, box);
    else if (centerCat === 'modpack') renderModpackCategory(inst, box);
    else if (centerCat === 'world') renderWorldCategory(inst, box);
    else renderResourceCategory(inst, box, centerCat);
  };

  document.querySelectorAll('#cat-bar .cat-tab').forEach((t) => {
    t.onclick = () => {
      centerCat = t.dataset.cat;
      document.querySelectorAll('#cat-bar .cat-tab').forEach((x) => x.classList.toggle('active', x === t));
      renderCatBody();
    };
  });

  renderCatBody();

  const impBtn = $('center-import');
  if (impBtn) impBtn.onclick = () => importViaDialog();
}

/* ---------- 分类：模组（本地管理 + 双源搜索） ---------- */

function renderModCategory(inst, box) {
  // 默认落在 Modrinth：CurseForge 的公开接口现在一律 403（要 API Key），
  // 之前默认进去就是一片「搜索失败」，所以把好用的那个放默认。
  box.innerHTML = `
    <div class="tabs">
      <button class="tab" data-mtab="local">本地 Mod</button>
      <button class="tab active" data-mtab="modrinth">Modrinth</button>
      <button class="tab" data-mtab="curseforge">CurseForge（需 API Key）</button>
    </div>
    <div id="mod-content"></div>
  `;

  const renderLocal = async () => {
    const mbox = $('mod-content');
    mbox.innerHTML = '<div style="color:var(--text-dim)">加载中…</div>';
    try {
      const list = await api.modsList(inst.gameDir);
      if (list.length === 0) {
        mbox.innerHTML = '<div class="glass" style="padding:24px;text-align:center;color:var(--text-dim)">还没有 Mod。切到 Modrinth / CurseForge 下载吧！</div>';
        return;
      }
      mbox.innerHTML = '<div class="card-list"></div>';
      const container = mbox.firstChild;
      list.forEach((m) => {
        const card = ce('div', 'mod-card glass');
        card.innerHTML = `
          <div class="mod-icon">🧩</div>
          <div class="mod-info">
            <div class="mod-name">${m.name}</div>
            <div class="mod-meta">${formatSize(m.size)} · ${m.disabled ? '<span class="badge disabled">已禁用</span>' : '<span class="badge">已启用</span>'}</div>
          </div>
          <div class="mod-actions">
            <button class="btn" data-act="toggle">${m.disabled ? '启用' : '禁用'}</button>
            <button class="btn danger" data-act="delete">删除</button>
          </div>
        `;
        card.querySelector('[data-act="toggle"]').onclick = async () => {
          await api.modsEnable(inst.gameDir, m.name, m.disabled);
          renderLocal();
        };
        card.querySelector('[data-act="delete"]').onclick = async () => {
          if (confirm(`确定删除 ${m.name}？`)) {
            await api.modsDelete(inst.gameDir, m.name);
            renderLocal();
          }
        };
        container.appendChild(card);
      });
    } catch (e) {
      mbox.innerHTML = `<div style="color:#fca5a5">${e.message}</div>`;
    }
  };

  const renderOnline = (source) => {
    const mbox = $('mod-content');
    const mcVersion = mcVerOf(inst.versionId);
    const loader = inst.modLoader && inst.modLoader !== 'vanilla' ? inst.modLoader : 'fabric';
    mbox.innerHTML = `
      <div class="search-bar">
        <input class="input grow" id="mod-search" placeholder="搜索 Mod…">
        <button class="btn primary" id="mod-search-btn">搜索</button>
      </div>
      <div id="mod-results"></div>
    `;
    const doSearch = async () => {
      const q = $('mod-search').value.trim();
      const results = $('mod-results');
      results.innerHTML = '<div style="color:var(--text-dim)">搜索中…</div>';
      try {
        const list = source === 'modrinth'
          ? await api.mrSearch(q, mcVersion, loader, 'mod')
          : await api.cfSearch(q, mcVersion, loader, 'mod');
        if (list.length === 0) {
          results.innerHTML = '<div class="glass" style="padding:20px;text-align:center;color:var(--text-dim)">无结果</div>';
          return;
        }
        results.innerHTML = '<div class="card-list"></div>';
        const container = results.firstChild;
        list.forEach((m) => {
          const card = ce('div', 'mod-card glass');
          card.innerHTML = `
            <div class="mod-icon">${m.icon ? `<img src="${m.icon}" onerror="this.style.display='none'">` : '🧩'}</div>
            <div class="mod-info">
              <div class="mod-name">${m.name}</div>
              <div class="mod-meta">${m.summary || ''} · ${(m.downloadCount || 0).toLocaleString()} 次下载</div>
            </div>
            <div class="mod-actions">
              <button class="btn primary" data-act="download">下载</button>
            </div>
          `;
          card.querySelector('[data-act="download"]').onclick = async () => {
            // 下载前置：实例还没配好版本 / 加载器，先弹二级菜单补齐，取消就不下了
            const fresh = await ensureRuntime(inst);
            if (!fresh) return;
            if (source === 'modrinth') {
              openModVersionPicker(m, fresh);
              return;
            }
            // CurseForge 源没有版本/依赖元数据，保持旧的直取最新逻辑
            const gv = mcVerOf(fresh.versionId);
            const gdir = instGameDir(fresh);
            try {
              const files = await api.cfFiles(m.id, gv);
              const file = files.find((f) => f.releaseType === 1) || files[0];
              if (!file) throw new Error('没有可用的文件版本');
              showLoading(`下载 ${m.name}…`);
              await api.cfDownload(file, gdir);
              toast(`${m.name} 下载成功`);
            } catch (e) {
              toast(e.message, true);
            } finally {
              hideLoading();
            }
          };
          container.appendChild(card);
        });
      } catch (e) {
        results.innerHTML = `<div style="color:#fca5a5">${e.message}</div>`;
      }
    };
    $('mod-search-btn').onclick = doSearch;
    $('mod-search').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
    doSearch();
  };

  box.querySelectorAll('[data-mtab]').forEach((t) => {
    t.onclick = () => {
      box.querySelectorAll('[data-mtab]').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      const tab = t.dataset.mtab;
      if (tab === 'local') renderLocal();
      else renderOnline(tab);
    };
  });

  renderOnline('modrinth');
}

/* ---------- 分类：光影 / 资源包 / 数据包（Modrinth） ---------- */

const RES_META = {
  shader: {
    hint: '光影需要先安装 Iris 或 OptiFine。安装后在游戏内「视频设置 → 光影」中启用。',
    placeholder: '搜索光影（需要 Iris / OptiFine）…',
    empty: '没有找到光影',
    ico: '✨',
  },
  resourcepack: {
    hint: '下载后在游戏内「选项 → 资源包」中启用。',
    placeholder: '搜索资源包 / 材质包…',
    empty: '没有找到资源包',
    ico: '🎨',
  },
  datapack: {
    hint: '数据包需放入对应存档的 datapacks 文件夹，下面按钮可打开存档目录。',
    placeholder: '搜索数据包…',
    empty: '没有找到数据包',
    ico: '📜',
  },
};

function renderResourceCategory(inst, box, cat) {
  const meta = RES_META[cat];
  const mcVersion = mcVerOf(inst.versionId);

  box.innerHTML = `
    <div class="glass" style="padding:14px 18px;margin-bottom:14px;color:var(--text-dim);font-size:13px">
      ${meta.hint}
      ${cat === 'datapack' ? `<button class="btn" id="dp-open-saves" style="margin-left:10px">📁 打开存档目录</button>` : ''}
    </div>
    <div class="search-bar">
      <input class="input grow" id="res-search" placeholder="${meta.placeholder}">
      <button class="btn primary" id="res-search-btn">搜索</button>
    </div>
    <div id="res-results"></div>
  `;

  const doSearch = async () => {
    const q = $('res-search').value.trim();
    const results = $('res-results');
    results.innerHTML = '<div style="color:var(--text-dim)">搜索中…</div>';
    try {
      const list = await api.mrSearch(q, mcVersion, '', cat);
      if (list.length === 0) {
        results.innerHTML = `<div class="glass" style="padding:20px;text-align:center;color:var(--text-dim)">${meta.empty}</div>`;
        return;
      }
      results.innerHTML = '<div class="card-list"></div>';
      const container = results.firstChild;
      list.forEach((m) => {
        const card = ce('div', 'mod-card glass');
        card.innerHTML = `
          <div class="mod-icon">${m.icon ? `<img src="${m.icon}" onerror="this.style.display='none'">` : meta.ico}</div>
          <div class="mod-info">
            <div class="mod-name">${m.name}</div>
            <div class="mod-meta">${m.summary || ''} · ${(m.downloadCount || 0).toLocaleString()} 次下载</div>
          </div>
          <div class="mod-actions">
            <button class="btn primary" data-act="download">下载</button>
            <button class="btn" data-act="web">网页</button>
          </div>
        `;
        card.querySelector('[data-act="download"]').onclick = async () => {
          // 下载前置：光影 / 资源包要实例先选好版本才下得准；数据包是按存档放的，不强求
          const fresh = cat === 'datapack' ? inst : await ensureRuntime(inst, 'vanilla');
          if (!fresh) return;
          const gv = mcVerOf(fresh.versionId) || mcVersion;
          try {
            const vers = await api.mrVersions(m.id, gv, '');
            const v = vers[0];
            const file = v.files.find((f) => f.primary) || v.files[0];
            if (!file) throw new Error('没有可用的文件版本');
            showLoading(`下载 ${m.name}…`);
            await api.mrDownload(file, instGameDir(fresh), cat);
            toast(`${m.name} 下载成功`);
          } catch (e) {
            toast(e.message, true);
          } finally {
            hideLoading();
          }
        };
        card.querySelector('[data-act="web"]').onclick = () =>
          api.openUrl(`https://modrinth.com/${cat}/${m.slug}`);
        container.appendChild(card);
      });
    } catch (e) {
      results.innerHTML = `<div style="color:#fca5a5">${e.message}</div>`;
    }
  };

  $('res-search-btn').onclick = doSearch;
  $('res-search').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  if (cat === 'datapack') {
    $('dp-open-saves').onclick = () => api.openPath(`${inst.gameDir}\\saves`);
  }
  doSearch();
}

/* ---------- 分类：整合包（Modrinth .mrpack → 新实例） ---------- */

function renderModpackCategory(inst, box) {
  box.innerHTML = `
    <div class="glass" style="padding:14px 18px;margin-bottom:14px;color:var(--text-dim);font-size:13px">
      一键安装整合包，会自动创建独立实例（含 Mod、配置、存档），安装后在主页实例列表选择即可启动。
    </div>
    <div class="search-bar">
      <input class="input grow" id="mp-search" placeholder="搜索整合包，如 All the Mods、Better MC…">
      <button class="btn primary" id="mp-search-btn">搜索</button>
    </div>
    <div id="mp-results"></div>
  `;

  const doSearch = async () => {
    const q = $('mp-search').value.trim();
    const results = $('mp-results');
    results.innerHTML = '<div style="color:var(--text-dim)">搜索中…</div>';
    try {
      const list = await api.mrSearch(q, '', '', 'modpack');
      if (list.length === 0) {
        results.innerHTML = '<div class="glass" style="padding:20px;text-align:center;color:var(--text-dim)">没有找到整合包</div>';
        return;
      }
      results.innerHTML = '<div class="card-list"></div>';
      const container = results.firstChild;
      list.forEach((m) => {
        const card = ce('div', 'mod-card glass');
        card.innerHTML = `
          <div class="mod-icon">${m.icon ? `<img src="${m.icon}" onerror="this.style.display='none'">` : '🗃️'}</div>
          <div class="mod-info">
            <div class="mod-name">${m.name}</div>
            <div class="mod-meta">${m.summary || ''} · ${(m.downloadCount || 0).toLocaleString()} 次下载</div>
          </div>
          <div class="mod-actions">
            <button class="btn primary" data-act="install">⚡ 安装</button>
            <button class="btn" data-act="web">网页</button>
          </div>
        `;
        card.querySelector('[data-act="install"]').onclick = async () => {
          const btn = card.querySelector('[data-act="install"]');
          try {
            const vers = await api.mrVersions(m.id, '', '');
            const v = vers[0];
            const file = v.files.find((f) => f.primary) || v.files[0];
            if (!file) throw new Error('没有可用的整合包文件');
            btn.disabled = true;
            btn.textContent = '安装中…';
            showLoading(`安装整合包：${m.name}`);
            await api.mrInstallPack(file, state.config.gameDir);
            state.config = await api.configGetAll();
            toast(`整合包「${m.name}」安装成功，已添加为新实例`);
          } catch (e) {
            toast(e.message, true);
            btn.disabled = false;
            btn.textContent = '⚡ 安装';
          } finally {
            hideLoading();
          }
        };
        card.querySelector('[data-act="web"]').onclick = () =>
          api.openUrl(`https://modrinth.com/modpack/${m.slug}`);
        container.appendChild(card);
      });
    } catch (e) {
      results.innerHTML = `<div style="color:#fca5a5">${e.message}</div>`;
    }
  };

  $('mp-search-btn').onclick = doSearch;
  $('mp-search').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  doSearch();
}

/* ---------- 分类：世界（直链 / 拖入 → saves） ---------- */

function renderWorldCategory(inst, box) {
  const gameDir = instGameDir(inst);

  box.innerHTML = `
    <div class="glass" style="padding:14px 18px;margin-bottom:14px;color:var(--text-dim);font-size:13px">
      地图会解压到实例「${escapeHtml(inst.name || '')}」的 saves 文件夹，进游戏即可看到。
    </div>

    <div class="glass" style="padding:16px 18px;margin-bottom:14px">
      <div style="font-weight:700;margin-bottom:8px">粘贴直链下载世界</div>
      <div class="search-bar" style="margin-bottom:0">
        <input class="input grow" id="world-url" placeholder="粘贴世界压缩包（.zip）的下载直链，例如某网盘 / 地图站给出的链接">
        <button class="btn primary" id="world-url-btn">下载到存档</button>
      </div>
      <div style="font-size:12px;color:var(--text-dim);margin-top:8px">
        任何能直接下到 zip 的地址都可以（地图站、网盘直链都行）。
      </div>
    </div>

    <div class="glass" style="padding:16px 18px;margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <span style="font-weight:700">本实例已有世界</span>
        <button class="btn sm ghost" id="world-refresh">刷新</button>
      </div>
      <div id="world-mine" style="font-size:13px;color:var(--text-dim)">读取中…</div>
    </div>

    <div class="glass" style="padding:16px 18px;color:var(--text-dim);font-size:13px">
      世界/地图不走在线搜索：Modrinth 不收录地图类资源，CurseForge 的接口又一律要 API Key（403），
      所以这里不摆一个点了必然失败的搜索框。想逛地图站可以用启动器顶栏的 🌐 浏览器，
      下到 zip 后再拖进启动器窗口，同样会落进本实例的存档。
    </div>
  `;

  // 本实例已有的世界：每次下载后都刷新，免得「下了一个又一个」却看不出到底存了几个
  const paintMine = async () => {
    const holder = $('world-mine');
    if (!holder || !holder.isConnected) return;
    try {
      const list = await api.worldList(gameDir);
      if (!holder.isConnected) return;
      if (!list.length) {
        holder.innerHTML = '还没有世界。用上面的直链下载，或直接把 zip 拖进窗口。';
        return;
      }
      holder.innerHTML = list.map((w) => `
        <div class="row" style="align-items:center;gap:10px;margin-bottom:6px">
          <span style="flex:1;color:var(--text)">🌍 ${escapeHtml(w.name)}${w.hasLevel ? '' : '（缺少 level.dat）'}</span>
          <span style="color:var(--text-dim)">${formatSize(w.size)}</span>
          <button class="btn sm" data-wdir="${escapeHtml(w.path)}">目录</button>
        </div>`).join('');
      holder.querySelectorAll('[data-wdir]').forEach((b) => {
        b.onclick = () => api.openPath(b.dataset.wdir);
      });
    } catch (e) {
      holder.textContent = '读取失败：' + e.message;
    }
  };
  paintMine();
  $('world-refresh').onclick = paintMine;

  $('world-url-btn').onclick = async () => {
    const url = $('world-url').value.trim();
    if (!/^https?:\/\//i.test(url)) return toast('请粘贴 http/https 的 zip 直链', true);
    const btn = $('world-url-btn');
    btn.disabled = true;
    btn.textContent = '下载中…';
    try {
      const r = await api.worldInstallUrl(url, gameDir);
      $('world-url').value = '';
      toast(`世界「${r.name}」已放入存档（${r.files} 个文件）`);
      paintMine();
    } catch (e) {
      toast('下载失败：' + e.message, true);
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = '下载到存档'; }
    }
  };
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/* ========== 多人游戏 ========== */

const svPing = {};   // address -> ping 结果

function pingLevel(latency) {
  if (!latency) return 0;
  if (latency < 60) return 5;
  if (latency < 120) return 4;
  if (latency < 220) return 3;
  if (latency < 400) return 2;
  return 1;
}

function latencyBars(latency) {
  const n = pingLevel(latency);
  const color = n >= 4 ? 'var(--accent)' : n === 3 ? '#eab308' : '#ef4444';
  return `<span class="sv-bars">${[1, 2, 3, 4, 5].map((i) =>
    `<i style="height:${4 + i * 2}px${i <= n ? `;background:${color}` : ''}"></i>`).join('')}</span>`;
}

function renderServers(page) {
  const servers = state.config.servers || [];
  page.innerHTML = `
    <div class="page-title">联机大厅</div>
    <div class="page-sub">服务器收藏与实时状态（延迟 · MOTD · 在线人数 · 版本）</div>
    <div class="row" style="margin-bottom:16px;gap:10px;flex-wrap:wrap">
      <button class="btn primary" id="sv-add" type="button">＋ 添加服务器</button>
      <button class="btn" id="sv-refresh" type="button">↻ 刷新全部状态</button>
      <span class="hint-text" id="sv-hint">正在查询服务器状态…</span>
    </div>

    <div class="lan-grid">
      <div class="glass lan-card lan-wide" id="lan-card-taohua">
        <div class="lan-title">🏺 陶瓦联机<span class="lan-ok" id="tc-badge">已内置</span></div>
        <div class="lan-desc">跨网络联机，效果跟同一个局域网一样。这套工具<b>已经随启动器装好了</b>，不用下载、不用自己找文件、不用开它的窗口：建房只要填个房间名，加入只要填房主的房间号。</div>

        <div class="tc-grid">
          <div class="tc-panel">
            <div class="tc-head">🏠 我来建房</div>
            <div class="field">
              <label>房间名</label>
              <input class="input" id="tc-host-name" placeholder="随便起一个，朋友填一样的名字也能进">
            </div>
            <div class="field">
              <label>我的游戏名（可选）</label>
              <input class="input" id="tc-host-player" placeholder="显示给房间里的人">
            </div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <button class="btn primary" id="tc-host" type="button">建房并进世界</button>
              <button class="btn" id="tc-host-only" type="button">只建房</button>
            </div>
          </div>
          <div class="tc-panel">
            <div class="tc-head">🚪 我要加入</div>
            <div class="field">
              <label>房间号 / 房间名</label>
              <input class="input" id="tc-join-code" placeholder="U/XXXX-XXXX-XXXX-XXXX 或房主填的房间名">
            </div>
            <div class="field">
              <label>我的游戏名（可选）</label>
              <input class="input" id="tc-join-player" placeholder="显示给房间里的人">
            </div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <button class="btn primary" id="tc-join" type="button">加入并进游戏</button>
            </div>
          </div>
        </div>

        <div class="tc-status" id="tc-status">正在读取陶瓦联机状态…</div>
        <div class="tc-room" id="tc-room"></div>
        <div class="tc-foot">
          <span class="hint-text">内置 <b>Terracotta | 陶瓦联机</b> © Burning_TNT · AGPL-3.0-or-later</span>
          <span style="flex:1"></span>
          <button class="btn sm" id="tc-leave" type="button">退出房间</button>
        </div>
      </div>

      <div class="glass lan-card lan-wide" id="lan-card-easytier">
        <div class="lan-title">🛰️ EasyTier 联机<span class="lan-ok" id="et-badge">已内置</span></div>
        <div class="lan-desc">另一种跨网络联机方式，和陶瓦互补：陶瓦是点对点打洞，EasyTier 组的是<b>虚拟局域网</b>，接上以后两边网段整个互通。同样已经装好了，不用下载、也不用自己找文件。</div>

        <div class="field" style="margin-top:12px">
          <label>公共节点（双方要填一样；留空则用内置候选）</label>
          <input class="input" id="et-nodes" placeholder="tcp://public.easytier.cn:11010；也可以填同一个局域网里房主的「本机地址:11010」">
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn sm" id="et-probe" type="button">检测节点连通性</button>
          <span class="hint-text">开打前先握一次手，连得上的排前面</span>
        </div>
        <div class="lan-ips" id="et-probe-box" style="display:none"></div>

        <div class="tc-grid">
          <div class="tc-panel">
            <div class="tc-head">🏠 我来建房</div>
            <div class="field">
              <label>房间名</label>
              <input class="input" id="et-host-name" placeholder="随便起一个，朋友填一样的名字也能进">
            </div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <button class="btn primary" id="et-host" type="button">建房并进世界</button>
              <button class="btn" id="et-host-only" type="button">只建房</button>
            </div>
            <div class="hint-text" style="margin-top:6px">建房要装虚拟网卡，所以第一次点会弹一次管理员授权；加入方不需要。</div>
          </div>
          <div class="tc-panel">
            <div class="tc-head">🚪 我要加入</div>
            <div class="field">
              <label>房间号 / 房间名</label>
              <input class="input" id="et-join-code" placeholder="房主给的房间号，或房主填的房间名">
            </div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <button class="btn primary" id="et-join" type="button">加入并进游戏</button>
            </div>
            <div class="hint-text" style="margin-top:6px">加入方会自动把 <b>localhost:25565</b> 接到房主那边，进游戏直接连本机地址就行。</div>
          </div>
        </div>

        <div class="tc-status" id="et-status">正在读取 EasyTier 状态…</div>
        <div class="tc-room" id="et-room"></div>
        <div class="tc-foot">
          <span class="hint-text">内置 <b>EasyTier</b> © EasyTier 项目组及贡献者 · LGPL-3.0 · 许可证原文见 resources/tools/easytier/LICENSE.txt</span>
          <span style="flex:1"></span>
          <button class="btn sm" id="et-leave" type="button">退出房间</button>
        </div>
      </div>

      <div class="glass lan-card">
        <div class="lan-title">🏠 局域网开房</div>
        <div class="lan-desc">直接进入存档，在游戏内按 Esc →「对局域网开放」，同网段的朋友即可用下面地址加入</div>
        <div class="field" style="margin-top:12px">
          <label>实例</label>
          <select class="input" id="lan-inst"></select>
        </div>
        <div class="field">
          <label>存档</label>
          <select class="input" id="lan-world"></select>
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="lan-open" type="button">启动并进入世界</button>
          <button class="btn" id="lan-copy" type="button">复制本机地址</button>
        </div>
        <div class="lan-ips" id="lan-ips">正在读取本机地址…</div>

        <div class="lan-pub">
          <div class="lan-pub-head">
            <span class="lan-pub-title">🌍 公网联机</span>
            <span class="lan-pub-state" id="lan-pub-state">检测中…</span>
          </div>
          <div class="lan-desc">不用装任何工具：开房后启动器自动用 IPv6 或 UPnP 打通公网，把地址发给朋友就能加入</div>
          <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">
            <input class="input" id="lan-port" type="number" min="1" max="65535" placeholder="局域网端口（游戏里开放后自动填入）" style="width:250px">
            <button class="btn primary" id="lan-pub-open" type="button">开启公网联机</button>
            <button class="btn" id="lan-pub-copy" type="button">复制公网地址</button>
          </div>
          <div class="lan-ips" id="lan-pub-addr">—</div>
        </div>
      </div>

      <div class="glass lan-card">
        <div class="lan-title">🔗 联机工具</div>
        <div class="lan-desc">陶瓦 / 红石 等虚拟局域网工具，直接装进启动器，之后一键开房，不用自己找 exe</div>
        <div id="lan-tools" style="margin-top:12px"><div class="hint-text">正在探测…</div></div>
        <div class="lan-tools-foot">
          <button class="btn sm" id="lan-tools-dir" type="button">打开工具目录</button>
        </div>
      </div>
    </div>

    <div class="page-title" style="font-size:17px;margin:22px 0 12px">服务器收藏</div>
    <div class="sv-grid" id="sv-list"></div>
  `;
  const list = $('sv-list');

  const draw = () => {
    if (!list.isConnected) return;
    if (!servers.length) {
      list.innerHTML = '<div class="empty-tip">还没有收藏的服务器，点「添加服务器」开始</div>';
      return;
    }
    list.innerHTML = servers.map((s, i) => {
      const info = svPing[s.address];
      const online = info && info.online;
      const delayed = !info;
      return `
        <div class="sv-card ${online ? 'online' : delayed ? '' : 'offline'}">
          <div class="sv-favicon">${info && info.favicon
            ? `<img src="${info.favicon}" alt="">`
            : '<span>🌐</span>'}</div>
          <div class="sv-main">
            <div class="sv-head">
              <span class="sv-name">${escapeHtml(s.name)}</span>
              ${delayed ? '<span class="sv-tag">查询中…</span>'
    : online ? '<span class="sv-tag ok">在线</span>' : `<span class="sv-tag bad">离线${info.error ? ' · ' + escapeHtml(info.error) : ''}</span>`}
            </div>
            <div class="sv-addr">${escapeHtml(s.address)}</div>
            <div class="sv-motd">${online ? (escapeHtml(info.motd) || '<span class="hint-text">无 MOTD</span>') : ''}</div>
            ${online ? `
              <div class="sv-stats">
                <span>👥 ${info.players.online} / ${info.players.max}</span>
                <span>🏷 ${escapeHtml(info.version || '未知版本')}</span>
                <span>📶 ${info.latency} ms ${latencyBars(info.latency)}</span>
              </div>` : ''}
          </div>
          <div class="sv-acts">
            <button class="btn sm primary" data-act="start" data-i="${i}">启动</button>
            <button class="btn sm" data-act="ping" data-i="${i}">刷新</button>
            <button class="btn sm" data-act="copy" data-i="${i}">复制地址</button>
            <button class="btn sm danger" data-act="del" data-i="${i}">删除</button>
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        const i = Number(b.dataset.i);
        const s = servers[i];
        if (!s) return;
        if (b.dataset.act === 'del') {
          const next = servers.filter((_, idx) => idx !== i);
          state.config.servers = next;
          await api.configSet('servers', next);
          servers.length = 0;
          servers.push(...next);
          draw();
          return;
        }
        if (b.dataset.act === 'copy') {
          try {
            await navigator.clipboard.writeText(s.address);
            toast('地址已复制');
          } catch { toast('复制失败', true); }
          return;
        }
        if (b.dataset.act === 'ping') {
          svPing[s.address] = null;
          draw();
          svPing[s.address] = await api.serverPing(s.address);
          draw();
          return;
        }
        if (b.dataset.act === 'start') {
          const inst = getInstance(state.selectedInstance);
          if (!inst) return toast('请先选择实例', true);
          showLoading(`正在启动并连接 ${s.address}…`);
          try {
            await api.launch(inst.id, { quickPlayServer: s.address });
          } catch (e) {
            toast('启动失败：' + e.message, true);
          } finally {
            hideLoading();
          }
        }
      };
    });
  };

  draw();

  const refreshAll = async () => {
    if (!servers.length) { $('sv-hint').textContent = '还没有服务器'; return; }
    $('sv-hint').textContent = '正在查询服务器状态…';
    servers.forEach((s) => { svPing[s.address] = null; });
    draw();
    const results = await api.serverPingAll(servers.map((s) => s.address));
    results.forEach((r) => { svPing[r.address] = r; });
    if ($('sv-hint')) $('sv-hint').textContent = `已刷新 ${results.length} 个服务器 · ${new Date().toLocaleTimeString('zh-CN')}`;
    draw();
  };

  /* ---------- 联机助手：局域网开房 ---------- */
  const lanInstSel = $('lan-inst');
  const lanWorldSel = $('lan-world');
  const instMap = state.config.instances || {};
  lanInstSel.innerHTML = Object.entries(instMap)
    .map(([id, i]) => `<option value="${escapeHtml(id)}" ${id === state.selectedInstance ? 'selected' : ''}>${escapeHtml(i.name)}${i.versionId ? ' · ' + escapeHtml(i.versionId) : ''}</option>`)
    .join('');

  const loadLanWorlds = async () => {
    const inst = instMap[lanInstSel.value];
    lanWorldSel.innerHTML = '<option value="">加载中…</option>';
    try {
      const saves = await api.contentSaves(instGameDir(inst));
      if (!lanWorldSel.isConnected) return;
      lanWorldSel.innerHTML = saves.length
        ? saves.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('')
        : '<option value="">（该实例暂无存档）</option>';
    } catch {
      if (lanWorldSel.isConnected) lanWorldSel.innerHTML = '<option value="">（读取失败）</option>';
    }
  };
  lanInstSel.onchange = loadLanWorlds;
  loadLanWorlds();

  const renderIps = (ips) => {
    const box = $('lan-ips');
    if (!box || !box.isConnected) return;
    box.innerHTML = ips.length
      ? `本机局域网地址（游戏内开放局域网后，把「地址:端口」发给朋友）：<br>${ips
        .map((i) => `<span class="lan-ip">${escapeHtml(i.address)}</span><span class="hint-text">${escapeHtml(i.name)}</span>`)
        .join('')}`
      : '<span class="hint-text">未检测到局域网地址（可能未连接 WiFi / 网线）</span>';
  };
  api.lanIps().then((ips) => { if ($('lan-ips')) renderIps(ips); }).catch(() => {
    if ($('lan-ips')) $('lan-ips').innerHTML = '<span class="hint-text">读取本机地址失败</span>';
  });

  /* ---------- 联机助手：公网联机（IPv6 直连 / UPnP 自动开端口） ---------- */
  let pubAddr = '';
  let pubIPv6 = [];

  const setPubAddr = (html) => {
    const box = $('lan-pub-addr');
    if (box && box.isConnected) box.innerHTML = html;
  };

  const renderPubState = (ipv6) => {
    pubIPv6 = ipv6 || [];
    const el = $('lan-pub-state');
    if (!el || !el.isConnected) return;
    el.innerHTML = pubIPv6.length
      ? '<span class="lan-ok">IPv6 可用</span>'
      : '<span class="hint-text">无公网 IPv6，将改用 UPnP</span>';
  };

  // silent = 由游戏日志自动触发，端口空的时候不弹提示
  const openPublic = async (silent) => {
    const input = $('lan-port');
    const port = parseInt(input && input.value, 10) || 0;
    if (!port) {
      if (!silent) toast('先填游戏里开放局域网的端口（在游戏里开放后会自动填入）', true);
      return;
    }
    const btn = $('lan-pub-open');
    if (btn) { btn.disabled = true; btn.textContent = '正在开启…'; }
    try {
      if (pubIPv6.length) {
        // 有公网 IPv6 就不用动路由器，直接把地址给对方
        pubAddr = `[${pubIPv6[0]}]:${port}`;
        setPubAddr(`公网地址（IPv6 直连，发给朋友即可加入）：<br><span class="lan-ip">${escapeHtml(pubAddr)}</span>`);
        toast('已就绪：把公网地址发给朋友');
      } else {
        const r = await api.lanUpnp(port);
        if (r && r.ip) {
          pubAddr = `${r.ip}:${port}`;
          setPubAddr(`公网地址（UPnP 已自动映射到本机）：<br><span class="lan-ip">${escapeHtml(pubAddr)}</span>`);
          toast('路由器已自动开好端口');
        } else {
          pubAddr = '';
          setPubAddr('<span class="hint-text">路由器不支持 UPnP，也检测不到公网 IPv6。可以改用下面的「联机工具」装一个内网穿透，或手动在路由器上把该端口转发到本机。</span>');
          toast('没能自动打通公网', true);
        }
      }
    } catch (e) {
      setPubAddr(`<span class="hint-text">开启失败：${escapeHtml(e.message)}</span>`);
      toast('开启失败：' + e.message, true);
    } finally {
      const b = $('lan-pub-open');
      if (b && b.isConnected) { b.disabled = false; b.textContent = '开启公网联机'; }
    }
  };

  // 游戏里点下「对局域网开放」后，日志会带出端口，这里自动填好并尝试打通公网
  state.lanPortHook = (info) => {
    const input = $('lan-port');
    if (!input || !input.isConnected) return;
    input.value = info.port;
    toast(`检测到局域网端口 ${info.port}，正在打通公网…`);
    openPublic(true);
  };

  $('lan-pub-open').onclick = () => openPublic(false);

  $('lan-pub-copy').onclick = async () => {
    if (!pubAddr) return toast('还没有公网地址，先点「开启公网联机」', true);
    try {
      await navigator.clipboard.writeText(pubAddr);
      toast(`已复制 ${pubAddr}`);
    } catch { toast('复制失败', true); }
  };

  $('lan-copy').onclick = async () => {
    try {
      const ips = await api.lanIps();
      if (!ips.length) return toast('未检测到局域网地址', true);
      await navigator.clipboard.writeText(ips[0].address);
      toast(`已复制 ${ips[0].address}`);
    } catch { toast('复制失败', true); }
  };

  $('lan-open').onclick = async () => {
    const instId = lanInstSel.value;
    const world = lanWorldSel.value;
    if (!instId) return toast('请先选择实例', true);
    if (!world) return toast('该实例没有可进入的存档', true);
    showLoading(`正在进入世界「${world}」…`);
    try {
      await api.launch(instId, { quickPlayWorld: world });
      toast('已进入世界，请在游戏内按 Esc →「对局域网开放」');
    } catch (e) {
      toast('启动失败：' + e.message, true);
    } finally {
      hideLoading();
    }
  };

  /* ---------- 联机助手：第三方工具 ---------- */
  const refreshTools = async () => renderTools((await api.lanDetect()).tools);

  const renderTools = (tools) => {
    const box = $('lan-tools');
    if (!box || !box.isConnected) return;
    const tag = (t) => {
      if (t.bundled) return '<span class="lan-ok">已内置</span>';
      if (t.managed) return '<span class="lan-ok">已装入启动器</span>';
      if (t.found) return '<span class="lan-ok">已找到</span>';
      return '';
    };
    const status = (t) => {
      if (t.custom) return t.path || t.desc;
      if (t.bundled) return `${t.name} 已随启动器内置，上面的联机卡片直接就能用`;
      if (t.managed) return `${t.name} 已由启动器托管，点「启动」直接开房`;
      if (t.page && !t.found) return `${t.desc}（官方只提供安装程序，点右边去官网下载）`;
      return t.path || t.desc;
    };
    box.innerHTML = tools.map((t) => `
      <div class="lan-tool">
        <span class="lan-tool-ico">${t.icon}</span>
        <div class="lan-tool-info">
          <div class="lan-tool-name">${escapeHtml(t.name)}${tag(t)}</div>
          <div class="lan-tool-status" title="${escapeHtml(t.path || '')}">${escapeHtml(status(t))}</div>
        </div>
        ${t.found && !t.bundled ? `<button class="btn sm primary" data-lan-run="${t.id}">启动</button>` : ''}
        ${t.bundled ? `<button class="btn sm" data-lan-goto="${t.id}">↑ 用上面卡片</button>` : ''}
        ${t.custom
          ? `<button class="btn sm" data-lan-pick="custom">指定</button>`
          : t.bundled
            ? ''
            : t.found
              ? `<button class="btn sm" data-lan-install="${t.id}">重装</button>`
              : t.auto
              ? `<button class="btn sm primary" data-lan-fetch="${t.id}">一键获取</button>`
              : t.page
                ? `<button class="btn sm primary" data-lan-page="${t.page}">打开下载页</button>`
                : `<button class="btn sm primary" data-lan-install="${t.id}">装进启动器</button>`}
      </div>`).join('');

    // 装进启动器：选一次安装包（zip 会自动解压），之后启动器托管并永久一键启动
    box.querySelectorAll('[data-lan-install]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.lanInstall;
        const file = await api.pickFile([{ name: '联机工具安装包', extensions: ['zip', 'exe', 'bat', 'cmd'] }]);
        if (!file) return;
        b.disabled = true;
        b.textContent = '收纳中…';
        try {
          const r = await api.lanInstall(id, file);
          toast(r.exe ? `已装进启动器：${r.exe.split(/[\\/]/).pop()}` : '已解压完成，但没找到可执行文件');
        } catch (e) {
          toast('收纳失败：' + e.message, true);
        }
        await refreshTools();
      };
    });

    // 配了官方直链的预置工具：启动器自己下载并收纳
    box.querySelectorAll('[data-lan-fetch]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.lanFetch;
        b.disabled = true;
        b.textContent = '获取中…';
        try {
          await api.lanFetch(id);
          toast('已装进启动器');
        } catch (e) {
          toast('获取失败：' + e.message, true);
        }
        await refreshTools();
      };
    });

    // 只提供安装程序的工具：开内置浏览器去官网下载页
    box.querySelectorAll('[data-lan-page]').forEach((b) => {
      b.onclick = () => api.openUrl(b.dataset.lanPage);
    });

    box.querySelectorAll('[data-lan-pick]').forEach((b) => {
      b.onclick = async () => {
        const file = await api.pickFile([{ name: '可执行文件', extensions: ['exe', 'bat', 'cmd', 'lnk'] }]);
        if (!file) return;
        await api.lanSetPath('custom', file, file.split(/[\\/]/).pop());
        toast('已登记该工具');
        await refreshTools();
      };
      b.oncontextmenu = async (e) => {
        e.preventDefault();
        await api.lanSetPath('custom', '');
        toast('已清除自定义工具');
        await refreshTools();
      };
    });

    box.querySelectorAll('[data-lan-run]').forEach((b) => {
      b.onclick = async () => {
        try {
          const r = await api.lanLaunch(b.dataset.lanRun);
          toast(`已启动：${r.path.split(/[\\/]/).pop()}`);
        } catch (e) { toast('启动失败：' + e.message, true); }
      };
    });

    // 内置工具已经在上面卡片无窗口集成：直接启动 exe 只会强开系统浏览器弹它的 Web 界面，
    // 多余还添乱。这里点一下直接滚回上面对应的联机卡片。
    box.querySelectorAll('[data-lan-goto]').forEach((b) => {
      b.onclick = () => {
        const anchor = $(`lan-card-${b.dataset.lanGoto}`);
        if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('用上面的卡片直接建房 / 加入就行');
      };
    });
  };
  api.lanDetect().then((r) => {
    renderTools(r.tools);
    renderPubState(r.ipv6);
  }).catch(() => {
    const box = $('lan-tools');
    if (box && box.isConnected) box.innerHTML = '<div class="hint-text">工具探测失败</div>';
    renderPubState([]);
  });
  const toolsDirBtn = $('lan-tools-dir');
  if (toolsDirBtn) {
    toolsDirBtn.onclick = async () => {
      const dir = await api.lanToolsDir();
      await api.openPath(dir);
      toast('已打开工具目录');
    };
  }

  /* ---------- 联机大厅：陶瓦联机（内置客户端） ---------- */
  const TC_STATES = {
    offline: '陶瓦后台没在运行（点下面按钮会自动拉起）',
    waiting: '空闲中（陶瓦后台已就绪，可以直接建房或加入）',
    'host-scanning': '正在等你进游戏后按 Esc →「对局域网开放」…',
    'host-starting': '正在建立房间…',
    'host-ok': '房间已经开好了',
    'guest-connecting': '正在寻找房主…',
    'guest-starting': '正在打通网络…',
    'guest-ok': '已经进到房间里了',
    exception: '联机出错了',
  };
  const TC_DIFFICULTY = { UNKNOWN: '未知', EASIEST: '极简', SIMPLE: '简单', MEDIUM: '中等', TOUGH: '困难' };

  let tcBusy = false;

  const tcSetStatus = (html) => {
    const el = $('tc-status');
    if (el && el.isConnected) el.innerHTML = html;
  };

  const tcRoomHtml = (code) => '房间号（发给朋友，或让朋友直接填上面的房间名）：<br>'
    + `<span class="lan-ip tc-code">${escapeHtml(code)}</span>`
    + `<button class="btn sm" data-tc-copy="${escapeHtml(code)}" type="button">复制房间号</button>`;

  const tcSetRoom = (html) => {
    const box = $('tc-room');
    if (!box || !box.isConnected) return;
    box.innerHTML = html;
    box.querySelectorAll('[data-tc-copy]').forEach((b) => {
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.tcCopy);
          toast(`已复制房间号 ${b.dataset.tcCopy}`);
        } catch { toast('复制失败', true); }
      };
    });
  };

  const tcPlayers = (profiles) => {
    const names = (profiles || []).map((p) => p && p.name).filter(Boolean);
    return names.length ? ` · 房间内 ${names.length} 人：${names.map((n) => escapeHtml(n)).join('、')}` : '';
  };

  /** 主进程推过来的房间状态，统一在这里落到界面上 */
  const tcShowState = (s) => {
    if (!s || !s.state) return;
    const label = TC_STATES[s.state] || s.state;
    let extra = '';
    if (s.state === 'host-starting' && s.room) extra = ` · 房间号 <b>${escapeHtml(s.room)}</b>`;
    if (s.state === 'host-ok' && s.room) extra = ` · 房间号 <b>${escapeHtml(s.room)}</b>${tcPlayers(s.profiles)}`;
    if (s.state === 'guest-starting' && s.difficulty) extra = ` · 连接难度：${TC_DIFFICULTY[s.difficulty] || s.difficulty}`;
    if (s.state === 'guest-ok') extra = tcPlayers(s.profiles);
    tcSetStatus(escapeHtml(label) + extra);
    if (s.state === 'host-ok' && s.room) tcSetRoom(tcRoomHtml(s.room));
  };
  state.tcHook = tcShowState;

  const tcSetBusy = (busy) => {
    tcBusy = busy;
    ['tc-host', 'tc-host-only', 'tc-join'].forEach((id) => {
      const b = $(id);
      if (b && b.isConnected) b.disabled = busy;
    });
  };

  const tcPlayerOf = (id) => {
    const el = $(id);
    return (el && el.value.trim()) || '';
  };

  api.scaffoldInfo().then((info) => {
    const badge = $('tc-badge');
    if (!info || !info.available) {
      if (badge) { badge.textContent = '内置文件缺失'; badge.classList.add('bad'); }
      tcSetStatus('<span class="hint-text">没找到内置的陶瓦联机文件（resources/tools/taohua）。可以先在下面「联机工具」里点「一键获取」补装，装好后这里就能直接用。</span>');
      return;
    }
    api.scaffoldState().then(tcShowState).catch(() => {});
  }).catch(() => tcSetStatus('<span class="hint-text">读取陶瓦联机状态失败</span>'));

  // 建房：withWorld = 顺手把存档也启动起来，玩家只要在游戏里开一下局域网
  const tcHost = async (withWorld) => {
    if (tcBusy) return;
    const name = tcPlayerOf('tc-host-name');
    if (!name) return toast('先给房间起个名字', true);
    const instId = lanInstSel.value;
    const world = lanWorldSel.value;
    if (withWorld && !instId) return toast('请先选择实例', true);
    if (withWorld && !world) return toast('该实例没有可进入的存档', true);

    tcSetBusy(true);
    tcSetStatus('正在拉起陶瓦联机…');
    let loading = false;
    const pending = api.scaffoldHost({ name, player: tcPlayerOf('tc-host-player') });
    try {
      if (withWorld) {
        showLoading(`正在建房并进入世界「${world}」…`);
        loading = true;
        await api.launch(instId, { quickPlayWorld: world });
        toast('已进入世界，请在游戏里按 Esc →「对局域网开放」');
        tcSetStatus('已进入世界，正在等你按 Esc →「对局域网开放」…');
      } else {
        tcSetStatus('正在建房…进游戏后按 Esc →「对局域网开放」，房间号会自动出现在这里');
      }
      const r = await pending;
      tcSetRoom(tcRoomHtml(r.code));
      toast(`房间开好了：${r.code}`);
    } catch (e) {
      await api.scaffoldLeave().catch(() => {});
      if (e.message !== '已取消') toast('建房失败：' + e.message, true);
    } finally {
      if (loading) hideLoading();
      tcSetBusy(false);
    }
  };

  const tcJoin = async () => {
    if (tcBusy) return;
    const raw = tcPlayerOf('tc-join-code');
    if (!raw) return toast('请填房主的房间号或房间名', true);
    const instId = lanInstSel.value;
    if (!instId) return toast('请先选择要用来联机的实例', true);

    tcSetBusy(true);
    tcSetStatus('正在拉起陶瓦联机…');
    let loading = false;
    try {
      const r = await api.scaffoldJoin({ room: raw, player: tcPlayerOf('tc-join-player') });
      if (!r.url) throw new Error('没能拿到服务器地址');
      try { await navigator.clipboard.writeText(r.url); } catch { /* 复制不了也没关系，下面照样显示 */ }
      tcSetRoom(`服务器地址（已复制）：<span class="lan-ip">${escapeHtml(r.url)}</span>${tcPlayers(r.profiles)}`);
      showLoading('正在进入服务器…');
      loading = true;
      await api.launch(instId, { quickPlayServer: r.url });
      toast('已进入房间。1.20 以下不会自动进服，用「多人游戏 → 直接连接」粘贴刚复制的地址即可');
    } catch (e) {
      if (e.message !== '已取消') toast('加入失败：' + e.message, true);
    } finally {
      if (loading) hideLoading();
      tcSetBusy(false);
    }
  };

  const tcHostBtn = $('tc-host');
  if (tcHostBtn) tcHostBtn.onclick = () => tcHost(true);
  const tcHostOnlyBtn = $('tc-host-only');
  if (tcHostOnlyBtn) tcHostOnlyBtn.onclick = () => tcHost(false);
  const tcJoinBtn = $('tc-join');
  if (tcJoinBtn) tcJoinBtn.onclick = tcJoin;

  const tcLeaveBtn = $('tc-leave');
  if (tcLeaveBtn) tcLeaveBtn.onclick = async () => {
    await api.scaffoldLeave();
    tcSetRoom('');
    tcSetStatus(TC_STATES.waiting + '（后台留着，下次点一下就能用）');
    toast('已退出房间');
  };

  /* ---------------- EasyTier 联机 ---------------- */
  const etSetStatus = (html) => {
    const el = $('et-status');
    if (el && el.isConnected) el.innerHTML = html;
  };
  const etSetRoom = (html) => {
    const box = $('et-room');
    if (!box || !box.isConnected) return;
    box.innerHTML = html;
    box.querySelectorAll('[data-et-copy]').forEach((b) => {
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.etCopy);
          toast(`已复制 ${b.dataset.etCopy}`);
        } catch { toast('复制失败', true); }
      };
    });
  };

  /** 主进程推过来的节点状态 */
  const etShowState = (s) => {
    if (!s || !s.phase) return;
    const who = (s.peers || []);
    const list = who.length
      ? ' · 网内 ' + who.map((p) => `${escapeHtml(p.hostname)}${p.direct ? '（直连）' : p.tunnel ? `（经 ${escapeHtml(p.tunnel)} 中转）` : ''}`).join('、')
      : '';
    if (s.phase === 'offline') { etSetStatus('未联机'); return; }
    if (s.phase === 'starting') {
      etSetStatus(s.role === 'host'
        ? `房已经建好（房间号 <b>${escapeHtml(s.code)}</b>），正在等朋友进网${list}`
        : `正在寻找房主…${list}`);
      return;
    }
    etSetStatus(s.role === 'host'
      ? `已经联通（房间号 <b>${escapeHtml(s.code)}</b>）${list}`
      : `已经接通，游戏里连 <b>localhost:25565</b> 即可${list}`);
  };
  state.etHook = etShowState;

  let etBusy = false;
  const etSetBusy = (busy) => {
    etBusy = busy;
    ['et-host', 'et-host-only', 'et-join'].forEach((id) => {
      const b = $(id);
      if (b && b.isConnected) b.disabled = busy;
    });
  };

  const etNodes = () => (($('et-nodes') && $('et-nodes').value.trim()) || '');

  /* 节点探测：内置公共节点随时可能失效，与其干等超时，不如提前说清楚 */
  const etSetProbe = (html) => {
    const box = $('et-probe-box');
    if (!box) return;
    box.innerHTML = html || '';
    box.style.display = html ? 'block' : 'none';
  };

  let etProbing = false;
  const etProbe = async (silent) => {
    if (etProbing) return;
    etProbing = true;
    const btn = $('et-probe');
    if (btn) btn.disabled = true;
    if (!silent) etSetProbe('<span class="hint-text">正在探测节点…</span>');
    try {
      const r = await api.easytierProbe(etNodes());
      const probes = (r && r.probes) || [];
      if (!probes.length) {
        etSetProbe('<span class="hint-text">没有可用的节点地址。</span>');
        return;
      }
      const rows = probes.map((p) => {
        const tag = p.ok ? `<span class="lan-ok">连通 ${p.ms}ms</span>`
          : p.unknown ? '<span class="lan-ok bad">UDP 无法预探</span>'
            : `<span class="lan-ok bad">${escapeHtml(p.note || '连不上')}</span>`;
        return `<div class="row" style="gap:8px;align-items:center">`
          + `<span class="lan-ip">${escapeHtml(p.url)}</span>${tag}</div>`;
      }).join('');
      const tail = r.allDown
        ? '<div class="hint-text" style="margin-top:6px;color:var(--danger,#f87171)">'
          + '这些节点现在都连不上。跨网络联机需要一个双方都能碰面的中转地址：'
          + '可以填自己搭的服务器，或同一个局域网里房主的「本机地址:11010」。'
          + '同一个局域网内联机不受影响。</div>'
        : '<div class="hint-text" style="margin-top:6px">建房 / 加入时会优先用上面靠前的节点。</div>';
      etSetProbe(rows + tail);
    } catch (e) {
      etSetProbe(`<span class="hint-text">探测失败：${escapeHtml(e.message)}</span>`);
    } finally {
      etProbing = false;
      if (btn) btn.disabled = false;
    }
  };

  const etProbeBtn = $('et-probe');
  if (etProbeBtn) etProbeBtn.onclick = () => etProbe(false);

  const etRoomHtml = (code, address) => '房间号（发给朋友，或让朋友直接填上面的房间名）：<br>'
    + `<span class="lan-ip tc-code">${escapeHtml(code)}</span>`
    + `<button class="btn sm" data-et-copy="${escapeHtml(code)}" type="button">复制房间号</button>`
    + `<br>联机地址：<span class="lan-ip">${escapeHtml(address)}</span>`
    + `<button class="btn sm" data-et-copy="${escapeHtml(address)}" type="button">复制地址</button>`;

  api.easytierInfo().then((info) => {
    const badge = $('et-badge');
    if (!info || !info.available) {
      if (badge) { badge.textContent = '内置文件缺失'; badge.classList.add('bad'); }
      etSetStatus('<span class="hint-text">没找到内置的 EasyTier 文件（resources/tools/easytier），可以在下面「联机工具」里点「一键获取」补装。</span>');
      return;
    }
    const input = $('et-nodes');
    if (input && (info.nodes || []).length) input.value = info.nodes.join(' ');
    else if (input && (info.defaults || []).length) input.placeholder = `${info.defaults.join(' / ')}（留空即用这些）`;
    etProbe(true);   // 进页面就先探一轮，让玩家一眼看到哪个节点能用
    api.easytierState().then(etShowState).catch(() => {});
  }).catch(() => etSetStatus('<span class="hint-text">读取 EasyTier 状态失败</span>'));

  const etHost = async (withWorld) => {
    if (etBusy) return;
    const name = ($('et-host-name') && $('et-host-name').value.trim()) || '';
    if (!name) return toast('先给房间起个名字', true);
    const instId = lanInstSel.value;
    const world = lanWorldSel.value;
    if (withWorld && !instId) return toast('请先选择实例', true);
    if (withWorld && !world) return toast('该实例没有可进入的存档', true);

    etSetBusy(true);
    etSetStatus('正在拉起 EasyTier（会弹一次管理员授权）…');
    let loading = false;
    try {
      await api.easytierNodes(etNodes() ? [etNodes()] : []);
      const pending = api.easytierHost({ room: name });
      if (withWorld) {
        showLoading(`正在建房并进入世界「${world}」…`);
        loading = true;
        await api.launch(instId, { quickPlayWorld: world });
        toast('已进入世界，请在游戏里按 Esc →「对局域网开放」');
      }
      const r = await pending;
      etSetRoom(etRoomHtml(r.code, r.address));
      toast(`房间开好了：${r.code}`);
    } catch (e) {
      await api.easytierLeave().catch(() => {});
      if (e.message !== '已取消') toast('建房失败：' + e.message, true);
    } finally {
      if (loading) hideLoading();
      etSetBusy(false);
    }
  };

  const etJoin = async () => {
    if (etBusy) return;
    const raw = ($('et-join-code') && $('et-join-code').value.trim()) || '';
    if (!raw) return toast('请填房主的房间号或房间名', true);
    const instId = lanInstSel.value;
    if (!instId) return toast('请先选择要用来联机的实例', true);

    etSetBusy(true);
    etSetStatus('正在拉起 EasyTier…');
    let loading = false;
    try {
      await api.easytierNodes(etNodes() ? [etNodes()] : []);
      const r = await api.easytierJoin({ room: raw });
      etSetRoom(etRoomHtml(r.code, r.address));
      showLoading('正在进入游戏…');
      loading = true;
      await api.launch(instId, { quickPlayServer: r.address });
      toast('已进入游戏。1.20 以下不会自动进服，用「多人游戏 → 直接连接」填 localhost:25565 即可');
    } catch (e) {
      if (e.message !== '已取消') toast('加入失败：' + e.message, true);
    } finally {
      if (loading) hideLoading();
      etSetBusy(false);
    }
  };

  const etHostBtn = $('et-host');
  if (etHostBtn) etHostBtn.onclick = () => etHost(true);
  const etHostOnlyBtn = $('et-host-only');
  if (etHostOnlyBtn) etHostOnlyBtn.onclick = () => etHost(false);
  const etJoinBtn = $('et-join');
  if (etJoinBtn) etJoinBtn.onclick = etJoin;
  const etLeaveBtn = $('et-leave');
  if (etLeaveBtn) etLeaveBtn.onclick = async () => {
    await api.easytierLeave();
    etSetRoom('');
    etSetStatus('已退出房间');
    toast('已退出 EasyTier 房间');
  };

  $('sv-refresh').onclick = refreshAll;
  $('sv-add').onclick = async () => {
    const name = await askText('服务器名称', '', '例如：我的生存服');
    if (!name) return;
    const address = await askText('服务器地址', '', 'host:port，例如 play.example.com:25565');
    if (!address) return;
    const next = [...servers, { name, address }];
    state.config.servers = next;
    await api.configSet('servers', next);
    servers.push({ name, address });
    draw();
    svPing[address] = null;
    draw();
    svPing[address] = await api.serverPing(address);
    draw();
  };

  refreshAll();
}

/* ========== 账号 ========== */

function renderAccount(page) {
  const acc = state.account;
  page.innerHTML = `
    <div class="page-title">账号</div>
    <div class="page-sub">选择登录方式</div>

    <div class="glass" style="padding:24px;margin-bottom:18px">
      <div class="page-title" style="font-size:18px">当前账号</div>
      ${acc ? `
        <div style="display:flex;align-items:center;gap:16px;margin-top:14px">
          <img class="acc-head" data-uuid="${escapeHtml(acc.uuid || '')}" src="https://crafatar.com/avatars/${acc.uuid}?size=64&overlay&default=MHF_Steve" style="width:56px;height:56px;border-radius:12px;image-rendering:pixelated">
          <div>
            <div style="font-size:18px;font-weight:700">${acc.username}</div>
            <div style="font-size:12px;color:var(--text-dim);margin-top:4px">${
              acc.type === 'microsoft' ? '正版 · Microsoft' :
              acc.type === 'yggdrasil' ? '皮肤站 · ' + (acc.stationUrl || '') :
              '离线模式'
            }</div>
          </div>
          <button class="btn danger" id="acc-logout" style="margin-left:auto">退出登录</button>
        </div>
      ` : '<div style="color:var(--text-dim);margin-top:10px">未登录</div>'}
    </div>

    ${state.accounts && state.accounts.length > 0 ? `
    <div class="glass" style="padding:22px;margin-bottom:18px">
      <div class="page-title" style="font-size:16px;margin-bottom:14px">已保存账号（${state.accounts.length}）</div>
      <div class="account-list" id="account-list">
        ${state.accounts.map((a) => `
          <div class="account-item ${a.uuid === acc?.uuid ? 'active' : ''}">
            <img class="acc-head" data-uuid="${escapeHtml(a.uuid || '')}" src="https://crafatar.com/avatars/${a.uuid}?size=48&overlay&default=MHF_Steve" style="width:40px;height:40px;border-radius:10px;image-rendering:pixelated">
            <div class="account-info">
              <div class="account-name">${a.username}</div>
              <div class="account-type">${
                a.type === 'microsoft' ? '正版' :
                a.type === 'yggdrasil' ? '皮肤站' : '离线'
              }</div>
            </div>
            ${a.uuid === acc?.uuid
              ? '<span class="badge">使用中</span>'
              : a.uuid
                ? `<button class="btn sm" data-switch="${escapeHtml(a.uuid)}">切换</button>
                   <button class="btn sm danger" data-remove="${escapeHtml(a.uuid)}">删除</button>`
                : ''
            }
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    <div class="grid-2">
      <div class="glass" style="padding:22px">
        <div class="field">
          <label style="font-size:15px;color:var(--text)">离线模式</label>
        </div>
        <div class="field">
          <label>角色名</label>
          <input class="input" id="off-name" maxlength="16" placeholder="Steve">
        </div>
        <button class="btn primary" id="off-login">离线登录</button>
      </div>

      <div class="glass" style="padding:22px">
        <div class="field">
          <label style="font-size:15px;color:var(--text)">微软正版登录</label>
        </div>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:14px">无需注册 Azure 应用，使用设备码登录。点击下方按钮后，启动器会自动在内置浏览器打开授权页，输入验证码即可。</div>
        <button class="btn primary" id="ms-login">⊞ 获取登录验证码</button>

        <!-- 设备码显示区（点击按钮后显示） -->
        <div id="device-code-panel" style="display:none;margin-top:16px;padding:16px;background:var(--bg-1);border:1px solid var(--border);border-radius:10px">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">启动器已在内置浏览器打开授权页，输入验证码；也可以点右侧按钮重新打开：</div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <code id="dc-url" style="flex:1;padding:8px 12px;background:var(--bg-0);border-radius:8px;font-size:12px;color:var(--accent);word-break:break-all">microsoft.com/link</code>
            <button class="btn sm" id="dc-open">在内置浏览器打开</button>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <code id="dc-code" style="flex:1;padding:10px 12px;background:var(--bg-0);border-radius:8px;font-size:22px;font-weight:800;letter-spacing:4px;text-align:center;color:var(--accent)">--------</code>
            <button class="btn sm" id="dc-copy">复制</button>
          </div>
          <div id="dc-status" style="font-size:12px;color:var(--text-dim);margin-top:10px;text-align:center">等待你在浏览器中完成授权…</div>
        </div>
      </div>
    </div>

    <div class="glass" style="padding:22px;margin-top:18px">
      <div class="field">
        <label style="font-size:15px;color:var(--text)">皮肤站登录（Yggdrasil）</label>
      </div>
      <div class="field">
        <label>皮肤站</label>
        <select class="input" id="skin-station"></select>
      </div>
      <div class="field" id="skin-url-field">
        <label>皮肤站 API 地址</label>
        <input class="input" id="skin-url" placeholder="https://example.com/api/yggdrasil">
      </div>
      <div class="grid-2">
        <div class="field">
          <label>用户名/邮箱</label>
          <input class="input" id="skin-user">
        </div>
        <div class="field">
          <label>密码</label>
          <input class="input" id="skin-pass" type="password">
        </div>
      </div>
      <button class="btn primary" id="skin-login">皮肤站登录</button>
    </div>
  `;

  // 账号头像：当前账号用本地渲染的皮肤头（主进程取纹理，不依赖境外图床），
  // 其它账号退回 crafatar；都取不到就把图藏起来，别在界面上留个破图。
  {
    const cur = state.account ? state.account.uuid : '';
    page.querySelectorAll('img.acc-head').forEach((img) => {
      const markBad = () => img.classList.add('bad');
      img.onerror = markBad;
      if (img.complete && img.naturalWidth === 0) markBad();
      if (cur && img.dataset.uuid === cur) {
        currentAccountHead().then((url) => {
          // 换成好图之后要把 onerror 摘掉：crafatar 那次请求被中断时可能补一个 error，
          // 会把刚拿到的皮肤头又打成破图态。
          if (url && img.isConnected) { img.onerror = null; img.classList.remove('bad'); img.src = url; }
        });
      }
    });
  }

  if ($('acc-logout')) {
    $('acc-logout').onclick = async () => {
      await api.authLogout();
      state.account = null;
      refreshAccounts();
      renderAccount(page);
      toast('已退出登录');
    };
  }

  // 切换 / 删除账号
  document.querySelectorAll('[data-switch]').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api.authSwitch(b.dataset.switch);
        state.account = r && r.account ? r.account : r;
        refreshAccounts();
        renderAccount(page);
        // 换新令牌失败时照样切过去，但要告诉玩家这个号可能得重新登录
        if (r && r.warn) toast(`已切换到 ${state.account.username}，但登录已失效，需要重新登录：${r.warn}`, true);
        else toast(`已切换到 ${state.account.username}`);
      } catch (e) { toast(e.message, true); }
    };
  });
  document.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('确定删除该账号？')) return;
      await api.authRemove(b.dataset.remove);
      refreshAccounts();
      renderAccount(page);
      toast('账号已删除');
    };
  });

  $('off-login').onclick = async () => {
    const name = $('off-name').value.trim();
    if (!name) return toast('请输入角色名', true);
    try {
      state.account = await api.authOffline(name);
      refreshAccounts();
      updateTopUser();
      toast(`离线登录成功：${state.account.username}`, false, { ico: '✅', desc: '欢迎回来' });
      renderAccount(page);
    } catch (e) { toast(e.message, true); }
  };

  $('ms-login').onclick = async () => {
    const btn = $('ms-login');
    btn.disabled = true;
    btn.textContent = '正在获取验证码…';
    islandNotify({
      ico: '🔐',
      title: '正在登录微软账号',
      desc: '授权页会在内置浏览器里自动打开',
    });

    // 监听设备码推送
    const dcPanel = $('device-code-panel');
    const dcCode = $('dc-code');
    const dcUrl = $('dc-url');
    const dcStatus = $('dc-status');
    const dcOpen = $('dc-open');
    const dcCopy = $('dc-copy');
    let dcInfo = null;
    let autoOpened = false;

    const offDc = api.onDeviceCode((info) => {
      if (info.userCode) {
        dcInfo = info;
        dcPanel.style.display = 'block';
        dcCode.textContent = info.userCode;
        dcUrl.textContent = info.verificationUri || 'microsoft.com/link';
        dcStatus.textContent = '等待你在浏览器中完成授权…';
        dcStatus.style.color = 'var(--text-dim)';
        btn.textContent = '等待授权中…';
        // 设备码一到手就直接用内置浏览器打开授权页，省掉「再去点一次按钮」。
        // 只开一次：回调可能因为轮询状态多次触发，不能每次都重新导航。
        if (!autoOpened && info.verificationUri) {
          autoOpened = true;
          api.browserOpen(info.verificationUri);
          dcStatus.textContent = '已在内置浏览器打开授权页，输入验证码后回来等待…';
        }
      }
      if (info.status === 'waiting') {
        dcStatus.textContent = autoOpened
          ? '已在内置浏览器打开授权页，输入验证码后回来等待…'
          : '等待你在浏览器中完成授权…';
      }
    });

    dcOpen.onclick = () => {
      // 走启动器内置浏览器（persist:cmbrowser 分区），登录态能留住，也不用切到系统浏览器。
      // 已自动打开过，这里保留给用户重开 / 换页用。
      if (dcInfo && dcInfo.verificationUri) api.browserOpen(dcInfo.verificationUri);
    };
    dcCopy.onclick = () => {
      if (dcInfo && dcInfo.userCode) {
        navigator.clipboard.writeText(dcInfo.userCode).then(() => toast('验证码已复制'));
      }
    };

    try {
      state.account = await api.authMicrosoft();
      offDc();
      refreshAccounts();
      updateTopUser();
      toast(`正版登录成功：${state.account.username}`, false, { ico: '✅', desc: '欢迎回来' });
      renderAccount(page);
    } catch (e) {
      offDc();
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = '⊞ 获取登录验证码';
      dcStatus.textContent = '登录失败：' + e.message;
      dcStatus.style.color = '#fca5a5';
    }
  };

  const ss = $('skin-station');
  (state.config.skinStations || []).forEach((s) => {
    const o = ce('option');
    o.value = s.authUrl;
    o.textContent = s.name;
    ss.appendChild(o);
  });
  const updateSkinUrlField = () => {
    $('skin-url-field').style.display = ss.value ? 'none' : 'block';
  };
  ss.onchange = updateSkinUrlField;
  updateSkinUrlField();

  $('skin-login').onclick = async () => {
    const baseUrl = ss.value || $('skin-url').value.trim();
    const username = $('skin-user').value.trim();
    const password = $('skin-pass').value;
    if (!baseUrl) return toast('请填写皮肤站地址', true);
    if (!username || !password) return toast('请输入用户名和密码', true);
    try {
      state.account = await api.authYggdrasil({ baseUrl, username, password });
      refreshAccounts();
      updateTopUser();
      toast(`皮肤站登录成功：${state.account.username}`, false, { ico: '✅', desc: '欢迎回来' });
      renderAccount(page);
    } catch (e) { toast(e.message, true); }
  };
}

/* ========== 皮肤中心 ========== */

let skinPicked = null;      // { path, dataUrl, name }
let skinVariant = 'classic';
let skinLibPage = 1;

/** 皮肤站配置 → 站点根地址（用于浏览皮肤库） */
function stationRoot(s) {
  const u = String((s && s.authUrl) || '');
  if (/littleservice|mcskin|littleskin/i.test(u)) return 'https://littleskin.cn';
  return u.replace(/\/api\/yggdrasil\/?$/i, '').replace(/\/+$/, '') || 'https://littleskin.cn';
}

function skinPreviewCard(imgUrl, title, sub, buttons) {
  return `
    <div class="skin-cell">
      <div class="skin-thumb"><img src="${escapeHtml(imgUrl)}" alt="" loading="lazy" onerror="this.classList.add('bad')"></div>
      <div class="skin-meta">
        <div class="skin-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <div class="skin-sub">${escapeHtml(sub || '')}</div>
      </div>
      <div class="skin-acts">${buttons || ''}</div>
    </div>`;
}

/* ---------- 本地皮肤渲染：直接读皮肤纹理画头像 / 全身，用的就是「我们的皮肤」 ---------- */
// 纹理里的部位坐标（原版 64x32 / 64x64 通用；左臂左腿只有 64x64 才自带，否则镜像右臂右腿）
const SKIN_UV = {
  headFront: [8, 8, 8, 8], headOver: [40, 8, 8, 8],
  bodyFront: [20, 20, 8, 12], bodyOver: [20, 36, 8, 12],
  armR: [44, 20, 4, 12], armROver: [44, 36, 4, 12],
  armL: [36, 52, 4, 12], armLOver: [52, 52, 4, 12],
  legR: [4, 20, 4, 12], legROver: [4, 36, 4, 12],
  legL: [20, 52, 4, 12], legLOver: [4, 52, 4, 12],
};

function skinImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('皮肤纹理加载失败'));
    im.src = src;
  });
}

/** 把纹理里的一块画到 canvas；关闭平滑保持像素感，mirror 用于旧版皮肤镜像左肢 */
function paintSkinRect(ctx, im, [sx, sy, sw, sh], dx, dy, dw, dh, mirror) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (mirror) {
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(im, sx, sy, sw, sh, 0, 0, dw, dh);
  } else {
    ctx.drawImage(im, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  ctx.restore();
}

/** 头像：正脸 + 帽子叠加层 */
function paintSkinHead(cv, im) {
  const ctx = cv.getContext('2d');
  const S = cv.width;
  ctx.clearRect(0, 0, cv.width, cv.height);
  paintSkinRect(ctx, im, SKIN_UV.headFront, 0, 0, S, S);
  paintSkinRect(ctx, im, SKIN_UV.headOver, 0, 0, S, S);
}

/**
 * 全身：正面「纸娃娃」。横向 16 格、纵向 32 格（头 8×8、躯干 8×12、臂 4×12、腿 4×12），
 * 等比放大后逐块贴纹理，最后叠上帽子/外套/袖子/裤腿层。
 */
function paintSkinBody(cv, im, model) {
  const ctx = cv.getContext('2d');
  const u = cv.height / 32;
  const modern = (im.naturalHeight || im.height) >= 64;
  const aw = model === 'slim' ? 3 : 4;      // 纤细模型的手臂是 3 格宽
  ctx.clearRect(0, 0, cv.width, cv.height);
  const put = (part, x, y, w, h, mirror) => paintSkinRect(ctx, im, part, x * u, y * u, w * u, h * u, mirror);

  // 本体
  put(SKIN_UV.headFront, 4, 0, 8, 8);
  put(SKIN_UV.bodyFront, 4, 8, 8, 12);
  put(SKIN_UV.armR, 4 - aw, 8, aw, 12);
  put(modern ? SKIN_UV.armL : SKIN_UV.armR, 12, 8, aw, 12, !modern);
  put(SKIN_UV.legR, 4, 20, 4, 12);
  put(modern ? SKIN_UV.legL : SKIN_UV.legR, 8, 20, 4, 12, !modern);
  // 叠加层
  put(SKIN_UV.headOver, 4, 0, 8, 8);
  put(SKIN_UV.bodyOver, 4, 8, 8, 12);
  put(SKIN_UV.armROver, 4 - aw, 8, aw, 12);
  put(modern ? SKIN_UV.armLOver : SKIN_UV.armROver, 12, 8, aw, 12, !modern);
  put(SKIN_UV.legROver, 4, 20, 4, 12);
  put(modern ? SKIN_UV.legLOver : SKIN_UV.legROver, 8, 20, 4, 12, !modern);
}

/** 用一段纹理（dataURL / 图片地址）重画头像与全身，界面上一有变化就调它 */
async function paintSkinFrom(src, model) {
  const head = $('skin-head');
  const body = $('skin-body');
  if (!head || !body || !head.isConnected) return false;
  const im = await skinImage(src);
  if (!head.isConnected) return false;
  paintSkinHead(head, im);
  paintSkinBody(body, im, model || 'classic');
  return true;
}

/** 取不到纹理时画个灰底占位，别留空白 */
function paintSkinPlaceholder() {
  for (const cv of [$('skin-head'), $('skin-body')]) {
    if (!cv || !cv.isConnected) continue;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(148,163,184,0.22)';
    ctx.fillRect(0, 0, cv.width, cv.height);
  }
}

function renderSkins(page) {
  if (state.config && state.config.skinVariant) skinVariant = state.config.skinVariant;
  const acc = state.account;
  const name = acc ? acc.username : 'Steve';
  const uuid = acc ? (acc.uuid || '') : '';
  const isMs = !!(acc && acc.type === 'microsoft');

  const stations = state.config.skinStations || [];

  page.innerHTML = `
    <div class="page-title">皮肤中心</div>
    <div class="page-sub">更换皮肤 · 按玩家 ID 扒皮肤 · 浏览皮肤站公开皮肤库</div>

    <div class="grid-2" style="grid-template-columns:300px 1fr;align-items:start">
      <div>
        <div class="panel" style="padding:26px;text-align:center">
          <div style="display:flex;justify-content:center;gap:22px;align-items:flex-end;margin-bottom:14px">
            <div>
              <canvas id="skin-head" class="skin-head-canvas" width="96" height="96"></canvas>
              <div style="font-size:11px;color:var(--text-dim);margin-top:8px">头像</div>
            </div>
            <div>
              <canvas id="skin-body" class="skin-body-canvas" width="96" height="192"></canvas>
              <div style="font-size:11px;color:var(--text-dim);margin-top:8px">全身</div>
            </div>
          </div>
          <div style="font-size:15px;font-weight:800">${escapeHtml(name)}</div>
          <div style="font-size:12px;color:var(--text-dim);margin-top:4px">${acc ? (isMs ? '微软正版' : acc.type === 'yggdrasil' ? '外置皮肤站' : '离线账号') : '未登录'}</div>
          <div class="hint-text" id="skin-src" style="margin-top:8px">正在读取当前皮肤…</div>
          <button class="btn sm" id="skin-src-reset" type="button" style="display:none;margin-top:8px">用回当前皮肤</button>
        </div>

        <div class="panel" style="padding:18px;margin-top:16px">
          <div class="section-title">最近使用</div>
          <div class="hint-text" style="margin-bottom:10px">点皮肤或「使用」即可立刻换上，每个账号各记各的</div>
          <div id="skin-hist" class="skin-grid"><div class="hint-text">加载中…</div></div>
        </div>

        <div class="panel" style="padding:18px;margin-top:16px">
          <div class="section-title">本地皮肤库</div>
          <div id="skin-local" class="skin-grid"><div class="hint-text">加载中…</div></div>
        </div>
      </div>

      <div>
        <div class="panel" style="padding:22px;margin-bottom:16px">
          <div class="section-title">更换皮肤</div>
          <div class="row" style="flex-wrap:wrap;gap:10px;margin-bottom:14px">
            <button class="btn" id="skin-pick" type="button">选择皮肤文件 (.png)</button>
            <select class="input" id="skin-variant" style="width:168px">
              <option value="classic" ${skinVariant === 'classic' ? 'selected' : ''}>经典模型（Steve）</option>
              <option value="slim" ${skinVariant === 'slim' ? 'selected' : ''}>纤细模型（Alex）</option>
            </select>
            <button class="btn primary" id="skin-upload-ms" type="button">上传到微软正版</button>
            <button class="btn primary" id="skin-upload-ys" type="button">上传到皮肤站</button>
          </div>
          <div id="skin-preview">${skinPicked && skinPicked.dataUrl
            ? skinPreviewCard(skinPicked.dataUrl, skinPicked.name || '已选皮肤', '待上传 · 尺寸已校验')
            : '<div class="hint-text">未选择文件。上传到微软需要正版账号，上传到皮肤站需要皮肤站账号。</div>'}</div>
        </div>

        <div class="panel" style="padding:22px;margin-bottom:16px">
          <div class="section-title">按玩家 ID 扒皮肤</div>
          <div class="row" style="gap:10px;margin-bottom:10px">
            <input class="input" id="skin-query" placeholder="输入正版玩家 ID，例如 Notch" style="flex:1">
            <button class="btn primary" id="skin-fetch" type="button">查询</button>
          </div>
          <div class="hint-text" style="margin-bottom:10px">通过 Mojang 官方接口读取该玩家的皮肤与披风，可保存到本地皮肤库</div>
          <div id="skin-fetched" class="skin-grid"></div>
        </div>

        <div class="panel" style="padding:22px">
          <div class="section-title">皮肤站皮肤库</div>
          <div class="row" style="gap:10px;margin-bottom:12px;flex-wrap:wrap">
            <select class="input" id="skin-station" style="width:200px">
              ${stations.map((s) => `<option value="${escapeHtml(stationRoot(s))}">${escapeHtml(s.name)}</option>`).join('')
                || '<option value="https://littleskin.cn">LittleSkin</option>'}
            </select>
            <input class="input" id="skin-lib-query" placeholder="关键词（可留空）" style="flex:1;min-width:160px">
            <button class="btn primary" id="skin-lib-go" type="button">浏览</button>
            <button class="btn" id="skin-lib-prev" type="button">上一页</button>
            <button class="btn" id="skin-lib-next" type="button">下一页</button>
          </div>
          <div id="skin-lib" class="skin-grid"><div class="hint-text">点「浏览」加载皮肤站公开皮肤库，点缩略图即可保存到本地</div></div>
        </div>
      </div>
    </div>
  `;

  /* ---------- 头像 / 全身：本地渲染「我们的皮肤」 ---------- */
  // 纹理来源优先级：挑选中的 → 账号在服务器上的实时皮肤 → 本地皮肤库最新一张 → 按 ID 取在线纹理
  async function resolveMySkin() {
    if (skinPicked && skinPicked.dataUrl) return { src: skinPicked.dataUrl, model: skinVariant, from: '挑选中' };
    try {
      const r = await api.skinCurrent();
      if (r && r.dataUrl) return { src: r.dataUrl, model: r.model || skinVariant, from: '账号实时皮肤' };
    } catch { /* 没登录或网络不通，继续往下退 */ }
    try {
      const list = await api.skinLocalList();
      if (list && list.length && list[0].dataUrl) return { src: list[0].dataUrl, model: skinVariant, from: '本地皮肤库' };
    } catch { /* 忽略 */ }
    const src = isMs && uuid
      ? `https://crafatar.com/skins/${uuid.replace(/-/g, '')}`
      : `https://minotar.net/skin/${encodeURIComponent(name || 'Steve')}`;
    return { src, model: skinVariant, from: '在线纹理' };
  }

  const setSkinTip = (text, showReset) => {
    const tip = $('skin-src');
    const rst = $('skin-src-reset');
    if (tip && tip.isConnected) tip.textContent = text;
    if (rst && rst.isConnected) rst.style.display = showReset ? '' : 'none';
  };

  // 实时刷新头像 / 全身，皮肤一变就调它
  const refreshSkinPreview = async () => {
    try {
      const r = await resolveMySkin();
      const ok = await paintSkinFrom(r.src, r.model);
      if (ok) setSkinTip(skinPicked ? '预览：挑选中的皮肤' : `来源：${r.from}`, !!skinPicked);
    } catch {
      paintSkinPlaceholder();
      setSkinTip('暂时取不到皮肤纹理', !!skinPicked);
    }
  };
  refreshSkinPreview();

  const srcReset = $('skin-src-reset');
  if (srcReset) srcReset.onclick = () => { skinPicked = null; refreshSkinPreview(); };

  /* ---------- 选择文件 ---------- */
  $('skin-pick').onclick = async () => {
    const f = await api.pickFile([{ name: '皮肤文件', extensions: ['png'] }]);
    if (!f) return;
    try {
      const r = await api.skinReadLocal(f);
      skinPicked = { path: f, dataUrl: r.dataUrl, name: r.name };
      $('skin-preview').innerHTML = skinPreviewCard(r.dataUrl, skinPicked.name, `已选 · ${r.dim.w}×${r.dim.h}`);
      refreshSkinPreview();
    } catch (e) {
      toast('读取皮肤失败：' + e.message, true);
    }
  };

  $('skin-variant').onchange = () => {
    skinVariant = $('skin-variant').value;
    api.configSet('skinVariant', skinVariant);
    refreshSkinPreview();
  };

  $('skin-upload-ms').onclick = async () => {
    if (!skinPicked) return toast('请先选择皮肤文件', true);
    if (!isMs) return toast('请先登录微软正版账号', true);
    showLoading('正在上传到微软…');
    try {
      await api.skinUploadOfficial(skinPicked.path, skinVariant);
      skinPicked = null;
      refreshSkinPreview();          // 上传成功后立刻按服务器的实时皮肤重画
      resetAccountHead();            // 顶栏那头像也要跟着换
      toast('皮肤已上传，游戏内稍后生效');
    } catch (e) {
      toast('上传失败：' + e.message, true);
    } finally {
      hideLoading();
    }
  };

  $('skin-upload-ys').onclick = async () => {
    if (!skinPicked) return toast('请先选择皮肤文件', true);
    if (!acc || acc.type !== 'yggdrasil') return toast('请先用皮肤站账号登录', true);
    showLoading('正在上传到皮肤站…');
    try {
      await api.skinUploadYggdrasil(skinPicked.path, skinVariant);
      skinPicked = null;
      refreshSkinPreview();          // 上传成功后立刻按皮肤站的实时皮肤重画
      resetAccountHead();            // 顶栏那头像也要跟着换
      toast('皮肤已上传到皮肤站');
    } catch (e) {
      toast('上传失败：' + e.message, true);
    } finally {
      hideLoading();
    }
  };

  /* ---------- 扒皮肤 ---------- */
  $('skin-fetch').onclick = async () => {
    const q = $('skin-query').value.trim();
    if (!q) return toast('请输入玩家 ID', true);
    const box = $('skin-fetched');
    box.innerHTML = '<div class="hint-text">查询中…</div>';
    try {
      const info = await api.skinOfficial(q);
      if (!box.isConnected) return;
      box.innerHTML = skinPreviewCard(
        info.skinUrl,
        info.name || q,
        `${info.uuid.slice(0, 8)}… · ${info.model === 'slim' ? '纤细模型' : '经典模型'}${info.capeUrl ? ' · 有披风' : ''}`,
        `<button class="btn sm" data-save-skin="${escapeHtml(info.skinUrl)}" data-label="${escapeHtml(info.name || q)}">保存皮肤</button>
         ${info.capeUrl ? `<button class="btn sm" data-save-skin="${escapeHtml(info.capeUrl)}" data-label="${escapeHtml((info.name || q) + '-cape')}">保存披风</button>` : ''}`,
      );
      box.querySelectorAll('[data-save-skin]').forEach((b) => {
        b.onclick = async () => {
          showLoading('正在保存…');
          try {
            await api.skinDownload(b.dataset.saveSkin, b.dataset.label);
            toast('已保存到本地皮肤库');
            loadLocalSkins();
          } catch (e) {
            toast('保存失败：' + e.message, true);
          } finally {
            hideLoading();
          }
        };
      });
    } catch (e) {
      if (box.isConnected) box.innerHTML = `<div class="hint-text">${escapeHtml(e.message)}</div>`;
    }
  };

  /* ---------- 皮肤库浏览 ---------- */
  const libBox = $('skin-lib');

  const loadLibrary = async (page) => {
    const root = $('skin-station').value;
    const q = $('skin-lib-query').value.trim();
    skinLibPage = Math.max(1, page);
    libBox.innerHTML = '<div class="hint-text">加载中…</div>';
    try {
      const res = await api.skinLibrary(root, q, skinLibPage);
      if (!libBox.isConnected) return;
      if (!res.items.length) {
        libBox.innerHTML = '<div class="hint-text">没有解析到皮肤（该站皮肤库可能需要登录，或页面结构不同）</div>';
        return;
      }
      libBox.innerHTML = res.items.map((it) => skinPreviewCard(
        it.url,
        it.hash.slice(0, 10),
        '点击保存到本地',
        `<button class="btn sm" data-save-skin="${escapeHtml(it.url)}" data-label="lib-${it.hash.slice(0, 8)}">保存</button>`,
      )).join('');
      libBox.querySelectorAll('[data-save-skin]').forEach((b) => {
        b.onclick = async () => {
          showLoading('正在保存…');
          try {
            await api.skinDownload(b.dataset.saveSkin, b.dataset.label);
            toast('已保存到本地皮肤库');
            loadLocalSkins();
          } catch (e) {
            toast('保存失败：' + e.message, true);
          } finally {
            hideLoading();
          }
        };
      });
    } catch (e) {
      if (libBox.isConnected) libBox.innerHTML = `<div class="hint-text">${escapeHtml(e.message)}</div>`;
    }
  };

  $('skin-lib-go').onclick = () => loadLibrary(1);
  $('skin-lib-prev').onclick = () => loadLibrary(Math.max(1, skinLibPage - 1));
  $('skin-lib-next').onclick = () => loadLibrary(skinLibPage + 1);

  /* ---------- 最近使用 ---------- */
  // 「使用」动作：最近使用区与本地皮肤库共用
  function bindUseSkin(scope) {
    scope.querySelectorAll('[data-use-skin]').forEach((b) => {
      b.onclick = async () => {
        showLoading('正在切换皮肤…');
        try {
          await api.skinUse(b.dataset.useSkin);
          skinPicked = null;               // 清掉待上传预览，避免预览仍停在旧选择
          await refreshSkinPreview();
          resetAccountHead();              // 顶栏头像立刻换
          toast('已切换皮肤');
          loadHistory();
        } catch (e) {
          toast('切换失败：' + e.message, true);
        } finally {
          hideLoading();
        }
      };
    });
  }

  async function loadHistory() {
    const box = $('skin-hist');
    if (!box) return;
    try {
      const list = await api.skinHistory();
      if (!box.isConnected) return;
      if (!list.length) { box.innerHTML = '<div class="hint-text">还没有用过的皮肤</div>'; return; }
      box.innerHTML = list.map((s) => skinPreviewCard(
        s.dataUrl || '',
        s.name,
        timeAgo(s.t),
        `<button class="btn sm primary" data-use-skin="${escapeHtml(s.path)}">使用</button>`,
      )).join('');
      bindUseSkin(box);
      // 点缩略图本身也能直接换，不用非得瞄准小按钮
      box.querySelectorAll('.skin-cell').forEach((cell) => {
        const btn = cell.querySelector('[data-use-skin]');
        const thumb = cell.querySelector('.skin-thumb');
        if (thumb && btn) { thumb.style.cursor = 'pointer'; thumb.onclick = () => btn.click(); }
      });
    } catch (e) {
      if (box.isConnected) box.innerHTML = `<div class="hint-text">${escapeHtml(e.message)}</div>`;
    }
  }

  async function loadLocalSkins() {
    const box = $('skin-local');
    if (!box) return;
    try {
      const list = await api.skinLocalList();
      if (!box.isConnected) return;
      if (!list.length) { box.innerHTML = '<div class="hint-text">还没有保存过皮肤</div>'; return; }
      box.innerHTML = list.slice(0, 12).map((s) => skinPreviewCard(
        s.dataUrl || '',
        s.name,
        `${formatSize(s.size)} · ${timeAgo(s.mtime)}`,
        `<button class="btn sm primary" data-use-skin="${escapeHtml(s.path)}">使用</button>
         <button class="btn sm" data-use="${escapeHtml(s.path)}">用作待上传</button>
         <button class="btn sm danger" data-del="${escapeHtml(s.name)}">删除</button>`,
      )).join('');
      box.querySelectorAll('[data-use]').forEach((b) => {
        b.onclick = async () => {
          const target = list.find((x) => x.path === b.dataset.use);
          if (!target) return;
          skinPicked = { path: target.path, dataUrl: target.dataUrl, name: target.name };
          $('skin-preview').innerHTML = skinPreviewCard(target.dataUrl, target.name, '已选 · 可直接上传');
          refreshSkinPreview();
          toast('已设为待上传皮肤');
        };
      });
      box.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = async () => {
          try {
            await api.skinLocalDelete(b.dataset.del);
            toast('已删除');
            loadLocalSkins();
          } catch (e) {
            toast('删除失败：' + e.message, true);
          }
        };
      });
      bindUseSkin(box);
    } catch (e) {
      if (box.isConnected) box.innerHTML = `<div class="hint-text">${escapeHtml(e.message)}</div>`;
    }
  }

  loadLocalSkins();
  loadHistory();
}

/* ========== 下载与日志 ========== */

let dlTab = 'queue';
let logLines = [];          // { level, message, time }
const LOG_MAX = 3000;
let logAutoScroll = true;

const DL_KINDS = {
  mod: { label: '模组', ico: '🧩' },
  modpack: { label: '整合包', ico: '🗃️' },
  resourcepack: { label: '资源包', ico: '🎨' },
  shaderpack: { label: '光影', ico: '✨' },
  world: { label: '世界', ico: '🌍' },
  curseforge: { label: 'CurseForge', ico: '🔥' },
  file: { label: '文件', ico: '📄' },
};

function dlKind(k) {
  return DL_KINDS[k] || { label: k || '文件', ico: '📄' };
}

function pushLog(entry) {
  logLines.push(entry);
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  const box = $('log-stream');
  if (box && box.isConnected) {
    const line = ce('div', `log-line lv-${entry.level}`);
    const t = new Date(entry.time);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    line.innerHTML = `<span class="log-time">${hh}:${mm}:${ss}</span><span class="log-msg">${escapeHtml(entry.message)}</span>`;
    box.appendChild(line);
    while (box.childElementCount > LOG_MAX) box.removeChild(box.firstElementChild);
    if (logAutoScroll) box.scrollTop = box.scrollHeight;
  }
}

function dlStatusText(t) {
  if (t.status === 'queued') return '排队中…';
  if (t.status === 'running') {
    return t.total
      ? `${t.percent}% · ${formatSize(t.received)} / ${formatSize(t.total)}${t.speed ? ' · ' + formatSize(t.speed) + '/s' : ''}`
      : '下载中…';
  }
  if (t.status === 'done') return `已完成${t.total ? ' · ' + formatSize(t.total) : ''}`;
  if (t.status === 'cancelled') return '已取消';
  return `失败 · ${t.error || '未知错误'}`;
}

function renderDownloads(page) {
  page.innerHTML = `
    <div class="page-title">下载与日志</div>
    <div class="page-sub">下载任务队列 · 运行日志实时查看</div>
    <div class="cat-bar glass" id="dl-bar">
      <button class="cat-tab ${dlTab === 'queue' ? 'active' : ''}" data-dl="queue" type="button"><span class="cat-ico">⇩</span><span>下载队列</span></button>
      <button class="cat-tab ${dlTab === 'log' ? 'active' : ''}" data-dl="log" type="button"><span class="cat-ico">📜</span><span>运行日志</span></button>
    </div>
    <div id="dl-body"></div>
  `;
  page.querySelectorAll('[data-dl]').forEach((b) => {
    b.onclick = () => { dlTab = b.dataset.dl; renderDownloads(page); };
  });
  (dlTab === 'queue' ? drawDownloadQueue : drawLogViewer)($('dl-body'));
}

async function drawDownloadQueue(body) {
  body.innerHTML = `
    <div class="row" style="margin-bottom:14px;flex-wrap:wrap;gap:10px">
      <input class="input" id="dl-url" placeholder="粘贴直链 URL 添加到下载队列" style="flex:1;min-width:260px">
      <button class="btn primary" id="dl-add" type="button">添加下载</button>
      <button class="btn" id="dl-clear" type="button">清除已完成</button>
      <button class="btn" id="dl-dir" type="button">打开下载目录</button>
    </div>
    <div class="dl-list" id="dl-list"></div>
  `;

  const list = $('dl-list');
  const render = (tasks) => {
    if (!list.isConnected) return;
    if (!tasks.length) {
      list.innerHTML = '<div class="empty-tip">队列为空。搜索页下载的模组 / 整合包会自动出现在这里。</div>';
      return;
    }
    list.innerHTML = tasks.map((t) => {
      const k = dlKind(t.kind);
      const prog = t.status === 'done' ? 100 : (t.percent || 0);
      const acts = [];
      if (t.status === 'running' || t.status === 'queued') acts.push(`<button class="btn sm" data-act="cancel" data-id="${t.id}">取消</button>`);
      if (t.status === 'failed' || t.status === 'cancelled') acts.push(`<button class="btn sm primary" data-act="retry" data-id="${t.id}">重试</button>`);
      if (t.status === 'done' && t.dest) acts.push(`<button class="btn sm" data-act="open" data-id="${t.id}">打开</button>`);
      if (t.finishedAt) acts.push(`<button class="btn sm danger" data-act="remove" data-id="${t.id}">移除</button>`);
      return `
        <div class="dl-row st-${t.status}">
          <div class="dl-ico">${k.ico}</div>
          <div class="dl-info">
            <div class="dl-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>
            <div class="dl-bar"><i style="width:${prog}%"></i></div>
            <div class="dl-meta">${escapeHtml(dlStatusText(t))} · ${k.label} · ${timeAgo(t.addedAt)}</div>
          </div>
          <div class="dl-acts">${acts.join('')}</div>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.id;
        const task = tasks.find((x) => x.id === id);
        try {
          if (b.dataset.act === 'cancel') await api.downloadsCancel(id);
          else if (b.dataset.act === 'retry') await api.downloadsRetry(id);
          else if (b.dataset.act === 'remove') await api.downloadsRemove(id);
          else if (b.dataset.act === 'open' && task && task.dest) await api.openPath(task.dest);
          render(await api.downloadsList());
        } catch (e) {
          toast(e.message, true);
        }
      };
    });
  };

  render(await api.downloadsList());

  $('dl-add').onclick = async () => {
    const url = $('dl-url').value.trim();
    if (!/^https?:\/\//i.test(url)) return toast('请输入 http/https 直链', true);
    try {
      await api.downloadsAdd({ url, kind: 'file' });
      $('dl-url').value = '';
      toast('已加入下载队列');
    } catch (e) { toast(e.message, true); }
  };
  $('dl-clear').onclick = async () => { await api.downloadsClear(); render(await api.downloadsList()); };
  $('dl-dir').onclick = () => api.downloadsOpenDir();

  // 主进程推送进度时局部刷新
  api.onDownloadsChanged((tasks) => render(tasks));
}

async function drawLogViewer(body) {
  body.innerHTML = `
    <div class="row" style="margin-bottom:12px;flex-wrap:wrap;gap:10px">
      <select class="input" id="log-level" style="width:130px">
        <option value="">全部级别</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
      <input class="input" id="log-filter" placeholder="过滤关键词，例如 crash / mods" style="flex:1;min-width:200px">
      <button class="btn" id="log-scroll" type="button">自动滚动：${logAutoScroll ? '开' : '关'}</button>
      <button class="btn" id="log-copy" type="button">复制全部</button>
      <button class="btn danger" id="log-clear" type="button">清屏</button>
    </div>
    <div class="log-stream" id="log-stream"></div>
  `;

  const box = $('log-stream');
  const repaint = () => {
    if (!box.isConnected) return;
    const lv = $('log-level').value;
    const kw = $('log-filter').value.trim().toLowerCase();
    const rows = logLines.filter((l) => (!lv || l.level === lv) && (!kw || l.message.toLowerCase().includes(kw)));
    box.innerHTML = rows.length
      ? rows.map((l) => {
        const t = new Date(l.time);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const ss = String(t.getSeconds()).padStart(2, '0');
        return `<div class="log-line lv-${l.level}"><span class="log-time">${hh}:${mm}:${ss}</span><span class="log-msg">${escapeHtml(l.message)}</span></div>`;
      }).join('')
      : '<div class="empty-tip">暂无日志。启动游戏或执行下载后可在这里看到实时输出。</div>';
    if (logAutoScroll) box.scrollTop = box.scrollHeight;
  };

  if (!logLines.length) {
    try {
      logLines = (await api.logHistory()).map((e) => ({ level: e.level, message: e.message, time: e.time }));
      if (!box.isConnected) return;
    } catch { /* 忽略 */ }
  }
  repaint();

  $('log-level').onchange = repaint;
  $('log-filter').oninput = repaint;
  $('log-scroll').onclick = () => {
    logAutoScroll = !logAutoScroll;
    $('log-scroll').textContent = `自动滚动：${logAutoScroll ? '开' : '关'}`;
    if (logAutoScroll && box.isConnected) box.scrollTop = box.scrollHeight;
  };
  $('log-copy').onclick = async () => {
    const text = logLines.map((l) => `[${l.level}] ${l.message}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('日志已复制到剪贴板');
    } catch { toast('复制失败', true); }
  };
  $('log-clear').onclick = () => { logLines = []; repaint(); };
}

/* ========== Axolotl 实验室 ========== */

const LAB_TABS = [
  { id: 'gradient', name: '渐变文字', ico: '🌈' },
  { id: 'seed', name: '种子地图', ico: '🗺' },
  { id: 'schematic', name: '投影工坊', ico: '📐' },
  { id: 'recipe', name: '配方生成器', ico: '📜' },
  { id: 'translate', name: '模组汉化', ico: '🌐' },
];

let labTab = 'gradient';

function renderLab(page) {
  page.innerHTML = `
    <div class="page-title">Axolotl 实验室</div>
    <div class="page-sub">内置工具箱 · 不用跳浏览器就能用的实用小工具</div>
    <div class="cat-bar glass" id="lab-bar">
      ${LAB_TABS.map((t) => `<button class="cat-tab ${t.id === labTab ? 'active' : ''}" data-lab="${t.id}" type="button"><span class="cat-ico">${t.ico}</span><span>${t.name}</span></button>`).join('')}
    </div>
    <div id="lab-body"></div>
  `;
  document.querySelectorAll('#lab-bar .cat-tab').forEach((b) => {
    b.onclick = () => {
      labTab = b.dataset.lab;
      document.querySelectorAll('#lab-bar .cat-tab').forEach((x) => x.classList.toggle('active', x === b));
      renderLabBody();
    };
  });
  renderLabBody();
}

function renderLabBody() {
  const box = $('lab-body');
  if (!box) return;
  box.innerHTML = '';
  const map = {
    gradient: renderGradientTool,
    seed: renderSeedTool,
    schematic: renderSchematicTool,
    recipe: renderRecipeTool,
    translate: renderTranslateTool,
  };
  (map[labTab] || renderGradientTool)(box);
}

/* ---------- 工具一：渐变文字 ---------- */

const LEGACY_COLORS = [
  ['0', '#000000'], ['1', '#0000AA'], ['2', '#00AA00'], ['3', '#00AAAA'],
  ['4', '#AA0000'], ['5', '#AA00AA'], ['6', '#FFAA00'], ['7', '#AAAAAA'],
  ['8', '#555555'], ['9', '#5555FF'], ['a', '#55FF55'], ['b', '#55FFFF'],
  ['c', '#FF5555'], ['d', '#FF55FF'], ['e', '#FFFF55'], ['f', '#FFFFFF'],
];

function hexToRgb(h) {
  const s = String(h).replace('#', '');
  return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
}
function hx(v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).toUpperCase().padStart(2, '0'); }
function sampleStops(stops, t) {
  if (stops.length === 1) return stops[0];
  const seg = Math.min(stops.length - 1, Math.floor(t * (stops.length - 1)));
  const localT = t * (stops.length - 1) - seg;
  const a = stops[seg];
  const b = stops[Math.min(stops.length - 1, seg + 1)];
  return [a[0] + (b[0] - a[0]) * localT, a[1] + (b[1] - a[1]) * localT, a[2] + (b[2] - a[2]) * localT];
}
function nearestLegacy(rgb) {
  let best = 'f';
  let bestD = Infinity;
  for (const [code, hex] of LEGACY_COLORS) {
    const c = hexToRgb(hex);
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestD) { bestD = d; best = code; }
  }
  return best;
}

function renderGradientTool(box) {
  box.innerHTML = `
    <div class="panel" style="padding:22px">
      <div class="section-title">渐变文字生成器</div>
      <div class="field">
        <label>文字内容</label>
        <input class="input" id="gt-text" value="BlockVibe 我的世界启动器">
      </div>
      <div class="grid-2">
        <div class="field"><label>起始颜色</label><input type="color" class="input" id="gt-c1" value="#22c55e"></div>
        <div class="field"><label>结束颜色</label><input type="color" class="input" id="gt-c2" value="#3b82f6"></div>
      </div>
      <div class="grid-2">
        <div class="field check"><label>启用中间色</label><label class="switch"><input type="checkbox" id="gt-usemid"><span class="slider"></span></label></div>
        <div class="field"><label>中间色</label><input type="color" class="input" id="gt-c3" value="#a78bfa"></div>
      </div>
      <div class="field">
        <label>输出格式</label>
        <select class="input" id="gt-mode">
          <option value="hex">十六进制逐字染色（1.16+，真渐变，推荐）</option>
          <option value="legacy">传统 § 16 色（兼容老版本）</option>
        </select>
      </div>
      <div class="preview" id="gt-preview">预览</div>
      <div class="field">
        <label>游戏内代码（粘贴到聊天框 / 告示牌 / 书）</label>
        <textarea class="input" id="gt-out" rows="2" readonly></textarea>
      </div>
      <div class="row">
        <button class="btn primary" id="gt-copy">复制代码</button>
      </div>
    </div>
  `;

  const gen = () => {
    const text = $('gt-text').value || '';
    const c1 = hexToRgb($('gt-c1').value);
    const c2 = hexToRgb($('gt-c2').value);
    const cm = hexToRgb($('gt-c3').value);
    const stops = $('gt-usemid').checked ? [c1, cm, c2] : [c1, c2];
    const mode = $('gt-mode').value;
    const chars = [...text];
    let code = '';
    for (let i = 0; i < chars.length; i++) {
      const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
      const rgb = sampleStops(stops, t);
      if (mode === 'hex' || chars[i] === ' ') {
        code += `§x§${hx(rgb[0])}§${hx(rgb[1])}§${hx(rgb[2])}${chars[i]}`;
      } else {
        code += `§${nearestLegacy(rgb)}${chars[i]}`;
      }
    }
    $('gt-out').value = code;
    const grad = `linear-gradient(90deg, ${$('gt-c1').value}, ${$('gt-usemid').checked ? `${$('gt-c3').value}, ` : ''}${$('gt-c2').value})`;
    const pv = $('gt-preview');
    pv.textContent = text;
    pv.style.background = grad;
    pv.style.webkitBackgroundClip = 'text';
    pv.style.backgroundClip = 'text';
    pv.style.color = 'transparent';
  };

  ['gt-text', 'gt-c1', 'gt-c2', 'gt-c3'].forEach((id) => { $(id).oninput = gen; });
  ['gt-usemid', 'gt-mode'].forEach((id) => { $(id).onchange = gen; });
  $('gt-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('gt-out').value); toast('已复制到剪贴板'); }
    catch { $('gt-out').select(); toast('请手动复制（Ctrl+C）'); }
  };
  gen();
}

/* ---------- 工具二：种子地图 ---------- */

// 群系 id → 中文名（id 依据 cubiomes BiomeID）
const BIOME_NAMES = {
  0: '海洋', 1: '平原', 2: '沙漠', 3: '山地', 4: '森林', 5: '针叶林', 6: '沼泽', 7: '河流',
  8: '下界荒地', 9: '末地', 10: '冻洋', 11: '冻河', 12: '雪原', 13: '雪山', 14: '蘑菇岛',
  15: '蘑菇岛岸', 16: '海滩', 17: '沙漠丘陵', 18: '繁茂丘陵', 19: '针叶林丘陵', 20: '山地边缘',
  21: '丛林', 22: '丛林丘陵', 23: '稀疏丛林', 24: '深海', 25: '石岸', 26: '积雪沙滩',
  27: '白桦林', 28: '白桦林丘陵', 29: '黑森林', 30: '积雪针叶林', 31: '积雪针叶林丘陵',
  32: '原始松木针叶林', 33: '原始云杉针叶林丘陵', 34: '繁茂山地', 35: '热带草原', 36: '热带高原',
  37: '恶地', 38: '繁茂恶地高原', 39: '恶地高原', 40: '末地小型岛屿', 41: '末地中型岛屿',
  42: '末地高地', 43: '末地荒岛', 44: '暖洋', 45: '温水海洋', 46: '冷水海洋', 47: '暖水深海',
  48: '温水深海', 49: '冷水深海', 50: '冻洋深海', 127: '虚空',
  129: '向日葵平原', 130: '沙漠湖泊', 131: '沙砾山地', 132: '繁花森林', 133: '针叶林山地',
  134: '沼泽丘陵', 140: '冰刺之地', 149: '丛林变种', 151: '稀疏丛林丘陵', 155: '原始白桦林',
  156: '原始白桦林丘陵', 157: '黑森林丘陵', 158: '积雪针叶林山地', 160: '原始云杉针叶林',
  161: '原始云杉针叶林丘陵', 162: '沙砾山地+', 163: '破碎热带草原', 164: '破碎热带高原',
  165: '风蚀恶地', 166: '繁茂恶地高原变种', 167: '恶地高原变种',
  168: '竹林', 169: '竹林丘陵', 170: '灵魂沙峡谷', 171: '绯红森林', 172: '诡异森林',
  173: '玄武岩三角洲', 174: '滴水石洞穴', 175: '繁茂洞穴', 177: '草甸', 178: '雪林',
  179: '积雪山坡', 180: '尖峭山峰', 181: '冰封山峰', 182: '裸岩山峰', 183: '深暗之域',
  184: '红树林沼泽', 185: '樱花林', 186: '苍白花园',
};

// 结构类型元信息（key 是 cubiomes StructureType 枚举整数）
const STRUCT_META = {
  1: { name: '沙漠神殿', short: '沙', color: '#e0b34c' },
  2: { name: '丛林神殿', short: '丛', color: '#57ab42' },
  3: { name: '女巫小屋', short: '巫', color: '#8a6a44' },
  4: { name: '雪屋', short: '雪', color: '#cfe3f5' },
  5: { name: '村庄', short: '村', color: '#d9a441' },
  6: { name: '海底遗迹', short: '骸', color: '#3f7db5' },
  7: { name: '沉船', short: '船', color: '#9a7444' },
  8: { name: '海底纪念碑', short: '卫', color: '#2e8b96' },
  9: { name: '林地府邸', short: '府', color: '#5b7a3f' },
  10: { name: '掠夺者前哨站', short: '哨', color: '#8c9a5b' },
  11: { name: '废弃传送门', short: '门', color: '#8d5aa8' },
  12: { name: '废弃传送门', short: '门', color: '#8d5aa8' },
  13: { name: '远古城市', short: '古', color: '#5b6ee1' },
  18: { name: '下界要塞', short: '塞', color: '#c0563b' },
  19: { name: '猪灵堡垒', short: '猪', color: '#d98c4a' },
  20: { name: '末地城', short: '末', color: '#d4af37' },
  23: { name: '古迹废墟', short: '迹', color: '#b08d57' },
  24: { name: '试炼密室', short: '试', color: '#9aa7b5' },
};

const SEED_VERSIONS = [
  '1.16.5', '1.17.1', '1.18.2', '1.19.2', '1.19.4',
  '1.20', '1.20.6', '1.21.1', '1.21.3', '1.21',
];
const DIMS = [
  { id: 0, name: '主世界' },
  { id: -1, name: '下界' },
  { id: 1, name: '末地' },
];

function renderSeedTool(box) {
  box.innerHTML = `
    <div class="panel" style="padding:22px">
      <div class="section-title">种子地图</div>
      <div class="row" style="flex-wrap:wrap;margin-bottom:12px">
        <div class="field" style="min-width:220px;flex:1;margin:0 10px 8px 0">
          <label>世界种子</label>
          <input class="input" id="sd-seed" placeholder="数字种子，例如 12345，回车生成">
        </div>
        <div class="field" style="width:130px;margin:0 10px 8px 0">
          <label>MC 版本</label>
          <select class="input" id="sd-ver">
            ${SEED_VERSIONS.map((v) => `<option${v === '1.20' ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="margin:0 10px 8px 0">
          <label>维度</label>
          <div class="row" style="gap:0;margin:0" id="sd-dims">
            ${DIMS.map((d, i) => `<button class="btn${i === 0 ? ' primary' : ''}" data-dim="${d.id}" style="border-radius:${i === 0 ? '10px 0 0 10px' : i === 2 ? '0 10px 10px 0' : '0'}">${d.name}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="row" style="flex-wrap:wrap;margin-bottom:6px">
        <button class="btn primary" id="sd-gen">生成地图</button>
        <button class="btn" id="sd-import">从存档导入种子</button>
        <button class="btn" id="sd-spawn">回到出生点</button>
        <button class="btn" id="sd-fort">定位最近要塞</button>
        <button class="btn" id="sd-toggle">隐藏结构标记</button>
      </div>
      <div id="sd-map" class="sd-map" style="position:relative">
        <canvas id="sd-canvas" style="width:100%;height:540px;display:block;border-radius:16px;cursor:grab;background:#070b14;touch-action:none"></canvas>
        <div id="sd-hud" style="position:absolute;left:12px;top:12px;background:rgba(10,15,26,.55);backdrop-filter:blur(8px);border-radius:10px;padding:6px 10px;font-size:12px;color:#cdd6e6;pointer-events:none">输入种子后生成地图</div>
        <div id="sd-tip" style="position:absolute;left:0;top:0;display:none;background:rgba(10,15,26,.82);backdrop-filter:blur(8px);border-radius:8px;padding:5px 9px;font-size:11.5px;color:#e6ecf6;pointer-events:none;white-space:nowrap"></div>
        <div class="row" style="position:absolute;right:12px;bottom:12px;margin:0;gap:6px">
          <button class="btn" id="sd-out" style="padding:4px 11px">－</button>
          <button class="btn" id="sd-in" style="padding:4px 11px">＋</button>
        </div>
      </div>
      <div id="sd-legend" class="row" style="flex-wrap:wrap;margin-top:10px"></div>
      <div class="hint-text" style="margin-top:8px">拖动平移 · 滚轮 / 按钮缩放 · 悬浮查看坐标与群系。全部结果在本地离线计算，基于 cubiomes（MIT License，© Cubitect），与游戏内生成一致。</div>
    </div>
  `;

  const canvas = $('sd-canvas');
  const ctx = canvas.getContext('2d');
  const hud = $('sd-hud');
  const tip = $('sd-tip');

  const S = {
    seed: '', ver: '1.20', dim: 0,
    ccx: 0, ccz: 0, bpp: 16,
    structs: [], strongholds: [], spawn: null,
    showStructs: true,
  };
  let reqSeq = 0;
  let frame = null; // { img, tx, tz, scale, left, top, bpp }
  const biomeCache = new Map();

  const vp = () => ({ W: canvas.clientWidth, H: canvas.clientHeight });

  function drawScene() {
    if (!frame) return;
    const { W, H } = vp();
    paint(W, H, frame.bpp, frame.left, frame.top);
  }

  /**
   * 把缓存瓦片画到指定视野（bpp/left/top 可以和取图时不同——
   * 拖动 / 滚轮时用它即时反馈，不重新请求引擎）。
   */
  function paint(W, H, bpp, left, top) {
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(W * dpr);
    const bh = Math.round(H * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, W, H);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame.img,
      (frame.tx - left) / bpp, (frame.tz - top) / bpp,
      frame.img.width * frame.scale / bpp, frame.img.height * frame.scale / bpp);

    // 区块网格（近景）与坐标轴
    if (bpp <= 16) {
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = 16;
      for (let bx = Math.ceil(left / step) * step; bx < left + W * bpp; bx += step) {
        const x = (bx - left) / bpp;
        ctx.moveTo(x, 0); ctx.lineTo(x, H);
      }
      for (let bz = Math.ceil(top / step) * step; bz < top + H * bpp; bz += step) {
        const y = (bz - top) / bpp;
        ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (0 >= left && 0 <= left + W * bpp) {
      const x = -left / bpp;
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
    if (0 >= top && 0 <= top + H * bpp) {
      const y = -top / bpp;
      ctx.moveTo(0, y); ctx.lineTo(W, y);
    }
    ctx.stroke();

    if (S.showStructs) {
      for (const p of S.structs) drawMarkerAt(p, STRUCT_META[p.type], left, top, bpp, W, H);
      for (const p of S.strongholds) drawStrongholdAt(p, left, top, bpp, W, H);
    }
    if (S.spawn) drawSpawnAt(S.spawn, left, top, bpp, W, H);
  }

  /** 用当前 S 视野即时重绘（不取新瓦片） */
  function instantView() {
    if (!frame) return;
    const { W, H } = vp();
    const left = S.ccx - W * S.bpp / 2;
    const top = S.ccz - H * S.bpp / 2;
    paint(W, H, S.bpp, left, top);
  }

  function drawMarkerAt(p, meta, left, top, bpp, W, H) {
    if (!meta) return;
    const x = (p.x - left) / bpp;
    const y = (p.z - top) / bpp;
    if (x < -12 || y < -12 || x > W + 12 || y > H + 12) return;
    const r = bpp <= 4 ? 7 : bpp <= 16 ? 5.5 : 4.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = meta.color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.stroke();
    ctx.fillStyle = '#0b101c';
    ctx.font = '600 8px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(meta.short, x, y + 0.5);
  }

  function drawStrongholdAt(p, left, top, bpp, W, H) {
    const x = (p.x - left) / bpp;
    const y = (p.z - top) / bpp;
    if (x < -14 || y < -14 || x > W + 14 || y > H + 14) return;
    const r = 7;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#c084fc';
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.lineWidth = 1;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.strokeRect(-r, -r, r * 2, r * 2);
    ctx.restore();
    ctx.fillStyle = '#1b1030';
    ctx.font = '700 9px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('S', x, y + 0.5);
  }

  function drawSpawnAt(p, left, top, bpp, W, H) {
    const x = (p.x - left) / bpp;
    const y = (p.z - top) / bpp;
    if (x < -14 || y < -14 || x > W + 14 || y > H + 14) return;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,.5)';
    ctx.stroke();
    ctx.fillStyle = '#2a1d04';
    ctx.font = '700 9px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('出', x, y + 0.5);
  }

  async function refresh() {
    if (!S.seed) return;
    const seq = ++reqSeq;
    const { W, H } = vp();
    if (!W || !H) return;
    const scale = S.bpp <= 4 ? 4 : S.bpp <= 16 ? 16 : S.bpp <= 64 ? 64 : 256;
    const left = S.ccx - W * S.bpp / 2;
    const top = S.ccz - H * S.bpp / 2;
    const tx = Math.floor(left / scale) * scale;
    const tz = Math.floor(top / scale) * scale;
    const tw = Math.min(2048, Math.ceil((left + W * S.bpp - tx) / scale) + 1);
    const th = Math.min(2048, Math.ceil((top + H * S.bpp - tz) / scale) + 1);
    const prevFrame = frame;
    hud.textContent = '渲染中…';
    try {
      const t = await api.labSeedTile({
        version: S.ver, dim: S.dim, seed: S.seed, scale, x: tx, z: tz, w: tw, h: th,
      });
      if (seq !== reqSeq) return;
      const off = document.createElement('canvas');
      off.width = tw;
      off.height = th;
      const octx = off.getContext('2d');
      const img = octx.createImageData(tw, th);
      const d = img.data;
      const px = t.pixels;
      for (let i = 0, p = 0; i < d.length; i += 4, p += 3) {
        d[i] = px[p]; d[i + 1] = px[p + 1]; d[i + 2] = px[p + 2]; d[i + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      frame = { img: off, tx, tz, scale, left, top, bpp: S.bpp };
      drawScene();
      fillHud(Math.round(S.ccx), Math.round(S.ccz), true);
    } catch (e) {
      if (seq === reqSeq) hud.textContent = prevFrame ? '' : '地图生成失败';
      toast(e.message, true);
    }

    // 当前视野内的结构
    const bx0 = Math.floor(left);
    const bz0 = Math.floor(top);
    const bx1 = Math.ceil(left + W * S.bpp);
    const bz1 = Math.ceil(top + H * S.bpp);
    try {
      const list = await api.labSeedStructs({
        version: S.ver, dim: S.dim, seed: S.seed, bx0, bz0, bx1, bz1,
      });
      if (seq !== reqSeq) return;
      S.structs = list;
      drawScene();
    } catch { /* 结构图层失败不影响底图 */ }
  }

  /**
   * 交互结束后的延迟取图：拖动 / 滚轮过程中只用旧瓦片即时重绘，
   * 停手 280ms 才向引擎请求当前视野的高清瓦片。
   */
  let settleTimer = null;
  function settleRefresh() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { refresh(); }, 280);
  }

  function curView() {
    const { W, H } = vp();
    return { W, H, left: S.ccx - W * S.bpp / 2, top: S.ccz - H * S.bpp / 2, bpp: S.bpp };
  }

  async function loadWorldMarkers() {
    S.strongholds = [];
    S.spawn = null;
    if (S.dim !== 0) return;
    try {
      const [sh, sp] = await Promise.all([
        api.labSeedStrongholds({ version: S.ver, seed: S.seed }),
        api.labSeedSpawn({ version: S.ver, seed: S.seed }),
      ]);
      S.strongholds = sh;
      S.spawn = sp;
    } catch { /* 标记缺失不影响地图 */ }
  }

  async function applySeed() {
    const seed = $('sd-seed').value.trim();
    if (!seed) { toast('请填写世界种子', true); return; }
    S.seed = seed;
    S.ver = $('sd-ver').value;
    S.structs = [];
    biomeCache.clear();
    frame = null;
    hud.textContent = '定位出生点…';
    await loadWorldMarkers();
    if (S.spawn) { S.ccx = S.spawn.x; S.ccz = S.spawn.z; }
    else { S.ccx = 0; S.ccz = 0; }
    S.bpp = 16;
    renderLegend();
    refresh();
  }

  function renderLegend() {
    const ids = S.dim === 0
      ? [5, 1, 2, 3, 4, 8, 6, 7, 9, 10, 11, 13, 23, 24]
      : S.dim === -1
        ? [18, 19, 11]
        : [20];
    $('sd-legend').innerHTML = ids.map((id) => {
      const m = STRUCT_META[id];
      return `<span style="display:inline-flex;align-items:center;font-size:11.5px;color:var(--text-dim);margin:0 12px 4px 0">
        <span style="width:9px;height:9px;border-radius:50%;background:${m.color};margin-right:6px"></span>${m.name}
      </span>`;
    }).join('') + `<span style="display:inline-flex;align-items:center;font-size:11.5px;color:var(--text-dim);margin:0 12px 4px 0">
        <span style="width:9px;height:9px;border-radius:2px;background:#c084fc;margin-right:6px;transform:rotate(45deg)"></span>要塞
      </span><span style="display:inline-flex;align-items:center;font-size:11.5px;color:var(--text-dim);margin:0 12px 4px 0">
        <span style="width:9px;height:9px;border-radius:50%;background:#fbbf24;margin-right:6px"></span>出生点
      </span>`;
  }

  /* ---- 交互：拖动 ---- */
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (dragging) {
      S.ccx -= (e.clientX - lastX) * S.bpp;
      S.ccz -= (e.clientY - lastY) * S.bpp;
      lastX = e.clientX;
      lastY = e.clientY;
      instantView();
      return;
    }
    if (!frame) return;
    const v = curView();
    const bx = Math.floor(v.left + mx * v.bpp);
    const bz = Math.floor(v.top + my * v.bpp);

    // 附近的结构点 → 浮层提示
    let near = null;
    if (S.showStructs) {
      let bestD = 14;
      const check = (p, name) => {
        const sx = (p.x - v.left) / v.bpp;
        const sy = (p.z - v.top) / v.bpp;
        const d = Math.hypot(sx - mx, sy - my);
        if (d < bestD) { bestD = d; near = { name, x: p.x, z: p.z }; }
      };
      for (const p of S.structs) {
        const m = STRUCT_META[p.type];
        if (m) check(p, m.name);
      }
      for (const p of S.strongholds) check(p, '要塞');
      if (S.spawn) check(S.spawn, '出生点');
    }
    if (near) {
      tip.style.display = 'block';
      tip.textContent = `${near.name}　X ${near.x}　Z ${near.z}`;
      tip.style.left = `${Math.min(mx + 14, rect.width - 150)}px`;
      tip.style.top = `${my + 16}px`;
    } else {
      tip.style.display = 'none';
    }

    fillHud(bx, bz, false);
  });

  /** 更新坐标/群系 HUD；缺群系时异步查一次并缓存 */
  let lastHudKey = '';
  function hudLine(bx, bz, id) {
    const name = id === undefined ? '群系读取中…' : (BIOME_NAMES[id] || ('群系#' + id));
    return `X ${bx}　Z ${bz}　·　${name}　·　每像素 ${S.bpp} 格`;
  }
  async function queryBiome(bx, bz) {
    const key = `${bx},${bz}`;
    try {
      const id = await api.labSeedBiome({
        version: S.ver, dim: S.dim, seed: S.seed, x: bx, z: bz,
      });
      biomeCache.set(key, id);
      if (lastHudKey === key) hud.textContent = hudLine(bx, bz, id);
    } catch { /* ignore */ }
  }
  function fillHud(bx, bz, instant) {
    const key = `${bx},${bz}`;
    lastHudKey = key;
    const cachedId = biomeCache.get(key);
    hud.textContent = hudLine(bx, bz, cachedId);
    if (cachedId !== undefined) return;
    if (instant) { queryBiome(bx, bz); return; }
    clearTimeout(canvas._bioTimer);
    canvas._bioTimer = setTimeout(() => {
      if (!biomeCache.has(key)) queryBiome(bx, bz);
    }, 120);
  }
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = 'grab';
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    settleRefresh();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* ---- 交互：滚轮缩放（以鼠标位置为锚点） ---- */
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!frame) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const v = curView();
    const blockX = v.left + mx * v.bpp;
    const blockZ = v.top + my * v.bpp;
    const nb = Math.max(2, Math.min(512, v.bpp * Math.exp(e.deltaY * 0.0014)));
    S.bpp = nb;
    S.ccx = blockX - mx * nb + rect.width * nb / 2;
    S.ccz = blockZ - my * nb + rect.height * nb / 2;
    instantView();
    settleRefresh();
  }, { passive: false });

  function zoomBy(f) {
    S.bpp = Math.max(2, Math.min(512, S.bpp * f));
    instantView();
    settleRefresh();
  }

  /* ---- 按钮 ---- */
  $('sd-gen').onclick = applySeed;
  $('sd-seed').addEventListener('keydown', (e) => { if (e.key === 'Enter') applySeed(); });
  $('sd-ver').onchange = async () => {
    if (!S.seed) return;
    S.ver = $('sd-ver').value;
    S.structs = [];
    frame = null;
    biomeCache.clear();
    hud.textContent = '切换版本…';
    await loadWorldMarkers();
    refresh();
  };
  $('sd-import').onclick = async () => {
    const dir = await api.pickDir();
    if (!dir) return;
    try {
      const seed = await api.labSeedFromSave(dir);
      $('sd-seed').value = seed;
      toast('已导入种子：' + seed);
      applySeed();
    } catch (e) { toast('读取失败：' + e.message, true); }
  };
  $('sd-spawn').onclick = () => {
    if (!S.seed) { toast('请先生成地图', true); return; }
    if (S.spawn) { S.ccx = S.spawn.x; S.ccz = S.spawn.z; refresh(); }
    else toast('出生点信息尚未就绪');
  };
  $('sd-fort').onclick = () => {
    if (!S.strongholds.length) { toast('还没有要塞信息（仅主世界）', true); return; }
    let best = S.strongholds[0];
    let bd = Infinity;
    for (const p of S.strongholds) {
      const d = (p.x - S.ccx) ** 2 + (p.z - S.ccz) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    S.ccx = best.x;
    S.ccz = best.z;
    S.bpp = 8;
    refresh();
  };
  $('sd-toggle').onclick = () => {
    S.showStructs = !S.showStructs;
    $('sd-toggle').textContent = S.showStructs ? '隐藏结构标记' : '显示结构标记';
    drawScene();
  };
  $('sd-in').onclick = () => zoomBy(0.7);
  $('sd-out').onclick = () => zoomBy(1.4);

  document.querySelectorAll('#sd-dims button').forEach((b) => {
    b.onclick = async () => {
      const dim = parseInt(b.dataset.dim, 10);
      if (dim === S.dim) return;
      S.dim = dim;
      S.structs = [];
      frame = null;
      biomeCache.clear();
      document.querySelectorAll('#sd-dims button').forEach((x) => x.classList.remove('primary'));
      b.classList.add('primary');
      renderLegend();
      if (S.seed) {
        hud.textContent = '切换维度…';
        await loadWorldMarkers();
        refresh();
      }
    };
  });

  // 容器尺寸变化（含初次布局完成）：先用旧瓦片即时适配，停稳后再取新图
  const ro = new ResizeObserver(() => {
    if (!S.seed) return;
    instantView();
    settleRefresh();
  });
  ro.observe(canvas);
  renderLegend();
}

/* ---------- 工具三：投影工坊 ---------- */

const SCH_COLORS = {};
function blockColor(name) {
  if (SCH_COLORS[name]) return SCH_COLORS[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 38 + (h % 30);
  const light = 42 + ((h >> 8) % 24);
  const c = `hsl(${hue} ${sat}% ${light}%)`;
  SCH_COLORS[name] = c;
  return c;
}

let schState = null; // { path, format, size, palette, blocks, counts, name }
let schView = { mode: 'layer', y: 0, rot: 0, spacing: 12 };

function renderSchematicTool(box) {
  const recent = (state.config.recentSchematics || []);
  box.innerHTML = `
    <div class="panel" style="padding:22px;margin-bottom:16px">
      <div class="section-title">投影工坊</div>
      <div class="row" style="flex-wrap:wrap;margin-bottom:10px">
        <button class="btn primary" id="sch-open">选择投影 / 结构文件</button>
        <span class="hint-text">支持 .litematic（Litematica 投影）/ .schem、.schematic（WorldEdit）</span>
      </div>
      ${recent.length ? `<div class="hint-text" style="margin-bottom:6px">最近预览：</div><div class="recent-list">${recent.map((p) => `<button class="chip" data-recent="${escapeHtml(p)}">${escapeHtml(p.split(/[\\/]/).pop())}</button>`).join('')}</div>` : ''}
    </div>
    <div id="sch-body"></div>
  `;
  $('sch-open').onclick = async () => {
    try {
      const res = await api.labSchematicOpen();
      if (res.canceled) return;
      schState = res;
      schView = { mode: 'layer', y: Math.floor(res.size.y / 2), rot: 0, spacing: 12 };
      renderSchematicBody();
      state.config = await api.configGetAll();
      renderSchematicTool(box);
      renderSchematicBody();
    } catch (e) { toast('读取失败：' + e.message, true); }
  };
  box.querySelectorAll('[data-recent]').forEach((b) => {
    b.onclick = async () => {
      try {
        const res = await api.labSchematicOpen(b.dataset.recent);
        if (res.canceled) return;
        schState = res;
        schView = { mode: 'layer', y: Math.floor(res.size.y / 2), rot: 0, spacing: 12 };
        renderSchematicBody();
      } catch (e) { toast('读取失败：' + e.message, true); }
    };
  });
  if (schState) renderSchematicBody();
}

function renderSchematicBody() {
  const body = $('sch-body');
  if (!body) return;
  if (!schState) { body.innerHTML = '<div class="empty-tip">还没有打开投影文件，点上面的按钮选一个吧</div>'; return; }
  const { size, counts, format, name, author } = schState;
  const fmtName = { litematic: 'Litematica 投影', sponge: 'Sponge（WorldEdit）', mcedit: 'MCEdit 经典' }[format] || format;

  body.innerHTML = `
    <div class="inst-head" style="margin-bottom:14px">
      <div class="inst-icon big">📐</div>
      <div class="inst-head-info">
        <div class="inst-name">${escapeHtml(name || schState.path.split(/[\\/]/).pop())}</div>
        <div class="inst-meta">${fmtName} · 尺寸 ${size.x}×${size.y}×${size.z}${author ? ` · 作者 ${escapeHtml(author)}` : ''}</div>
      </div>
      <div class="row">
        <button class="btn" id="sch-export">导出结构文件</button>
      </div>
    </div>

    <div class="tabs">
      <button class="tab active" data-sv="layer">逐层查看</button>
      <button class="tab" data-sv="iso">3D 预览</button>
      <button class="tab" data-sv="mat">材料列表</button>
    </div>
    <div id="sch-view"></div>
  `;

  document.querySelectorAll('[data-sv]').forEach((t) => {
    t.onclick = () => {
      schView.mode = t.dataset.sv;
      document.querySelectorAll('[data-sv]').forEach((x) => x.classList.toggle('active', x === t));
      renderSchView();
    };
  });
  $('sch-export').onclick = async () => {
    try {
      const r = await api.labSchematicExport();
      if (r && r.canceled) return;
      toast('已导出结构文件');
    } catch (e) { toast(e.message, true); }
  };
  renderSchView();
}

function renderSchView() {
  const v = $('sch-view');
  if (!v || !schState) return;
  if (schView.mode === 'layer') renderSchLayer(v);
  else if (schView.mode === 'iso') renderSchIso(v);
  else renderSchMaterials(v);
}

function renderSchLayer(v) {
  const { size, palette, blocks } = schState;
  v.innerHTML = `
    <div class="row" style="align-items:center;gap:12px;margin:12px 0">
      <button class="btn sm" id="ly-prev">上一层</button>
      <input type="range" id="ly-range" min="0" max="${size.y - 1}" value="${schView.y}" style="flex:1">
      <button class="btn sm" id="ly-next">下一层</button>
      <span class="hint-text" id="ly-label">第 ${schView.y} 层 / 共 ${size.y} 层</span>
    </div>
    <div class="layer-wrap"><canvas id="ly-canvas"></canvas></div>
  `;
  const draw = () => {
    const y = schView.y;
    $('ly-range').value = y;
    $('ly-label').textContent = `第 ${y} 层 / 共 ${size.y} 层`;
    const cell = Math.max(2, Math.min(14, Math.floor(620 / Math.max(size.x, size.z))));
    const dpr = window.devicePixelRatio || 1;
    const c = $('ly-canvas');
    c.width = size.x * cell * dpr;
    c.height = size.z * cell * dpr;
    c.style.width = `${size.x * cell}px`;
    c.style.height = `${size.z * cell}px`;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0e1420';
    ctx.fillRect(0, 0, size.x * cell, size.z * cell);
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++) {
        const idx = blocks[(y * size.z + z) * size.x + x];
        const nm = palette[idx];
        if (!nm || nm === 'minecraft:air') continue;
        ctx.fillStyle = blockColor(nm);
        ctx.fillRect(x * cell, z * cell, cell - (cell > 4 ? 1 : 0), cell - (cell > 4 ? 1 : 0));
      }
    }
  };
  $('ly-range').oninput = (e) => { schView.y = parseInt(e.target.value, 10); draw(); };
  $('ly-prev').onclick = () => { schView.y = Math.max(0, schView.y - 1); draw(); };
  $('ly-next').onclick = () => { schView.y = Math.min(size.y - 1, schView.y + 1); draw(); };
  draw();
}

function renderSchIso(v) {
  const { size } = schState;
  v.innerHTML = `
    <div class="row" style="align-items:center;gap:12px;margin:12px 0;flex-wrap:wrap">
      <button class="btn sm" id="iso-rot">旋转 90°</button>
      <span class="hint-text">层间距</span>
      <input type="range" id="iso-space" min="4" max="28" value="${schView.spacing}" style="width:180px">
      <span class="hint-text" id="iso-info">尺寸 ${size.x}×${size.y}×${size.z}</span>
    </div>
    <div class="layer-wrap"><canvas id="iso-canvas"></canvas></div>
  `;
  const draw = () => drawIso($('iso-canvas'));
  $('iso-rot').onclick = () => { schView.rot = (schView.rot + 1) % 4; draw(); };
  $('iso-space').oninput = (e) => { schView.spacing = parseInt(e.target.value, 10); draw(); };
  draw();
}

function drawIso(canvas) {
  const { size, palette, blocks } = schState;
  const yaw = schView.rot * Math.PI / 2;
  const cy = Math.cos(yaw); const sy = Math.sin(yaw);
  const spacing = schView.spacing;

  // 采样步长，避免超大结构卡顿
  let step = 1;
  while ((size.x / step) * (size.y / step) * (size.z / step) > 60000) step++;

  const a = 7;      // 半宽
  const b = 4;      // 半高（顶面菱形）
  const cubes = [];
  for (let y = 0; y < size.y; y += step) {
    for (let z = 0; z < size.z; z += step) {
      for (let x = 0; x < size.x; x += step) {
        const idx = blocks[(y * size.z + z) * size.x + x];
        const nm = palette[idx];
        if (!nm || nm === 'minecraft:air') continue;
        const rx = x * cy - z * sy;
        const rz = x * sy + z * cy;
        cubes.push({ rx, rz, y, nm });
      }
    }
  }
  cubes.sort((p, q) => (p.rx + p.rz) - (q.rx + q.rz) || p.y - q.y);

  let minPx = Infinity; let maxPx = -Infinity; let minPy = Infinity; let maxPy = -Infinity;
  for (const c of cubes) {
    c.px = c.rx * (a + 3);
    c.py = c.rz * b - c.y * spacing;
    if (c.px < minPx) minPx = c.px;
    if (c.px > maxPx) maxPx = c.px;
    if (c.py < minPy) minPy = c.py;
    if (c.py > maxPy) maxPy = c.py;
  }
  const pad = 24;
  const W = Math.max(120, maxPx - minPx + pad * 2);
  const H = Math.max(120, maxPy - minPy + pad * 2 + spacing);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#0e1420';
  ctx.fillRect(0, 0, W, H);
  ctx.translate(pad - minPx, pad - minPy + spacing);

  for (const c of cubes) {
    const base = blockColor(c.nm);
    const x = c.px; const y = c.py;
    // 顶面
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.moveTo(x, y - b);
    ctx.lineTo(x + a, y);
    ctx.lineTo(x, y + b);
    ctx.lineTo(x - a, y);
    ctx.closePath();
    ctx.fill();
    // 左侧面（暗）
    ctx.globalAlpha = 0.72;
    ctx.beginPath();
    ctx.moveTo(x - a, y);
    ctx.lineTo(x, y + b);
    ctx.lineTo(x, y + b + spacing);
    ctx.lineTo(x - a, y + spacing);
    ctx.closePath();
    ctx.fill();
    // 右侧面（更暗）
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(x + a, y);
    ctx.lineTo(x, y + b);
    ctx.lineTo(x, y + b + spacing);
    ctx.lineTo(x + a, y + spacing);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  $('iso-info').textContent = `尺寸 ${size.x}×${size.y}×${size.z} · 绘制 ${cubes.length} 方块${step > 1 ? `（每 ${step} 格采样）` : ''}`;
}

function renderSchMaterials(v) {
  const { counts, palette } = schState;
  v.innerHTML = `
    <div class="row" style="margin:12px 0;flex-wrap:wrap;align-items:center;gap:8px">
      <span class="hint-text">材料替换：把</span>
      <select class="input sm" id="mat-from" style="width:auto">${counts.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${c.count})</option>`).join('')}</select>
      <span class="hint-text">换成</span>
      <input class="input sm" id="mat-to" placeholder="minecraft:stone" style="width:200px">
      <button class="btn sm primary" id="mat-apply">应用替换</button>
    </div>
    <div class="mat-grid" id="mat-grid"></div>
  `;
  const grid = $('mat-grid');
  for (const c of counts) {
    const row = ce('div', 'mat-row');
    row.innerHTML = `
      <span class="mat-swatch" style="background:${blockColor(c.name)}"></span>
      <span class="mat-name">${escapeHtml(c.name)}</span>
      <span class="mat-count">× ${c.count}</span>
    `;
    grid.appendChild(row);
  }
  $('mat-apply').onclick = async () => {
    const from = $('mat-from').value;
    const to = $('mat-to').value.trim();
    if (!to) return toast('请填写目标方块 ID，例如 minecraft:stone', true);
    try {
      const res = await api.labSchematicReplace(from, to);
      schState.counts = res.counts;
      schState.palette = res.palette;
      schState.blocks = res.blocks;
      toast(`已替换 ${res.changed} 个方块`);
      renderSchMaterials(v);
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- 工具四：配方生成器 ---------- */

const RECIPE_TYPES = [
  { id: 'crafting_shaped', name: '工作台（有序 3×3）' },
  { id: 'crafting_shapeless', name: '工作台（无序）' },
  { id: 'smelting', name: '熔炉烧炼' },
  { id: 'blasting', name: '高炉冶炼' },
  { id: 'smoking', name: '烟熏炉' },
  { id: 'campfire_cooking', name: '营火烹饪' },
  { id: 'stonecutting', name: '切石机' },
];

function renderRecipeTool(box) {
  box.innerHTML = `
    <div class="panel" style="padding:22px">
      <div class="section-title">配方生成器</div>
      <div class="grid-2">
        <div class="field"><label>配方类型</label><select class="input" id="rc-type">${RECIPE_TYPES.map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select></div>
        <div class="field"><label>命名空间</label><input class="input" id="rc-ns" value="${escapeHtml(state.config.recipeNamespace || 'cm_craft')}"></div>
        <div class="field"><label>数据包格式（1.20.1=15 / 1.21=48）</label><input class="input" type="number" id="rc-pf" value="${state.config.recipePackFormat || 15}"></div>
        <div class="field"><label>配方名称</label><input class="input" id="rc-name" value="my_recipe"></div>
      </div>
      <div id="rc-body"></div>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" id="rc-export">导出数据包 (.zip)</button>
      </div>
      <div class="hint-text" style="margin-top:8px">导出后放进存档的 datapacks 文件夹，或整合包的 data 目录；方块 ID 形如 minecraft:stone。</div>
    </div>
  `;

  const body = $('rc-body');
  const drawBody = () => {
    const t = $('rc-type').value;
    if (t === 'crafting_shaped') {
      body.innerHTML = `
        <label class="rc-label">合成表（留空为空格）</label>
        <div class="craft-grid" id="rc-grid">
          ${Array.from({ length: 9 }).map((_, i) => `<input class="input craft-cell" data-i="${i}" placeholder="${i === 4 ? '中心' : ''}">`).join('')}
        </div>
        <div class="grid-2" style="margin-top:12px">
          <div class="field"><label>产物 ID</label><input class="input" id="rc-result" value="minecraft:diamond"></div>
          <div class="field"><label>产物数量</label><input class="input" type="number" id="rc-count" value="1" min="1" max="64"></div>
        </div>`;
    } else if (t === 'crafting_shapeless') {
      body.innerHTML = `
        <label class="rc-label">材料（每行一个方块 ID，最多 9 个）</label>
        <textarea class="input" id="rc-ing" rows="4" placeholder="minecraft:oak_planks&#10;minecraft:stick"></textarea>
        <div class="grid-2" style="margin-top:12px">
          <div class="field"><label>产物 ID</label><input class="input" id="rc-result" value="minecraft:crafting_table"></div>
          <div class="field"><label>产物数量</label><input class="input" type="number" id="rc-count" value="1" min="1" max="64"></div>
        </div>`;
    } else if (t === 'stonecutting') {
      body.innerHTML = `
        <div class="grid-2">
          <div class="field"><label>输入方块 ID</label><input class="input" id="rc-in" value="minecraft:stone"></div>
          <div class="field"><label>产物 ID</label><input class="input" id="rc-result" value="minecraft:stone_slab"></div>
          <div class="field"><label>产物数量</label><input class="input" type="number" id="rc-count" value="2"></div>
        </div>`;
    } else {
      body.innerHTML = `
        <div class="grid-2">
          <div class="field"><label>输入物品 ID</label><input class="input" id="rc-in" value="minecraft:iron_ore"></div>
          <div class="field"><label>产物 ID</label><input class="input" id="rc-result" value="minecraft:iron_ingot"></div>
          <div class="field"><label>产物数量</label><input class="input" type="number" id="rc-count" value="1"></div>
          <div class="field"><label>经验（experience）</label><input class="input" type="number" step="0.1" id="rc-exp" value="0.7"></div>
          <div class="field"><label>耗时（tick，200=10 秒）</label><input class="input" type="number" id="rc-time" value="200"></div>
        </div>`;
    }
  };
  $('rc-type').onchange = drawBody;
  drawBody();

  $('rc-export').onclick = async () => {
    try {
      const recipe = buildRecipePayload();
      const res = await api.labRecipeExport({
        namespace: $('rc-ns').value.trim() || 'cm_craft',
        packFormat: parseInt($('rc-pf').value, 10) || 15,
        description: 'CM 启动器配方数据包',
        recipes: [{ id: $('rc-name').value.trim() || 'recipe', json: recipe }],
      });
      if (res && res.canceled) return;
      toast(`已导出数据包（${res.count} 个配方）`);
      await applyAndSave({ recipeNamespace: $('rc-ns').value.trim() || 'cm_craft', recipePackFormat: parseInt($('rc-pf').value, 10) || 15 });
    } catch (e) { toast(e.message, true); }
  };
}

function buildRecipePayload() {
  const t = $('rc-type').value;
  const result = { item: ($('rc-result').value || '').trim(), count: parseInt($('rc-count').value, 10) || 1 };
  if (t === 'crafting_shaped') {
    const cells = Array.from(document.querySelectorAll('.craft-cell')).map((el) => el.value.trim());
    const used = cells.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    if (!used.length) throw new Error('合成表不能全空');
    const rows = used.map((i) => Math.floor(i / 3));
    const cols = used.map((i) => i % 3);
    const r0 = Math.min(...rows); const r1 = Math.max(...rows);
    const c0 = Math.min(...cols); const c1 = Math.max(...cols);
    // 裁掉空白行列，并给每种材料分配单字符代号
    const pattern = [];
    const map = new Map();
    for (let r = r0; r <= r1; r++) {
      let line = '';
      for (let c = c0; c <= c1; c++) {
        const cell = cells[r * 3 + c];
        if (!cell) { line += ' '; continue; }
        if (!map.has(cell)) map.set(cell, String.fromCharCode(65 + map.size));
        line += map.get(cell);
      }
      pattern.push(line);
    }
    const key = {};
    for (const [item, ch] of map.entries()) key[ch] = { item };
    return { type: 'minecraft:crafting_shaped', pattern, key, result };
  }
  if (t === 'crafting_shapeless') {
    const items = ($('rc-ing').value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!items.length) throw new Error('请至少填写一个材料');
    return { type: 'minecraft:crafting_shapeless', ingredients: items.map((i) => ({ item: i })), result };
  }
  if (t === 'stonecutting') {
    return { type: 'minecraft:stonecutting', ingredient: { item: ($('rc-in').value || '').trim() }, result: ($('rc-result').value || '').trim(), count: result.count };
  }
  return {
    type: `minecraft:${t}`,
    ingredient: { item: ($('rc-in').value || '').trim() },
    result: ($('rc-result').value || '').trim(),
    count: result.count,
    experience: parseFloat($('rc-exp').value) || 0,
    cookingtime: parseInt($('rc-time').value, 10) || 200,
  };
}

/* ---------- 工具五：模组汉化 ---------- */

function renderTranslateTool(box) {
  const ai = state.config.ai || {};
  box.innerHTML = `
    <div class="panel" style="padding:22px;margin-bottom:16px">
      <div class="section-title">模组汉化（AI 翻译）</div>
      <div class="hint-text" style="margin-bottom:12px">解包 jar 内的 assets/&lt;modid&gt;/lang/en_us.json，用 AI 翻译后写回 zh_cn.json 并重新打包。需要 OpenAI 兼容接口的 API Key。</div>
      <div class="grid-2">
        <div class="field"><label>接口地址（Base URL）</label><input class="input" id="ai-url" value="${escapeHtml(ai.baseUrl || '')}" placeholder="https://api.openai.com/v1"></div>
        <div class="field"><label>模型</label><input class="input" id="ai-model" value="${escapeHtml(ai.model || '')}" placeholder="gpt-4o-mini"></div>
      </div>
      <div class="field"><label>API Key</label><input class="input" type="password" id="ai-key" value="${escapeHtml(ai.apiKey || '')}" placeholder="sk-..."></div>
      <div class="row">
        <button class="btn" id="ai-save">保存设置</button>
        <button class="btn primary" id="tr-run">选择 jar 并汉化</button>
      </div>
      <div class="progress-wrap" id="tr-progress"></div>
    </div>
  `;
  $('ai-save').onclick = async () => {
    await applyAndSave({
      ai: {
        baseUrl: $('ai-url').value.trim(),
        model: $('ai-model').value.trim(),
        apiKey: $('ai-key').value.trim(),
      },
    });
    toast('AI 翻译设置已保存');
  };
  $('tr-run').onclick = async () => {
    const prog = $('tr-progress');
    prog.innerHTML = '<div class="hint-text">准备中…</div>';
    try {
      const res = await api.labTranslateJar();
      if (res && res.canceled) { prog.innerHTML = ''; return; }
      prog.innerHTML = `<div class="hint-text">完成：翻译 ${res.translated} 条，涉及模块 ${res.files.join('、') || '无'}</div>`;
      toast('汉化完成，已输出 jar');
    } catch (e) {
      prog.innerHTML = `<div class="hint-text" style="color:var(--danger,#f87171)">失败：${escapeHtml(e.message)}</div>`;
    }
  };
}

/* ========== 启动器自更新 ========== */

// 检查到的新版清单；null = 无新版 / 还没查过。顶栏红点与首页徽章都读它。
let pendingUpdate = null;

/** 有新版时在顶栏头像挂小红点、首页挂个徽章（两处都可能不在 DOM 里，各自判空） */
function paintUpdateDot() {
  const on = !!pendingUpdate;
  const av = $('top-avatar');
  if (av) {
    av.classList.toggle('has-update', on);
    av.title = on ? `发现新版本 v${pendingUpdate.latest}` : '';
  }
  const badge = $('hero-badge-update');
  if (badge) badge.hidden = !on;
}

/** 跳到设置页的更新区块 */
function openUpdateSettings() {
  renderPage('settings');
  const el = $('up-block');
  if (el) el.scrollIntoView({ block: 'center' });
}

/**
 * 检查更新。silent=true 供启动时后台跑：没查到新版、连不上、地址没填都一律不打扰玩家，
 * 只有确实有新版才点亮红点与徽章。
 */
async function checkUpdate(silent = false) {
  const up = (state.config && state.config.update) || {};
  if (!up.url) {
    if (!silent) toast('还没填更新地址', true);
    return null;
  }
  try {
    const res = await api.updaterCheck(up.url);
    pendingUpdate = res.hasUpdate ? res : null;
    paintUpdateDot();
    if (!silent) toast(res.hasUpdate ? `发现新版本 v${res.latest}` : '已是最新版');
    return res;
  } catch (e) {
    if (!silent) toast(`检查更新失败：${e.message}`, true);
    return null;
  }
}

/** 6 小时内查过就跳过，免得每开一次启动器都去敲一遍服务器 */
async function autoCheckUpdate() {
  const up = (state.config && state.config.update) || {};
  if (up.autoCheck === false || !up.url) return;
  if (Date.now() - Number(up.lastCheckAt || 0) < 6 * 3600 * 1000) return;
  await checkUpdate(true);
}

/* ========== 设置 ========== */

function renderSettings(page) {
  const c = state.config;
  page.innerHTML = `
    <div class="page-title">设置</div>
    <div class="page-sub">外观、运行环境、内存与下载</div>

    <div class="panel" style="padding:22px;margin-bottom:18px">
      <div class="section-title">外观</div>
      <div class="field">
        <label>主题色（界面强调色）</label>
        <div class="accent-dots" id="accent-dots"></div>
      </div>
      <div class="field">
        <label>外观模式</label>
        <div class="ui-opts" id="ui-theme"></div>
      </div>
      <div class="field">
        <label>液态玻璃 · 材质</label>
        <div class="ui-opts" id="ui-material"></div>
        <div class="hint-text">透明＝苹果那种清透玻璃（几乎不挡背景 + 轻模糊 + 亮边） · 亚克力＝半透明 + 强模糊 + 细颗粒 · 不透明＝近实心、文字最锐 · 滑杆可连续微调通透度（窗口恒为实心，不会透出桌面）</div>
      </div>
      <div class="field">
        <label>液态玻璃 · 通透度</label>
        <div class="ui-slider-row">
          <input class="ui-slider" id="ui-glass" type="range" min="0" max="100" step="1" value="55">
          <span class="ui-slider-val" id="ui-glass-val">55%</span>
        </div>
        <label class="ui-check"><input type="checkbox" id="ui-glass-auto" checked> 窗口切到后台时自动收一档（省电）</label>
        <div class="hint-text" id="ui-glass-hint"></div>
      </div>
      <div class="field">
        <label>自定义背景</label>
        <div class="row">
          <button class="btn" id="btn-wall-pick" type="button">上传图片 / 动图 / 视频 / 实况照片</button>
          <button class="btn" id="btn-wall-reset" type="button">恢复内置背景</button>
        </div>
        <div class="wall-info" id="wall-info"></div>
        <div class="hint-text">
          静态图 jpg / png / webp / avif · 动图 GIF / 动态 WebP / APNG · 视频 mp4 / webm / mkv · 实况照片 HEIC / 内嵌动态的 JPEG。
          上限 8K（超过 7680×4320 会被拒绝）。
        </div>
      </div>
      <div class="field">
        <label>界面密度</label>
        <div class="ui-opts" id="ui-density"></div>
      </div>
      <div class="field">
        <label>背景氛围</label>
        <div class="ui-opts" id="ui-aura"></div>
      </div>
    </div>

    <div class="glass" style="padding:22px;margin-bottom:18px">
      <div class="page-title" style="font-size:17px;margin-bottom:16px">游戏运行</div>
      <div class="field">
        <label>游戏目录</label>
        <div class="row">
          <input class="input grow" id="set-gamedir" readonly value="${c.gameDir}">
          <button class="btn" id="btn-gamedir">浏览</button>
        </div>
      </div>
      <div class="field">
        <label>Java 运行环境</label>
        <div class="row">
          <select class="input grow" id="set-java"></select>
          <button class="btn" id="btn-java">浏览</button>
          <button class="btn" id="btn-java-rescan">重新扫描</button>
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:5px" id="java-hint">扫描中…</div>
      </div>
      <div id="java-panel"></div>
      <div class="grid-2">
        <div class="field">
          <label>最大内存 MB（-Xmx）</label>
          <input class="input" type="number" id="set-maxmem" min="512" step="256" value="${c.maxMemory || 4096}">
        </div>
        <div class="field">
          <label>最小内存 MB（-Xms）</label>
          <input class="input" type="number" id="set-minmem" min="128" step="128" value="${c.minMemory || 512}">
        </div>
      </div>
      <div class="field">
        <label>自定义 JVM 参数</label>
        <input class="input" id="set-jvm" placeholder="-XX:+UnlockExperimentalVMOptions ..." value="${c.jvmArgs || ''}">
      </div>
      <div class="field">
        <label class="ui-check">
          <input type="checkbox" id="set-boost" ${c.speedBoost !== false ? 'checked' : ''}>
          <span>游戏加速</span>
        </label>
        <div class="hint-text" style="margin-top:4px">自动按物理内存抬高堆上限、加一组 G1 调优参数，并把游戏进程优先级提到「高于正常」，减少卡顿</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:-8px;margin-bottom:14px;flex-wrap:wrap">
        <button class="btn sm" id="btn-aikar">⚡ 应用 Aikar's G1GC 优化</button>
        <button class="btn sm" id="btn-aikar-old">⚡ Aikar's (Java 8 旧版)</button>
        <button class="btn sm" id="btn-jvm-clear">清除</button>
      </div>
      <div class="quick-actions">
        <div class="quick-action" id="qa-game"><div class="qa-icon">📁</div><div class="qa-label">游戏目录</div></div>
        <div class="quick-action" id="qa-mods"><div class="qa-icon">🧩</div><div class="qa-label">Mods 文件夹</div></div>
        <div class="quick-action" id="qa-config"><div class="qa-icon">⚙️</div><div class="qa-label">Config 文件夹</div></div>
        <div class="quick-action" id="qa-saves"><div class="qa-icon">💾</div><div class="qa-label">存档文件夹</div></div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label>窗口宽度</label>
          <input class="input" type="number" id="set-width" value="${c.width || 854}">
        </div>
        <div class="field">
          <label>窗口高度</label>
          <input class="input" type="number" id="set-height" value="${c.height || 480}">
        </div>
      </div>
    </div>

    <div class="glass" style="padding:22px;margin-bottom:18px">
      <div class="page-title" style="font-size:17px;margin-bottom:16px">内存管理</div>
      <div class="mem-stats" id="mem-stats">
        <div class="mem-stat">
          <div class="mem-stat-label">系统总内存</div>
          <div class="mem-stat-value" id="mem-total">—</div>
        </div>
        <div class="mem-stat">
          <div class="mem-stat-label">已用内存</div>
          <div class="mem-stat-value" id="mem-used">—</div>
        </div>
        <div class="mem-stat">
          <div class="mem-stat-label">可用内存</div>
          <div class="mem-stat-value" id="mem-free">—</div>
        </div>
        <div class="mem-stat">
          <div class="mem-stat-label">启动器占用</div>
          <div class="mem-stat-value" id="mem-proc">—</div>
        </div>
      </div>
      <div class="mem-gauge" id="mem-gauge">
        <div class="mem-gauge-head">
          <span class="mem-gauge-num" id="mem-used-num">—</span>
          <span class="mem-gauge-total">/ <span id="mem-total-num">—</span> 已用</span>
          <span class="mem-gauge-badge" id="mem-pct">—</span>
        </div>
        <div class="mem-track" id="mem-track">
          <div class="mem-track-fill" id="mem-fill"></div>
          <div class="mem-track-proc" id="mem-proc-bar"></div>
          <div class="mem-track-plan" id="mem-plan"></div>
          <div class="mem-track-ticks" id="mem-ticks"></div>
        </div>
        <div class="mem-legend">
          <span><i class="mem-dot used"></i>系统已用</span>
          <span><i class="mem-dot proc"></i>启动器占用</span>
          <span><i class="mem-dot plan"></i>计划分配 <b id="mem-plan-num">—</b></span>
          <span class="mem-legend-free" id="mem-free-hint">可用 —</span>
        </div>
      </div>
      <div style="margin-bottom:16px">
        <div class="hint-text" style="margin-bottom:8px">清理强度（三级以上会请求管理员权限，能把系统待机内存也清出来）</div>
        <div class="row" id="mem-levels" style="gap:8px;flex-wrap:wrap;margin:0">
          <button class="btn" data-level="1">一级 · 轻度</button>
          <button class="btn" data-level="2">二级 · 标准</button>
          <button class="btn" data-level="3">三级 · 增强</button>
          <button class="btn" data-level="4">四级 · 深度</button>
          <button class="btn" data-level="5">五级 · 强力</button>
          <button class="btn" data-level="6">六级 · 极限</button>
        </div>
        <div class="hint-text" id="mem-level-desc" style="margin-top:8px;line-height:1.7"></div>
      </div>
      <div class="mem-actions">
        <button class="btn" id="btn-auto-mem">⚙ 自动分配内存</button>
        <button class="btn" id="btn-clean-mem">🧹 一键清理内存</button>
      </div>
      <div id="mem-recommend-tip" class="mem-tip" style="display:none"></div>
    </div>

    <div class="glass" style="padding:22px">
      <div class="page-title" style="font-size:17px;margin-bottom:16px">下载</div>
      <div class="field">
        <label>游戏文件下载源</label>
        <select class="input" id="set-mirror">
          <option value="bmcl">BMCLAPI 国内镜像（推荐）</option>
          <option value="official">Mojang 官方源</option>
        </select>
      </div>
      <div class="field" style="display:flex;align-items:center;gap:12px">
        <label class="switch">
          <input type="checkbox" id="set-snapshots" ${c.showSnapshots ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
        <span>在版本列表中显示快照版本</span>
      </div>
    </div>

    <div class="glass" style="padding:22px;margin-top:18px">
      <div class="page-title" style="font-size:17px;margin-bottom:6px">AI 翻译</div>
      <div class="page-sub" style="margin-bottom:14px">兼容 OpenAI 接口的服务均可使用；用于模组汉化（实验室 → 汉化）与文本翻译</div>
      <div class="field">
        <label>服务商预设</label>
        <div class="row" id="ai-providers" style="flex-wrap:wrap;gap:8px"></div>
      </div>
      <div class="field">
        <label>接口地址（Base URL）</label>
        <input class="input" id="ai-base" placeholder="https://api.openai.com/v1" value="${(c.ai && c.ai.baseUrl) || ''}">
      </div>
      <div class="grid-2">
        <div class="field">
          <label>API Key</label>
          <input class="input" id="ai-key" type="password" placeholder="sk-..." value="${(c.ai && c.ai.apiKey) || ''}">
        </div>
        <div class="field">
          <label>模型名</label>
          <input class="input" id="ai-model" placeholder="gpt-4o-mini" value="${(c.ai && c.ai.model) || ''}">
        </div>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <button class="btn" id="ai-save" type="button">保存 AI 配置</button>
        <button class="btn" id="ai-test" type="button">🔌 测试连接</button>
        <span class="hint-text" id="ai-status">未测试</span>
      </div>
      <div class="field">
        <label>快速文本翻译</label>
        <div class="row">
          <input class="input grow" id="ai-text" placeholder="粘贴要翻译的文本（中英日韩等）">
          <button class="btn primary" id="ai-translate" type="button">翻译</button>
        </div>
        <div class="ai-result" id="ai-result" hidden></div>
      </div>
    </div>

    <div class="glass" style="padding:22px;margin-top:18px">
      <div class="page-title" style="font-size:17px;margin-bottom:6px">翻译 / AI</div>
      <div class="page-sub" style="margin-bottom:14px">兼容 OpenAI 接口格式，用于模组汉化与文本翻译（DeepSeek / 通义 / 智谱 / 本地 Ollama 均可）</div>
      <div class="field">
        <label>快速预设</label>
        <div class="ai-presets" id="ai-presets"></div>
      </div>
      <div class="field">
        <label>接口地址 Base URL</label>
        <input class="input" id="ai-base" placeholder="https://api.openai.com/v1" value="${(c.ai && c.ai.baseUrl) || ''}">
      </div>
      <div class="grid-2">
        <div class="field">
          <label>模型</label>
          <input class="input" id="ai-model" placeholder="gpt-4o-mini" value="${(c.ai && c.ai.model) || ''}">
        </div>
        <div class="field">
          <label>API Key</label>
          <input class="input" id="ai-key" type="password" placeholder="sk-…" value="${(c.ai && c.ai.apiKey) || ''}">
        </div>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <button class="btn primary" id="ai-save" type="button">保存配置</button>
        <button class="btn" id="ai-test" type="button">🔌 测试连接</button>
        <span class="hint-text" id="ai-status"></span>
      </div>
      <div class="field">
        <label>文本翻译</label>
        <textarea class="input" id="ai-text" rows="3" placeholder="粘贴要翻译的文本…"></textarea>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn" id="ai-do" type="button">翻译为中文</button>
        <button class="btn" id="ai-do-en" type="button">译为英文</button>
      </div>
      <div id="ai-result" class="ai-result" hidden></div>
    </div>

    <div class="glass" style="padding:22px;margin-top:18px">
      <div class="page-title" style="font-size:17px;margin-bottom:6px">从其他启动器搬家</div>
      <div class="page-sub" style="margin-bottom:14px">自动探测 PCL2 / HMCL 的实例、存档与内存设置，一键迁移到本启动器</div>
      <div class="row" style="align-items:center;gap:12px">
        <button class="btn" id="btn-migrate-scan">🔍 扫描其他启动器</button>
        <button class="btn" id="btn-migrate-pick">📁 手动选择目录</button>
        <span id="migrate-hint" style="font-size:12px;color:var(--text-dim)">尚未扫描</span>
      </div>
    </div>

    <div class="glass" style="padding:22px;margin-top:18px">
      <div class="page-title" style="font-size:17px;margin-bottom:6px">实验功能</div>
      <div class="page-sub" style="margin-bottom:14px">可能还在打磨的玩法，默认关闭，随时可以撤回</div>
      <div class="field">
        <label class="ui-check">
          <input type="checkbox" id="set-island" ${c.islandEnabled ? 'checked' : ''}>
          <span>通知浮岛 · 顶部居中弹出通知</span>
        </label>
        <div class="hint-text" style="margin-top:6px">打开后，下载完成、游戏启动 / 退出、更新等消息会从屏幕顶部正中以液态玻璃胶囊弹出、展开、再收起，点击可提前关掉。名字与造型都是我们自己的，不含任何第三方商标素材。</div>
        <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
          <button class="btn" id="btn-island-test" type="button">试弹一条</button>
          <span class="hint-text" id="island-test-hint"></span>
        </div>
      </div>
    </div>

    <div class="glass" id="up-block" style="padding:22px;margin-top:18px">
      <div class="page-title" style="font-size:17px;margin-bottom:6px">更新</div>
      <div class="page-sub" style="margin-bottom:14px">填一个能返回更新清单 JSON 的地址，启动器会比对版本并下载新版安装包</div>
      <div class="field">
        <label>更新地址</label>
        <input class="input" id="up-url" placeholder="https://github.com/BlockVibe001/cm-launcher/releases/latest/download/update.json">
        <div class="hint-text">JSON 需含 version 与 installer，可选 notes / publishedAt / sha256 / page。留空则不检查。当前版本 <b id="up-cur">—</b>。</div>
      </div>
      <label class="ui-check"><input type="checkbox" id="up-auto"> 启动时自动检查更新（6 小时内只查一次）</label>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px">
        <button class="btn primary" id="up-check" type="button">检查更新</button>
        <button class="btn" id="up-save" type="button">保存更新设置</button>
        <button class="btn" id="up-action" type="button" hidden>立即更新</button>
        <button class="btn" id="up-page" type="button" hidden>打开下载页</button>
        <span class="hint-text" id="up-status"></span>
      </div>
      <div class="progress-track" id="up-progress" hidden><div class="progress-fill" id="up-fill"></div></div>
      <div class="hint-text" id="up-notes" hidden style="margin-top:10px"></div>
    </div>

    <div style="margin-top:18px;display:flex;justify-content:flex-end">
      <button class="btn primary" id="btn-save-settings">保存设置</button>
    </div>
  `;

  // 主题色圆点
  const ad = $('accent-dots');
  ACCENTS.forEach((a) => {
    const dot = ce('div', 'accent-dot' + (c.accent === a.id ? ' active' : ''));
    dot.style.background = a.color;
    dot.onclick = () => {
      c.accent = a.id;
      document.querySelectorAll('.accent-dot').forEach((x) => x.classList.remove('active'));
      dot.classList.add('active');
      applyAndSave({ accent: a.id });
    };
    ad.appendChild(dot);
  });

  bindUiPrefs();

  $('btn-gamedir').onclick = async () => {
    const dir = await api.pickDir();
    if (!dir) return;
    const cur = String(state.config.gameDir || '');
    const normDir = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
    if (normDir(dir) === normDir(cur)) return;

    const choice = await askChoice('把游戏目录改到这里？', [
      {
        value: 'move',
        label: '一起移动已有文件（推荐）',
        desc: `把当前目录里的版本、模组、存档、资源等全部移动到新目录，旧位置清空，不用重新下载。文件多时需要一些时间。`,
      },
      {
        value: 'keep',
        label: '只改位置，不移动文件',
        desc: '今后游戏文件下载到新目录；旧目录里的文件原样保留（可之后手动删除）。',
      },
    ]);
    if (!choice) return;

    const btn = $('btn-gamedir');
    const inp = $('set-gamedir');
    btn.disabled = true;
    btn.textContent = choice === 'move' ? '正在移动文件…' : '切换中…';
    try {
      const r = await api.gameDirChange(dir, choice === 'move');
      await refreshConfig();
      inp.value = r.newDir;
      if (choice === 'move') {
        const n = Object.keys(r.changed || {}).length;
        toast(`游戏文件已移动到新目录${n ? `，${n} 个实例路径已同步` : ''}`);
      } else {
        toast('游戏目录已更改，今后文件将下载到新位置');
      }
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '浏览';
    }
  };

  // Java 列表 + 版本匹配 + 自动下载
  const javaSel = $('set-java');
  const javaHint = $('java-hint');
  const javaPanel = $('java-panel');

  async function loadJavas() {
    javaSel.innerHTML = '<option value="">自动检测</option>';
    javaHint.textContent = '扫描中…';
    let javas = [];
    try {
      javas = await api.javaList();
    } catch {
      if (javaHint.isConnected) javaHint.textContent = 'Java 扫描失败';
      return [];
    }
    if (!javaSel.isConnected) return javas;
    javas.forEach((j) => {
      const o = ce('option');
      o.value = j.path;
      o.textContent = `Java ${j.major} · ${j.path}`;
      javaSel.appendChild(o);
    });
    javaSel.value = c.javaPath || '';
    javaHint.textContent = javas.length ? `检测到 ${javas.length} 个 Java` : '未检测到 Java，可点击下方一键下载';
    return javas;
  }

  async function mountJavaPanel(javas) {
    const installed = await api.javaInstalled().catch(() => []);
    if (!javaPanel.isConnected) return;
    const inst = (state.config.instances || {})[state.selectedInstance] || {};
    const mcVer = inst.versionId || '';
    const need = mcVer ? await api.javaRequired(mcVer).catch(() => null) : null;

    const managed = new Map(installed.map((x) => [x.major, x]));
    const has = (m) => managed.has(m);
    const presets = [
      { major: 8, label: 'Java 8', tip: '1.16 及更早' },
      { major: 17, label: 'Java 17', tip: '1.17 ~ 1.20.4' },
      { major: 21, label: 'Java 21', tip: '1.20.5 及以上' },
    ];

    const matchJava = need ? javas.find((j) => j.major === need.major)
      || javas.find((j) => j.major >= need.major)
      || javas.slice().sort((a, b) => b.major - a.major)[0] : null;

    javaPanel.innerHTML = `
      <div class="java-match">
        ${need
    ? `当前实例 <b>${mcVer || '未选版本'}</b> 需要 <b class="hl">${need.text}</b> · ${matchJava
      ? `已匹配 <b class="ok">Java ${matchJava.major}</b>` : '<b class="bad">未找到可用 Java，请下载</b>'}`
    : '当前实例尚未选择游戏版本，无法判断所需 Java'}
        <button class="btn sm" id="java-open-dir" style="margin-left:auto">📂 Java 目录</button>
      </div>
      <div class="java-dl-title">一键下载 Java（Eclipse Adoptium 官方 JRE）</div>
      <div class="java-dl">
        ${presets.map((p) => `
          <div class="java-dl-item" data-major="${p.major}">
            <div class="java-dl-info">
              <div class="java-dl-name">${p.label} <span class="java-dl-tag">${p.tip}</span></div>
              <div class="java-dl-status">${has(p.major) ? `已安装 · ${managed.get(p.major).dir}` : '未安装'}</div>
              <div class="java-dl-bar" hidden><i></i></div>
            </div>
            ${has(p.major)
    ? `<button class="btn sm danger" data-jun="${p.major}">卸载</button>`
    : `<button class="btn sm primary" data-jdl="${p.major}">下载</button>`}
          </div>`).join('')}
      </div>
    `;

    $('java-open-dir').onclick = () => api.javaHome().then((d) => api.openPath(d));
    javaPanel.querySelectorAll('[data-jdl]').forEach((btn) => {
      btn.onclick = () => downloadJava(parseInt(btn.dataset.jdl, 10), btn);
    });
    javaPanel.querySelectorAll('[data-jun]').forEach((btn) => {
      btn.onclick = async () => {
        const m = parseInt(btn.dataset.jun, 10);
        await api.javaUninstall(m);
        toast(`已卸载 Java ${m}`);
        if (!javaPanel.isConnected) return;
        mountJavaPanel(await api.javaList().catch(() => []));
        loadJavas();
      };
    });
  }

  async function downloadJava(major, btn) {
    const item = javaPanel.querySelector(`.java-dl-item[data-major="${major}"]`);
    if (!item) return;
    const bar = item.querySelector('.java-dl-bar');
    const status = item.querySelector('.java-dl-status');
    bar.hidden = false;
    btn.disabled = true;
    btn.textContent = '下载中…';
    try {
      const res = await api.javaDownload(major);
      toast(`Java ${major} 安装完成`);
      if (javaPanel.isConnected) mountJavaPanel(await api.javaList().catch(() => []));
      loadJavas();
      return res;
    } catch (e) {
      status.textContent = `下载失败：${e.message}`;
      btn.disabled = false;
      btn.textContent = '重试';
      bar.hidden = true;
    }
  }

  // 下载进度推送
  api.onJavaProgress((p) => {
    const item = document.querySelector(`.java-dl-item[data-major="${p.major}"]`);
    if (!item) return;
    const bar = item.querySelector('.java-dl-bar');
    const fill = bar.querySelector('i');
    const status = item.querySelector('.java-dl-status');
    bar.hidden = false;
    fill.style.width = `${p.percent || 0}%`;
    status.textContent = p.stage === 'extract'
      ? `正在解压 ${p.percent || 0}%`
      : `下载中 ${p.percent || 0}% · ${((p.received || 0) / 1048576).toFixed(1)}MB`;
  });

  loadJavas().then((javas) => mountJavaPanel(javas));
  javaSel.onchange = () => applyAndSave({ javaPath: javaSel.value });
  $('btn-java-rescan').onclick = async () => {
    javaHint.textContent = '扫描中…';
    const javas = await api.javaList().catch(() => []);
    if (!javaSel.isConnected) return;
    javaSel.innerHTML = '<option value="">自动检测</option>';
    javas.forEach((j) => {
      const o = ce('option');
      o.value = j.path;
      o.textContent = `Java ${j.major} · ${j.path}`;
      javaSel.appendChild(o);
    });
    javaSel.value = c.javaPath || '';
    javaHint.textContent = javas.length ? `检测到 ${javas.length} 个 Java` : '未检测到 Java，可点击下方一键下载';
    mountJavaPanel(javas);
  };
  $('btn-java').onclick = async () => {
    const file = await api.javaPick();
    if (file) {
      if (![...javaSel.options].some((o) => o.value === file)) {
        const o = ce('option');
        o.value = file;
        o.textContent = `手动 · ${file}`;
        javaSel.appendChild(o);
      }
      javaSel.value = file;
      applyAndSave({ javaPath: file });
    }
  };

  $('set-mirror').value = c.mirror;
  $('set-mirror').onchange = () => applyAndSave({ mirror: $('set-mirror').value });
  $('set-snapshots').onchange = () => applyAndSave({ showSnapshots: $('set-snapshots').checked });
  $('set-boost').onchange = () => applyAndSave({ speedBoost: $('set-boost').checked });

  // Aikar's G1GC 优化参数
  const AIKAR_ARGS = '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1';
  const AIKAR_OLD_ARGS = '-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:MaxGCPauseMillis=150 -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1';
  $('btn-aikar').onclick = () => { $('set-jvm').value = AIKAR_ARGS; toast('已填入 Aikar\'s G1GC 优化参数（Java 17+）'); };
  $('btn-aikar-old').onclick = () => { $('set-jvm').value = AIKAR_OLD_ARGS; toast('已填入 Aikar\'s G1GC 旧版参数（Java 8）'); };
  $('btn-jvm-clear').onclick = () => { $('set-jvm').value = ''; toast('已清除 JVM 参数'); };

  // 快速打开文件夹
  $('qa-game').onclick = () => api.openGameDir();
  $('qa-mods').onclick = () => api.openModsDir();
  $('qa-config').onclick = () => api.openConfigDir();
  $('qa-saves').onclick = () => api.openSavesDir();

  /* ---------- 翻译 / AI ---------- */
  const aiCfg = () => ({
    baseUrl: $('ai-base').value.trim(),
    model: $('ai-model').value.trim(),
    apiKey: $('ai-key').value.trim(),
  });
  api.aiProviders().then((list) => {
    const box = $('ai-presets');
    if (!box || !box.isConnected) return;
    box.innerHTML = list.map((p) => `<button class="ai-chip" type="button" data-ai="${p.id}">${escapeHtml(p.name)}</button>`).join('');
    box.querySelectorAll('[data-ai]').forEach((b) => {
      const p = list.find((x) => x.id === b.dataset.ai);
      b.onclick = () => {
        $('ai-base').value = p.baseUrl;
        $('ai-model').value = p.model;
        toast(`已填入 ${p.name} 的接口地址`);
      };
    });
  }).catch(() => { /* 预设加载失败不影响手填 */ });

  $('ai-save').onclick = () => {
    applyAndSave({ ai: aiCfg() });
    $('ai-status').textContent = '已保存';
    toast('AI 配置已保存');
  };
  $('ai-test').onclick = async () => {
    const st = $('ai-status');
    const btn = $('ai-test');
    btn.disabled = true;
    st.textContent = '正在测试…';
    try {
      const r = await api.aiTest(aiCfg());
      st.textContent = r.models && r.models.length
        ? `连接成功 · ${r.models.length} 个模型可用`
        : '连接成功';
      toast('AI 接口连接正常');
    } catch (e) {
      st.textContent = '连接失败：' + e.message;
      toast('连接失败：' + e.message, true);
    } finally {
      btn.disabled = false;
    }
  };

  const runTranslate = async (target) => {
    const src = $('ai-text').value.trim();
    const box = $('ai-result');
    if (!src) return toast('请输入要翻译的内容', true);
    box.hidden = false;
    box.textContent = '翻译中…';
    try {
      const r = await api.aiTranslate(aiCfg(), src, target);
      if (!box.isConnected) return;
      box.textContent = r.text;
      if (r.chunks > 1) box.textContent += `\n\n（共 ${r.chunks} 段）`;
    } catch (e) {
      if (box.isConnected) box.textContent = '翻译失败：' + e.message;
      toast('翻译失败：' + e.message, true);
    }
  };
  $('ai-do').onclick = () => runTranslate('简体中文');
  $('ai-do-en').onclick = () => runTranslate('English');

  $('btn-migrate-scan').onclick = () => scanOtherLaunchers($('btn-migrate-scan'));
  $('btn-migrate-pick').onclick = () => scanPickedDir($('btn-migrate-pick'));

  // ========== 实验功能：通知浮岛 ==========
  $('set-island').onchange = async (e) => {
    await api.configSet('islandEnabled', e.target.checked);
    state.config.islandEnabled = e.target.checked;
    $('island-test-hint').textContent = e.target.checked ? '已开启' : '已关闭';
  };
  $('btn-island-test').onclick = () => {
    if (!state.config.islandEnabled) {
      $('set-island').checked = true;
      api.configSet('islandEnabled', true);
      state.config.islandEnabled = true;
    }
    islandNotify({ ico: '🎉', title: '通知浮岛已就绪', desc: '以后下载完成的消息会从这里弹出来' });
  };

  // ========== 更新 ==========
  const up = state.config.update || {};
  $('up-url').value = up.url || 'https://github.com/BlockVibe001/cm-launcher/releases/latest/download/update.json';
  $('up-auto').checked = up.autoCheck !== false;
  $('up-cur').textContent = `v${(state.updateInfo || {}).version || '1.0.0'}`;

  /** 摆好按钮：安装版给「立即更新」，清单里带了下载页就给「打开下载页」；免安装版只留后者 */
  const refreshUpActions = (status) => {
    const m = pendingUpdate;
    const portable = !!(state.updateInfo || {}).portable;
    $('up-action').hidden = !(m && m.installer && !portable);
    $('up-page').hidden = !(m && m.page);
    $('up-notes').textContent = (m && m.notes) || '';
    $('up-notes').hidden = !(m && m.notes);
    if (status !== undefined) $('up-status').textContent = status;
  };
  refreshUpActions(pendingUpdate
    ? `发现新版本 v${pendingUpdate.latest}（当前 v${pendingUpdate.current}）`
      + ((state.updateInfo || {}).portable ? ' · 免安装版请到下载页取新版' : '')
    : '');

  $('up-save').onclick = async () => {
    const url = $('up-url').value.trim();
    await api.configUpdate({ update: { url, autoCheck: $('up-auto').checked } });
    state.config = await api.configGetAll();
    toast(url ? '更新设置已保存' : '已清空更新地址，不再检查更新');
  };

  $('up-check').onclick = async () => {
    const url = $('up-url').value.trim();
    if (!url) return toast('请先填写更新地址', true);
    const btn = $('up-check');
    btn.disabled = true;
    btn.textContent = '检查中…';
    try {
      const res = await api.updaterCheck(url);
      pendingUpdate = res.hasUpdate ? res : null;
      paintUpdateDot();
      $('up-progress').hidden = true;
      $('up-fill').style.width = '0';
      refreshUpActions(res.hasUpdate
        ? `发现新版本 v${res.latest}（当前 v${res.current}）${res.portable ? ' · 免安装版请到下载页取新版' : ''}`
        : `已是最新版 v${res.current}`);
      toast(res.hasUpdate ? `发现新版本 v${res.latest}` : '已是最新版');
    } catch (e) {
      toast(`检查更新失败：${e.message}`, true);
      $('up-status').textContent = `检查失败：${e.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '检查更新';
    }
  };

  $('up-action').onclick = async () => {
    const m = pendingUpdate;
    if (!m) return;
    const btn = $('up-action');
    btn.disabled = true;
    $('up-progress').hidden = false;
    $('up-fill').style.width = '0';
    $('up-status').textContent = '准备下载…';
    try {
      const r = await api.updaterDownload(m);
      $('up-status').textContent = '安装包已就绪，正在启动安装程序…';
      await api.updaterInstall(r.path);
      $('up-status').textContent = '已启动安装程序，启动器即将退出';
    } catch (e) {
      toast(`更新失败：${e.message}`, true);
      $('up-status').textContent = `更新失败：${e.message}`;
      btn.disabled = false;
    }
  };

  $('up-page').onclick = () => {
    if (pendingUpdate && pendingUpdate.page) api.updaterOpen(pendingUpdate.page);
  };

  $('btn-save-settings').onclick = () => {
    const maxMem = parseInt($('set-maxmem').value) || 4096;
    const minMem = parseInt($('set-minmem').value) || 512;
    if (minMem > maxMem) return toast('最小内存不能大于最大内存', true);
    applyAndSave({
      maxMemory: maxMem,
      minMemory: minMem,
      jvmArgs: $('set-jvm').value,
      width: parseInt($('set-width').value) || 854,
      height: parseInt($('set-height').value) || 480,
    });
    toast('设置已保存');
  };

  // ========== 内存管理 ==========
  if (state._memTimer) { clearInterval(state._memTimer); state._memTimer = null; }

  // 大号数字用 GB 更像 PCL2，小数值（不足 1GB）退回 MB 免得显示成 0.0 GB
  const fmtMem = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

  // 计划分配：内存条上那条竖线标记的位置
  const paintPlan = (totalMB) => {
    const planEl = $('mem-plan');
    const numEl = $('mem-plan-num');
    if (!planEl || !numEl) return;
    const val = parseInt(($('set-maxmem') || {}).value, 10) || state.config.maxMemory || 0;
    numEl.textContent = val ? fmtMem(val) : '—';
    if (!val || !totalMB) { planEl.style.display = 'none'; return; }
    planEl.style.display = 'block';
    planEl.style.left = `${Math.min(100, (val / totalMB) * 100)}%`;
  };

  // 刻度：每格 1GB（内存很大时每格 4GB），保证格数落在 8~32 之间
  const paintTicks = (totalMB) => {
    const tickEl = $('mem-ticks');
    if (!tickEl || !totalMB) return;
    const segMB = totalMB > 32768 ? 4096 : totalMB > 16384 ? 2048 : 1024;
    const segs = Math.max(2, Math.round(totalMB / segMB));
    tickEl.style.setProperty('--seg', `${100 / segs}%`);
  };

  const refreshMemInfo = async () => {
    try {
      const info = await api.memoryInfo();
      // 异步返回时可能已经离开设置页
      if (state.currentPage !== 'settings') return;
      const totalEl = $('mem-total');
      if (!totalEl) return;
      const pct = info.usedPercent;
      state._memTotalMB = info.totalMB;
      totalEl.textContent = fmtMem(info.totalMB);
      $('mem-used').textContent = fmtMem(info.usedMB);
      $('mem-free').textContent = fmtMem(info.freeMB);
      $('mem-proc').textContent = fmtMem(info.processMB);

      $('mem-used-num').textContent = fmtMem(info.usedMB);
      $('mem-total-num').textContent = fmtMem(info.totalMB);
      $('mem-pct').textContent = `${pct}%`;
      $('mem-gauge').dataset.level = pct > 85 ? 'high' : pct > 65 ? 'mid' : 'ok';
      $('mem-free-hint').textContent = `可用 ${fmtMem(info.freeMB)}`;

      $('mem-fill').style.width = `${pct}%`;
      // 启动器占用贴在已用段的右端，跟系统已用区分开
      const procPct = Math.min(pct, (info.processMB / info.totalMB) * 100);
      $('mem-proc-bar').style.width = `${procPct}%`;
      $('mem-proc-bar').style.left = `${Math.max(0, pct - procPct)}%`;

      paintTicks(info.totalMB);
      paintPlan(info.totalMB);
    } catch {}
  };
  refreshMemInfo();
  state._memTimer = setInterval(refreshMemInfo, 2000);
  // 手改最大内存时标记线要跟着动
  if ($('set-maxmem')) $('set-maxmem').addEventListener('input', () => paintPlan(state._memTotalMB || 0));

  // 自动分配内存
  $('btn-auto-mem').onclick = async () => {
    const btn = $('btn-auto-mem');
    btn.disabled = true;
    btn.textContent = '计算中…';
    try {
      const rec = await api.memoryRecommend();
      $('set-maxmem').value = rec.recommended;
      $('set-minmem').value = rec.minRecommended;
      const tip = $('mem-recommend-tip');
      tip.style.display = 'block';
      tip.textContent = `物理内存 ${rec.totalGB}GB（${rec.band} 档）→ 推荐最大 ${fmtMem(rec.recommended)}、最小 ${fmtMem(rec.minRecommended)}；`
        + `本机上限 ${fmtMem(rec.limitMB)}（不超过物理内存一半，也不超过当前可用内存的 80%）。`
        + `${rec.isBase ? '' : '当前可用内存偏紧，已按可用量下调。'}点「保存设置」生效。`;
      paintPlan(rec.totalMB);
      toast(`推荐最大内存 ${fmtMem(rec.recommended)}`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '⚙ 自动分配内存';
    }
  };

  // ---- 清理强度等级 ----
  const LEVEL_NAME = ['', '轻度', '标准', '增强', '深度', '强力', '极限'];
  const LEVEL_DESC = {
    1: '一级 · 轻度：只收回启动器自身进程的工作集，瞬间完成，不需要授权。',
    2: '二级 · 标准：连带收回全系统进程的工作集（普通权限能收的部分）。',
    3: '三级 · 增强：请求管理员权限，清空低优先级待机内存（系统缓存的一部分）。',
    4: '四级 · 深度：管理员权限清空全部待机内存——待机内存常占 1~4GB，开游戏前清一次最划算。',
    5: '五级 · 强力：再把已修改页面写回磁盘、收缩系统文件缓存，释放更彻底。',
    6: '六级 · 极限：整套操作连续执行两轮，把内存压到最低。',
  };
  let cleanLevel = 3;
  const selectLevel = (lv) => {
    cleanLevel = lv;
    document.querySelectorAll('#mem-levels button').forEach((b) => {
      b.classList.toggle('primary', parseInt(b.dataset.level, 10) === lv);
    });
    const descEl = $('mem-level-desc');
    if (descEl) {
      descEl.textContent = LEVEL_DESC[lv]
        + (lv >= 3 ? '　点击清理后会弹出系统 UAC 授权框，请点「是」。' : '');
    }
  };
  document.querySelectorAll('#mem-levels button').forEach((b) => {
    b.onclick = () => selectLevel(parseInt(b.dataset.level, 10));
  });
  selectLevel(3);

  // 一键清理内存（按选中的强度等级执行）
  $('btn-clean-mem').onclick = async () => {
    const btn = $('btn-clean-mem');
    const gauge = $('mem-gauge');
    btn.disabled = true;
    btn.textContent = cleanLevel >= 3 ? '等待管理员授权…' : '清理中…';
    if (gauge) gauge.classList.add('cleaning');
    try {
      const r = await api.memoryClean(cleanLevel);
      const tip = $('mem-recommend-tip');
      tip.style.display = 'block';

      if (r.cancelled) {
        tip.textContent = `已取消管理员授权，${LEVEL_NAME[r.level]}清理未执行。重新点击清理并在 UAC 框里选「是」即可。`;
        toast('已取消管理员授权', true);
      } else {
        const sysFreed = r.systemFreedMB;
        const standbyOk = r.lowStandbyStatus === 0 || r.standbyStatus === 0;
        const parts = [`【${'一二三四五六'[r.level - 1]}级 · ${LEVEL_NAME[r.level]}】本次释放系统内存 ${fmtMem(sysFreed)}`];
        parts.push(`启动器占用 ${fmtMem(r.appBeforeMB)} → ${fmtMem(r.appAfterMB)}`);
        if (r.sysTrimmed > 0) parts.push(`修剪进程 ${r.sysTrimmed} 个`);
        if (r.level >= 3 && !standbyOk) parts.push('待机内存未能清空（可能被安全软件拦截）');
        let text = parts.join('，') + '。';
        if (r.level >= 3) {
          text += '清理会暂时清掉系统文件缓存，接下来短时间内打开程序、读存档可能稍慢，属正常现象。';
        }
        tip.textContent = text;
        toast(sysFreed > 0 ? `已释放 ${fmtMem(sysFreed)}` : '内存已是低位');
      }
      await refreshMemInfo();
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (gauge) gauge.classList.remove('cleaning');
      btn.disabled = false;
      btn.textContent = '🧹 一键清理内存';
    }
  };
}

function applyAndSave(patch) {
  Object.assign(state.config, patch);
  applyTheme();
  api.configUpdate(patch);
}

/* ========== 可拉液态玻璃：高光跟随指针 + 按住拖动果冻回弹 ========== */

// 参与液态效果的玻璃根。顶栏也在内（高光能用），但它同时是系统的窗口拖拽区，
// 「拖顶栏 = 拖窗口」更重要，所以下面单独禁掉它的「可拉」。
const LIQUID_ROOT = '.glass,.panel,.panel-strong,.glass-strong,.card,.cat-bar,.stat-card,'
  + '.sv-card,.dl-row,.skin-cell,.inst-card,.theme-card,.widget,.quick-card,.acc-card,.modal,.sidenav,.topbar';
// 指针与玻璃根之间只要碰到这些（或手写 onclick 的元素），就完全不管，照常点击
const LIQUID_EXCLUDE = 'button,a,input,select,textarea,label,[contenteditable="true"],'
  + '.ui-opt,.ui-check,.accent-dot,.topbar-drag,[data-no-jelly]';
const LIQUID_NO_DRAG = 'topbar';
const LIQUID_THRESHOLD = 6;   // px：位移不到它就算点击，绝不抢

// 页面重建时要收回手势，绑定前先给个空实现
let liquidFinish = () => {};

function bindLiquidGlass() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let dragEl = null;               // 已升级成拖动的玻璃根
  let start = null;                // { x, y, el }
  let last = null;                 // { x, y, t }，用来估甩动速度
  let velocity = { x: 0, y: 0 };
  let point = null;                // 本帧要写入的坐标
  let raf = 0;

  /** 从事件目标往上找玻璃根；中途遇到控件就当没命中 */
  const glassRootOf = (target) => {
    if (!(target instanceof Element)) return null;
    const root = target.closest(LIQUID_ROOT);
    if (!root) return null;
    for (let n = target; n && n !== root; n = n.parentElement) {
      if (n.matches && n.matches(LIQUID_EXCLUDE)) return null;
      if (n.onclick) return null;   // div + onclick 的手写按钮
    }
    return root;
  };

  // 每帧只写一个元素：拖动时更新果冻变形，坐标读取全在这里做
  const frame = () => {
    raf = 0;
    if (!dragEl || !point || !start) return;
    if (!dragEl.isConnected) { finish(false); return; }
    const rect = dragEl.getBoundingClientRect();
    dragEl.style.transform = GlassMotion.jellyTransform({
      dx: point.x - start.x,
      dy: point.y - start.y,
      w: rect.width,
      h: rect.height,
      velocity,
    }).transform;
  };
  const request = () => { if (!raf) raf = requestAnimationFrame(frame); };

  /** 收手：清掉内联变形，松手时挂一次回弹过渡 */
  const finish = (release) => {
    if (dragEl) {
      const el = dragEl;
      dragEl = null;
      if (el.isConnected) {
        el.style.transform = '';
        el.classList.remove('jelly-drag');
        if (release && !reduce.matches) {
          el.classList.add('jelly-release');
          setTimeout(() => { if (el.isConnected) el.classList.remove('jelly-release'); }, 460);
        }
      }
    }
    start = null;
    last = null;
    point = null;
    velocity = { x: 0, y: 0 };
  };
  liquidFinish = finish;

  const upgrade = (e) => {
    const el = start.el;
    dragEl = el;
    el.classList.add('jelly-drag');
    try { el.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
    // 拖完吞掉这一次 click，免得卡片原本的 onclick 被误触发
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    document.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', swallow, true), 400);
  };

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    const el = glassRootOf(e.target);
    if (!el) return;
    start = { x: e.clientX, y: e.clientY, el };
    last = { x: e.clientX, y: e.clientY, t: performance.now() };
    point = { x: e.clientX, y: e.clientY };
    velocity = { x: 0, y: 0 };
  });

  document.addEventListener('pointermove', (e) => {
    // 没有按下就什么都不做：高光已经去掉，悬停不再需要跟踪
    if (!start) return;
    point = { x: e.clientX, y: e.clientY };
    if (!dragEl && !reduce.matches && !start.el.classList.contains(LIQUID_NO_DRAG)
      && Math.hypot(point.x - start.x, point.y - start.y) >= LIQUID_THRESHOLD) {
      upgrade(e);
    }
    if (dragEl) {
      const now = performance.now();
      const dt = now - last.t;
      if (dt >= 8) {
        velocity = { x: (point.x - last.x) / dt * 1000, y: (point.y - last.y) / dt * 1000 };
        last = { x: point.x, y: point.y, t: now };
      }
      request();
    }
  }, { passive: true });

  document.addEventListener('pointerup', () => finish(true));
  document.addEventListener('pointercancel', () => finish(false));
  // 指针在窗口外松开、拖动中页面滚动、以及系统接管文件拖拽，都要收手
  window.addEventListener('blur', () => finish(false));
  document.addEventListener('scroll', () => { if (dragEl) finish(false); }, true);
  document.addEventListener('dragenter', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) finish(false);
  });
}

/* ========== 全局事件 ========== */

function bindGlobalEvents() {
  bindDropImport();
  bindLiquidGlass();
  api.onProgress((p) => {
    if (state.currentPage === 'home') {
      showHomeProgress(`下载校验 ${p.completed}/${p.total} · ${p.current}`, p.percent);
    }
  });
  api.onModloaderProgress((p) => {
    if ($('loading-text')) $('loading-text').textContent = p.step || '';
  });
  api.onGameStarted(() => {
    state.busy = true;
    if (state.currentPage === 'home') {
      const btn = $('home-play');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '🎮 游戏运行中…';
      }
    }
    hideHomeProgress();
    toast('游戏已启动', false, { ico: '🎮', desc: '祝你玩得开心', hold: 2800 });
  });
  api.onGameExit((code) => {
    state.busy = false;
    if (state.currentPage === 'home') {
      const btn = $('home-play');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="play-ico"></span>立即启动'; }
    }
    if (code && code !== 0) {
      toast(`游戏异常退出（代码 ${code}）`, true, { ico: '🏁', hold: 4200 });
    } else {
      islandNotify({ ico: '🏁', title: '游戏已退出', desc: '欢迎下次再来', hold: 2600 });
    }
  });
  api.onLog((entry) => {
    pushLog(entry);
  });
  // 游戏日志里冒出「已对局域网开放」时，把端口交给联机页去打通公网
  api.onLanPort((info) => {
    if (typeof state.lanPortHook === 'function') state.lanPortHook(info);
  });
  // 陶瓦联机推过来的房间状态，交给联机页刷新
  api.onScaffoldState((s) => {
    if (typeof state.tcHook === 'function') state.tcHook(s);
  });
  // EasyTier 联机推过来的房间状态，交给联机页刷新
  api.onEasytierState((s) => {
    if (typeof state.etHook === 'function') state.etHook(s);
  });
  api.onMigrateProgress((p) => {
    const el = document.getElementById('mig-progress');
    if (el) el.textContent = `${p.done}/${p.total} · ${p.label}`;
  });
}

/* ========== 拖拽智能导入 ========== */

const DND_KINDS = [
  { id: 'mod', label: '模组', icon: '🧩' },
  { id: 'resourcepack', label: '资源包', icon: '🎨' },
  { id: 'shaderpack', label: '光影包', icon: '✨' },
  { id: 'datapack', label: '数据包', icon: '📦' },
  { id: 'world', label: '世界存档', icon: '🌍' },
  { id: 'modpack', label: '整合包', icon: '🗃️' },
  { id: 'schematic', label: '投影文件', icon: '📐' },
];

function dndKind(id) {
  return DND_KINDS.find((k) => k.id === id) || { id: 'unknown', label: '未识别', icon: '❓' };
}

function bindDropImport() {
  const overlay = $('drop-overlay');
  if (!overlay) return;

  let depth = 0;
  const hasFiles = (e) => {
    const t = e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
  };

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });

  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;

    const paths = [];
    for (const f of Array.from(e.dataTransfer.files || [])) {
      let p = f.path || '';
      if (!p && api.pathForFile) p = api.pathForFile(f);
      if (p) paths.push(p);
    }

    // 文件夹无法取到绝对路径，提示用户压缩后再拖
    let dirs = 0;
    if (e.dataTransfer.items) {
      for (const it of Array.from(e.dataTransfer.items)) {
        try {
          const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
          if (entry && entry.isDirectory) dirs++;
        } catch { /* ignore */ }
      }
    }
    if (dirs) toast(`已忽略 ${dirs} 个文件夹，请压缩为 zip 后再拖入`, true);

    if (!paths.length) {
      if (!dirs) toast('未获取到文件路径，可改用「本地导入」按钮', true);
      return;
    }
    openImportDialog(paths);
  });
}

/** 弹出导入确认弹窗 */
async function openImportDialog(paths) {
  let items = [];
  showLoading('正在识别文件…');
  try {
    items = await api.dndInspect(paths);
  } catch (e) {
    hideLoading();
    toast('识别失败：' + e.message, true);
    return;
  }
  hideLoading();
  if (!items.length) { toast('没有可导入的文件', true); return; }

  const instanceMap = state.config.instances || {};
  const entries = Object.entries(instanceMap);
  if (!entries.length) {
    toast('还没有实例，请先下载游戏版本建好实例再导入', true);
    return;
  }
  const curId = state.selectedInstance in instanceMap ? state.selectedInstance : entries[0][0];
  const needWorld = items.some((it) => it.kind === 'datapack');

  const mask = ce('div', 'modal-mask');
  mask.innerHTML = `
    <div class="modal wide import-modal">
      <div class="modal-title">导入 ${items.length} 个文件</div>
      <div class="imp-target">
        <label class="imp-field"><span>目标实例</span>
          <select class="input" id="imp-inst">
            ${entries.map(([id, i]) => `<option value="${escapeHtml(id)}" ${id === curId ? 'selected' : ''}>${escapeHtml(i.name)}</option>`).join('')}
          </select>
        </label>
        <label class="imp-field" id="imp-world-field" ${needWorld ? '' : 'hidden'}><span>目标世界（数据包用）</span>
          <select class="input" id="imp-world"><option value="">加载中…</option></select>
        </label>
      </div>
      <div class="imp-list">
        ${items.map((it, i) => `
          <div class="imp-row" data-idx="${i}">
            <span class="imp-ico">${dndKind(it.kind).icon}</span>
            <div class="imp-info">
              <div class="imp-name" title="${escapeHtml(it.path)}">${escapeHtml(it.name)}</div>
              <div class="imp-detail">${escapeHtml(it.detail || '未识别')} · ${it.isDir ? '文件夹' : formatSize(it.size)}</div>
            </div>
            <select class="input imp-kind" data-idx="${i}">
              ${DND_KINDS.map((k) => `<option value="${k.id}" ${k.id === it.kind ? 'selected' : ''}>${k.icon} ${k.label}</option>`).join('')}
            </select>
          </div>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="imp-cancel" type="button">取消</button>
        <button class="btn primary" id="imp-ok" type="button">导入</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);

  const instSel = mask.querySelector('#imp-inst');
  const worldSel = mask.querySelector('#imp-world');
  const worldField = mask.querySelector('#imp-world-field');

  const fillWorlds = async (instId) => {
    worldSel.innerHTML = '<option value="">加载中…</option>';
    try {
      const saves = await api.contentSaves(instGameDir(instanceMap[instId]));
      if (!worldSel.isConnected) return;
      if (!saves.length) {
        worldSel.innerHTML = '<option value="">（该实例暂无存档）</option>';
        return;
      }
      worldSel.innerHTML = '<option value="">（未选择）</option>'
        + saves.map((s) => `<option value="${escapeHtml(s.path)}">${escapeHtml(s.name)}</option>`).join('');
    } catch {
      if (worldSel.isConnected) worldSel.innerHTML = '<option value="">（读取失败）</option>';
    }
  };

  const refreshWorldField = () => {
    const need = Array.from(mask.querySelectorAll('.imp-kind')).some((s) => s.value === 'datapack');
    worldField.hidden = !need;
    return need;
  };

  mask.querySelectorAll('.imp-kind').forEach((sel) => {
    sel.onchange = () => {
      const row = sel.closest('.imp-row');
      const ico = row && row.querySelector('.imp-ico');
      if (ico) ico.textContent = dndKind(sel.value).icon;
      refreshWorldField();
    };
  });

  instSel.onchange = () => fillWorlds(instSel.value);
  if (needWorld) fillWorlds(curId);

  const close = () => mask.remove();
  mask.querySelector('#imp-cancel').onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };

  mask.querySelector('#imp-ok').onclick = async () => {
    const btn = mask.querySelector('#imp-ok');
    const instId = instSel.value;
    const worldDir = worldSel.value || '';
    const list = Array.from(mask.querySelectorAll('.imp-row')).map((row) => {
      const it = items[Number(row.dataset.idx)];
      return {
        path: it.path,
        name: it.name,
        ext: it.ext,
        isDir: it.isDir,
        detail: it.detail,
        kind: row.querySelector('.imp-kind').value,
      };
    });
    if (list.some((x) => x.kind === 'datapack') && !worldDir) {
      toast('数据包需要先选择目标世界', true);
      return;
    }

    btn.disabled = true;
    btn.textContent = '导入中…';
    try {
      const res = await api.dndImport(list, {
        gameDir: instGameDir(instanceMap[instId]),
        gameRoot: state.config.gameDir,
        worldDir,
        instanceId: instId,
      });
      close();
      await refreshConfig();
      showImportResult(res);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '导入';
      toast('导入失败：' + e.message, true);
    }
  };
}

function showImportResult(res) {
  const schematics = res.results.filter((r) => r.action === 'schematic');
  const mask = ce('div', 'modal-mask');
  mask.innerHTML = `
    <div class="modal wide import-modal">
      <div class="modal-title">导入完成 · 成功 ${res.ok} · 失败 ${res.failed}</div>
      <div class="imp-list">
        ${res.results.map((r) => `
          <div class="imp-row">
            <span class="imp-ico">${r.ok ? (r.action === 'schematic' ? '📐' : '✅') : '⚠️'}</span>
            <div class="imp-info">
              <div class="imp-name">${escapeHtml(r.name)}</div>
              <div class="imp-detail">${escapeHtml(r.message || '')}</div>
            </div>
          </div>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn primary" id="imp-done" type="button">知道了</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  mask.querySelector('#imp-done').onclick = () => {
    mask.remove();
    if (schematics.length) { openSchematicFromDrop(schematics[0].path); return; }
    if (res.newInstances && res.newInstances.length) {
      state.selectedInstance = res.newInstances[0].id;
      api.configSet('selectedInstance', res.newInstances[0].id);
      renderPage('instances');
    }
  };
}

/** 把拖入的投影文件直接送到实验室打开 */
async function openSchematicFromDrop(p) {
  try {
    const res = await api.labSchematicOpen(p);
    if (res.canceled) return;
    schState = res;
    schView = { mode: 'layer', y: Math.floor(res.size.y / 2), rot: 0, spacing: 12 };
    labTab = 'schematic';
    renderPage('lab');
    toast(`已在实验室打开：${res.name || res.path.split(/[\\/]/).pop()}`);
  } catch (e) {
    toast('读取投影失败：' + e.message, true);
  }
}

/* ========== 从其他启动器搬家（PCL2 / HMCL） ========== */

async function scanOtherLaunchers(btn) {
  const hint = $('migrate-hint');
  if (btn) { btn.disabled = true; btn.textContent = '🔍 扫描中…'; }
  if (hint) hint.textContent = '正在探测…';
  try {
    const found = await api.migrateDetect();
    if (!hint || !hint.isConnected) return;
    if (!found.length) {
      hint.textContent = '未检测到 PCL2 / HMCL 的数据目录，点右边「手动选择目录」自己指一个';
      toast('没扫到，试试手动选择目录', true);
      return;
    }
    showMigrateFound(found, hint);
  } catch (e) {
    if (hint && hint.isConnected) hint.textContent = '扫描失败：' + e.message;
    toast('扫描失败：' + e.message, true);
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = '🔍 扫描其他启动器'; }
  }
}

/** 手动指定一个目录来搬家（自动扫描够不着时用） */
async function scanPickedDir(btn) {
  const hint = $('migrate-hint');
  let dir = null;
  try {
    dir = await api.pickDir();
  } catch { /* 对话框取消失败就算了 */ }
  if (!dir) return;
  if (btn) { btn.disabled = true; btn.textContent = '读取中…'; }
  try {
    const found = await api.migrateDetectIn(dir);
    if (!hint || !hint.isConnected) return;
    showMigrateFound(found, hint);
  } catch (e) {
    if (hint && hint.isConnected) hint.textContent = '这个目录用不了：' + e.message;
    toast(e.message, true);
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = '📁 手动选择目录'; }
  }
}

function showMigrateFound(found, hint) {
  const vCount = found.reduce((n, l) => n + l.gameDirs.reduce((m, g) => m + g.versions.length, 0), 0);
  const sCount = found.reduce((n, l) => n + l.gameDirs.reduce((m, g) => m + g.saves.length, 0), 0);
  hint.textContent = `检测到 ${found.map((l) => l.name).join(' / ')} · 共 ${vCount} 个实例、${sCount} 个存档`;
  openMigrateDialog(found);
}

function openMigrateDialog(found) {
  const mask = ce('div', 'modal-mask');
  mask.innerHTML = `
    <div class="modal wide import-modal">
      <div class="modal-title">从其他启动器搬家</div>
      <div class="mig-rate">
        <label><input type="radio" name="mig-mode" value="link" checked> 引用（不复制文件，直接使用原目录）</label>
        <label><input type="radio" name="mig-mode" value="copy"> 复制（把文件搬进本启动器目录）</label>
      </div>
      <div class="imp-list" id="mig-body">
        ${found.map((l, li) => `
          <div class="mig-launcher">
            <div class="mig-head"><span class="mig-ico">${l.icon}</span>
              <b>${escapeHtml(l.fullName)}</b>
              <span class="mig-path" title="${escapeHtml(l.dataDir)}">${escapeHtml(l.dataDir)}</span>
            </div>
            ${l.gameDirs.map((g, gi) => `
              <div class="mig-game">
                <div class="mig-game-path" title="${escapeHtml(g.dir)}">📁 ${escapeHtml(g.dir)}</div>
                <label class="mig-all"><input type="checkbox" class="mig-all-cb" data-l="${li}" data-g="${gi}"> 全选该目录</label>
                ${g.versions.map((v) => `
                  <label class="mig-item">
                    <input type="checkbox" class="mig-ver" data-l="${li}" data-g="${gi}" value="${escapeHtml(v.id)}">
                    <span class="mig-name">${escapeHtml(v.id)}</span>
                    <span class="mig-tag">${v.modLoader === 'vanilla' ? '原版' : v.modLoader}${v.isolated ? ' · 已隔离' : ''}</span>
                    <span class="mig-meta">${v.mods} 模组 · ${v.saves} 存档</span>
                  </label>`).join('')}
                ${g.saves.length ? `
                  <div class="mig-sub">存档</div>
                  ${g.saves.map((s) => `
                    <label class="mig-item">
                      <input type="checkbox" class="mig-save" data-l="${li}" data-g="${gi}" value="${escapeHtml(s)}">
                      <span class="mig-name">🌍 ${escapeHtml(s)}</span>
                    </label>`).join('')}` : ''}
              </div>`).join('')}
          </div>`).join('')}
      </div>
      <div class="mig-opt">
        <label><input type="checkbox" id="mig-apply-settings" checked> 同时套用对方的最大内存设置</label>
        <span id="mig-progress" class="mig-progress"></span>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="mig-cancel" type="button">取消</button>
        <button class="btn primary" id="mig-ok" type="button">开始搬家</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);

  mask.querySelectorAll('.mig-all-cb').forEach((cb) => {
    cb.onchange = () => {
      const { l, g } = cb.dataset;
      mask.querySelectorAll(`.mig-ver[data-l="${l}"][data-g="${g}"], .mig-save[data-l="${l}"][data-g="${g}"]`)
        .forEach((x) => { x.checked = cb.checked; });
    };
  });

  const close = () => mask.remove();
  mask.querySelector('#mig-cancel').onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };

  mask.querySelector('#mig-ok').onclick = async () => {
    const btn = mask.querySelector('#mig-ok');
    const mode = (mask.querySelector('input[name="mig-mode"]:checked') || {}).value || 'link';
    const applySettings = mask.querySelector('#mig-apply-settings').checked;
    const picked = Array.from(mask.querySelectorAll('.mig-ver:checked'))
      .map((x) => ({ l: Number(x.dataset.l), g: Number(x.dataset.g), id: x.value }));
    const pickedSaves = Array.from(mask.querySelectorAll('.mig-save:checked'))
      .map((x) => ({ l: Number(x.dataset.l), g: Number(x.dataset.g), id: x.value }));
    if (!picked.length && !pickedSaves.length) { toast('请至少选择一个实例或存档', true); return; }

    // 按「启动器 + 游戏目录」分组执行
    const groups = new Map();
    const groupOf = (it) => {
      const key = `${it.l}-${it.g}`;
      if (!groups.has(key)) groups.set(key, { l: it.l, g: it.g, versions: [], saves: [] });
      return groups.get(key);
    };
    for (const it of picked) groupOf(it).versions.push(it.id);
    for (const it of pickedSaves) groupOf(it).saves.push(it.id);

    btn.disabled = true;
    btn.textContent = '搬家进行中…';
    const summary = { instances: [], saves: [], failed: [], skipped: [], settings: null };
    try {
      for (const grp of groups.values()) {
        const launcher = found[grp.l];
        const game = launcher.gameDirs[grp.g];
        const res = await api.migrateRun({
          mode,
          gameDir: game.dir,
          versions: [...new Set(grp.versions)],
          saves: [...new Set(grp.saves)],
          applySettings: !!(applySettings && launcher.settings && launcher.settings.maxMemory > 0),
          settings: launcher.settings,
        });
        summary.instances.push(...res.instances);
        summary.saves.push(...res.saves);
        summary.failed.push(...res.failed);
        summary.skipped.push(...res.skipped);
        if (res.settings) summary.settings = res.settings;
      }
      close();
      await refreshConfig();
      showMigrateResult(summary);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '开始搬家';
      toast('搬家失败：' + e.message, true);
    }
  };
}

async function showMigrateResult(res) {
  const mask = ce('div', 'modal-mask');
  const rows = [
    ...res.instances.map((i) => ({ ok: true, icon: '📦', name: i.name, detail: `实例已创建（${i.mode === 'copy' ? '复制' : '引用'}）· 版本 ${i.versionId} · ${i.mods} 个模组` })),
    ...res.saves.map((s) => ({ ok: true, icon: '🌍', name: s.name, detail: `存档已导入（源：${s.from}）` })),
    ...res.skipped.map((s) => ({ ok: true, icon: '⏭️', name: s.name, detail: s.message })),
    ...res.failed.map((f) => ({ ok: false, icon: '⚠️', name: f.name, detail: f.message })),
  ];
  mask.innerHTML = `
    <div class="modal wide import-modal">
      <div class="modal-title">搬家完成 · 实例 ${res.instances.length} · 存档 ${res.saves.length} · 失败 ${res.failed.length}</div>
      ${res.settings ? `<div class="mig-progress">已套用最大内存：${res.settings.maxMemory} MB</div>` : ''}
      <div class="imp-list">
        ${rows.map((r) => `
          <div class="imp-row">
            <span class="imp-ico">${r.icon}</span>
            <div class="imp-info">
              <div class="imp-name">${escapeHtml(r.name)}</div>
              <div class="imp-detail">${escapeHtml(r.detail)}</div>
            </div>
          </div>`).join('') || '<div class="mig-progress">没有可导入的内容</div>'}
      </div>
      <div class="modal-actions">
        <button class="btn primary" id="mig-done" type="button">知道了</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  mask.querySelector('#mig-done').onclick = () => {
    mask.remove();
    if (res.instances.length) renderPage('instances');
  };
}

/** 「本地导入」按钮：走同一套识别流程 */
async function importViaDialog() {
  const files = await api.pickFiles();
  if (!files || !files.length) return;
  openImportDialog(files);
}

/* ========== Toast / Loading ========== */

let toastTimer = null;
function toast(message, isError = false, island = null) {
  const el = $('toast');
  el.textContent = message;
  el.className = isError ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  // 第三参数：可覆盖浮岛的图标/描述，或传 false 表示这条只走 toast、不弹浮岛
  if (island !== false) {
    islandNotify(Object.assign(
      { title: message, err: isError, ico: isError ? '⚠️' : '🔔' },
      island,
    ));
  }
}

/* ---------- 通知浮岛（实验功能） ---------- */

const islandState = { queue: [], busy: false, waitRes: null };

/** 可被「点击胶囊」提前结束的等待 */
function islandWait(ms) {
  return new Promise((res) => {
    islandState.waitRes = res;
    setTimeout(res, ms);
  });
}
function islandSkipWait() {
  if (islandState.waitRes) islandState.waitRes();
}

async function islandDrain() {
  if (islandState.busy) return;
  if (!islandState.queue.length) return;
  islandState.busy = true;

  const host = $('notify-island');
  const pill = $('island-pill');
  pill.onclick = () => {
    islandState.queue.length = 0;   // 点一下：跳过当前、清掉排队
    islandSkipWait();
  };

  while (islandState.queue.length) {
    const item = islandState.queue.shift();
    $('island-ico').textContent = item.ico || '🔔';
    $('island-title').textContent = item.title || '';
    const desc = $('island-desc');
    desc.textContent = item.desc || '';
    desc.style.display = item.desc ? '' : 'none';
    pill.classList.toggle('err', !!item.err);

    host.hidden = false;
    void pill.offsetWidth;                       // 确保起始态先绘制，入场动画才跑得起来
    pill.classList.add('pop');                  // ① 小圆胶囊冒出来
    await islandWait(220);
    pill.classList.add('expanded');             // ② 横向展开露文字
    await islandWait(item.hold || 3400);

    pill.classList.remove('expanded');          // 收起
    await islandWait(300);
    pill.classList.remove('pop');
    await islandWait(300);
  }

  host.hidden = true;
  islandState.busy = false;
}

/**
 * 弹一条通知浮岛。开关关着就静默忽略（调用方无需判断）。
 * 连续相同标题的消息会被丢弃，避免一条消息刷一串胶囊。
 */
function islandNotify(item) {
  if (!state.config || !state.config.islandEnabled || !item || !item.title) return;
  const last = islandState.queue[islandState.queue.length - 1];
  if (last && last.title === item.title) return;
  islandState.queue.push(item);
  islandDrain();
}

function showLoading(text = '处理中…') {
  $('loading-text').textContent = text;
  $('global-loading').hidden = false;
}

function hideLoading() {
  $('global-loading').hidden = true;
}

init();
