/* ============================================================
 * feat_search.js — 双平台统一搜索（Modrinth + CurseForge 合并）
 * 纯前端实现：包装 window.renderModCategory，在 data-mtab 标签栏追加「全部」。
 * 搜索并行调 api.mrSearch / api.cfSearch，CF 无 Key(403) 时优雅降级。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 文案 ----------
  const ZH = {
    'search.all': '全部',
    'search.placeholder': '同时搜索 Modrinth 与 CurseForge…',
    'search.btn': '搜索',
    'search.cfNoKey': 'CurseForge 需 API Key，仅显示 Modrinth 结果',
    'search.cfFail': 'CurseForge 搜索失败，仅显示 Modrinth 结果',
    'search.empty': '无结果',
    'search.searching': '搜索中…',
    'search.sourceMr': 'Modrinth',
    'search.sourceCf': 'CurseForge',
    'search.web': '网页',
    'search.download': '下载',
    'search.noRuntime': '实例运行环境未就绪',
  };
  const EN = {
    'search.all': 'All',
    'search.placeholder': 'Search Modrinth & CurseForge…',
    'search.btn': 'Search',
    'search.cfNoKey': 'CurseForge needs an API key; showing Modrinth results only',
    'search.cfFail': 'CurseForge search failed; showing Modrinth results only',
    'search.empty': 'No results',
    'search.searching': 'Searching…',
    'search.sourceMr': 'Modrinth',
    'search.sourceCf': 'CurseForge',
    'search.web': 'Web',
    'search.download': 'Download',
    'search.noRuntime': 'Instance runtime not ready',
  };
  window.__DICT__ = window.__DICT__ || {};
  window.__DICT__['zh-CN'] = Object.assign(window.__DICT__['zh-CN'] || {}, ZH);
  window.__DICT__['en'] = Object.assign(window.__DICT__['en'] || {}, EN);

  // ---------- 样式（fx- 前缀，一次性注入） ----------
  if (!document.getElementById('fx-search-style')) {
    const st = ce('style');
    st.id = 'fx-search-style';
    st.textContent = `
      .fx-src { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px; margin-left: 6px; vertical-align: middle; }
      .fx-src-mr { background: rgba(20,184,166,.18); color: #2dd4bf; }
      .fx-src-cf { background: rgba(251,146,60,.18); color: #fb923c; }
      .fx-warn { font-size: 12px; color: #fbbf24; margin: 8px 0; }
      #fx-all-results { margin-top: 10px; }
    `;
    document.head.appendChild(st);
  }

  function isCf403(err) {
    const s = String((err && err.message) || err || '');
    return /403|API ?Key|APIKey/i.test(s);
  }

  // 渲染「全部」合并搜索区
  function renderAll(inst, mbox) {
    mbox.innerHTML = `
      <div class="search-bar">
        <input class="input grow" id="fx-all-search" placeholder="${t('search.placeholder')}">
        <button class="btn primary" id="fx-all-btn">${t('search.btn')}</button>
      </div>
      <div id="fx-all-warn"></div>
      <div id="fx-all-results"></div>
    `;
    const results = mbox.querySelector('#fx-all-results');
    const warn = mbox.querySelector('#fx-all-warn');

    const doSearch = async () => {
      const q = mbox.querySelector('#fx-all-search').value.trim();
      const mcVersion = mcVerOf(inst.versionId);
      const loader = inst.modLoader && inst.modLoader !== 'vanilla' ? inst.modLoader : 'fabric';
      results.innerHTML = `<div style="color:var(--text-dim)">${t('search.searching')}</div>`;
      warn.innerHTML = '';

      const [mrRes, cfRes] = await Promise.allSettled([
        api.mrSearch(q, mcVersion, loader, 'mod'),
        api.cfSearch(q, mcVersion, loader, 'mod'),
      ]);

      const mrList = mrRes.status === 'fulfilled' ? mrRes.value : [];
      let cfList = [];
      if (cfRes.status === 'fulfilled') {
        cfList = cfRes.value;
      } else {
        warn.innerHTML = `<div class="fx-warn">⚠ ${isCf403(cfRes.reason) ? t('search.cfNoKey') : t('search.cfFail')}</div>`;
      }

      const merged = [
        ...mrList.map((m) => Object.assign({}, m, { __src: 'mr' })),
        ...cfList.map((m) => Object.assign({}, m, { __src: 'cf' })),
      ];

      if (!merged.length) {
        results.innerHTML = `<div class="glass" style="padding:20px;text-align:center;color:var(--text-dim)">${t('search.empty')}</div>`;
        return;
      }

      results.innerHTML = '<div class="card-list"></div>';
      const container = results.firstChild;
      merged.forEach((m) => {
        const isMr = m.__src === 'mr';
        const badge = isMr
          ? `<span class="fx-src fx-src-mr">${t('search.sourceMr')}</span>`
          : `<span class="fx-src fx-src-cf">${t('search.sourceCf')}</span>`;
        const card = ce('div', 'mod-card glass fx-card');
        card.dataset.src = m.__src;
        card.innerHTML = `
          <div class="mod-icon">${m.icon ? `<img src="${m.icon}" onerror="this.style.display='none'">` : '🧩'}</div>
          <div class="mod-info">
            <div class="mod-name">${m.name}${badge}</div>
            <div class="mod-meta">${(m.summary || '').slice(0, 80)} · ${(m.downloadCount || 0).toLocaleString()} 次下载</div>
          </div>
          <div class="mod-actions">
            <button class="btn primary" data-act="fxdl">${t('search.download')}</button>
            ${(!isMr && m.url) ? `<button class="btn" data-act="fxweb">${t('search.web')}</button>` : ''}
          </div>
        `;
        const webBtn = card.querySelector('[data-act="fxweb"]');
        if (webBtn) webBtn.onclick = () => api.openUrl(m.url);
        card.querySelector('[data-act="fxdl"]').onclick = async () => {
          const fresh = await ensureRuntime(inst);
          if (!fresh) { toast(t('search.noRuntime'), true); return; }
          if (isMr) {
            openModVersionPicker(m, fresh);
            return;
          }
          // CurseForge：直取最新兼容文件
          const gv = mcVerOf(fresh.versionId);
          const gdir = instGameDir(fresh);
          try {
            const files = await api.cfFiles(m.id, gv);
            const file = files.find((f) => f.releaseType === 1) || files[0];
            if (!file) throw new Error('No compatible file');
            showLoading(`${t('search.download')} ${m.name}…`);
            await api.cfDownload(file, gdir);
            toast(`${m.name} ✓`);
          } catch (e) {
            toast(e.message, true);
          } finally {
            hideLoading();
          }
        };
        container.appendChild(card);
      });
    };

    mbox.querySelector('#fx-all-btn').onclick = doSearch;
    mbox.querySelector('#fx-all-search').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  }

  // 包装 renderModCategory：原逻辑跑完后追加「全部」标签
  const orig = window.renderModCategory;
  if (typeof orig === 'function') {
    window.renderModCategory = async function (inst, box) {
      await orig(inst, box);
      const tabsBar = box.querySelector('.tabs');
      const mbox = box.querySelector('#mod-content');
      if (!tabsBar || !mbox || tabsBar.querySelector('#fx-all-tab')) return;

      const allTab = ce('button', 'tab');
      allTab.id = 'fx-all-tab';
      allTab.dataset.mtab = 'fxall';
      allTab.textContent = t('search.all');
      tabsBar.appendChild(allTab);

      allTab.onclick = () => {
        tabsBar.querySelectorAll('[data-mtab]').forEach((x) => x.classList.remove('active'));
        allTab.classList.add('active');
        renderAll(inst, mbox);
      };
    };
  }
})();
