// 轻量 i18n v2：语义 key 翻译（t/data-i18n）+ 运行时 DOM 翻译（translatePage）。
// - t(key, vars)：按语义 key 查字典，缺失回退 zh，再缺失回退 key 本身。
// - data-i18n / data-i18n-ph / data-i18n-title：静态元素替换。
// - translatePage()：遍历 DOM 文本节点与 placeholder/title，把中文短语按
//   en._phrases 映射表翻译（用于 app.js 动态渲染内容，无需改源码）。
// - MutationObserver 自动监听 #content，渲染后自动翻译（debounce）。
// 语言优先级：localStorage['cm_lang'] > navigator.language > 'zh-CN'。
// 切换语言后整页刷新。
(function () {
  'use strict';
  const STORAGE_KEY = 'cm_lang';
  const SUPPORTED = ['zh-CN', 'en'];
  const dicts = window.__DICT__ || {};
  let lang = 'zh-CN';
  const listeners = [];

  function pick() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) || 'auto';
      if (stored !== 'auto' && SUPPORTED.indexOf(stored) >= 0) return stored;
    } catch (e) { /* ignore */ }
    const nav = (navigator.language || 'zh-CN').toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh-CN' : 'en';
  }

  function fmt(str, vars) {
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, function (m, k) {
      return vars[k] !== undefined ? String(vars[k]) : m;
    });
  }

  // 中文短语 → 目标语言（en 字典的 _phrases 表；zh 时原样返回）
  function phrase(s) {
    if (lang === 'zh-CN') return s;
    const en = dicts['en'] || {};
    const table = en._phrases || {};
    return table[s] !== undefined ? table[s] : s;
  }

  // 把文本中的中文短语按 en._phrases 表翻译（长 key 优先，全局替换）。
  // 这样"汇聚国内外启动器优点"会先命中"启动器优点"，再命中"汇聚"/"国内外"。
  // 单字安全集合：仅在独立 UI 选项语境使用（其余单字一律不参与，防误伤）
  const SAFE_SINGLES = { '弱': 1, '强': 1, '需': 1 };
  let sortedKeys = null;
  function translateText(s) {
    if (!s || lang === 'zh-CN' || !/[\u4e00-\u9fff]/.test(s)) return s;
    const en = dicts['en'] || {};
    const table = en._phrases || {};
    if (!sortedKeys) {
      sortedKeys = Object.keys(table)
        .filter(function (k) { return (/[\u4e00-\u9fff]/.test(k)) && (k.length >= 2 || SAFE_SINGLES[k]); })
        .sort(function (a, b) { return b.length - a.length; });
    }
    let out = s;
    for (let i = 0; i < sortedKeys.length; i++) {
      const k = sortedKeys[i];
      const v = table[k];
      if (v === k) continue;
      if (out.indexOf(k) >= 0) out = out.split(k).join(' ' + v + ' ');
    }
    // 清理英文语境中的孤立单字中文（如"的""个""时"），保留双字及以上未译词
    out = out.replace(/\s[\u4e00-\u9fff]\s/g, ' ');
    // 标点本地化：中文标点 → 英文（en 下）
    out = out
      .replace(/，/g, ', ')
      .replace(/。/g, '. ')
      .replace(/！/g, '! ')
      .replace(/？/g, '? ')
      .replace(/：/g, ': ')
      .replace(/；/g, '; ')
      .replace(/、/g, ', ')
      .replace(/（/g, ' (')
      .replace(/）/g, ') ')
      .replace(/…/g, '...')
      .replace(/「/g, '"')
      .replace(/」/g, '"')
      .replace(/＝/g, ' = ')
      .replace(/(\d+) 天/g, '$1 day')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.!?:;)"])/g, '$1')
      .replace(/\(\s+/g, '(');
    return out;
  }

  let translateTimer = null;
  function translatePage(root) {
    if (lang === 'zh-CN') return;
    const target = root || document.body;
    // 文本节点
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const parent = nd.parentNode;
      if (!parent) continue;
      if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE' || parent.tagName === 'TEXTAREA') continue;
      const s = nd.nodeValue;
      if (!s || !/[\u4e00-\u9fff]/.test(s)) continue;
      const t2 = translateText(s);
      if (t2 !== s) nd.nodeValue = t2;
    }
    // placeholder / title
    target.querySelectorAll('[placeholder]').forEach(function (el) {
      const p = el.getAttribute('placeholder');
      if (p && /[\u4e00-\u9fff]/.test(p)) el.setAttribute('placeholder', translateText(p));
    });
    target.querySelectorAll('[title]').forEach(function (el) {
      const p = el.getAttribute('title');
      if (p && /[\u4e00-\u9fff]/.test(p)) el.setAttribute('title', translateText(p));
    });
  }

  function scheduleTranslate() {
    if (translateTimer) clearTimeout(translateTimer);
    translateTimer = setTimeout(function () { translatePage(document.body); }, 100);
  }

  const i18n = {
    get lang() { return lang; },
    get supported() { return SUPPORTED.slice(); },
    setLang(l, persist) {
      if (SUPPORTED.indexOf(l) < 0) l = pick();
      lang = l;
      if (persist !== false) {
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* ignore */ }
      }
      document.documentElement.lang = lang;
      listeners.forEach(function (fn) { fn(lang); });
      return lang;
    },
    onChanged(fn) { listeners.push(fn); },
    t(key, vars) {
      const d = dicts[lang] || {};
      if (d[key] !== undefined) return fmt(d[key], vars);
      const zh = dicts['zh-CN'] || {};
      const fallback = zh[key] !== undefined ? zh[key] : key;
      return fmt(fallback, vars);
    },
    translateText: translateText,
    translatePage: translatePage,
    applyStatic() {
      document.querySelectorAll('[data-i18n]').forEach(function (el) {
        el.textContent = i18n.t(el.getAttribute('data-i18n'));
      });
      document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
        el.setAttribute('placeholder', i18n.t(el.getAttribute('data-i18n-ph')));
      });
      document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
        el.setAttribute('title', i18n.t(el.getAttribute('data-i18n-title')));
      });
    },
  };

  window.i18n = i18n;
  i18n.setLang(pick(), false);

  // 静态替换 + 内容区自动翻译
  document.addEventListener('DOMContentLoaded', function () {
    i18n.applyStatic();
    i18n.translatePage(document.body);
  });
  // 动态渲染监听：整个 body 子树变化 → debounce 翻译（en 时才真正翻译）
  try {
    if ('MutationObserver' in window) {
      const mo = new MutationObserver(function () { scheduleTranslate(); });
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
  } catch (e) { /* ignore */ }
})();
