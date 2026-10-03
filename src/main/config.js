const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let configPath = null;
let cache = null;

function defaults() {
  return {
    gameDir: path.join(app.getPath('appData'), '.minecraft'),
    javaPath: '',
    minMemory: 512,
    maxMemory: 4096,
    width: 854,
    height: 480,
    jvmArgs: '',
    speedBoost: true,           // 游戏加速：自适应堆 + G1 调优参数 + 提升进程优先级
    mirror: 'bmcl',
    showSnapshots: false,
    selectedInstance: 'default',
    instances: {
      default: {
        name: '默认',
        versionId: '',
        gameDir: path.join(app.getPath('appData'), '.minecraft'),
        modLoader: 'vanilla',
        loaderVersion: '',
        javaPath: '',
        memory: null,
        jvmArgs: '',
        icon: '⛏',
      },
    },
    account: null,
    accounts: [],   // 保存的多账号列表
    // UI 主题
    accent: 'axolotl',
    theme: 'dark',              // 外观模式：dark 深色 | light 浅色 | oled 纯黑 | system 跟随系统
    // 自定义背景（设置页可上传）
    wallpaperType: 'builtin',   // builtin 内置渐变 | custom 用户上传
    wallpaperUrl: '',           // 自定义背景文件绝对路径
    wallpaperKind: '',          // image 静态图 | animated 动图 | video 视频 | live 实况照片
    wallpaperLive: '',          // 实况照片抽出的视频路径（可空）
    // 界面外观偏好（设置页可实时调整）
    ui: {
      glassLevel: 55,     // 液态玻璃通透度 0–100，100 = 全部透明
      glassMaterial: 'custom',  // 材质档：custom 自定义 | transparent 透明 | acrylic 亚克力 | solid 不透明
      glassAuto: true,    // 窗口失焦时自动省电
      density: 'normal',  // 界面密度：compact | normal | cozy
      aura: 'std',        // 背景氛围光斑：off | soft | std | strong
    },
    servers: [],
    // EasyTier 联机用的公共共享节点（留空则用内置候选）
    easytierNodes: [],
    // 内置浏览器：下载落地方式 auto 自动分流 | ask 每次询问 | queue 只存下载目录
    browserDownloadMode: 'auto',
    browserBookmarks: null,     // null = 还没调过，用内置的默认收藏栏
    // 皮肤站列表
    skinStations: [
      { name: 'LittleSkin', authUrl: 'https://littleskin.cn/api/yggdrasil' },
      { name: 'BlessingSkin 自建', authUrl: '' },
    ],
    activeSkinStation: 'LittleSkin',
    // Axolotl 实验室
    ai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
    },
    recentSchematics: [],   // 最近预览的投影文件
    recipeNamespace: 'cm_craft',
    recipePackFormat: 15,
    // 首页桌面
    homeMode: 'widget',   // 'simple' 简洁列表 | 'widget' 小组件桌面
    homeWidgets: [
      { id: 'greeting', visible: true, span: 2 },
      { id: 'pinnedInstances', visible: true, span: 1 },
      { id: 'pinnedWorlds', visible: true, span: 1 },
      { id: 'pinnedServers', visible: true, span: 1 },
      { id: 'recentWorlds', visible: true, span: 1 },
      { id: 'calendar', visible: true, span: 1 },
      { id: 'news', visible: true, span: 1 },
      { id: 'stats', visible: true, span: 2 },
    ],
    pinned: { instances: [], servers: [], worlds: [] },
    playLog: {},   // { 'YYYY-MM-DD': { total: n, instances: { id: {name, count} } } }
    newsCache: null,
    newsCacheAt: 0,
  };
}

function ensure() {
  if (cache) return cache;
  configPath = path.join(app.getPath('userData'), 'config.json');
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // 首次或损坏
  }
  cache = deepMerge(defaults(), data);
  sanitize(cache);
  return cache;
}

/**
 * 老版本配置文件里可能留着已经废弃或非法的取值（deepMerge 会把它们保留下来），
 * 这里统一纠正，避免旧配置把界面带偏。
 */
function sanitize(c) {
  const THEMES = ['dark', 'light', 'oled', 'system'];
  if (!THEMES.includes(c.theme)) c.theme = 'dark';

  const ui = c.ui || {};
  if (!['compact', 'normal', 'cozy'].includes(ui.density)) ui.density = 'normal';
  if (!['off', 'soft', 'std', 'strong'].includes(ui.aura)) ui.aura = 'std';
  const g = Number(ui.glassLevel);
  ui.glassLevel = Number.isFinite(g) ? Math.max(0, Math.min(100, Math.round(g))) : 55;
  // 档位只认这四个；早期版本叫 transparent 的那个档现在叫 clear（透明），
  // 老配置里认不出来的值一律回落「自定义」，由滑杆值继续生效，画面不会突变。
  if (!['custom', 'clear', 'acrylic', 'solid'].includes(ui.glassMaterial)) ui.glassMaterial = 'custom';
  // 档位与滑杆值必须自洽：滑杆被拖到别的值就说明已经是「自定义」了。
  // 否则会留下「档位写不透明、实际 59% 通透」这种自相矛盾的配置（模糊倍率也会跟着错）。
  const PRESET_G = { clear: 100, acrylic: 45, solid: 4 };
  if (ui.glassMaterial !== 'custom' && PRESET_G[ui.glassMaterial] !== ui.glassLevel) ui.glassMaterial = 'custom';
  ui.glassAuto = ui.glassAuto !== false;
  delete ui.glass;               // 旧的字符串档位，已被 glassLevel 取代
  c.ui = ui;

  // 登录列表兜底：老版本 / 更新以后可能只有 account 却没把它记进 accounts 列表，
  // 这样「已保存账号」里就选不到它，只能重新登录。这里统一补齐，保证登录不丢。
  if (!Array.isArray(c.accounts)) c.accounts = [];
  if (c.account && typeof c.account === 'object' && c.account.uuid
    && !c.accounts.some((a) => a && a.uuid === c.account.uuid)) {
    c.accounts.push(c.account);
  }

  // 皮肤站地址纠错：早期版本把 LittleSkin 的接口误写成了 mcskin.littleservice.cn，
  // 那个地址下的 /api/yggdrasil/authserver/authenticate 返回 404，登录时只看到一句
  // 「Not Found」。老配置会把错误地址一直留着（deepMerge 保留已存数组），这里统一改回官方地址。
  if (Array.isArray(c.skinStations)) {
    for (const s of c.skinStations) {
      if (s && typeof s.authUrl === 'string' && /littleservice\.cn/i.test(s.authUrl)) {
        s.authUrl = 'https://littleskin.cn/api/yggdrasil';
      }
    }
  }

  c.speedBoost = c.speedBoost !== false;
  if (!['', 'image', 'animated', 'video', 'live'].includes(c.wallpaperKind || '')) c.wallpaperKind = '';
  if (c.wallpaperType !== 'custom') c.wallpaperType = 'builtin';
  return c;
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function save() {
  ensure();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cache, null, 2));
}

function getAll() {
  return JSON.parse(JSON.stringify(ensure()));
}

function get(key) {
  return ensure()[key];
}

function set(key, value) {
  ensure()[key] = value;
  save();
}

function update(obj) {
  Object.assign(ensure(), obj);
  save();
}

/**
 * 设置当前账号，同时按 uuid 把它同步进多账号列表。
 * 登录、切换、令牌续期统一走这里，避免列表里留着一份过期令牌。
 */
function setAccount(acc) {
  ensure();
  const list = cache.accounts || [];
  if (acc && acc.uuid) {
    const idx = list.findIndex((a) => a && a.uuid === acc.uuid);
    if (idx >= 0) list[idx] = acc;
    else list.push(acc);
  }
  cache.accounts = list;
  cache.account = acc || null;
  save();
  return cache.account;
}

module.exports = { getAll, get, set, update, setAccount, sanitize };
