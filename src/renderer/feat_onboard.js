/* ============================================================
 * feat_onboard.js — 新手引导
 * 亮点：点“去下载/去资源中心”先收起引导，不再压住后面的弹窗；
 *       首次默认 C 盘时把“选游戏目录”并进引导，不再单独弹一次。
 * ============================================================ */
(function () {
  'use strict';

  var KEY = 'cm.onboarded';

  window.__DICT__ = window.__DICT__ || {};
  window.__DICT__['zh-CN'] = Object.assign(window.__DICT__['zh-CN'] || {}, {
    'fx.onboard.welcome.title': '欢迎使用星云启动器',
    'fx.onboard.welcome.body': '先选好游戏文件放哪，再装一个版本，几分钟就能开玩。',
    'fx.onboard.dir.title': '先选游戏文件放哪',
    'fx.onboard.dir.body': '默认会放在 C 盘。建议选 D/E 等空间大的盘，版本、模组、存档都放这里，不占 C 盘。',
    'fx.onboard.dir.pick': '选择目录',
    'fx.onboard.dir.keep': '就用当前目录',
    'fx.onboard.download.title': '下载第一个版本',
    'fx.onboard.download.body': '选原版或 Fabric/Forge，点下载后自动装好，不用再手动补文件。',
    'fx.onboard.download.go': '去下载版本',
    'fx.onboard.center.title': '资源中心',
    'fx.onboard.center.body': '模组、光影、资源包、皮肤都在这里；下载记录会写到「下载与日志」。',
    'fx.onboard.center.go': '打开资源中心',
    'fx.onboard.done.title': '可以开玩了',
    'fx.onboard.done.body': '回到首页选中刚装好的实例，点「立即启动」即可。',
    'fx.onboard.start': '开始',
    'fx.onboard.next': '下一步',
    'fx.onboard.back': '上一步',
    'fx.onboard.skip': '跳过',
    'fx.onboard.done': '开始使用',
    'fx.onboard.reopen': '🎓 重新打开新手引导',
    'fx.onboard.step': '第 {n} / {total} 步',
  });
  window.__DICT__['en'] = Object.assign(window.__DICT__['en'] || {}, {
    'fx.onboard.welcome.title': 'Welcome to Nebula Launcher',
    'fx.onboard.welcome.body': 'Pick where game files live, install one version, and you are ready to play.',
    'fx.onboard.dir.title': 'Choose a game folder',
    'fx.onboard.dir.body': 'The default is on C:. Pick a roomier drive — versions, mods and worlds will live there.',
    'fx.onboard.dir.pick': 'Choose folder',
    'fx.onboard.dir.keep': 'Keep current folder',
    'fx.onboard.download.title': 'Install your first version',
    'fx.onboard.download.body': 'Pick Vanilla, Fabric or Forge and download — files are installed automatically.',
    'fx.onboard.download.go': 'Download a version',
    'fx.onboard.center.title': 'Resource Center',
    'fx.onboard.center.body': 'Mods, shaders, resource packs and skins live here; every download is logged.',
    'fx.onboard.center.go': 'Open Resource Center',
    'fx.onboard.done.title': 'Ready to play',
    'fx.onboard.done.body': 'Go back home, pick the new instance and hit Launch.',
    'fx.onboard.start': 'Start',
    'fx.onboard.next': 'Next',
    'fx.onboard.back': 'Back',
    'fx.onboard.skip': 'Skip',
    'fx.onboard.done': 'Get started',
    'fx.onboard.reopen': '🎓 Reopen the welcome tour',
    'fx.onboard.step': 'Step {n} / {total}',
  });

  function isDone() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function markDone() {
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* ignore */ }
  }

  function injectStyle() {
    if (document.getElementById('fx-onboard-style')) return;
    var css = ''
      + '.fx-ob-card{width:min(500px,92vw);padding:24px 24px 20px;border-radius:24px;position:relative;'
      + 'background:linear-gradient(145deg,rgba(28,32,44,.96),rgba(14,16,24,.97));border:1px solid rgba(255,255,255,.14);'
      + 'box-shadow:0 24px 80px rgba(0,0,0,.55);overflow:hidden}'
      + '.fx-ob-close{position:absolute;right:14px;top:12px;width:28px;height:28px;border:0;border-radius:50%;'
      + 'background:rgba(255,255,255,.08);color:var(--text-dim);font-size:15px;line-height:1;cursor:pointer}'
      + '.fx-ob-close:hover{background:rgba(255,255,255,.16);color:#fff}'
      + '.fx-ob-step{font-size:11px;letter-spacing:.14em;color:var(--text-faint);text-transform:uppercase}'
      + '.fx-ob-ico{width:54px;height:54px;border-radius:16px;display:grid;place-items:center;font-size:26px;margin:14px 0 12px;'
      + 'background:linear-gradient(135deg,rgba(92,132,255,.24),rgba(160,90,255,.18));border:1px solid rgba(255,255,255,.12)}'
      + '.fx-ob-title{font-size:20px;font-weight:800;color:#fff;margin:0 0 8px}'
      + '.fx-ob-body{font-size:13.5px;line-height:1.78;color:var(--text-dim);margin:0 0 12px}'
      + '.fx-ob-path{font-family:ui-monospace,Consolas,monospace;font-size:12px;padding:9px 11px;border-radius:10px;'
      + 'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:var(--text);word-break:break-all;margin-bottom:12px}'
      + '.fx-ob-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap;margin-top:18px}'
      + '.fx-ob-back{border:0;background:none;color:var(--text-faint);font-size:12.5px;cursor:pointer;margin-right:auto;padding:6px 2px}'
      + '.fx-ob-dots{display:flex;gap:6px;margin-top:16px}'
      + '.fx-ob-dots i{height:4px;flex:1;border-radius:999px;background:rgba(255,255,255,.14);transition:background .2s}'
      + '.fx-ob-dots i.on{background:var(--accent)}'
      + '.fx-ob-shade{position:fixed;inset:0;background:rgba(4,6,12,.62);backdrop-filter:blur(8px);z-index:2000;display:grid;place-items:center}';
    var style = document.createElement('style');
    style.id = 'fx-onboard-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  var mask = null;
  var idx = 0;
  var chosenDir = '';
  var dirStepEnabled = false;

  function close() {
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    mask = null;
  }

  function finish() {
    markDone();
    close();
  }

  function currentDir() {
    return chosenDir || (window.state && state.config && state.config.gameDir) || '';
  }

  function needsDirStep() {
    return dirStepEnabled;
  }

  function steps() {
    var list = [
      {
        ico: '👋', title: t('fx.onboard.welcome.title'), body: t('fx.onboard.welcome.body'),
        primary: { label: t('fx.onboard.start'), run: function () { idx++; render(); } },
        skip: true,
      },
    ];
    if (needsDirStep()) {
      list.push({
        ico: '📁', title: t('fx.onboard.dir.title'), body: t('fx.onboard.dir.body'), path: currentDir(),
        primary: { label: t('fx.onboard.dir.pick'), run: pickDir },
        secondary: { label: t('fx.onboard.dir.keep'), run: function () {
          api.configUpdate({ gameDirPicked: true }).catch(function () {});
          idx++; render();
        } },
        skip: true,
      });
    }
    list.push({
      ico: '📦', title: t('fx.onboard.download.title'), body: t('fx.onboard.download.body'),
      primary: { label: t('fx.onboard.download.go'), run: function () {
        finish();
        setTimeout(function () { try { openVersionInstaller({ mode: 'new' }); } catch (e) {} }, 120);
      } },
      skip: true,
    });
    list.push({
      ico: '✦', title: t('fx.onboard.center.title'), body: t('fx.onboard.center.body'),
      primary: { label: t('fx.onboard.center.go'), run: function () {
        finish();
        setTimeout(function () { try { renderPage('center'); } catch (e) {} }, 80);
      } },
      skip: true,
    });
    list.push({
      ico: '🎉', title: t('fx.onboard.done.title'), body: t('fx.onboard.done.body'),
      primary: { label: t('fx.onboard.done'), run: finish },
    });
    return list;
  }

  async function pickDir() {
    try {
      var dir = await api.pickDir();
      if (!dir) return;
      await api.configUpdate({ gameDir: dir, gameDirPicked: true });
      if (window.state) state.config = await api.configGetAll();
      chosenDir = dir;
      toast('游戏目录已设为 ' + dir);
      idx++;
      render();
    } catch (e) {
      toast('选择目录失败：' + (e.message || e), true);
    }
  }

  function render() {
    var list = steps();
    if (idx >= list.length) idx = list.length - 1;
    var cur = list[idx];
    var dots = list.map(function (_, i) { return '<i class="' + (i === idx ? 'on' : '') + '"></i>'; }).join('');
    var buttons = '<button class="btn primary" data-ob="primary">' + cur.primary.label + '</button>';
    if (cur.secondary) buttons += '<button class="btn" data-ob="secondary">' + cur.secondary.label + '</button>';
    if (cur.skip) buttons += '<button class="btn ghost" data-ob="skip">' + t('fx.onboard.skip') + '</button>';

    mask.innerHTML = ''
      + '<div class="fx-ob-card">'
      + '<button class="fx-ob-close" data-ob="skip" title="' + t('fx.onboard.skip') + '">✕</button>'
      + '<div class="fx-ob-step">' + t('fx.onboard.step').replace('{n}', idx + 1).replace('{total}', list.length) + '</div>'
      + '<div class="fx-ob-ico">' + cur.ico + '</div>'
      + '<div class="fx-ob-title">' + cur.title + '</div>'
      + '<div class="fx-ob-body">' + cur.body + '</div>'
      + (cur.path ? '<div class="fx-ob-path">' + cur.path.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>' : '')
      + '<div class="fx-ob-actions">'
      + (idx > 0 ? '<button class="fx-ob-back" data-ob="back">← ' + t('fx.onboard.back') + '</button>' : '')
      + buttons
      + '</div>'
      + '<div class="fx-ob-dots">' + dots + '</div>'
      + '</div>';

    var primary = mask.querySelector('[data-ob="primary"]');
    if (primary) primary.onclick = cur.primary.run;
    var secondary = mask.querySelector('[data-ob="secondary"]');
    if (secondary) secondary.onclick = cur.secondary.run;
    var back = mask.querySelector('[data-ob="back"]');
    if (back) back.onclick = function () { idx = Math.max(0, idx - 1); render(); };
    mask.querySelectorAll('[data-ob="skip"]').forEach(function (el) {
      el.onclick = finish;
    });
  }

  function show() {
    injectStyle();
    close();
    idx = 0;
    chosenDir = '';
    dirStepEnabled = /^[cC]:/.test((window.state && state.config && state.config.gameDir) || '');
    mask = document.createElement('div');
    mask.className = 'modal-mask fx-ob-shade';
    document.body.appendChild(mask);
    render();
  }

  if (window.__onHook) {
    window.__onHook('appReady', function () {
      if (window.__featDisclaimer && !window.__featDisclaimer.isAccepted()) return;
      if (!isDone()) setTimeout(show, 500);
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

  window.__featOnboard = { show: show, markDone: markDone, isDone: isDone };
})();
