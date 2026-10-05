/* ============================================================
 * feat_skin.js — HD 皮肤 + 披风本地管理
 * 状态：由功能子代理填充实现。
 * 实现约定（硬性）：
 *  - 本文件是唯一领地，禁止修改 app.js / api-adapter.js / index.html / locales / styles.css。
 *  - Rust 侧命令已由集成层接线（feat_skin.rs）：hd:import / hd:list / hd:delete / hd:apply / hd:capeApply。
 *    api 扩展：
 *      window.api.hdImport = (srcPath, kind) => window.__invoke('hd:import', { srcPath, kind });
 *      window.api.hdList = () => window.__invoke('hd:list');
 *      window.api.hdDelete = (name, kind) => window.__invoke('hd:delete', { name, kind });
 *      window.api.hdApply = (filePath) => window.__invoke('hd:apply', { filePath });
 *      window.api.hdCapeApply = (filePath) => window.__invoke('hd:capeApply', { filePath });
 *  - 预览可复用全局 paintSkinFrom(src, model)（返回 canvas）做 2D 预览。
 *  - 入口：皮肤中心页（pageRendered('skins')）追加「本地 HD 皮肤 / 披风库」区块。
 *  - 文案：Object.assign(window.__DICT__['zh-CN'], {...}) 与 window.__DICT__['en']。
 *  - 改完必须 node --check 本文件。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- i18n 文案（中文优先，en 补充） ---------- */
  const ZH = {
    fx_hd_title: '本地 HD 皮肤 / 披风库',
    fx_hd_hint: '导入高清皮肤（PNG）与披风文件，本地管理、一键应用。离线模式下游戏内不渲染披风属 Minecraft 机制限制。',
    fx_hd_import_skin: '导入皮肤',
    fx_hd_import_cape: '导入披风',
    fx_hd_empty: '还没有导入任何 HD 皮肤或披风',
    fx_hd_loading: '加载中…',
    fx_hd_kind_skin: '皮肤',
    fx_hd_kind_cape: '披风',
    fx_hd_applied_tag: '使用中',
    fx_hd_apply: '应用',
    fx_hd_apply_cape: '应用披风',
    fx_hd_delete: '删除',
    fx_hd_imported: '已导入',
    fx_hd_applied_ok: '皮肤已应用',
    fx_hd_cape_ok: '披风已记录（离线游戏内不渲染）',
    fx_hd_deleted: '已删除',
    fx_hd_fail: '操作失败：',
    fx_hd_load_fail: '加载失败：',
  };
  const EN = {
    fx_hd_title: 'Local HD Skins / Capes',
    fx_hd_hint: 'Import HD skin / cape PNGs, manage locally, apply with one click. Offline mode does not render capes in-game (Minecraft limitation).',
    fx_hd_import_skin: 'Import Skin',
    fx_hd_import_cape: 'Import Cape',
    fx_hd_empty: 'No HD skins or capes imported yet',
    fx_hd_loading: 'Loading…',
    fx_hd_kind_skin: 'Skin',
    fx_hd_kind_cape: 'Cape',
    fx_hd_applied_tag: 'In use',
    fx_hd_apply: 'Apply',
    fx_hd_apply_cape: 'Apply Cape',
    fx_hd_delete: 'Delete',
    fx_hd_imported: 'Imported',
    fx_hd_applied_ok: 'Skin applied',
    fx_hd_cape_ok: 'Cape recorded (not rendered offline)',
    fx_hd_deleted: 'Deleted',
    fx_hd_fail: 'Failed: ',
    fx_hd_load_fail: 'Load failed: ',
  };
  try {
    window.__DICT__ = window.__DICT__ || {};
    window.__DICT__['zh-CN'] = window.__DICT__['zh-CN'] || {};
    window.__DICT__['en'] = window.__DICT__['en'] || {};
    Object.assign(window.__DICT__['zh-CN'], ZH);
    Object.assign(window.__DICT__['en'], EN);
  } catch (e) { /* 词典未就绪也不影响主流程 */ }

  /* ---------- api 扩展 ---------- */
  window.api = window.api || {};
  window.api.hdImport = (srcPath, kind) => window.__invoke('hd:import', { srcPath, kind });
  window.api.hdList = () => window.__invoke('hd:list');
  window.api.hdDelete = (name, kind) => window.__invoke('hd:delete', { name, kind });
  window.api.hdApply = (filePath) => window.__invoke('hd:apply', { filePath });
  window.api.hdCapeApply = (filePath) => window.__invoke('hd:capeApply', { filePath });

  /* ---------- 样式注入（fx- 前缀） ---------- */
  const STYLE = `
.fx-hd-lib { margin-top:16px; }
.fx-hd-scroll { max-height:440px; overflow-y:auto; padding-right:6px; }
.fx-hd-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; }
.fx-hd-cell { position:relative; display:flex; flex-direction:column; gap:8px; padding:12px;
  border:1px solid rgba(148,163,184,0.18); border-radius:12px; background:rgba(148,163,184,0.06); }
.fx-hd-cell.fx-applied { outline:2px solid var(--accent, #4ade80); outline-offset:-1px; }
.fx-hd-thumb { display:flex; align-items:center; justify-content:center; height:96px;
  background:rgba(0,0,0,0.18); border-radius:8px; overflow:hidden; }
.fx-hd-thumb canvas, .fx-hd-thumb img { image-rendering:pixelated; max-height:100%; max-width:100%; }
.fx-hd-cape-img { max-width:80% !important; }
.fx-hd-name { font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fx-hd-sub { font-size:11px; color:var(--text-dim); }
.fx-hd-badge { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:6px;
  font-size:10px; background:var(--accent, #4ade80); color:#0b0f14; }
.fx-hd-acts { display:flex; gap:6px; flex-wrap:wrap; }
`;
  function injectStyle() {
    if (document.getElementById('fx-hd-style')) return;
    const st = document.createElement('style');
    st.id = 'fx-hd-style';
    st.textContent = STYLE;
    (document.head || document.documentElement).appendChild(st);
  }

  const t = (k) => (window.i18n ? window.i18n.t(k) : (ZH[k] || k));

  /* ---------- 单条卡片 ---------- */
  async function buildCard(it) {
    const isCape = it.kind === 'cape';
    const cell = document.createElement('div');
    cell.className = 'fx-hd-cell' + (it.applied ? ' fx-applied' : '');
    cell.innerHTML = `
      <div class="fx-hd-thumb"></div>
      <div class="fx-hd-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
      <div class="fx-hd-sub">${escapeHtml(isCape ? t('fx_hd_kind_cape') : t('fx_hd_kind_skin'))}
        · ${formatSize(it.size)}${it.applied ? '<span class="fx-hd-badge">' + escapeHtml(t('fx_hd_applied_tag')) + '</span>' : ''}
      </div>
      <div class="fx-hd-acts">
        <button class="btn sm primary" data-fx-apply type="button">${escapeHtml(isCape ? t('fx_hd_apply_cape') : t('fx_hd_apply'))}</button>
        <button class="btn sm danger" data-fx-del type="button">${escapeHtml(t('fx_hd_delete'))}</button>
      </div>`;

    // 预览：披风直接 <img>；皮肤画一个正脸 2D 预览（头前层+帽子层）
    try {
      const r = await window.api.skinReadLocal(it.filePath);
      if (!cell.isConnected) return cell;
      const thumb = cell.querySelector('.fx-hd-thumb');
      if (isCape) {
        const im = document.createElement('img');
        im.src = r.dataUrl;
        im.alt = '';
        im.loading = 'lazy';
        im.className = 'fx-hd-cape-img';
        thumb.appendChild(im);
      } else {
        const cv = document.createElement('canvas');
        cv.width = 64; cv.height = 64;
        thumb.appendChild(cv);
        const im = await skinImage(r.dataUrl);
        if (!cell.isConnected) return cell;
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, 64, 64);
        // 原版头 UV：前层 [8,8,8,8]、帽子叠加层 [40,8,8,8]
        ctx.drawImage(im, 8, 8, 8, 8, 0, 0, 64, 64);
        ctx.drawImage(im, 40, 8, 8, 8, 0, 0, 64, 64);
      }
    } catch (e) { /* 预览失败留白即可 */ }

    cell.querySelector('[data-fx-apply]').onclick = async () => {
      try {
        if (isCape) {
          await window.api.hdCapeApply(it.filePath);
          toast(t('fx_hd_cape_ok'));
        } else {
          await window.api.hdApply(it.filePath);
          toast(t('fx_hd_applied_ok'));
        }
        loadList();
      } catch (e) {
        toast(t('fx_hd_fail') + (e && e.message ? e.message : e), true);
      }
    };
    cell.querySelector('[data-fx-del]').onclick = async () => {
      try {
        await window.api.hdDelete(it.name, it.kind);
        toast(t('fx_hd_deleted'));
        loadList();
      } catch (e) {
        toast(t('fx_hd_fail') + (e && e.message ? e.message : e), true);
      }
    };
    return cell;
  }

  /* ---------- 列表加载 ---------- */
  async function loadList() {
    const grid = document.getElementById('fx-hd-grid');
    if (!grid || !grid.isConnected) return;
    try {
      const res = await window.api.hdList();
      if (!grid.isConnected) return;
      const items = (res && res.items) || [];
      if (!items.length) {
        grid.innerHTML = '<div class="hint-text">' + escapeHtml(t('fx_hd_empty')) + '</div>';
        return;
      }
      grid.innerHTML = '';
      for (const it of items) {
        const card = await buildCard(it);
        if (!grid.isConnected) return;
        grid.appendChild(card);
      }
    } catch (e) {
      if (grid.isConnected) {
        grid.innerHTML = '<div class="hint-text">' + escapeHtml(t('fx_hd_load_fail') + (e && e.message ? e.message : e)) + '</div>';
      }
    }
  }

  /* ---------- 区块注入 ---------- */
  function mountBlock(pageEl) {
    if (pageEl.querySelector('.fx-hd-lib')) return;
    const sec = document.createElement('div');
    sec.className = 'panel fx-hd-lib';
    sec.innerHTML = `
      <div class="section-title">${escapeHtml(t('fx_hd_title'))}</div>
      <div class="hint-text" style="margin-bottom:12px">${escapeHtml(t('fx_hd_hint'))}</div>
      <div class="row" style="gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <button class="btn" id="fx-hd-import-skin" type="button">${escapeHtml(t('fx_hd_import_skin'))}</button>
        <button class="btn" id="fx-hd-import-cape" type="button">${escapeHtml(t('fx_hd_import_cape'))}</button>
      </div>
      <div class="fx-hd-scroll">
        <div class="fx-hd-grid" id="fx-hd-grid"><div class="hint-text">${escapeHtml(t('fx_hd_loading'))}</div></div>
      </div>`;
    pageEl.appendChild(sec);

    sec.querySelector('#fx-hd-import-skin').onclick = async () => {
      const p = await window.api.pickFile([{ name: 'PNG 图片', extensions: ['png'] }]);
      if (!p) return;
      try {
        const r = await window.api.hdImport(p, 'skin');
        if (r && r.ok) { toast(t('fx_hd_imported')); loadList(); }
        else toast(t('fx_hd_fail') + ((r && r.error) || '?'), true);
      } catch (e) { toast(t('fx_hd_fail') + (e && e.message ? e.message : e), true); }
    };
    sec.querySelector('#fx-hd-import-cape').onclick = async () => {
      const p = await window.api.pickFile([{ name: 'PNG 图片', extensions: ['png'] }]);
      if (!p) return;
      try {
        const r = await window.api.hdImport(p, 'cape');
        if (r && r.ok) { toast(t('fx_hd_imported')); loadList(); }
        else toast(t('fx_hd_fail') + ((r && r.error) || '?'), true);
      } catch (e) { toast(t('fx_hd_fail') + (e && e.message ? e.message : e), true); }
    };
    loadList();
  }

  injectStyle();
  if (window.__onHook) {
    window.__onHook('pageRendered', (page, pageEl) => {
      if (page !== 'skins' || !pageEl) return;
      mountBlock(pageEl);
    });
  }
})();
