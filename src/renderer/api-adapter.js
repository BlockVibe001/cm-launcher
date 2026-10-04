/* CM 启动器 Tauri 适配层
 * Electron 版由 preload.js 提供 window.api；本文件检测到非 Tauri 环境直接退出，两边互不干扰。
 * 方法签名与 preload.js 一一对应；Tauri invoke 的参数是命名对象（camelCase 键），
 * 这里把 preload 的位置参数逐个包装。Rust 命令还没落地的通道走桩默认值，
 * 命令注册后 invoke 成功，桩自动失效。
 */
(() => {
  if (!window.__TAURI__) return;
  const { invoke, convertFileSrc } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const win = window.__TAURI__.window.getCurrentWindow();

  /* ---------- 错误与桩 ---------- */
  const toError = (e) => (e instanceof Error ? e : new Error(typeof e === 'string' ? e : (e && e.message) || String(e)));
  const isNotImpl = (e) => /not found|unknown|not implemented/i.test(String((e && e.message) || e));

  // 未迁移通道的默认返回值（按通道名）。随阶段推进逐步清空。
  const STUBS = {
    'versions:manifest': () => ({ versions: [] }),
    'versions:installed': () => [],
    'update:version': () => ({ version: '1.0.0', portable: true }),
    'update:check': () => ({ hasUpdate: false }),
    'home:news': () => [],
    'home:playLog': () => ({}),
    'skin:current': () => null,
    'skin:localList': () => [],
    'skin:history': () => [],
    'downloads:list': () => [],
    'instances:list': () => [],
    'java:list': () => [],
    'java:installed': () => [],
    'java:home': () => '',
    'memory:info': () => null,
    'browser:info': () => ({ open: false }),
    'wallpaper:live': () => null,
    'ai:providers': () => [],
    'migrate:detect': () => [],
    'world:schema': () => ({ gamemodes: [], difficulties: [], gamerules: [] }),
  };

  const call = (channel, args) => invoke(channel, args).catch((e) => {
    if (isNotImpl(e) && Object.prototype.hasOwnProperty.call(STUBS, channel)) {
      console.warn('[api-stub]', channel);
      return STUBS[channel]();
    }
    throw toError(e);
  });

  const on = (channel) => (cb) => {
    listen(channel, (e) => cb(e.payload));
  };

  /* ---------- file:// → asset:// ----------
   * Tauri 里页面源不是 file://，WebView2 不允许 http(s) 页面直接引用 file:// 媒体；
   * 统一把 file:/// 开头的媒体地址改走 asset 协议（scope 已放开）。
   */
  const fixUrl = (u) => {
    if (typeof u !== 'string' || !u.startsWith('file:///')) return u;
    try {
      const p = decodeURIComponent(new URL(u).pathname).replace(/^\/([A-Za-z]:[\\/])/, '$1');
      return convertFileSrc(p);
    } catch { return u; }
  };
  for (const proto of [HTMLImageElement.prototype, HTMLVideoElement.prototype, HTMLSourceElement.prototype]) {
    const d = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!d || !d.set || !d.configurable) continue;
    Object.defineProperty(proto, 'src', {
      configurable: true,
      get: d.get ? function () { return d.get.call(this); } : undefined,
      set(v) { d.set.call(this, fixUrl(v)); },
    });
  }

  /* ---------- 无边框窗口拖拽（Electron 的 -webkit-app-region 在 WebView2 无效） ---------- */
  const bindDrag = () => {
    document.querySelectorAll('.topbar-drag').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.detail === 2) { win.toggleMaximize(); return; } // 双击切换最大化，对齐 Electron
        win.startDragging();
      });
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindDrag);
  else bindDrag();

  /* ---------- window.api 全量表面 ---------- */
  window.api = {
    // 配置（已落地 Rust）
    configGetAll: () => call('config:get'),
    configSet: (key, value) => call('config:set', { key, value }),
    configUpdate: (obj) => call('config:update', { obj }),

    // 自定义背景
    wallpaperPick: () => call('wallpaper:pick'),
    wallpaperLive: (p) => call('wallpaper:live', { p }),

    // 版本
    versionsManifest: (force) => call('versions:manifest', { force }),
    versionsInstalled: (gameDir) => call('versions:installed', { gameDir }),
    versionsDownload: (mcVersion, gameDir) => call('versions:download', { mcVersion, gameDir }),

    // Java
    javaList: () => call('java:list'),
    javaPick: () => call('java:pick'),
    javaRequired: (mcVersion) => call('java:required', { mcVersion }),
    javaMatch: (mcVersion) => call('java:match', { mcVersion }),
    javaInstalled: () => call('java:installed'),
    javaRemote: (major) => call('java:remote', { major }),
    javaHome: () => call('java:home'),
    javaDownload: (major) => call('java:download', { major }),
    javaUninstall: (major) => call('java:uninstall', { major }),
    onJavaProgress: on('java:progress'),

    // 对话框
    pickDir: () => call('dialog:dir'),
    pickFile: (filters) => call('dialog:file', { filters }),

    // 账号
    authOffline: (username) => call('auth:offline', { username }),
    authMicrosoft: () => call('auth:microsoft'),
    authYggdrasil: (data) => call('auth:yggdrasil', { data }),
    authLogout: () => call('auth:logout'),
    authSwitch: (uuid) => call('auth:switch', { uuid }),
    authRemove: (uuid) => call('auth:remove', { uuid }),

    // 实例
    instancesList: () => call('instances:list'),
    instancesSave: (id, data) => call('instances:save', { id, data }),
    instancesDelete: (id) => call('instances:delete', { id }),
    instancesExport: (id) => call('instances:export', { id }),

    // 实例内容
    contentResourcePacks: (gameDir) => call('content:resourcepacks', { gameDir }),
    contentResourcePackToggle: (gameDir, name, on2) => call('content:resourcepack:toggle', { gameDir, name, on: on2 }),
    contentShaders: (gameDir) => call('content:shaders', { gameDir }),
    contentShaderEnable: (gameDir, name) => call('content:shader:enable', { gameDir, name }),
    contentSaves: (gameDir) => call('content:saves', { gameDir }),
    contentScreenshots: (gameDir) => call('content:screenshots', { gameDir }),
    contentLogs: (gameDir) => call('content:logs', { gameDir }),
    contentLogRead: (gameDir, rel) => call('content:log:read', { gameDir, rel }),
    contentDelete: (gameDir, category, name) => call('content:delete', { gameDir, category, name }),

    // 存档
    worldList: (gameDir) => call('world:list', { gameDir }),
    worldInfo: (saveDir) => call('world:info', { saveDir }),
    worldSchema: () => call('world:schema'),
    worldUpdate: (saveDir, patch) => call('world:update', { saveDir, patch }),
    worldInstallUrl: (url, gameDir) => call('world:installUrl', { url, gameDir }),

    // Axolotl 实验室
    labRecipeExport: (payload) => call('lab:recipeExport', { payload }),
    labSlime: (seed, cx0, cz0, w, h) => call('lab:slime', { seed, cx0, cz0, w, h }),
    labSeedFromSave: (saveDir) => call('lab:seedFromSave', { saveDir }),
    labChunkbase: (seed, version) => call('lab:chunkbase', { seed, version }),
    labSeedTile: (payload) => call('lab:seedTile', { payload }),
    labSeedStructs: (payload) => call('lab:seedStructs', { payload }),
    labSeedStrongholds: (payload) => call('lab:seedStrongholds', { payload }),
    labSeedSpawn: (payload) => call('lab:seedSpawn', { payload }),
    labSeedSlime: (payload) => call('lab:seedSlime', { payload }),
    labSeedBiome: (payload) => call('lab:seedBiome', { payload }),
    labSchematicOpen: (presetPath) => call('lab:schematicOpen', { presetPath }),
    labSchematicReplace: (from, to) => call('lab:schematicReplace', { from, to }),
    labSchematicExport: () => call('lab:schematicExport'),
    labTranslateJar: () => call('lab:translateJar'),
    onLabTranslateProgress: on('lab:translate:progress'),

    // AI / 翻译
    aiProviders: () => call('ai:providers'),
    aiTest: (cfg) => call('ai:test', { cfg }),
    aiTranslate: (cfg, text, targetLang) => call('ai:translate', { cfg, text, targetLang }),

    // Mod 更新 / 回滚
    modsCheckUpdates: (gameDir, mcVersion, loader) => call('mods:checkUpdates', { gameDir, mcVersion, loader }),
    modsResolve: (gameDir, file) => call('mods:resolve', { gameDir, file }),
    modsVersions: (projectId, mcVersion, loader) => call('mods:versions', { projectId, mcVersion, loader }),
    modsInstallVersion: (projectId, versionId, gameDir, replaceFile) =>
      call('mods:installVersion', { projectId, versionId, gameDir, replaceFile }),

    // Mod Loader
    forgeVersions: (mcVersion) => call('modloader:forge:versions', { mcVersion }),
    forgeInstall: (mcVersion, fv, gameDir, javaPath) =>
      call('modloader:forge:install', { mcVersion, fv, gameDir, javaPath }),
    neoForgeVersions: (mcVersion) => call('modloader:neoforge:versions', { mcVersion }),
    neoForgeInstall: (mcVersion, nv, gameDir, javaPath) =>
      call('modloader:neoforge:install', { mcVersion, nv, gameDir, javaPath }),
    fabricLoaders: () => call('modloader:fabric:loaders'),
    fabricInstall: (mcVersion, lv, gameDir) => call('modloader:fabric:install', { mcVersion, lv, gameDir }),
    quiltLoaders: () => call('modloader:quilt:loaders'),
    quiltInstall: (mcVersion, lv, gameDir) => call('modloader:quilt:install', { mcVersion, lv, gameDir }),

    // Mod 管理
    modsList: (gameDir) => call('mods:list', { gameDir }),
    modsEnable: (gameDir, fileName, enabled) => call('mods:enable', { gameDir, fileName, enabled }),
    modsDelete: (gameDir, fileName) => call('mods:delete', { gameDir, fileName }),

    // 搜索下载
    cfSearch: (query, mcVersion, modLoader, cls) => call('search:curseforge', { query, mcVersion, modLoader, cls }),
    cfFiles: (modId, mcVersion) => call('search:curseforge:files', { modId, mcVersion }),
    cfDownload: (file, gameDir) => call('search:curseforge:download', { file, gameDir }),
    cfWorldInstall: (file, gameDir) => call('search:curseforge:world', { file, gameDir }),
    mrSearch: (query, mcVersion, modLoader, projectType) =>
      call('search:modrinth', { query, mcVersion, modLoader, projectType }),
    mrVersions: (projectId, mcVersion, modLoader) => call('search:modrinth:versions', { projectId, mcVersion, modLoader }),
    mrProject: (projectId) => call('search:modrinth:project', { projectId }),
    mrDownload: (file, gameDir, projectType) => call('search:modrinth:download', { file, gameDir, projectType }),
    mrInstallPack: (file, gameRoot) => call('search:modrinth:installpack', { file, gameRoot }),

    // 游戏
    launch: (instanceId, extra) => call('game:launch', { instanceId, extra }),
    cancel: () => call('game:cancel'),
    running: () => call('game:running'),

    // 首页桌面
    homeNews: (force) => call('home:news', { force }),
    homePlayLog: () => call('home:playLog'),

    // 拖拽智能识别（Tauri 拖放原生给路径，pathForFile 仅兼容留空）
    dndInspect: (paths) => call('dnd:inspect', { paths }),
    dndImport: (items, opts) => call('dnd:import', { items, opts }),
    pickFiles: (filters) => call('dialog:files', { filters }),
    pathForFile: () => '',

    // 搬家
    migrateDetect: () => call('migrate:detect'),
    migrateDetectIn: (dir) => call('migrate:detectIn', { dir }),
    migrateRun: (payload) => call('migrate:run', { payload }),
    onMigrateProgress: on('migrate:progress'),

    // 皮肤系统
    skinOfficial: (nameOrUuid) => call('skin:official', { nameOrUuid }),
    skinDownload: (url, label) => call('skin:download', { url, label }),
    skinReadLocal: (p) => call('skin:readLocal', { p }),
    skinLocalList: () => call('skin:localList'),
    skinLocalDelete: (name) => call('skin:localDelete', { name }),
    skinUploadOfficial: (filePath, variant) => call('skin:uploadOfficial', { filePath, variant }),
    skinUploadYggdrasil: (filePath, variant) => call('skin:uploadYggdrasil', { filePath, variant }),
    skinLibrary: (base, query, page) => call('skin:library', { base, query, page }),
    skinCurrent: () => call('skin:current'),
    skinUse: (filePath) => call('skin:use', { filePath }),
    skinHistory: () => call('skin:history'),

    // 下载队列
    downloadsList: () => call('downloads:list'),
    downloadsAdd: (opts) => call('downloads:add', { opts }),
    downloadsCancel: (id) => call('downloads:cancel', { id }),
    downloadsRetry: (id) => call('downloads:retry', { id }),
    downloadsRemove: (id) => call('downloads:remove', { id }),
    downloadsClear: () => call('downloads:clear'),
    downloadsOpenDir: () => call('downloads:openDir'),
    onDownloadsChanged: on('downloads:changed'),

    // 内置浏览器
    browserOpen: (url) => call('browser:open', { url }),
    browserInfo: () => call('browser:info'),

    // 日志 / Ping
    logHistory: () => call('log:history'),
    serverPing: (address) => call('server:ping', { address }),
    serverPingAll: (addresses) => call('server:pingAll', { addresses }),

    // 联机助手
    lanDetect: () => call('lan:detect'),
    lanIps: () => call('lan:ips'),
    lanSetPath: (id, p, name) => call('lan:setPath', { id, p, name }),
    lanLaunch: (id) => call('lan:launch', { id }),
    lanInstall: (id, file) => call('lan:install', { id, file }),
    lanFetch: (id) => call('lan:fetch', { id }),
    lanToolsDir: () => call('lan:toolsDir'),
    lanUpnp: (port) => call('lan:upnp', { port }),
    lanUpnpClose: (port) => call('lan:upnpClose', { port }),
    lanPublicEndpoints: (port) => call('lan:publicEndpoints', { port }),
    onLanPort: on('game:lanPort'),

    // 陶瓦联机
    scaffoldInfo: () => call('scaffold:info'),
    scaffoldState: () => call('scaffold:state'),
    scaffoldCodeOf: (name) => call('scaffold:codeOf', { name }),
    scaffoldHost: (opts) => call('scaffold:host', { opts }),
    scaffoldJoin: (opts) => call('scaffold:join', { opts }),
    scaffoldLeave: () => call('scaffold:leave'),
    onScaffoldState: on('scaffold:state'),

    // EasyTier 联机
    easytierInfo: () => call('easytier:info'),
    easytierState: () => call('easytier:state'),
    easytierCodeOf: (name) => call('easytier:codeOf', { name }),
    easytierNodes: (list) => call('easytier:nodes', { list }),
    easytierProbe: (text) => call('easytier:probe', { text }),
    easytierHost: (opts) => call('easytier:host', { opts }),
    easytierJoin: (opts) => call('easytier:join', { opts }),
    easytierLeave: () => call('easytier:leave'),
    onEasytierState: on('easytier:state'),

    // 自更新
    updaterVersion: () => call('update:version'),
    updaterCheck: (url) => call('update:check', { url }),
    updaterDownload: (manifest) => call('update:download', { manifest }),
    updaterInstall: (p) => call('update:install', { p }),
    updaterOpen: (url) => call('update:open', { url }),
    onUpdateProgress: on('update:progress'),

    // 内存管理
    memoryInfo: () => call('memory:info'),
    memoryRecommend: () => call('memory:recommend'),
    memoryClean: (level) => call('memory:clean', { level }),
    gameDirChange: (dir, move) => call('gameDir:change', { dir, move }),

    // 外部打开
    openUrl: (url) => call('shell:open', { url }),
    openPath: (p) => call('shell:openPath', { p }),
    openGameDir: () => call('shell:openGameDir'),
    openModsDir: () => call('shell:openModsDir'),
    openConfigDir: () => call('shell:openConfigDir'),
    openSavesDir: () => call('shell:openSavesDir'),

    // 窗口（直连，不走 invoke）
    minimize: () => win.minimize(),
    toggleMaximize: () => win.toggleMaximize(),
    close: () => win.close(),

    // 主进程事件
    onLog: on('log'),
    onProgress: on('download:progress'),
    onModloaderProgress: on('modloader:progress'),
    onGameStarted: (cb) => { listen('game:started', () => cb()); },
    onGameExit: (cb) => { listen('game:exit', (e) => cb(e.payload)); },
    onDeviceCode: (cb) => {
      let un = null;
      listen('auth:devicecode', (e) => cb(e.payload)).then((u) => { un = u; });
      return () => { if (un) un(); };
    },
  };
})();
