/* ============================================================
 * feat_onboard.js — 新手引导
 * 纯前端实现：首次启动（localStorage 无 cm.onboarded 标记）弹出
 * 步骤式引导遮罩（.modal-mask，z-index 2000）：
 *   1 欢迎  →  2 下载版本/建实例（openVersionInstaller({mode:'new'})）
 *   →  3 资源中心指引（renderPage('center')）  →  4 完成。
 * 每步都可「跳过」；跳过/完成都会写入 cm.onboarded='1'。
 * 设置页提供「重新打开新手引导」入口（.fx-onboard-reopen）。
 * ============================================================ */
(function () {
  'use strict';

  var KEY = 'cm.onboarded';

  /* ---------- 文案 ---------- */
  window.__DICT__ = window.__DICT__ || {};
  window.__DICT__['zh-CN'] = Object.assign(window.__DICT__['zh-CN'] || {}, {
    'fx.onboard.welcome.title': '👋 欢迎使用 BlockVibe Launcher',
    'fx.onboard.welcome.body': '三步带你装好第一个版本，开始你的方块之旅。',
    'fx.onboard.step2.title': '📦 下载游戏版本',
    'fx.onboard.step2.body': '选一个 Mod 加载器（原版 / Fabric / Forge…）和游戏版本，即可创建你的第一个实例。',
    'fx.onboard.step3.title': '✿ 前往资源中心',
    'fx.onboard.step3.body': 'Mod、光影、皮肤、数据包……所有游戏资源都在这里下载。',
    'fx.onboard.step4.title': '🎉 一切就绪',
    'fx.onboard.step4.body': '回到首页选好实例，点「启动」就能开玩了！',
    'fx.onboard.start': '开始引导',
    'fx.onboard.next': '下一步',
    'fx.onboard.skip': '跳过',
    'fx.onboard.download': '下载版本',
    'fx.onboard.center': '前往资源中心',
    'fx.onboard.done': '开始使用',
    'fx.onboard.reopen': '🎓 重新打开新手引导',
  });
  window.__DICT__['en'] = Object.assign(window.__DICT__['en'] || {}, {
    'fx.onboard.welcome.title': '👋 Welcome to BlockVibe Launcher',
    'fx.onboard.welcome.body': 'Set up your first version in three quick steps.',
    'fx.onboard.step2.title': '📦 Download a game version',
    'fx.onboard.step2.body': 'Pick a mod loader (Vanilla / Fabric / Forge…) and a game version to create your first instance.',
    'fx.onboard.step3.title': '✿ Visit the Resource Center',
    'fx.onboard.step3.body': 'Mods, shaders, skins, datapacks — all game resources are downloaded here.',
    'fx.onboard.step4.title': '🎉 All set',
    'fx.onboard.step4.body': 'Pick an instance on the home page and hit Launch to play!',
    'fx.onboard.start': 'Start tour',
    'fx.onboard.next': 'Next',
    'fx.onboard.skip': 'Skip',
    'fx.onboard.download': 'Download version',
    'fx.onboard.center': 'Open Resource Center',
    'fx.onboard.done': 'Get started',
    'fx.onboard.reopen': '🎓 Reopen the welcome tour',
  });

  function isDone() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function markDone() {
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* ignore */ }
  }

  /* ---------- 注入自带样式 ---------- */
  function injectStyle() {
    if (document.getElementById('fx-onboard-style')) return;
    var css = ''
      + '.fx-onboard-modal { width:min(440px, 92vw); }'
      + '.fx-onboard-body { margin:14px 0 18px; line-height:1.75; color:var(--text-dim); font-size:13.5px; }'
      + '.fx-onboard-dots { display:flex; gap:6px; justify-content:center; margin-bottom:14px; }'
      + '.fx-onboard-dots i { width:7px; height:7px; border-radius:50%; background:var(--bg-4); transition:all .2s; }'
      + '.fx-onboard-dots i.on { background:var(--accent); box-shadow:0 0 8px var(--accent-glow); }'
      + '.fx-onboard-actions { display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }';
    var style = document.createElement('style');
    style.id = 'fx-onboard-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---------- 引导遮罩 ---------- */
  var mask = null;

  function close() {
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    mask = null;
  }

  function stepDefs() {
    return [
      {
        title: t('fx.onboard.welcome.title'),
        body: t('fx.onboard.welcome.body'),
        buttons: [
          { label: t('fx.onboard.start'), primary: true, run: goNext },
          { label: t('fx.onboard.skip'), primary: false, run: finish },
        ],
      },
      {
        title: t('fx.onboard.step2.title'),
        body: t('fx.onboard.step2.body'),
        buttons: [
          {
            label: t('fx.onboard.download'), primary: true,
            run: function () { try { openVersionInstaller({ mode: 'new' }); } catch (e) { /* ignore */ } },
          },
          { label: t('fx.onboard.next'), primary: false, run: goNext },
          { label: t('fx.onboard.skip'), primary: false, run: finish },
        ],
      },
      {
        title: t('fx.onboard.step3.title'),
        body: t('fx.onboard.step3.body'),
        buttons: [
          {
            label: t('fx.onboard.center'), primary: true,
            run: function () { try { renderPage('center'); } catch (e) { /* ignore */ } },
          },
          { label: t('fx.onboard.next'), primary: false, run: goNext },
          { label: t('fx.onboard.skip'), primary: false, run: finish },
        ],
      },
      {
        title: t('fx.onboard.step4.title'),
        body: t('fx.onboard.step4.body'),
        buttons: [
          { label: t('fx.onboard.done'), primary: true, run: finish },
        ],
      },
    ];
  }

  var idx = 0;
  function goNext() { idx++; renderStep(); }
  function finish() { markDone(); close(); }

  function renderStep() {
    var steps = stepDefs();
    var cur = steps[Math.min(idx, steps.length - 1)];
    var dotsHtml = steps.map(function (_, i) {
      return '<i class="' + (i === Math.min(idx, steps.length - 1) ? 'on' : '') + '"></i>';
    }).join('');
    var actionsHtml = cur.buttons.map(function (b, i) {
      return '<button class="btn ' + (b.primary ? 'primary' : 'ghost') + '" data-fx-btn="' + i + '" type="button">'
        + b.label + '</button>';
    }).join('');

    mask.innerHTML = ''
      + '<div class="modal fx-onboard-modal">'
      +   '<div class="fx-onboard-dots">' + dotsHtml + '</div>'
      +   '<div class="modal-title">' + cur.title + '</div>'
      +   '<div class="fx-onboard-body">' + cur.body + '</div>'
      +   '<div class="fx-onboard-actions">' + actionsHtml + '</div>'
      + '</div>';

    cur.buttons.forEach(function (b, i) {
      var el = mask.querySelector('[data-fx-btn="' + i + '"]');
      if (el) el.addEventListener('click', b.run);
    });
  }

  function show() {
    injectStyle();
    close(); // 防重复
    idx = 0;
    mask = document.createElement('div');
    mask.className = 'modal-mask fx-onboard-mask';
    document.body.appendChild(mask);
    renderStep();
  }

  /* ---------- 生命周期 ---------- */
  if (window.__onHook) {
    window.__onHook('appReady', function () {
      if (!isDone()) {
        // 等首页先渲染出来，再叠引导遮罩
        setTimeout(show, 500);
      }
    });
    window.__onHook('pageRendered', function (page, pageEl) {
      if (page !== 'settings' || !pageEl) return;
      var wrap = document.createElement('div');
      wrap.className = 'glass';
      wrap.style.cssText = 'padding:18px;margin-top:18px;';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn fx-onboard-reopen';
      btn.textContent = t('fx.onboard.reopen');
      btn.addEventListener('click', show);
      wrap.appendChild(btn);
      pageEl.appendChild(wrap);
    });
  }

  /* ---------- 冒烟/调试接口 ---------- */
  window.__featOnboard = {
    show: show,
    markDone: markDone,
    isDone: isDone,
  };
})();
