/* ============================================================
 * feat_theme.js — 主题彩蛋 / 解锁机制（PCL2 式隐藏主题）
 * 纯前端实现：解锁状态存 localStorage（绝不写 config.theme，
 * config.rs sanitize 白名单只有 dark/light/oled/system）。
 *
 * 三个隐藏主题：
 *   neon   赛博霓虹  —— dark 基调 + 青/品红霓虹强调 + 动感渐变背景
 *                       解锁：累计启动次数 >= 3（本文件每次加载 launches+1）
 *   mint   薄荷奶油  —— light 基调 + 薄荷绿强调
 *                       解锁：连续点击左上角 .brand Logo 5 次（切页 / 2s 超时归零）
 *   sakura 樱花限定  —— light 基调 + 樱花粉
 *                       解锁：特殊节日当天（06-01 儿童节 / 12-31 跨年夜）
 *
 * 应用机制：包装全局 applyTheme()——隐藏主题生效时在原逻辑之后
 * 覆盖 body[data-mode]（按主题基调配 dark/light）与 body[data-secret]，
 * 并注入本文件自带的 <style>（fx- 前缀）。
 * ============================================================ */
(function () {
  'use strict';

  var KEY = 'cm.secretTheme';
  var MINT_STREAK_N = 5;          // 连续点 Logo 次数
  var STREAK_TIMEOUT = 2000;      // 两次点击间隔超过即断连
  var NEON_LAUNCH_MIN = 3;        // 累计启动次数门槛
  var SPECIAL_DATES = ['06-01', '12-31']; // MM-DD：儿童节 / 跨年夜

  /* ---------- 文案（zh-CN 原文 + en） ---------- */
  window.__DICT__ = window.__DICT__ || {};
  window.__DICT__['zh-CN'] = Object.assign(window.__DICT__['zh-CN'] || {}, {
    'fx.theme.neon': '赛博霓虹',
    'fx.theme.mint': '薄荷奶油',
    'fx.theme.sakura': '樱花限定',
    'fx.theme.hint.neon': '累计启动 3 次',
    'fx.theme.hint.mint': '连续点击左上角 Logo 5 次',
    'fx.theme.hint.sakura': '特殊节日当天（6 月 1 日 / 12 月 31 日）',
    'fx.theme.unlocked': '🎉 解锁隐藏主题：{name}',
    'fx.theme.lockedToast': '🔒 {name}（{hint}）',
  });
  window.__DICT__['en'] = Object.assign(window.__DICT__['en'] || {}, {
    'fx.theme.neon': 'Cyber Neon',
    'fx.theme.mint': 'Mint Cream',
    'fx.theme.sakura': 'Sakura Limited',
    'fx.theme.hint.neon': 'Launch the app 3 times in total',
    'fx.theme.hint.mint': 'Click the top-left logo 5 times in a row',
    'fx.theme.hint.sakura': 'On a special day (Jun 1 / Dec 31)',
    'fx.theme.unlocked': '🎉 Secret theme unlocked: {name}',
    'fx.theme.lockedToast': '🔒 {name} ({hint})',
  });

  var THEMES = {
    neon: { nameKey: 'fx.theme.neon', hintKey: 'fx.theme.hint.neon', base: 'dark' },
    mint: { nameKey: 'fx.theme.mint', hintKey: 'fx.theme.hint.mint', base: 'light' },
    sakura: { nameKey: 'fx.theme.sakura', hintKey: 'fx.theme.hint.sakura', base: 'light' },
  };

  /* ---------- 状态读写（localStorage） ---------- */
  function read() {
    var s = { launches: 0, logos: 0, unlocked: [], current: '' };
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      s.launches = raw.launches | 0;
      s.logos = raw.logos | 0;
      s.unlocked = Array.isArray(raw.unlocked) ? raw.unlocked.slice() : [];
      s.current = raw.current || '';
    } catch (e) { /* 损坏则重置 */ }
    return s;
  }
  function write(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  /* ---------- 本文件加载即计一次启动 ---------- */
  var st0 = read();
  st0.launches = (st0.launches | 0) + 1;
  write(st0);

  /* ---------- 解锁判定 ---------- */
  function dateKey() {
    var d = new Date();
    return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function unlock(id) {
    var s = read();
    if (s.unlocked.indexOf(id) >= 0) return false;
    s.unlocked.push(id);
    write(s);
    try { toast(t('fx.theme.unlocked', { name: t(THEMES[id].nameKey) })); } catch (e) { /* toast 未就绪 */ }
    return true;
  }
  function refreshUnlocks() {
    var s = read();
    if (s.launches >= NEON_LAUNCH_MIN) unlock('neon');
    if (SPECIAL_DATES.indexOf(dateKey()) >= 0) unlock('sakura');
  }

  /* ---------- 隐藏主题 CSS（fx- 前缀，自带 style 节点） ---------- */
  function injectStyle() {
    if (document.getElementById('fx-secret-theme-style')) return;
    var css = ''
      + 'body[data-secret="neon"] {'
      + '  --accent:#22e6ff; --accent-2:#ff3df0;'
      + '  --accent-glow:rgba(34,230,255,.40); --accent-soft:rgba(255,61,240,.16);'
      + '}'
      + 'body[data-secret="neon"] .bg-layer {'
      + '  background:'
      + '    radial-gradient(60% 50% at 12% 0%, rgba(255,61,240,.38), transparent 72%),'
      + '    radial-gradient(55% 60% at 92% 18%, rgba(34,230,255,.34), transparent 72%),'
      + '    linear-gradient(120deg,#0a0420 0%,#150a33 48%,#041c30 100%) !important;'
      + '  animation: fx-neon-shift 9s ease-in-out infinite alternate;'
      + '}'
      + '@keyframes fx-neon-shift {'
      + '  from { filter: hue-rotate(0deg) saturate(1.1); }'
      + '  to   { filter: hue-rotate(45deg) saturate(1.35); }'
      + '}'
      + 'body[data-mode="light"][data-secret="mint"], body[data-secret="mint"] {'
      + '  --accent:#22c582; --accent-2:#129a63;'
      + '  --accent-glow:rgba(34,197,130,.30); --accent-soft:rgba(34,197,130,.15);'
      + '  --bg-0:#ecf6ee;'
      + '}'
      + 'body[data-secret="mint"] .bg-layer {'
      + '  background:'
      + '    radial-gradient(70% 60% at 18% 8%, rgba(120,230,180,.50), transparent 72%),'
      + '    linear-gradient(160deg,#f3fbf4 0%,#e3f2e9 100%) !important;'
      + '}'
      + 'body[data-mode="light"][data-secret="sakura"], body[data-secret="sakura"] {'
      + '  --accent:#ff8fb8; --accent-2:#ef5f95;'
      + '  --accent-glow:rgba(255,143,184,.32); --accent-soft:rgba(255,143,184,.16);'
      + '  --bg-0:#fdf0f5;'
      + '}'
      + 'body[data-secret="sakura"] .bg-layer {'
      + '  background:'
      + '    radial-gradient(60% 50% at 82% 0%, rgba(255,183,213,.60), transparent 72%),'
      + '    radial-gradient(50% 50% at 8% 92%, rgba(255,209,228,.55), transparent 72%),'
      + '    linear-gradient(160deg,#fff5f9 0%,#ffe7ef 100%) !important;'
      + '}'
      + '.fx-secret-btn.locked { opacity:.62; font-weight:400; }'
      + '.fx-secret-btn .fx-cond { display:block; font-size:10.5px; line-height:1.4; opacity:.8; }';
    var style = document.createElement('style');
    style.id = 'fx-secret-theme-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---------- 包装全局 applyTheme ---------- */
  var origApply = (typeof window.applyTheme === 'function') ? window.applyTheme : null;

  function applyThemeWrapped() {
    // 先跑原有逻辑（data-accent / data-mode=resolveMode / glass / wallpaper），
    // 隐藏主题再覆盖 data-mode 与 data-secret。
    if (origApply) {
      try { origApply(); } catch (e) { /* config 未就绪时忽略 */ }
    }
    var s = read();
    var cur = s.current;
    if (cur && THEMES[cur] && s.unlocked.indexOf(cur) >= 0) {
      document.body.setAttribute('data-mode', THEMES[cur].base);
      document.body.setAttribute('data-secret', cur);
    } else {
      document.body.removeAttribute('data-secret');
      if (cur) { s.current = ''; write(s); } // 非法 current（如被删解锁）→ 回退官方主题
    }
  }
  window.applyTheme = applyThemeWrapped;

  /* ---------- Mint：连续点 .brand 5 次 ---------- */
  var streak = 0;
  var streakTimer = null;
  function onBrandClick() {
    var s = read();
    s.logos = (s.logos | 0) + 1;
    write(s);
    streak++;
    if (streakTimer) clearTimeout(streakTimer);
    streakTimer = setTimeout(function () { streak = 0; }, STREAK_TIMEOUT);
    if (streak >= MINT_STREAK_N) {
      streak = 0;
      unlock('mint');
    }
  }
  function bindBrand() {
    var brand = document.querySelector('.brand');
    if (brand && !brand.__fxThemeBound) {
      brand.__fxThemeBound = 1;
      brand.addEventListener('click', onBrandClick);
    }
  }

  /* ---------- 设置页：#ui-theme 追加隐藏主题按钮 ---------- */
  function renderSecretOpts() {
    var box = document.getElementById('ui-theme');
    if (!box) return;
    var s = read();

    Object.keys(THEMES).forEach(function (id) {
      var meta = THEMES[id];
      var unlocked = s.unlocked.indexOf(id) >= 0;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-opt fx-secret-btn'
        + (unlocked && s.current === id ? ' on' : '')
        + (unlocked ? '' : ' locked');
      btn.dataset.secret = id;
      if (unlocked) {
        btn.textContent = t(meta.nameKey);
      } else {
        var name = document.createElement('span');
        name.textContent = '🔒 ' + t(meta.nameKey);
        var cond = document.createElement('span');
        cond.className = 'fx-cond';
        cond.textContent = t(meta.hintKey);
        btn.appendChild(name);
        btn.appendChild(cond);
      }
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var cur = read();
        if (cur.unlocked.indexOf(id) < 0) {
          toast(t('fx.theme.lockedToast', { name: t(meta.nameKey), hint: t(meta.hintKey) }));
          return;
        }
        cur.current = (cur.current === id) ? '' : id; // 再点一次取消 → 回退官方主题
        write(cur);
        applyThemeWrapped();
        // 同步选中态
        box.querySelectorAll('.fx-secret-btn').forEach(function (b) {
          b.classList.toggle('on', b.dataset.secret === cur.current);
        });
        box.querySelectorAll('.ui-opt:not(.fx-secret-btn)').forEach(function (b) {
          b.classList.remove('on');
        });
      });
      box.appendChild(btn);
    });

    // 点官方 4 主题 → 清除隐藏主题 current
    box.querySelectorAll('.ui-opt:not(.fx-secret-btn)').forEach(function (b) {
      b.addEventListener('click', function () {
        var cur = read();
        if (cur.current) { cur.current = ''; write(cur); }
        document.body.removeAttribute('data-secret');
      });
    });

    // 渲染时同步选中态：隐藏主题激活时，官方按钮全部取消高亮
    if (s.current) {
      box.querySelectorAll('.ui-opt:not(.fx-secret-btn)').forEach(function (b) {
        b.classList.remove('on');
      });
    }
  }

  /* ---------- 生命周期钩子 ---------- */
  if (window.__onHook) {
    window.__onHook('appReady', function () {
      injectStyle();
      refreshUnlocks();
      bindBrand();
      applyThemeWrapped();
    });
    window.__onHook('pageRendered', function (page) {
      streak = 0; // 切页打断连击
      bindBrand();
      if (page === 'settings') {
        injectStyle();
        refreshUnlocks();
        renderSecretOpts();
      }
    });
  }

  /* ---------- 冒烟/调试接口（仅调试用，不侵入正常逻辑） ---------- */
  window.__featTheme = {
    state: function () { return read(); },
    setLaunches: function (n) {
      var s = read();
      s.launches = Math.max(0, n | 0);
      write(s);
      refreshUnlocks();
      applyThemeWrapped();
      return read();
    },
    setLogos: function (n) {
      var s = read();
      s.logos = Math.max(0, n | 0);
      write(s);
      return read();
    },
    apply: function () { applyThemeWrapped(); },
  };
})();
