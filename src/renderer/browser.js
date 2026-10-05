/* CM 浏览器（Tauri 版）：书签栏 + 单标签 iframe 浏览 + 地址栏/前后退/窗口控制。
 * 由 browser.html 引入；主进程 browser.rs 通过 window.__pending_nav 驱动导航。
 */
(() => {
  if (!window.__TAURI__) return;
  const { invoke } = window.__TAURI__.core;
  const { getCurrentWindow } = window.__TAURI__.window;
  const win = getCurrentWindow();
  const $ = (id) => document.getElementById(id);

  const HOME_URL = 'https://www.mcmod.cn/';
  const MODE_LABEL = { auto: '下载：自动进实例', ask: '下载：每次问我', queue: '下载：只存下载目录' };

  const state = { marks: [], mode: 'auto', current: null };

  let toastTimer = null;
  function toast(message) {
    const el = $('bw-toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  function normalize(raw) {
    const s = String(raw || '').trim();
    if (!s) return HOME_URL;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[\w-]+(\.[\w-]+)+(\/|:|$)/.test(s)) return `https://${s}`;
    return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
  }

  /* ---------- 视图：单标签 iframe ---------- */
  let frame = null;
  function ensureFrame() {
    if (frame && frame.isConnected) return frame;
    frame = document.createElement('iframe');
    frame.className = 'bw-view';
    frame.allow = 'fullscreen';
    frame.setAttribute('allowfullscreen', '');
    $('bw-views').innerHTML = '';
    $('bw-views').appendChild(frame);
    frame.addEventListener('load', () => {
      syncNav();
      try { $('bw-url').value = frame.contentWindow.location.href; } catch { /* 跨域读不了地址 */ }
      renderTabs();
    });
    return frame;
  }

  function load(url) {
    const u = normalize(url);
    state.current = u;
    ensureFrame().src = u;
    $('bw-url').value = u;
    renderTabs();
    syncNav();
  }

  function back() { try { frame && frame.contentWindow.history.back(); } catch { toast('无法后退'); } }
  function fwd() { try { frame && frame.contentWindow.history.forward(); } catch { toast('无法前进'); } }
  function reload() { try { frame && frame.contentWindow.location.reload(); } catch { toast('无法刷新'); } }

  function syncNav() {
    // 跨域 iframe 读不到 history 长度，前后退按钮保持可点，动作交给 try/catch
    const has = !!state.current;
    $('bw-back').disabled = !has;
    $('bw-fwd').disabled = !has;
    updateStar();
  }

  /* ---------- 标签栏（单标签显示当前页） ---------- */
  function renderTabs() {
    const box = $('bw-tabs');
    box.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'bw-tab on';
    const label = document.createElement('span');
    label.className = 'bw-tab-t';
    label.textContent = state.current ? state.current.replace(/^https?:\/\//, '').slice(0, 40) : '网页';
    label.title = state.current || '';
    el.appendChild(label);
    box.appendChild(el);
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
      b.title = m.url;
      b.onclick = () => load(m.url);
      box.appendChild(b);
    }
    updateStar();
  }

  function updateStar() {
    const marked = !!state.current && state.marks.some((m) => m.url === state.current);
    $('bw-star').textContent = marked ? '★' : '☆';
    $('bw-star').title = marked ? '取消收藏当前页' : '收藏当前页';
  }

  async function toggleStar() {
    if (!state.current || !/^https?:/i.test(state.current)) return;
    const hit = state.marks.findIndex((m) => m.url === state.current);
    if (hit >= 0) state.marks.splice(hit, 1);
    else state.marks.push({ name: (state.current.replace(/^https?:\/\//, '').slice(0, 20)) || '书签', url: state.current });
    try {
      await invoke('config:update', { obj: { browserBookmarks: state.marks } });
      renderMarks();
      toast(hit >= 0 ? '已取消收藏' : '已收藏到书签栏');
    } catch (e) {
      toast('收藏失败：' + e.message);
    }
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
    document.body.setAttribute('data-material', (info.ui || {}).glassMaterial || 'custom');
  }

  /* ---------- 启动 ---------- */
  async function init() {
    // 窗口控制（无边框窗口）
    $('bw-min').onclick = () => { try { win.minimize(); } catch (e) {} };
    $('bw-max').onclick = () => { try { win.toggleMaximize(); } catch (e) {} };
    $('bw-close').onclick = () => { try { win.close(); } catch (e) {} };
    const drag = document.querySelector('.bw-drag');
    if (drag) drag.addEventListener('pointerdown', () => { try { win.startDragging(); } catch (e) {} });

    let info = {};
    try {
      info = await invoke('browser:info');
      state.marks = info.bookmarks || [];
      state.mode = info.downloadMode || 'auto';
      applyLook(info);
    } catch (e) { /* 书签取不到就用空 */ }

    const sel = $('bw-mode');
    for (const m of (info.modes || ['auto', 'ask', 'queue'])) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = MODE_LABEL[m] || m;
      sel.appendChild(o);
    }
    sel.value = state.mode;
    sel.onchange = () => {
      state.mode = sel.value;
      invoke('config:update', { obj: { browserDownloadMode: state.mode } }).catch(() => {});
    };

    $('bw-new').onclick = () => load(HOME_URL);
    $('bw-back').onclick = back;
    $('bw-fwd').onclick = fwd;
    $('bw-reload').onclick = reload;
    $('bw-home').onclick = () => load(HOME_URL);
    $('bw-star').onclick = () => toggleStar();
    $('bw-dir').onclick = () => toast('下载目录在启动器「设置 → 下载」中查看');
    $('bw-url').onkeydown = (e) => { if (e.key === 'Enter') { load(e.target.value); e.target.blur(); } };

    renderMarks();

    // 主进程通过 eval 设置待导航地址（启动器点书签/授权页时）
    const pending = window.__pending_nav;
    if (pending) { load(pending); return; }
    setInterval(() => {
      const u = window.__pending_nav;
      if (u && u !== state.current) load(u);
    }, 250);
    load(HOME_URL);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
