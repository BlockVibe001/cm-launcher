// 液态玻璃背后的两套纯算法：材质档参数表 + 果冻变形。
// 刻意不碰 window / document —— 浏览器里挂到 window.GlassMotion，
// Node（冒烟测试 smoke.js）里走 module.exports，两边共用同一份数学，
// 这样交互手感能在没有真实鼠标的情况下被断言。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GlassMotion = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * 变形上限：手感调参只改这一处。
   * 这些数字同时也是「文字绝不变形」的硬保证（横 ≤3%、纵 ≤2%、旋转 ≤0.8°）。
   */
  const LIMITS = {
    SPAN_FRAC: 0.04,   // 位移上限 = 元素对角线 × 这个比例
    PULL_FRAC: 0.32,   // 拖到对角线的这么多比例就吃满强度
    STRETCH: 0.03,     // 沿拖动方向最多拉长 3%
    SQUASH: 0.66,      // 垂直方向的压扁量 = 拉长量 × 这个比例（近似体积守恒）
    TILT: 0.8,         // 最大歪斜角度（度）
  };

  /**
   * 材质档。g 是通透度滑杆值（null 表示「自定义」不接管滑杆），
   * blurK 是模糊倍率（写进 --glass-blur-k），grain 是亚克力颗粒噪点。
   * 「透明」档 = 完全透明：面板底色为 0（--panel-a 在 g=1 时正好算成 0）、模糊也归零，
   * 轮廓全靠样式里的亮边 + 上沿镜面高光托住（见 styles.css 的 [data-material="clear"]），
   * 背景原样透出来。
   * 注意它不等于「透出桌面」——窗口恒为实心，透出来的始终是应用自己的背景层。
   * 不透明档归零模糊是因为它本来就实心。
   */
  const MATERIALS = {
    custom: { id: 'custom', label: '自定义', g: null, blurK: 1, grain: false },
    clear: { id: 'clear', label: '透明', g: 100, blurK: 0.7, grain: false },
    acrylic: { id: 'acrylic', label: '亚克力', g: 45, blurK: 1.7, grain: true },
    solid: { id: 'solid', label: '不透明', g: 4, blurK: 0, grain: false },
  };

  /** 界面上按顺序摆的快捷档（不含 custom）：由清透到厚实 */
  const PRESETS = ['clear', 'acrylic', 'solid'];

  const IDS = Object.keys(MATERIALS);

  /** 非法 / 空值一律回落到「自定义」，渲染层拿它兜运行期写入的脏值 */
  function normalizeMaterial(id) {
    return IDS.includes(id) ? id : 'custom';
  }

  /** 取档位定义，永远返回一个可用对象 */
  function materialOf(id) {
    return MATERIALS[normalizeMaterial(id)];
  }

  /**
   * 通透度 → 档位：正好等于某档代表值就返回该档 id，否则 null。
   * 「自定义」是派生出来的，不存第二份真源，所以滑杆微调后档位自动熄灭。
   */
  function materialForLevel(level) {
    const n = Number(level);
    if (!Number.isFinite(n)) return null;
    const v = Math.round(n);
    for (const id of PRESETS) if (MATERIALS[id].g === v) return id;
    return null;
  }

  /* ---------- 果冻变形 ---------- */

  const r3 = (x) => Math.round(x * 1000) / 1000;
  const num = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  function identityTransform() {
    return {
      tx: 0, ty: 0, a: 1, b: 1, tilt: 0, dir: 0,
      transform: 'translate3d(0px, 0px, 0) rotate(0deg) scale(1, 1)',
    };
  }

  /** 甩动速度带来的额外歪斜：速度方向与拉动方向的角速度，px/s 换算成度 */
  function velocityTilt(v, ux, uy) {
    if (!v || typeof v !== 'object') return 0;
    return (num(v.x) * uy - num(v.y) * ux) / 900;
  }

  /**
   * 按住拖动时玻璃的果冻形变。
   * @param {{dx:number, dy:number, w:number, h:number, velocity?:{x:number,y:number}}} o
   *        dx/dy = 指针相对按下点的位移（px），w/h = 元素当前尺寸，velocity = 甩动速度
   * @returns {{tx:number,ty:number,a:number,b:number,tilt:number,dir:number,transform:string}}
   *          退化输入（尺寸非正、位移近乎为零）返回恒等变换，永不抛。
   */
  function jellyTransform(o) {
    const p = o || {};
    const w = num(p.w);
    const h = num(p.h);
    const dx = num(p.dx);
    const dy = num(p.dy);

    const dist = Math.hypot(dx, dy);
    if (!(w > 0) || !(h > 0) || !(dist >= 0.01)) return identityTransform();

    const span = Math.hypot(w, h);          // 对角线做尺度基准，宽卡 / 窄侧栏通用
    const ux = dx / dist;
    const uy = dy / dist;

    const t = Math.min(1, dist / (span * LIMITS.PULL_FRAC));   // 拖到对角线 32% 吃满
    const s = t * t * (3 - 2 * t);                             // smoothstep：起步柔、后段稳

    const grow = LIMITS.STRETCH * s;
    const shrink = LIMITS.STRETCH * LIMITS.SQUASH * s;
    // 按主导轴决定谁被拉长：横着拖拉宽、竖着拖拉高（scale(a,b) 的 a 是 x、b 是 y）。
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const a = r3(horizontal ? 1 + grow : 1 - shrink);
    const b = r3(horizontal ? 1 - shrink : 1 + grow);

    const tx = r3(ux * span * LIMITS.SPAN_FRAC * s);
    const ty = r3(uy * span * LIMITS.SPAN_FRAC * s);

    const rad = Math.atan2(dy, dx);
    const tilt = r3(clamp(
      velocityTilt(p.velocity, ux, uy) + LIMITS.TILT * 0.35 * s * Math.sin(2 * rad),
      -LIMITS.TILT, LIMITS.TILT,
    ));

    return {
      tx, ty, a, b, tilt,
      dir: r3(rad * 180 / Math.PI),   // 角度制，和信息里 tilt 的单位保持一致
      // 不带 rotate(dir) 的共轭对：拉伸轴直接交给 scale(a,b) 表达，
      // 额外的 tilt 只用来提供「被甩歪」的手感，避免方向被重复计入。
      transform: `translate3d(${tx}px, ${ty}px, 0) rotate(${tilt}deg) scale(${a}, ${b})`,
    };
  }

  return {
    LIMITS,
    MATERIALS,
    PRESETS,
    normalizeMaterial,
    materialOf,
    materialForLevel,
    jellyTransform,
  };
});