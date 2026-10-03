// 内置浏览器窗口：多标签 + 地址栏 + 收藏栏
// 网页本身跑在 <webview> 里（每个标签一个），登录态由主进程的持久化分区负责，
// 这里的活只有「管标签、同步地址栏、收藏、显示下载结果」。
const $ = (id) => document.getElementById(id);

/** 空白标签页打开的位置 */
const HOME_URL = 'https://www.mcmod.cn/';

const MODE_LABEL = {
  auto: '下载：自动进实例',
  ask: '下载：每次问我',
  queue: '下载：只存下载目录',
};

const state = {
  tabs: [],
  active: '',
  marks: [],
  mode: 'auto',
};

let seq = 0;
let toastTimer = null;

/* ---------- 小工具 ---------- */

function toast(message) {
  const el = $('bw-toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function current() {
  return state.tabs.find((t) => t.id === state.active) || null;
}

/** 地址栏里输的东西：完整网址直接用，像域名的补 https，其余当搜索词 */
function normalize(raw) {
  const s = String(raw || '').trim();
  if (!s) return HOME_URL;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/|:|$)/.test(s)) return `https://${s}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
}

/* ---------- 标签页 ---------- */

function addTab(url, activate = true) {
  const view = document.createElement('webview');
  view.className = 'bw-view';
  view.setAttribute('src', normalize(url));
  view.setAttribute('allowpopups', '');
  view.hidden = true;
  $('bw-views').appendChild(view);

  const tab = { id: `t${++seq}`, view, url: view.getAttribute('src'), title: '加载中…', loading: true };
  state.tabs.push(tab);
  bindView(tab);
  if (activate) activateTab(tab.id);
  else renderTabs();
  return tab;
}

function activateTab(id) {
  state.active = id;
  for (const t of state.tabs) t.view.hidden = t.id !== id;
  const tab = current();
  if (tab) $('bw-url').value = tab.url;
  renderTabs();
  syncNav();
}

function closeTab(id) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [tab] = state.tabs.splice(i, 1);
  tab.view.remove();
  if (state.active !== id) { renderTabs(); return; }
  const next = state.tabs[i] || state.tabs[i - 1];
  if (next) activateTab(next.id);
  else addTab(HOME_URL);          // 关掉最后一个就补一个首页，窗口留着
}

function bindView(tab) {
  const v = tab.view;
  const sync = () => {
    try {
      tab.url = v.getURL() || tab.url;
      if (v.getTitle()) tab.title = v.getTitle();
    } catch { /* 视图还没挂上，下次再说 */ }
    if (state.active === tab.id) { $('bw-url').value = tab.url; syncNav(); }
    renderTabs();
  };
  v.addEventListener('did-start-loading', () => { tab.loading = true; renderTabs(); });
  v.addEventListener('did-stop-loading', () => { tab.loading = false; sync(); });
  v.addEventListener('did-navigate', (e) => { tab.url = e.url; sync(); });
  v.addEventListener('did-navigate-in-page', (e) => { tab.url = e.url; sync(); });
  v.addEventListener('page-title-updated', (e) => { tab.title = e.title || tab.title; renderTabs(); });
  v.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return;       // 用户自己中断的，不算失败
    toast(`打不开：${e.errorDescription || `错误 ${e.errorCode}`}`);
  });
}

function renderTabs() {
  const box = $('bw-tabs');
  box.innerHTML = '';
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = `bw-tab${tab.id === state.active ? ' on' : ''}`;
    const label = document.createElement('span');
    label.className = 'bw-tab-t';
    label.textContent = tab.title || tab.url || '新标签页';
    label.title = tab.url;
    el.appendChild(label);
    if (tab.loading) {
      const dot = document.createElement('i');
      dot.className = 'bw-tab-load';
      el.appendChild(dot);
    }
    const x = document.createElement('span');
    x.className = 'bw-tab-x';
    x.textContent = '✕';
    x.onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
    el.appendChild(x);
    el.onclick = () => activateTab(tab.id);
    box.appendChild(el);
  }
  updateStar();
}

function load(url) {
  const tab = current();
  if (!tab) { addTab(url); return; }
  tab.view.loadURL(normalize(url));
}

function go(where) {
  const tab = current();
  if (!tab) return;
  try {
    if (where === 'back' && tab.view.canGoBack()) tab.view.goBack();
    else if (where === 'fwd' && tab.view.canGoForward()) tab.view.goForward();
    else if (where === 'reload') tab.view.reload();
  } catch { /* 视图还没准备好 */ }
}

function syncNav() {
  const tab = current();
  let back = false;
  let fwd = false;
  try {
    back = !!(tab && tab.view.canGoBack());
    fwd = !!(tab && tab.view.canGoForward());
  } catch { /* 忽略 */ }
  $('bw-back').disabled = !back;
  $('bw-fwd').disabled = !fwd;
}

/* ---------- 收藏栏 ---------- */

function renderMarks() {
  const box = $('bw-marks');
  box.innerHTML = '';
  for (const m of state.marks) {
    const b = document.createElement('button');
    b.className = 'bw-mark';
    b.type = 'button';
    b.textContent = m.name || m.url;
    b.title = `${m.url}\n（右键可移除）`;
    b.onclick = () => load(m.url);
    b.oncontextmenu = async (e) => {
      e.preventDefault();
      state.marks = state.marks.filter((x) => x.url !== m.url);
      state.marks = await api.setBookmarks(state.marks);
      renderMarks();
    };
    box.appendChild(b);
  }
  updateStar();
}

function updateStar() {
  const tab = current();
  const marked = !!(tab && state.marks.some((m) => m.url === tab.url));
  $('bw-star').textContent = marked ? '★' : '☆';
}

async function toggleStar() {
  const tab = current();
  if (!tab || !/^https?:/i.test(tab.url || '')) return;
  const hit = state.marks.findIndex((m) => m.url === tab.url);
  if (hit >= 0) state.marks.splice(hit, 1);
  else state.marks.push({ name: tab.title || tab.url, url: tab.url });
  state.marks = await api.setBookmarks(state.marks);
  renderMarks();
}

/* ---------- 外观同步 ---------- */

function applyLook(info) {
  const t = info.theme || 'dark';
  const mode = t === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : t;
  document.body.setAttribute('data-mode', mode);
  document.body.setAttribute('data-accent', info.accent || 'axolotl');
  const g = Number((info.ui || {}).glassLevel);
  document.body.style.setProperty('--g', String(Number.isFinite(g) ? g / 100 : 0.55));
  // 只同步材质标识（亚克力的噪点等 CSS 靠它生效）；浏览器窗口不做「可拉」交互
  document.body.setAttribute('data-material', (info.ui || {}).glassMaterial || 'custom');
}

/* ---------- 启动 ---------- */

async function init() {
  const info = await api.info();
  applyLook(info);
  state.marks = info.bookmarks || [];
  state.mode = info.downloadMode || 'auto';

  const sel = $('bw-mode');
  for (const m of info.modes || ['auto', 'ask', 'queue']) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = MODE_LABEL[m] || m;
    sel.appendChild(o);
  }
  sel.value = state.mode;
  sel.onchange = async () => {
    state.mode = await api.setDownloadMode(sel.value);
  };

  $('bw-new').onclick = () => addTab(HOME_URL);
  $('bw-back').onclick = () => go('back');
  $('bw-fwd').onclick = () => go('fwd');
  $('bw-reload').onclick = () => go('reload');
  $('bw-home').onclick = () => load(HOME_URL);
  $('bw-star').onclick = () => toggleStar();
  $('bw-dir').onclick = () => api.openDownloadDir();
  $('bw-min').onclick = () => api.minimize();
  $('bw-max').onclick = () => api.toggleMaximize();
  $('bw-close').onclick = () => api.close();

  $('bw-url').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    load(e.target.value);
    e.target.blur();
  };

  renderMarks();

  // 启动器点开浏览器时带过来的地址 / 网页里点出来的新窗口
  api.onNavigate((url) => { if (url) load(url); });
  api.onNewTab((url) => addTab(url));

  api.onDownload((d) => {
    if (!d || !d.ok) return;
    const label = d.label && d.label !== '文件' ? `（${d.label}）` : '';
    toast(`已保存 ${d.name}${label}\n${d.dest}`);
  });

  addTab(HOME_URL);
}

init();