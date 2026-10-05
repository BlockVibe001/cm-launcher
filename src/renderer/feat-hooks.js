/* ============================================================
 * CM 启动器 · 功能扩展注册表（feat_*.js 独立模块的公共底座）
 * 由集成层一次性创建，feat_*.js 只读不改。
 * 提供：
 *   window.registerFeatPage(name, fn)   注册新页面渲染器（fn(pageEl)）
 *   window.__onHook(name, fn)           注册生命周期钩子
 *   window.__emitHook(name, ...args)    触发钩子（renderPage 内已埋点）
 * 钩子名：
 *   pageRendered(page, pageEl)  每次 renderPage 渲染完成后触发
 *   appReady()                  首帧渲染完成后触发一次（轮询 #content 子节点）
 * ============================================================ */
(function () {
  window.__featPages = window.__featPages || {};
  window.registerFeatPage = function (name, fn) { window.__featPages[name] = fn; };

  window.__featHooks = window.__featHooks || { map: {} };
  window.__onHook = function (name, fn) {
    (window.__featHooks.map[name] = window.__featHooks.map[name] || []).push(fn);
  };
  window.__emitHook = function (name) {
    const args = Array.prototype.slice.call(arguments, 1);
    (window.__featHooks.map[name] || []).forEach(function (fn) {
      try { fn.apply(null, args); } catch (e) { console.error('[feat-hook]', name, e); }
    });
  };

  // appReady：内容区出现首个子节点后触发一次（init 的 renderPage('home') 之后）
  let readyFired = false;
  function tryReady() {
    if (readyFired) return;
    const c = document.getElementById('content');
    if (c && c.children.length > 0) {
      readyFired = true;
      window.__emitHook('appReady');
    } else {
      setTimeout(tryReady, 250);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryReady);
  else setTimeout(tryReady, 100);
})();
