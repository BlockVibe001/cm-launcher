/* ============================================================
 * feat_backup.js — 世界备份管理
 * 实现：
 *  - api 扩展：window.api.backupCreate / backupList / backupRestore / backupDelete
 *  - 包装全局 loadSavesTab：
 *    (a) 头部 #sv-open 那行追加「💾 备份管理」按钮（打开备份列表弹窗）；
 *    (b) 每张 .save-card 的 .save-actions 追加「备份」小按钮。
 *  - 样式自带 fx- 前缀，注入一次 <style>；不改 styles.css / app.js。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 文案（中文优先；en 走 _phrases 运行时 DOM 翻译） ---------- */
  window.__DICT__['zh-CN'] = window.__DICT__['zh-CN'] || {};
  window.__DICT__['en'] = window.__DICT__['en'] || {};
  window.__DICT__['en']._phrases = window.__DICT__['en']._phrases || {};
  Object.assign(window.__DICT__['zh-CN'], {
    'fx-backup.mgr': '💾 备份管理',
    'fx-backup.title': '💾 世界备份管理',
    'fx-backup.empty': '还没有备份，点卡片上的「备份」即可为世界创建时间点快照',
    'fx-backup.restore': '恢复',
    'fx-backup.del': '删除',
    'fx-backup.restoreConfirm': '恢复会覆盖同名世界（已存在则自动改名），继续？',
    'fx-backup.delConfirm': '删除这条备份？此操作不可恢复',
    'fx-backup.close': '关闭',
    'fx-backup.loading': '加载中…',
    'fx-backup.ok.created': '已备份世界',
    'fx-backup.ok.restored': '已恢复世界',
    'fx-backup.ok.deleted': '已删除备份',
    'fx-backup.fail': '操作失败',
  });
  Object.assign(window.__DICT__['en']._phrases, {
    '💾 备份管理': '💾 Backups',
    '💾 世界备份管理': '💾 World Backups',
    '还没有备份，点卡片上的「备份」即可为世界创建时间点快照':
      'No backups yet. Click “Backup” on a world card to snapshot it.',
    '恢复': 'Restore',
    '删除': 'Delete',
    '关闭': 'Close',
    '加载中…': 'Loading…',
    '恢复会覆盖同名世界（已存在则自动改名），继续？':
      'Restoring overwrites the same-named world (existing one is renamed). Continue?',
    '删除这条备份？此操作不可恢复': 'Delete this backup? This cannot be undone.',
  });

  /* ---------- 样式（fx- 前缀，只注入一次） ---------- */
  if (!document.getElementById('fx-backup-style')) {
    const st = ce('style', null);
    st.id = 'fx-backup-style';
    st.textContent = [
      '.modal-mask.fx-backup-mask { z-index: 2000; }',
      '.fx-backup-list { overflow-y: auto; max-height: 50vh; margin: 6px 0 10px; padding-right: 2px; }',
      '.fx-backup-row { display:flex; align-items:center; gap:10px; padding:9px 2px; border-bottom:1px solid var(--border); }',
      '.fx-backup-row:last-child { border-bottom:none; }',
      '.fx-backup-info { flex:1; min-width:0; }',
      '.fx-backup-name { font-size:13px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.fx-backup-meta { font-size:11.5px; color:var(--text-dim); margin-top:2px; }',
      '.fx-backup-actions { display:flex; gap:6px; flex-shrink:0; }',
      '#fx-backup-open { white-space:nowrap; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- api 扩展 ---------- */
  window.api.backupCreate = (gameDir, saveName) => window.__invoke('backup:create', { gameDir, saveName });
  window.api.backupList = (gameDir) => window.__invoke('backup:list', { gameDir });
  window.api.backupRestore = (gameDir, backupFile) => window.__invoke('backup:restore', { gameDir, backupFile });
  window.api.backupDelete = (gameDir, backupFile) => window.__invoke('backup:delete', { gameDir, backupFile });

  function failMsg(e) { return '操作失败：' + ((e && e.message) || e); }

  /* ---------- 备份管理弹窗 ---------- */
  function openBackupModal(gameDir, inst, body) {
    const mask = ce('div', 'modal-mask fx-backup-mask');
    mask.innerHTML = `
      <div class="modal" style="width:460px">
        <div class="modal-title">💾 世界备份管理</div>
        <div class="fx-backup-list" id="fx-backup-list"><div class="empty-tip" style="padding:18px 0">加载中…</div></div>
        <div class="modal-actions">
          <button type="button" class="btn" id="fx-backup-close">关闭</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);
    const listEl = mask.querySelector('#fx-backup-list');

    async function refresh() {
      let items = [];
      try {
        const r = await window.api.backupList(gameDir);
        items = (r && r.items) || [];
      } catch (e) { items = []; }
      if (!items.length) {
        listEl.innerHTML = '<div class="empty-tip" style="padding:18px 0">还没有备份，点卡片上的「备份」即可为世界创建时间点快照</div>';
        return;
      }
      listEl.innerHTML = '';
      for (const b of items) {
        const row = ce('div', 'fx-backup-row');
        row.innerHTML = `
          <div class="fx-backup-info">
            <div class="fx-backup-name">${escapeHtml(b.saveName || '?')}</div>
            <div class="fx-backup-meta">${formatSize(b.size || 0)} · ${timeAgo(b.mtime || 0)}</div>
          </div>
          <div class="fx-backup-actions">
            <button type="button" class="btn sm primary" data-fxb="restore">恢复</button>
            <button type="button" class="btn sm danger" data-fxb="del">删除</button>
          </div>
        `;
        row.querySelector('[data-fxb=restore]').onclick = async (ev) => {
          if (!window.confirm('恢复会覆盖同名世界（已存在则自动改名），继续？')) return;
          ev.target.disabled = true;
          try {
            const r = await window.api.backupRestore(gameDir, b.file);
            if (!r || !r.ok) { toast('操作失败：' + ((r && r.error) || '未知错误'), true); return; }
            toast('已恢复世界「' + (r.saveName || b.saveName) + '」');
            window.loadSavesTab(inst, gameDir, body);
            refresh();
          } catch (e) {
            toast(failMsg(e), true);
          } finally { ev.target.disabled = false; }
        };
        row.querySelector('[data-fxb=del]').onclick = async (ev) => {
          if (!window.confirm('删除这条备份？此操作不可恢复')) return;
          ev.target.disabled = true;
          try {
            const r = await window.api.backupDelete(gameDir, b.file);
            if (!r || !r.ok) { toast('操作失败：' + ((r && r.error) || '未知错误'), true); return; }
            toast('已删除备份');
            refresh();
          } catch (e) {
            toast(failMsg(e), true);
          } finally { ev.target.disabled = false; }
        };
        listEl.appendChild(row);
      }
    }

    mask.querySelector('#fx-backup-close').onclick = () => mask.remove();
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { mask.remove(); document.removeEventListener('keydown', onKey); }
    });
    refresh();
  }

  /* ---------- 注入存档标签 UI ---------- */
  async function injectBackupUI(inst, gameDir, body) {
    if (!body || !body.isConnected) return;
    // (a) 头部 #sv-open 那行追加「备份管理」按钮（无存档的 early-return 分支也走到这里）
    const openBtn = body.querySelector('#sv-open');
    const headRow = openBtn ? openBtn.parentElement : null;
    if (headRow && !headRow.querySelector('#fx-backup-open')) {
      const btn = ce('button', 'btn sm');
      btn.id = 'fx-backup-open';
      btn.type = 'button';
      btn.textContent = '💾 备份管理';
      btn.onclick = () => openBackupModal(gameDir, inst, body);
      headRow.appendChild(btn);
    }
    // (b) 每张存档卡片追加「备份」小按钮（按顺序与 worldList 对齐拿 s.name）
    let items = [];
    try { items = (await window.api.worldList(gameDir)) || []; } catch (e) { items = []; }
    if (!body.isConnected) return;
    const cards = body.querySelectorAll('.save-card');
    cards.forEach((card, i) => {
      const s = items[i];
      if (!s) return;
      const actions = card.querySelector('.save-actions');
      if (!actions || actions.querySelector('[data-fxb=card-backup]')) return;
      const btn = ce('button', 'btn sm');
      btn.dataset.fxb = 'card-backup';
      btn.type = 'button';
      btn.textContent = '💾 备份';
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const r = await window.api.backupCreate(gameDir, s.name);
          if (!r || !r.ok) { toast('操作失败：' + ((r && r.error) || '未知错误'), true); return; }
          toast('已备份世界「' + s.name + '」');
        } catch (e) {
          toast(failMsg(e), true);
        } finally { btn.disabled = false; }
      };
      actions.appendChild(btn);
    });
  }

  /* ---------- 包装全局 loadSavesTab ---------- */
  const origLoadSavesTab = window.loadSavesTab;
  if (typeof origLoadSavesTab === 'function') {
    window.loadSavesTab = async function (inst, gameDir, body) {
      await origLoadSavesTab.call(this, inst, gameDir, body);
      injectBackupUI(inst, gameDir, body);
    };
  }
})();
