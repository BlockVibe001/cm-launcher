/* ============================================================
 * feat_share.js — 实例/整合包分享码
 * 实现：
 *  - api 扩展：window.api.shareEncode / shareDecode / shareImport
 *  - 入口：实例详情页 .inst-head .row 追加「🔗 分享码」按钮
 *  - 弹窗两页签：导出（生成 + 复制）/ 导入（解析预览 + 确认导入）
 *  - 样式自带 fx- 前缀，注入一次 <style>；不改 styles.css / app.js。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 文案（中文优先；en 走 _phrases 运行时 DOM 翻译） ---------- */
  window.__DICT__['zh-CN'] = window.__DICT__['zh-CN'] || {};
  window.__DICT__['en'] = window.__DICT__['en'] || {};
  window.__DICT__['en']._phrases = window.__DICT__['en']._phrases || {};
  Object.assign(window.__DICT__['zh-CN'], {
    'fx-share.btn': '🔗 分享码',
    'fx-share.title': '🔗 实例分享码',
    'fx-share.tab.export': '导出',
    'fx-share.tab.import': '导入',
    'fx-share.gen': '生成分享码',
    'fx-share.genning': '正在生成…',
    'fx-share.copy': '复制',
    'fx-share.copied': '已复制到剪贴板',
    'fx-share.decode': '解析预览',
    'fx-share.decoding': '解析中…',
    'fx-share.import': '确认导入',
    'fx-share.note': '分享码只含实例与 mod 清单，不含存档/皮肤；导入需要联网下载 mod。',
    'fx-share.ph.export': '点「生成分享码」后显示在这里',
    'fx-share.ph.import': '粘贴 CM-SHARE-1. 开头的分享码',
    'fx-share.imported': '已导入实例',
    'fx-share.modFailed': '个 mod 下载失败，请进实例模组页补装',
  });
  Object.assign(window.__DICT__['en']._phrases, {
    '分享码': 'Share Code',
    '导出': 'Export',
    '导入': 'Import',
    '生成分享码': 'Generate Code',
    '正在生成…': 'Generating…',
    '复制': 'Copy',
    '已复制到剪贴板': 'Copied to clipboard',
    '解析预览': 'Preview',
    '解析中…': 'Parsing…',
    '确认导入': 'Confirm Import',
    '分享码只含实例与 mod 清单，不含存档/皮肤；导入需要联网下载 mod。':
      'The code contains only the instance & mod list — no saves/skins. Importing downloads mods over the network.',
    '点「生成分享码」后显示在这里': 'The generated code appears here after clicking Generate',
    '粘贴 CM-SHARE-1. 开头的分享码': 'Paste a share code starting with CM-SHARE-1.',
    '已导入实例': 'Instance imported',
    '个 mod 下载失败，请进实例模组页补装': 'mod(s) failed to download; install them later in the mod list.',
  });

  /* ---------- 样式（fx- 前缀，只注入一次） ---------- */
  if (!document.getElementById('fx-share-style')) {
    const st = ce('style', null);
    st.id = 'fx-share-style';
    st.textContent = [
      '.fx-share-tabs { display:flex; gap:8px; margin-bottom:12px; }',
      '.fx-share-tab { flex:1; height:32px; border-radius:8px; font-size:12.5px; cursor:pointer;',
      '  background:transparent; border:1px solid var(--border); color:var(--text-dim); }',
      '.fx-share-tab.on { background:rgba(120,160,255,.16); border-color:rgba(120,160,255,.5); color:var(--text); }',
      '.fx-share-body { overflow-y:auto; max-height:52vh; padding-right:2px; }',
      '.fx-share-code { width:100%; box-sizing:border-box; font-family:ui-monospace,Consolas,monospace;',
      '  font-size:11.5px; line-height:1.5; resize:vertical; background:var(--bg-1);',
      '  border:1px solid var(--border); border-radius:8px; color:var(--text); padding:8px 10px; }',
      '.fx-share-code:focus { outline:none; border-color:rgba(120,160,255,.5); }',
      '.fx-share-meta { font-size:12px; color:var(--text-dim); margin:8px 0; line-height:1.7; }',
      '.fx-share-preview { font-size:12.5px; line-height:1.8; margin:10px 0; }',
      '.fx-share-preview .fx-err { color:#fca5a5; }',
      '.fx-share-preview ul { margin:6px 0 0; padding-left:18px; max-height:120px; overflow-y:auto; }',
      '.fx-share-note { margin-top:12px; font-size:11.5px; color:var(--text-dim); line-height:1.6; }',
      '#fx-share-btn { white-space:nowrap; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- api 扩展 ---------- */
  window.api.shareEncode = (instanceId) => window.__invoke('share:encode', { instanceId });
  window.api.shareDecode = (code) => window.__invoke('share:decode', { code });
  window.api.shareImport = (code) => window.__invoke('share:import', { code });

  const NOTE = '分享码只含实例与 mod 清单，不含存档/皮肤；导入需要联网下载 mod。';

  async function copyText(textarea, fallbackText) {
    try {
      await navigator.clipboard.writeText(fallbackText);
      return true;
    } catch (e) {
      try {
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function openShareModal() {
    const mask = ce('div', 'modal-mask');
    mask.innerHTML = `
      <div class="modal" style="width:440px">
        <div class="modal-title">🔗 实例分享码</div>
        <div class="fx-share-tabs">
          <button type="button" class="fx-share-tab on" data-fxp="export">导出</button>
          <button type="button" class="fx-share-tab" data-fxp="import">导入</button>
        </div>
        <div class="fx-share-body">
          <div data-fxpanel="export">
            <div class="fx-share-meta" id="fx-export-meta">生成后会显示一段 CM-SHARE-1. 开头的文本，发给朋友即可复现本实例。</div>
            <textarea class="fx-share-code" id="fx-export-code" rows="6" readonly placeholder="点「生成分享码」后显示在这里"></textarea>
            <div class="modal-actions">
              <button type="button" class="btn" id="fx-export-copy" disabled>复制</button>
              <button type="button" class="btn primary" id="fx-export-gen">生成分享码</button>
            </div>
          </div>
          <div data-fxpanel="import" hidden>
            <textarea class="fx-share-code" id="fx-import-code" rows="5" placeholder="粘贴 CM-SHARE-1. 开头的分享码"></textarea>
            <div class="fx-share-preview" id="fx-import-preview"></div>
            <div class="modal-actions">
              <button type="button" class="btn primary" id="fx-import-ok" disabled>确认导入</button>
              <button type="button" class="btn" id="fx-import-decode">解析预览</button>
            </div>
          </div>
        </div>
        <div class="fx-share-note">${escapeHtml(NOTE)}</div>
      </div>
    `;
    document.body.appendChild(mask);

    const $m = (id) => mask.querySelector('#' + id);
    const exportCode = $m('fx-export-code');
    const importCode = $m('fx-import-code');
    const importOk = $m('fx-import-ok');
    let parsedCode = '';

    // 页签切换
    mask.querySelectorAll('.fx-share-tab').forEach((tab) => {
      tab.onclick = () => {
        mask.querySelectorAll('.fx-share-tab').forEach((x) => x.classList.toggle('on', x === tab));
        mask.querySelectorAll('[data-fxpanel]').forEach((p) => {
          p.hidden = p.dataset.fxpanel !== tab.dataset.fxp;
        });
      };
    });

    // ---- 导出 ----
    $m('fx-export-gen').onclick = async () => {
      const btn = $m('fx-export-gen');
      const id = state.currentInstanceId;
      if (!id) { toast('当前没有打开的实例', true); return; }
      btn.disabled = true;
      btn.textContent = '正在生成…';
      try {
        const r = await window.api.shareEncode(id);
        exportCode.value = r.code || '';
        $m('fx-export-meta').textContent =
          `实例「${r.name}」 · MC ${r.mcVersion || '?'} · ${r.modLoader || 'vanilla'} · mod ${r.modCount} 个`;
        $m('fx-export-copy').disabled = !r.code;
      } catch (e) {
        toast('生成失败：' + (e && e.message ? e.message : e), true);
      } finally {
        btn.disabled = false;
        btn.textContent = '生成分享码';
      }
    };
    $m('fx-export-copy').onclick = async () => {
      const ok = await copyText(exportCode, exportCode.value);
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动全选复制', !ok);
    };

    // ---- 导入：解析预览 ----
    $m('fx-import-decode').onclick = async () => {
      const code = (importCode.value || '').trim();
      const box = $m('fx-import-preview');
      importOk.disabled = true;
      parsedCode = '';
      if (!code) { box.innerHTML = '<span class="fx-err">请先粘贴分享码</span>'; return; }
      const btn = $m('fx-import-decode');
      btn.disabled = true;
      btn.textContent = '解析中…';
      try {
        const r = await window.api.shareDecode(code);
        if (!r.ok) {
          box.innerHTML = `<span class="fx-err">${escapeHtml(r.error || '解析失败')}</span>`;
          return;
        }
        parsedCode = code;
        const mods = r.mods || [];
        const items = mods.slice(0, 30)
          .map((m) => `<li>${escapeHtml(m.name || m.fileName || '?')}</li>`)
          .join('');
        box.innerHTML =
          `<div><b>${escapeHtml(r.name || '未命名')}</b></div>` +
          `<div>MC ${escapeHtml(r.mcVersion || '?')} · ${escapeHtml(r.modLoader || 'vanilla')}${r.loaderVersion ? ' ' + escapeHtml(r.loaderVersion) : ''} · mod ${mods.length} 个</div>` +
          (mods.length ? `<ul>${items}${mods.length > 30 ? `<li>…等 ${mods.length} 个</li>` : ''}</ul>` : '');
        importOk.disabled = false;
      } catch (e) {
        box.innerHTML = `<span class="fx-err">${escapeHtml((e && e.message) || String(e))}</span>`;
      } finally {
        btn.disabled = false;
        btn.textContent = '解析预览';
      }
    };

    // ---- 导入：确认导入 ----
    importOk.onclick = async () => {
      if (!parsedCode) return;
      const btn = importOk;
      btn.disabled = true;
      btn.textContent = '正在导入…';
      try {
        const r = await window.api.shareImport(parsedCode);
        if (!r.ok) {
          toast('导入失败：' + (r.error || '未知错误'), true);
          btn.disabled = false;
          btn.textContent = '确认导入';
          return;
        }
        mask.remove();
        const bad = (r.failedMods || []).length;
        toast(`已导入实例「${r.name}」` + (bad ? `，${bad} 个 mod 下载失败，请进实例模组页补装` : ''), !!bad);
        renderPage('instances');
      } catch (e) {
        toast('导入失败：' + (e && e.message ? e.message : e), true);
        btn.disabled = false;
        btn.textContent = '确认导入';
      }
    };

    // 点遮罩 / Esc 关闭
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { mask.remove(); document.removeEventListener('keydown', onKey); }
    });
  }

  /* ---------- 入口：实例详情页 .inst-head .row 追加按钮 ---------- */
  window.__onHook('pageRendered', (page) => {
    if (page !== 'instance') return;
    const row = document.querySelector('.inst-head .row');
    if (!row || row.querySelector('#fx-share-btn')) return;
    const btn = ce('button', 'btn');
    btn.id = 'fx-share-btn';
    btn.type = 'button';
    btn.textContent = '🔗 分享码';
    btn.onclick = openShareModal;
    row.appendChild(btn);
  });
})();
