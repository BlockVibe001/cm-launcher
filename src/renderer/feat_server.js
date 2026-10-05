/* ============================================================
 * feat_server.js — 内置服务器管理（开服）
 * 入口：联机大厅页（pageRendered('servers')）注入「🖥️ 开服管理」卡片，
 * 点击弹窗：创建服务器（MC 版本 + 加载器 + 名称）→ 控制台（流式输出 +
 * 命令输入）→ 启动/停止。样式全部在本文件 <style>（fx- 前缀）。
 * ============================================================ */
(function () {
  'use strict';

  if (!window.__invoke || !window.__TAURI__) return; // 非 Tauri 环境不挂载

  /* ---------- 文案 ---------- */
  window.__DICT__ = window.__DICT__ || {};
  window.__DICT__['zh-CN'] = Object.assign(window.__DICT__['zh-CN'] || {}, {
    'fx.srv.entry.title': '🖥️ 开服管理',
    'fx.srv.entry.desc': '下载服务端 jar，一键开服：内置控制台与命令输入，朋友联机先把服务端跑起来。',
    'fx.srv.entry.open': '⚙ 打开开服管理台',
    'fx.srv.title': '🖥️ 开服管理',
    'fx.srv.create': '创建服务器',
    'fx.srv.mcVer': 'MC 版本',
    'fx.srv.mcVerPh': '如 1.20.1 / 1.21',
    'fx.srv.loader': '加载器',
    'fx.srv.name': '服务器名',
    'fx.srv.namePh': '留空自动生成',
    'fx.srv.maxMem': '最大内存（MB）',
    'fx.srv.createBtn': '创建并下载',
    'fx.srv.creating': '正在下载…',
    'fx.srv.list': '已创建的服务器',
    'fx.srv.emptyList': '还没有服务器，先在上面创建一个。',
    'fx.srv.running': '运行中',
    'fx.srv.stopped': '已停止',
    'fx.srv.start': '启动',
    'fx.srv.stop': '停止',
    'fx.srv.cmdPh': '输入命令，回车发送（如 say hello）',
    'fx.srv.noDir': '先选择或创建一个服务器',
    'fx.srv.created': '服务器「{name}」创建完成',
    'fx.srv.started': '服务端已启动（pid {pid}）',
    'fx.srv.stoppedMsg': '服务端已停止',
    'fx.srv.noneConsole': '选择左侧服务器后，这里会显示控制台输出。',
    'fx.srv.dir': '目录',
  });
  window.__DICT__['en'] = Object.assign(window.__DICT__['en'] || {}, {
    'fx.srv.entry.title': '🖥️ Dedicated Server',
    'fx.srv.entry.desc': 'Download the server jar and start it with one click: built-in console and command input.',
    'fx.srv.entry.open': '⚙ Open server console',
    'fx.srv.title': '🖥️ Dedicated Server',
    'fx.srv.create': 'Create server',
    'fx.srv.mcVer': 'MC version',
    'fx.srv.mcVerPh': 'e.g. 1.20.1 / 1.21',
    'fx.srv.loader': 'Loader',
    'fx.srv.name': 'Server name',
    'fx.srv.namePh': 'auto if empty',
    'fx.srv.maxMem': 'Max memory (MB)',
    'fx.srv.createBtn': 'Create & download',
    'fx.srv.creating': 'Downloading…',
    'fx.srv.list': 'Servers',
    'fx.srv.emptyList': 'No server yet. Create one above.',
    'fx.srv.running': 'Running',
    'fx.srv.stopped': 'Stopped',
    'fx.srv.start': 'Start',
    'fx.srv.stop': 'Stop',
    'fx.srv.cmdPh': 'Type a command, Enter to send (e.g. say hello)',
    'fx.srv.noDir': 'Select or create a server first',
    'fx.srv.created': 'Server "{name}" created',
    'fx.srv.started': 'Server started (pid {pid})',
    'fx.srv.stoppedMsg': 'Server stopped',
    'fx.srv.noneConsole': 'Select a server on the left to see its console.',
    'fx.srv.dir': 'Dir',
  });

  /* ---------- api 扩展 ---------- */
  window.api = window.api || {};
  window.api.serverSetup = (opts) => window.__invoke('server:setup', { opts });
  window.api.serverStart = (dir, memory) => window.__invoke('server:start', { dir, memory });
  window.api.serverStop = (dir) => window.__invoke('server:stop', { dir });
  window.api.serverStatus = () => window.__invoke('server:status');
  window.api.serverInput = (dir, line) => window.__invoke('server:input', { dir, line });
  window.api.onServerConsole = (cb) =>
    window.__TAURI__.event.listen('server:console', (e) => cb(e.payload));

  /* ---------- 控制台缓冲（按 dir 分桶） ---------- */
  const buffers = {};
  function bufferFor(dir) { return (buffers[dir] = buffers[dir] || []); }
  function appendLine(dir, line) {
    const buf = bufferFor(dir);
    buf.push(line);
    if (buf.length > 5000) buf.splice(0, buf.length - 5000);
    const pre = document.getElementById('fx-srv-console');
    if (pre && pre.dataset.dir === dir) {
      pre.textContent += line + '\n';
      pre.scrollTop = pre.scrollHeight;
    }
  }
  window.api.onServerConsole((p) => {
    if (p && p.dir) appendLine(p.dir, String(p.line == null ? '' : p.line));
  });

  /* ---------- 样式（fx- 前缀） ---------- */
  function injectStyle() {
    if (document.getElementById('fx-srv-style')) return;
    const css = ''
      + '#fx-srv-entry .lan-title { font-size:15px; }'
      + '.fx-srv-modal { width:min(880px,94vw); max-width:none; padding:18px 20px; }'
      + '.fx-srv-body { display:flex; gap:16px; margin-top:12px; }'
      + '.fx-srv-left { width:280px; flex:0 0 280px; display:flex; flex-direction:column; gap:12px; }'
      + '.fx-srv-right { flex:1; min-width:0; display:flex; flex-direction:column; gap:8px; }'
      + '.fx-srv-section { font-size:12px; color:var(--text-dim); letter-spacing:.04em; text-transform:uppercase; margin-top:2px; }'
      + '.fx-srv-list { display:flex; flex-direction:column; gap:6px; max-height:150px; overflow-y:auto; }'
      + '.fx-srv-item { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--border); border-radius:9px; cursor:pointer; background:rgba(127,127,127,.06); }'
      + '.fx-srv-item.on { border-color:var(--accent); background:var(--accent-soft, rgba(127,127,127,.12)); }'
      + '.fx-srv-item .nm { flex:1; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }'
      + '.fx-srv-dot { width:8px; height:8px; border-radius:50%; background:#64748b; flex:0 0 8px; }'
      + '.fx-srv-item.run .fx-srv-dot { background:#22c55e; box-shadow:0 0 6px #22c55e; }'
      + '.fx-srv-status { display:flex; align-items:center; gap:10px; font-size:12.5px; color:var(--text-dim); }'
      + '.fx-srv-status b { color:var(--text); }'
      + '#fx-srv-console {'
      + '  height:320px; overflow-y:auto; overflow-x:auto; border-radius:10px;'
      + '  background:#070b10; color:#d7e3ee; font:12px/1.55 Consolas,Menlo,monospace;'
      + '  padding:10px 12px; white-space:pre-wrap; word-break:break-all; margin:0; }'
      + '#fx-srv-console.idle { display:flex; align-items:center; justify-content:center; color:#5b6b7c; background:transparent; }'
      + '.fx-srv-row { display:flex; gap:8px; align-items:center; }'
      + '.fx-srv-row .input { flex:1; }'
      + '.fx-srv-form .field { margin-bottom:8px; }'
      + '.fx-srv-form .field label { font-size:11.5px; color:var(--text-dim); }'
      + '.fx-srv-actions { display:flex; gap:8px; margin-top:2px; }';
    const style = document.createElement('style');
    style.id = 'fx-srv-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---------- 状态 ---------- */
  let modal = null;
  let currentDir = null;
  let serversCache = [];
  let pollTimer = null;

  /* ---------- 渲染：左侧服务器列表 ---------- */
  function renderList() {
    const box = modal && modal.querySelector('.fx-srv-list');
    if (!box) return;
    if (!serversCache.length) {
      box.innerHTML = '<div class="hint-text">' + t('fx.srv.emptyList') + '</div>';
      return;
    }
    box.innerHTML = '';
    serversCache.forEach((s) => {
      const it = document.createElement('div');
      it.className = 'fx-srv-item' + (s.running ? ' run' : '') + (s.dir === currentDir ? ' on' : '');
      it.innerHTML = '<i class="fx-srv-dot"></i><span class="nm"></span>';
      it.querySelector('.nm').textContent = s.name + (s.running ? '' : '');
      it.title = s.dir;
      it.onclick = () => selectDir(s.dir);
      box.appendChild(it);
    });
  }

  function refreshStatusLine() {
    const line = modal && modal.querySelector('.fx-srv-status');
    if (!line) return;
    const s = serversCache.find((x) => x.dir === currentDir);
    if (!s) {
      line.innerHTML = '<b>' + t('fx.srv.noneConsole') + '</b>';
      return;
    }
    line.innerHTML = '<b>' + s.name + '</b>'
      + (s.running
        ? ' · <span style="color:#22c55e">' + t('fx.srv.running') + '</span> · pid ' + (s.pid || '?')
        : ' · <span style="color:#94a3b8">' + t('fx.srv.stopped') + '</span>')
      + ' <span style="flex:1"></span><span class="hint-text" title="' + s.dir + '">' + t('fx.srv.dir') + '</span>';
    const pre = document.getElementById('fx-srv-console');
    if (pre) {
      pre.dataset.dir = currentDir;
      pre.classList.remove('idle');
      pre.textContent = bufferFor(currentDir).join('\n') + (bufferFor(currentDir).length ? '\n' : '');
      pre.scrollTop = pre.scrollHeight;
    }
    const startBtn = modal.querySelector('#fx-srv-start');
    const stopBtn = modal.querySelector('#fx-srv-stop');
    if (startBtn) startBtn.disabled = !!s.running;
    if (stopBtn) stopBtn.disabled = !s.running;
  }

  async function pollStatus() {
    try {
      const r = await window.api.serverStatus();
      serversCache = (r && r.servers) || [];
      renderList();
      refreshStatusLine();
    } catch (e) { /* 轮询失败静默 */ }
  }

  function selectDir(dir) {
    currentDir = dir;
    renderList();
    refreshStatusLine();
  }

  /* ---------- 弹窗 ---------- */
  function openPanel() {
    if (modal) return;
    injectStyle();
    modal = document.createElement('div');
    modal.className = 'modal-mask';
    modal.innerHTML =
      '<div class="modal fx-srv-modal">'
      + '<div class="modal-title">' + t('fx.srv.title') + '</div>'
      + '<div class="fx-srv-body">'
      + '  <div class="fx-srv-left">'
      + '    <div class="fx-srv-section">' + t('fx.srv.create') + '</div>'
      + '    <div class="fx-srv-form">'
      + '      <div class="field"><label>' + t('fx.srv.mcVer') + '</label>'
      + '        <input class="input" id="fx-srv-mc" placeholder="' + t('fx.srv.mcVerPh') + '"></div>'
      + '      <div class="field"><label>' + t('fx.srv.loader') + '</label>'
      + '        <select class="input" id="fx-srv-loader">'
      + '          <option value="vanilla">Vanilla</option>'
      + '          <option value="fabric" selected>Fabric</option>'
      + '          <option value="forge">Forge</option>'
      + '        </select></div>'
      + '      <div class="field"><label>' + t('fx.srv.name') + '</label>'
      + '        <input class="input" id="fx-srv-name" placeholder="' + t('fx.srv.namePh') + '"></div>'
      + '      <div class="field"><label>' + t('fx.srv.maxMem') + '</label>'
      + '        <input class="input" id="fx-srv-mem" type="number" value="2048" min="512" step="256"></div>'
      + '      <button class="btn primary" id="fx-srv-create" type="button" style="width:100%">' + t('fx.srv.createBtn') + '</button>'
      + '    </div>'
      + '    <div class="fx-srv-section">' + t('fx.srv.list') + '</div>'
      + '    <div class="fx-srv-list"></div>'
      + '  </div>'
      + '  <div class="fx-srv-right">'
      + '    <div class="fx-srv-status"></div>'
      + '    <pre id="fx-srv-console" class="idle"></pre>'
      + '    <div class="fx-srv-row">'
      + '      <input class="input" id="fx-srv-cmd" placeholder="' + t('fx.srv.cmdPh') + '">'
      + '    </div>'
      + '    <div class="fx-srv-actions">'
      + '      <button class="btn primary" id="fx-srv-start" type="button">' + t('fx.srv.start') + '</button>'
      + '      <button class="btn danger" id="fx-srv-stop" type="button">' + t('fx.srv.stop') + '</button>'
      + '    </div>'
      + '  </div>'
      + '</div></div>';
    document.body.appendChild(modal);

    // enhanceSelect（若全局可用）
    try { if (window.enhanceSelect) window.enhanceSelect(modal.querySelector('#fx-srv-loader')); } catch (e) {}

    // 创建
    modal.querySelector('#fx-srv-create').onclick = async (ev) => {
      const btn = ev.currentTarget;
      const mc = modal.querySelector('#fx-srv-mc').value.trim();
      const loader = modal.querySelector('#fx-srv-loader').value;
      const name = modal.querySelector('#fx-srv-name').value.trim();
      if (!mc) { toast(t('fx.srv.mcVer') + '：1.20.1', true); return; }
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = t('fx.srv.creating');
      try {
        const r = await window.api.serverSetup({ mcVersion: mc, loader: loader, name: name });
        if (r && r.ok) {
          toast(t('fx.srv.created', { name: r.name || name || mc }));
          await pollStatus();
          selectDir(r.dir);
        } else {
          toast('创建失败：' + ((r && r.error) || 'unknown'), true);
        }
      } catch (e) {
        toast('创建失败：' + e.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    };

    // 启动
    modal.querySelector('#fx-srv-start').onclick = async () => {
      if (!currentDir) { toast(t('fx.srv.noDir'), true); return; }
      const mem = parseInt(modal.querySelector('#fx-srv-mem').value, 10) || 2048;
      try {
        const r = await window.api.serverStart(currentDir, { max: mem });
        if (r && r.ok) {
          toast(t('fx.srv.started', { pid: r.pid }));
          await pollStatus();
        } else {
          toast('启动失败：' + ((r && r.error) || 'unknown'), true);
        }
      } catch (e) {
        toast('启动失败：' + e.message, true);
      }
    };

    // 停止
    modal.querySelector('#fx-srv-stop').onclick = async () => {
      if (!currentDir) return;
      try {
        const r = await window.api.serverStop(currentDir);
        if (r && r.ok) toast(t('fx.srv.stoppedMsg'));
        else toast('停止失败：' + ((r && r.error) || 'unknown'), true);
      } catch (e) {
        toast('停止失败：' + e.message, true);
      } finally {
        setTimeout(pollStatus, 600);
      }
    };

    // 命令输入
    modal.querySelector('#fx-srv-cmd').onkeydown = async (e) => {
      if (e.key !== 'Enter') return;
      const input = e.currentTarget;
      const line = input.value.trim();
      if (!line || !currentDir) return;
      try {
        await window.api.serverInput(currentDir, line);
        input.value = '';
      } catch (err) {
        toast('命令发送失败：' + err.message, true);
      }
    };

    // 点遮罩关闭
    modal.onclick = (e) => { if (e.target === modal) closePanel(); };

    pollStatus();
    pollTimer = setInterval(pollStatus, 3000);
  }

  function closePanel() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (modal) { modal.remove(); modal = null; }
  }

  /* ---------- 联机大厅页入口 ---------- */
  function injectEntry(pageEl) {
    if (pageEl.querySelector('#fx-srv-entry')) return;
    const card = document.createElement('div');
    card.className = 'glass lan-card lan-wide';
    card.id = 'fx-srv-entry';
    card.innerHTML =
      '<div class="lan-title">' + t('fx.srv.entry.title') + '</div>'
      + '<div class="lan-desc">' + t('fx.srv.entry.desc') + '</div>'
      + '<div class="row" style="margin-top:12px">'
      + '  <button class="btn primary" id="fx-srv-open" type="button">' + t('fx.srv.entry.open') + '</button>'
      + '</div>';
    const grid = pageEl.querySelector('.lan-grid');
    if (grid) grid.insertBefore(card, grid.firstChild);
    else pageEl.appendChild(card);
    card.querySelector('#fx-srv-open').onclick = openPanel;
  }

  if (window.__onHook) {
    window.__onHook('pageRendered', function (page, pageEl) {
      if (page === 'servers') injectStyle(), injectEntry(pageEl);
    });
  }

  /* ---------- 冒烟/调试句柄 ---------- */
  window.__featServer = {
    buffers: buffers,
    samples: function (dir) { return (buffers[dir] || []).slice(); },
    open: openPanel,
    close: closePanel,
  };
})();
