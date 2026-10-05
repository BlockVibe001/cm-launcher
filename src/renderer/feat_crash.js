/* ============================================================
 * feat_crash.js — 崩溃日志自动归因
 * 本文件是唯一领地：只改自己，样式注入 <style> 且类名加 fx- 前缀。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- i18n 文案 ---------- */
  var ZH = {
    'crash.auto': '🔍 分析崩溃原因',
    'crash.one': '分析',
    'crash.title': '崩溃归因',
    'crash.loading': '正在分析日志…',
    'crash.empty': '未找到可分析的日志',
    'crash.close': '关闭',
    'crash.detail': '展开原文',
    'crash.fold': '收起原文',
    'crash.kind.memory': '内存不足',
    'crash.kind.java': 'Java 版本',
    'crash.kind.dependency': '缺少依赖',
    'crash.kind.mod': '模组崩溃',
    'crash.kind.unknown': '未知原因',
    'crash.kind.none': '无日志',
  };
  var EN = {
    'crash.auto': '🔍 Analyze crash cause',
    'crash.one': 'Analyze',
    'crash.title': 'Crash analysis',
    'crash.loading': 'Analyzing log…',
    'crash.empty': 'No log to analyze',
    'crash.close': 'Close',
    'crash.detail': 'Show raw log',
    'crash.fold': 'Hide raw log',
    'crash.kind.memory': 'Out of memory',
    'crash.kind.java': 'Java version',
    'crash.kind.dependency': 'Missing dependency',
    'crash.kind.mod': 'Mod crash',
    'crash.kind.unknown': 'Unknown',
    'crash.kind.none': 'No log',
  };
  window.__DICT__ = window.__DICT__ || {};
  window.__DICT__['zh-CN'] = Object.assign({}, window.__DICT__['zh-CN'], ZH);
  window.__DICT__['en'] = Object.assign({}, window.__DICT__['en'], EN);

  /* ---------- api 扩展 ---------- */
  window.api = window.api || {};
  window.api.crashList = function (gameDir) {
    return window.__invoke('crash:list', { gameDir: gameDir });
  };
  window.api.crashAnalyze = function (gameDir, rel) {
    return window.__invoke('crash:analyze', { gameDir: gameDir, rel: rel });
  };

  /* ---------- 样式注入（fx- 前缀） ---------- */
  if (!document.getElementById('fx-crash-style')) {
    var st = document.createElement('style');
    st.id = 'fx-crash-style';
    st.textContent = [
      '.fx-crash-bar { display:flex; align-items:center; gap:8px; padding:4px 2px 10px; }',
      '.fx-crash-one { margin-left:6px; font-size:11px; padding:2px 8px; }',
      '.fx-modal-mask { z-index:2000 !important; }',
      '.fx-kind-badge { display:inline-block; padding:3px 12px; border-radius:999px; font-size:12px; margin:6px 0 4px; }',
      '.fx-kind-memory { background:rgba(255,152,0,.18); color:#ffb74d; }',
      '.fx-kind-java { background:rgba(66,165,245,.18); color:#64b5f6; }',
      '.fx-kind-dependency { background:rgba(244,67,54,.18); color:#ef9a9a; }',
      '.fx-kind-mod { background:rgba(186,104,200,.20); color:#ce93d8; }',
      '.fx-kind-unknown { background:rgba(140,140,140,.22); color:#bbb; }',
      '.fx-kind-none { background:rgba(140,140,140,.22); color:#bbb; }',
      '.fx-summary { font-size:14px; line-height:1.7; margin:4px 0 12px; }',
      '.fx-suggestions { margin:4px 0 12px; padding-left:20px; line-height:1.9; font-size:13.5px; }',
      '.fx-detail { max-height:260px; overflow:auto; background:rgba(0,0,0,.25); border-radius:8px; padding:10px; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-all; margin-bottom:10px; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- 弹窗 ---------- */
  function showLoading() {
    var mask = ce('div', 'modal-mask fx-modal-mask');
    mask.style.zIndex = '2000';
    mask.innerHTML =
      '<div class="modal"><div class="modal-title">' + t('crash.title') + '</div>' +
      '<div class="fx-summary">' + t('crash.loading') + '</div></div>';
    document.body.appendChild(mask);
    return mask;
  }

  function showResult(res, fileName) {
    res = res || {};
    var mask = ce('div', 'modal-mask fx-modal-mask');
    mask.style.zIndex = '2000';
    var kind = res.ok === false ? 'none' : (res.kind || 'unknown');
    var badge = '<span class="fx-kind-badge fx-kind-' + kind + '">' + escapeHtml(t('crash.kind.' + kind)) + '</span>';
    var bodyHtml;
    if (res.ok === false) {
      bodyHtml = '<div class="fx-summary">' + escapeHtml(res.summary || t('crash.empty')) + '</div>';
    } else {
      var items = (res.suggestions || []).map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('');
      bodyHtml = badge +
        '<div class="fx-summary">' + escapeHtml(res.summary || '') + '</div>' +
        (items ? '<ul class="fx-suggestions">' + items + '</ul>' : '') +
        (res.detail
          ? '<button class="btn sm ghost" id="fx-detail-toggle">' + t('crash.detail') + '</button>' +
            '<pre class="fx-detail" id="fx-detail" hidden>' + escapeHtml(res.detail) + '</pre>'
          : '');
    }
    mask.innerHTML =
      '<div class="modal">' +
      '<div class="modal-title">' + t('crash.title') + (fileName ? ' · ' + escapeHtml(fileName) : '') + '</div>' +
      bodyHtml +
      '<div class="modal-actions"><button class="btn primary" id="fx-close">' + t('crash.close') + '</button></div>' +
      '</div>';
    document.body.appendChild(mask);
    var close = function () { if (mask.parentNode) mask.parentNode.removeChild(mask); };
    mask.querySelector('#fx-close').onclick = close;
    mask.onclick = function (e) { if (e.target === mask) close(); };
    var toggle = mask.querySelector('#fx-detail-toggle');
    if (toggle) {
      toggle.onclick = function () {
        var d = mask.querySelector('#fx-detail');
        if (!d) return;
        var show = d.hidden;
        d.hidden = !show;
        toggle.textContent = show ? t('crash.fold') : t('crash.detail');
      };
    }
  }

  function analyze(gameDir, rel, label) {
    var loading = showLoading();
    window.api.crashAnalyze(gameDir, rel).then(function (res) {
      loading.remove();
      showResult(res, label);
    }).catch(function (e) {
      loading.remove();
      showResult({ ok: false, kind: 'none', summary: String((e && e.message) || e) }, label);
    });
  }

  function autoAnalyze(gameDir) {
    var loading = showLoading();
    window.api.crashList(gameDir).then(function (data) {
      var items = (data && data.items) || [];
      var crash = items.filter(function (i) { return i.kind === 'crash'; })
        .sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); })[0];
      loading.remove();
      if (crash) analyze(gameDir, crash.rel, crash.name);
      else analyze(gameDir, '', 'latest.log');
    }).catch(function (e) {
      loading.remove();
      showResult({ ok: false, kind: 'none', summary: String((e && e.message) || e) }, 'latest.log');
    });
  }

  /* ---------- 包装全局 loadLogsTab：注入工具条 + 每行分析按钮 ---------- */
  function inject(inst, gameDir, body) {
    if (!body || !body.isConnected) return;
    var layout = body.querySelector('.log-layout');
    if (!layout) return;

    if (!layout.querySelector('.fx-crash-bar')) {
      var bar = ce('div', 'fx-crash-bar');
      var btn = ce('button', 'btn sm primary');
      btn.id = 'fx-crash-auto';
      btn.textContent = t('crash.auto');
      btn.onclick = function () { autoAnalyze(gameDir); };
      bar.appendChild(btn);
      layout.insertBefore(bar, layout.firstChild);
    }

    window.api.crashList(gameDir).then(function (data) {
      var items = (data && data.items) || [];
      var rows = body.querySelectorAll('#log-list .log-item');
      rows.forEach(function (row) {
        var nameEl = row.querySelector('.log-item-name');
        var nm = nameEl ? nameEl.textContent.trim() : '';
        var it = items.find(function (i) { return i.name === nm; });
        if (!it || it.kind !== 'crash') return;
        if (row.querySelector('.fx-crash-one')) return;
        var one = ce('button', 'btn sm fx-crash-one');
        one.textContent = t('crash.one');
        one.onclick = function (e) {
          e.stopPropagation();
          analyze(gameDir, it.rel, it.name);
        };
        var meta = row.querySelector('.log-item-meta');
        if (meta) meta.appendChild(one); else row.appendChild(one);
      });
    }).catch(function () { /* 列表拉取失败不影响原功能 */ });
  }

  var orig = window.loadLogsTab;
  if (typeof orig === 'function') {
    window.loadLogsTab = function (inst, gameDir, body) {
      var p = orig.call(this, inst, gameDir, body);
      Promise.resolve(p).then(function () {
        try { inject(inst, gameDir, body); } catch (e) { console.warn('[crash] inject failed', e); }
      });
      return p;
    };
  }
})();
