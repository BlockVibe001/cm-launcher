/* ============================================================
 * feat_update.js — 整合包增量更新
 * 实现：
 *  - 包装 api.mrInstallPack：安装后把 { projectId, versionId, name } 写入
 *    localStorage「cm.packmeta[instanceId]」（mrpack.rs 本身不记录来源）。
 *  - api 扩展：window.api.packStatus / packApply
 *  - 入口：实例详情页 .inst-head .row 追加「🔄 检查整合包更新」按钮
 *    （所有实例都显示；非整合包实例点击后提示来源无法识别）
 *  - 弹窗：当前版本 → 最新版本 → diff 统计（新增/变动/移除，可展开文件清单）
 *    → 开始更新 → 进度提示 → 完成后回写 packmeta 的 versionId。
 *  - 样式自带 fx- 前缀，注入一次 <style>；不改 styles.css / app.js。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 文案（中文优先；en 走 _phrases 运行时 DOM 翻译） ---------- */
  window.__DICT__['zh-CN'] = window.__DICT__['zh-CN'] || {};
  window.__DICT__['en'] = window.__DICT__['en'] || {};
  window.__DICT__['en']._phrases = window.__DICT__['en']._phrases || {};
  Object.assign(window.__DICT__['zh-CN'], {
    'fx-update.btn': '🔄 检查整合包更新',
    'fx-update.title': '🔄 整合包更新',
    'fx-update.checking': '正在检查更新…',
    'fx-update.cur': '当前版本',
    'fx-update.latest': '最新版本',
    'fx-update.upToDate': '已是最新版本，无需更新',
    'fx-update.apply': '开始更新',
    'fx-update.applying': '正在下载更新文件…',
    'fx-update.done': '整合包已更新到最新版本，存档与设置不受影响',
    'fx-update.fail': '更新失败',
    'fx-update.noMeta': '无法识别整合包来源（旧版本安装的整合包需重新导入才能增量更新）',
    'fx-update.stat.added': '新增',
    'fx-update.stat.changed': '变动',
    'fx-update.stat.removed': '移除',
    'fx-update.note': '仅更新整合包文件；你的存档、配置与手动添加的 mod 不会被改动。',
  });
  Object.assign(window.__DICT__['en']._phrases, {
    '检查更新': 'checking for updates',
    '正在检查更新…': 'Checking for updates…',
    '当前版本': 'Current',
    '最新版本': 'Latest',
    '已是最新版本，无需更新': 'Already up to date',
    '开始更新': 'Update Now',
    '正在下载更新文件…': 'Downloading updated files…',
    '整合包已更新到最新版本，存档与设置不受影响': 'Modpack updated. Your saves and settings are untouched.',
    '更新失败': 'Update failed',
    '无法识别整合包来源（旧版本安装的整合包需重新导入才能增量更新）':
      'Unknown modpack source. Re-import this pack to enable incremental updates.',
    '新增': 'Added',
    '变动': 'Changed',
    '移除': 'Removed',
    '仅更新整合包文件；你的存档、配置与手动添加的 mod 不会被改动。':
      'Only pack files are updated; your saves, configs and manually added mods are kept.',
  });

  /* ---------- 样式（fx- 前缀，只注入一次） ---------- */
  if (!document.getElementById('fx-update-style')) {
    const st = ce('style', null);
    st.id = 'fx-update-style';
    st.textContent = [
      '#fx-update-btn { white-space:nowrap; }',
      '.fx-upd-mask { z-index:2000; }',
      '.fx-upd-body { overflow-y:auto; max-height:55vh; padding-right:2px; }',
      '.fx-upd-ver { font-size:12.5px; color:var(--text-dim); line-height:1.9; margin:6px 0; }',
      '.fx-upd-ver b { color:var(--text); font-weight:600; }',
      '.fx-upd-stats { display:flex; gap:10px; margin:12px 0 4px; }',
      '.fx-upd-stat { flex:1; border:1px solid var(--border); border-radius:8px; padding:8px 6px; text-align:center; }',
      '.fx-upd-stat .n { font-size:20px; font-weight:800; }',
      '.fx-upd-stat .k { font-size:11px; color:var(--text-dim); margin-top:2px; }',
      '.fx-upd-stat.add .n { color:#86efac; }',
      '.fx-upd-stat.chg .n { color:#93c5fd; }',
      '.fx-upd-stat.rm .n { color:#fca5a5; }',
      '.fx-upd-files { margin-top:10px; font-size:12px; }',
      '.fx-upd-files details { margin:4px 0; }',
      '.fx-upd-files summary { cursor:pointer; color:var(--text-dim); user-select:none; }',
      '.fx-upd-files ul { margin:4px 0 0; padding-left:16px; max-height:120px; overflow-y:auto; }',
      '.fx-upd-files li { font-family:ui-monospace,Consolas,monospace; font-size:11px; line-height:1.7; color:var(--text); word-break:break-all; }',
      '.fx-upd-err { color:#fca5a5; font-size:12.5px; line-height:1.7; margin:8px 0; }',
      '.fx-upd-note { margin-top:12px; font-size:11.5px; color:var(--text-dim); line-height:1.6; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- packmeta 读写 ---------- */
  const META_KEY = 'cm.packmeta';
  function readPackmeta() {
    try {
      return JSON.parse(localStorage.getItem(META_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function writePackmeta(meta) {
    try {
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } catch (e) { /* 忽略存储异常 */ }
  }

  /* ---------- 包装 api.mrInstallPack：记录整合包来源 ---------- */
  const origInstallPack = window.api && window.api.mrInstallPack;
  if (origInstallPack && !origInstallPack.__fxUpdWrapped) {
    const wrapped = async function (file, root) {
      const r = await origInstallPack(file, root);
      try {
        const url = (file && file.url) || '';
        // Modrinth 下载 URL 两种形态：
        //  api.modrinth.com/v2/project/{pid}/version/{vid}/download
        //  cdn.modrinth.com/data/{pid}/versions/{vid}/xxx.jar
        let m = url.match(/\/project\/([^/\\]+)\/version\/([^/\\]+)\/download/);
        if (!m) m = url.match(/\/data\/([^/\\]+)\/versions\/([^/\\]+)\//);
        if (m && r && r.instanceId) {
          const meta = readPackmeta();
          meta[r.instanceId] = {
            projectId: m[1],
            versionId: m[2],
            name: (file && file.filename) || '',
          };
          writePackmeta(meta);
        }
      } catch (e) { /* 记录失败不影响安装 */ }
      return r;
    };
    wrapped.__fxUpdWrapped = true;
    window.api.mrInstallPack = wrapped;
  }

  /* ---------- api 扩展 ---------- */
  window.api.packStatus = (gameDir, projectId, packVersion) =>
    window.__invoke('pack:status', { gameDir, projectId, packVersion });
  // Rust 签名固定为 (game_dir, version_id, files)：removed 并入 files 对象传递
  window.api.packApply = (gameDir, versionId, files, removed) =>
    window.__invoke('pack:apply', {
      gameDir,
      versionId,
      files: {
        changed: (files && files.changed) || [],
        added: (files && files.added) || [],
        removed: removed || [],
      },
    });

  /* ---------- 更新弹窗 ---------- */
  function fileListHtml(list, color) {
    if (!list || !list.length) return '';
    const items = list
      .map((f) => {
        const rel = f.rel || f.path || '?';
        const size = typeof f.size === 'number' && f.size ? ` · ${formatSize(f.size)}` : '';
        return `<li style="color:${color}">${escapeHtml(rel)}${escapeHtml(size)}</li>`;
      })
      .join('');
    return `<details><summary>${escapeHtml(rel)} · ${list.length} 个文件</summary><ul>${items}</ul></details>`;
  }

  function openUpdateModal() {
    const id = state.currentInstanceId;
    if (!id) { toast('当前没有打开的实例', true); return; }
    const meta = readPackmeta()[id];
    if (!meta || !meta.projectId) {
      toast(t('fx-update.noMeta'), true);
      return;
    }
    const inst = (state.config && state.config.instances || {})[id];
    const gameDir = instGameDir(inst);

    const mask = ce('div', 'modal-mask fx-upd-mask');
    mask.innerHTML = `
      <div class="modal" style="width:460px">
        <div class="modal-title">${escapeHtml(t('fx-update.title'))}</div>
        <div class="fx-upd-body" id="fx-upd-body">
          <div class="fx-upd-ver">${escapeHtml(t('fx-update.checking'))}</div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn primary" id="fx-upd-apply" disabled>${escapeHtml(t('fx-update.apply'))}</button>
        </div>
        <div class="fx-upd-note">${escapeHtml(t('fx-update.note'))}</div>
      </div>
    `;
    document.body.appendChild(mask);
    const body = mask.querySelector('#fx-upd-body');
    const applyBtn = mask.querySelector('#fx-upd-apply');

    const close = () => mask.remove();
    mask.onclick = (e) => { if (e.target === mask) close(); };
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });

    async function run() {
      let r;
      try {
        r = await window.api.packStatus(gameDir, meta.projectId, meta.versionId || null);
      } catch (e) {
        body.innerHTML = `<div class="fx-upd-err">${escapeHtml((e && e.message) || String(e))}</div>`;
        return;
      }
      if (!r || !r.ok) {
        body.innerHTML = `<div class="fx-upd-err">${escapeHtml((r && r.error) || '检查更新失败')}</div>`;
        return;
      }

      const diff = r.diff || { changed: [], added: [], removed: [] };
      const curVer = r.installedVersionId || '—';
      const latestVer = r.latestVersionNumber || r.latestVersionId || '—';
      const packName = r.installedPackName || meta.name || '';

      body.innerHTML =
        `<div class="fx-upd-ver">${escapeHtml(t('fx-update.cur'))}：<b>${escapeHtml(curVer)}</b></div>` +
        `<div class="fx-upd-ver">${escapeHtml(t('fx-update.latest'))}：<b>${escapeHtml(latestVer)}</b>` +
        (packName ? ` · ${escapeHtml(packName)}` : '') + `</div>` +
        `<div class="fx-upd-stats">` +
        `<div class="fx-upd-stat add"><div class="n">${diff.added.length}</div><div class="k">${escapeHtml(t('fx-update.stat.added'))}</div></div>` +
        `<div class="fx-upd-stat chg"><div class="n">${diff.changed.length}</div><div class="k">${escapeHtml(t('fx-update.stat.changed'))}</div></div>` +
        `<div class="fx-upd-stat rm"><div class="n">${diff.removed.length}</div><div class="k">${escapeHtml(t('fx-update.stat.removed'))}</div></div>` +
        `</div>` +
        `<div class="fx-upd-files">` +
        fileListHtml(diff.added, '#86efac') +
        fileListHtml(diff.changed, '#93c5fd') +
        fileListHtml(diff.removed, '#fca5a5') +
        `</div>`;

      if (!r.hasUpdate) {
        body.insertAdjacentHTML('beforeend',
          `<div class="fx-upd-ver" style="text-align:center">${escapeHtml(t('fx-update.upToDate'))}</div>`);
        return;
      }

      applyBtn.disabled = false;
      applyBtn.onclick = async () => {
        applyBtn.disabled = true;
        applyBtn.textContent = t('fx-update.applying');
        let res;
        try {
          res = await window.api.packApply(gameDir, r.latestVersionId, diff, diff.removed);
        } catch (e) {
          toast((e && e.message) || String(e), true);
          applyBtn.disabled = false;
          applyBtn.textContent = t('fx-update.apply');
          return;
        }
        if (res && res.ok) {
          // 回写已安装版本号
          const m2 = readPackmeta();
          if (m2[id]) {
            m2[id].versionId = r.latestVersionId;
            writePackmeta(m2);
          }
          close();
          toast(t('fx-update.done'));
        } else {
          const bad = ((res && res.failed) || []).slice(0, 3)
            .map((f) => `${f.rel}:${f.error}`).join('；');
          toast(`${t('fx-update.fail')}：${bad}`, true);
          applyBtn.disabled = false;
          applyBtn.textContent = t('fx-update.apply');
        }
      };
    }
    run();
  }

  /* ---------- 入口：实例详情页 .inst-head .row 追加按钮 ---------- */
  window.__onHook('pageRendered', (page) => {
    if (page !== 'instance') return;
    const row = document.querySelector('.inst-head .row');
    if (!row || row.querySelector('#fx-update-btn')) return;
    const btn = ce('button', 'btn');
    btn.id = 'fx-update-btn';
    btn.type = 'button';
    btn.textContent = t('fx-update.btn');
    btn.onclick = openUpdateModal;
    row.appendChild(btn);
  });
})();
