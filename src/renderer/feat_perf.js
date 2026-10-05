/* ============================================================
 * feat_perf.js — 性能优化模组一键装（Fabric 优化预设）
 * 纯前端实现：复用 api.mrSearch / api.mrVersions / api.mrDownload。
 * 入口：实例详情页 .inst-head .row 追加「⚡ 优化预设」按钮。
 * ============================================================ */
(function () {
  'use strict';

  // 预设模组列表（按 Modrinth 搜索词匹配，取首个命中）
  const PRESETS = [
    { label: 'Sodium', query: 'Sodium' },
    { label: 'Lithium', query: 'Lithium' },
    { label: 'FerriteCore', query: 'FerriteCore' },
    { label: 'EntityCulling', query: 'EntityCulling' },
    { label: 'ModMenu', query: 'Mod Menu' },
  ];

  // ---------- 文案 ----------
  const ZH = {
    'perf.btn': '优化预设',
    'perf.title': 'Fabric 优化预设',
    'perf.desc': '为当前实例按 Fabric 安装优化模组',
    'perf.matched': '匹配版本',
    'perf.loader': '加载器',
    'perf.needFabric': '该实例未安装 Fabric/Quilt，请先安装 Fabric 再使用优化预设',
    'perf.start': '开始安装',
    'perf.cancel': '取消',
    'perf.none': '请至少勾选一个模组',
    'perf.searching': '搜索中…',
    'perf.downloading': '下载中…',
    'perf.ok': '✓ 完成',
    'perf.fail': '✗ 失败',
    'perf.allDone': '优化预设安装完成',
    'perf.notFound': '未找到对应项目',
    'perf.noVersion': '无匹配版本',
    'perf.noFile': '无可用下载文件',
  };
  const EN = {
    'perf.btn': 'Perf Preset',
    'perf.title': 'Fabric Performance Preset',
    'perf.desc': 'Install performance mods for this instance via Fabric',
    'perf.matched': 'Matching version',
    'perf.loader': 'Loader',
    'perf.needFabric': 'This instance has no Fabric/Quilt. Install Fabric first.',
    'perf.start': 'Install',
    'perf.cancel': 'Cancel',
    'perf.none': 'Select at least one mod',
    'perf.searching': 'Searching…',
    'perf.downloading': 'Downloading…',
    'perf.ok': '✓ Done',
    'perf.fail': '✗ Failed',
    'perf.allDone': 'Performance preset installed',
    'perf.notFound': 'Project not found',
    'perf.noVersion': 'No matching version',
    'perf.noFile': 'No downloadable file',
  };
  window.__DICT__ = window.__DICT__ || {};
  window.__DICT__['zh-CN'] = Object.assign(window.__DICT__['zh-CN'] || {}, ZH);
  window.__DICT__['en'] = Object.assign(window.__DICT__['en'] || {}, EN);

  // ---------- 样式（fx- 前缀，一次性注入） ----------
  if (!document.getElementById('fx-perf-style')) {
    const st = ce('style');
    st.id = 'fx-perf-style';
    st.textContent = `
      .fx-list { margin: 10px 0; max-height: 220px; overflow-y: auto; }
      .fx-row { display: flex; align-items: center; gap: 8px; padding: 6px 4px; font-size: 14px; }
      .fx-meta { font-size: 13px; color: var(--text-dim); margin: 8px 0; }
      .fx-progress { font-size: 13px; margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
      .fx-progress .fx-step { color: var(--text-dim); }
      .fx-progress .fx-step.fx-good { color: #34d399; }
      .fx-progress .fx-step.fx-bad { color: #fca5a5; }
    `;
    document.head.appendChild(st);
  }

  // 取当前实例（实例详情页）
  function currentInst() {
    const instances = (state.config && state.config.instances) || {};
    return currentInstanceOf(instances, state.currentInstanceId);
  }

  async function installOne(p, mcVersion, rowEl) {
    rowEl.textContent = p.label + ' · ' + t('perf.searching');
    rowEl.className = 'fx-step';
    const hits = await api.mrSearch(p.query, mcVersion, 'fabric', 'mod');
    if (!hits || !hits.length) throw new Error(t('perf.notFound') + ': ' + p.label);
    const proj = hits[0];
    const vers = await api.mrVersions(proj.id, mcVersion, 'fabric');
    if (!vers || !vers.length) throw new Error(t('perf.noVersion') + ': ' + p.label);
    let v = vers.find((x) => (x.gameVersions || []).includes(mcVersion)) || vers[0];
    const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
    if (!file) throw new Error(t('perf.noFile') + ': ' + p.label);
    rowEl.textContent = p.label + ' · ' + t('perf.downloading');
    await api.mrDownload(file, instGameDir(currentInst()), 'mod');
    rowEl.textContent = t('perf.ok') + ' ' + p.label + ' → ' + file.name;
    rowEl.className = 'fx-step fx-good';
    return file.name;
  }

  function openPreset() {
    const inst = currentInst();
    if (!inst) return;
    const loader = inst.modLoader;
    if (loader !== 'fabric' && loader !== 'quilt') {
      toast(t('perf.needFabric'), true);
      return;
    }
    const mcVersion = mcVerOf(inst.versionId);

    const mask = ce('div', 'modal-mask');
    mask.innerHTML = `
      <div class="modal">
        <div class="modal-title">⚡ ${t('perf.title')}</div>
        <div class="hint-text">${t('perf.desc')}</div>
        <div class="fx-meta">
          ${t('perf.matched')}：<b>${mcVersion || '未知'}</b>
          · ${t('perf.loader')}：<b>${loaderName(loader)}</b>
        </div>
        <div class="fx-list" id="fx-perf-list">
          ${PRESETS.map((p) => `
            <label class="fx-row">
              <input type="checkbox" class="fx-perf-mod" data-name="${p.label}" checked>
              <span>${p.label}</span>
            </label>`).join('')}
        </div>
        <div id="fx-perf-progress" class="fx-progress"></div>
        <div class="modal-actions">
          <button class="btn ghost" id="fx-perf-cancel">${t('perf.cancel')}</button>
          <button class="btn primary" id="fx-perf-start">${t('perf.start')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);

    const close = () => mask.remove();
    mask.querySelector('#fx-perf-cancel').onclick = close;
    mask.onclick = (e) => { if (e.target === mask) close(); };

    const startBtn = mask.querySelector('#fx-perf-start');
    startBtn.onclick = async () => {
      const checked = PRESETS.filter((p) =>
        mask.querySelector(`.fx-perf-mod[data-name="${p.label}"]`).checked);
      if (!checked.length) { toast(t('perf.none'), true); return; }
      startBtn.disabled = true;
      const prog = mask.querySelector('#fx-perf-progress');
      prog.innerHTML = '';
      const okFiles = [];
      for (const p of checked) {
        const row = ce('div', 'fx-step');
        prog.appendChild(row);
        try {
          const f = await installOne(p, mcVersion, row);
          okFiles.push(f);
        } catch (e) {
          row.textContent = t('perf.fail') + ' ' + p.label + '：' + e.message;
          row.className = 'fx-step fx-bad';
        }
      }
      if (okFiles.length) toast(`${t('perf.allDone')}（${okFiles.length}）`);
      close();
      // 仍在实例模组标签时刷新列表
      if (state.instTab === 'mods' && $('inst-tab-body')) {
        try { loadModsTab(inst, instGameDir(inst), $('inst-tab-body')); } catch (e) { /* ignore */ }
      }
    };
  }

  // ---------- 入口注入 ----------
  window.__onHook('pageRendered', (page, pageEl) => {
    if (page !== 'instance' || !pageEl) return;
    const row = pageEl.querySelector('.inst-head .row');
    if (!row) return;
    const btn = ce('button', 'btn');
    btn.id = 'fx-perf-btn';
    btn.textContent = '⚡ ' + t('perf.btn');
    btn.onclick = openPreset;
    row.appendChild(btn);
  });
})();
