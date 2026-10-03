const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 配置
  configGetAll: () => ipcRenderer.invoke('config:get'),
  configSet: (key, value) => ipcRenderer.invoke('config:set', key, value),
  configUpdate: (obj) => ipcRenderer.invoke('config:update', obj),

  // 自定义背景
  wallpaperPick: () => ipcRenderer.invoke('wallpaper:pick'),
  wallpaperLive: (p) => ipcRenderer.invoke('wallpaper:live', p),

  // 版本
  versionsManifest: (force) => ipcRenderer.invoke('versions:manifest', force),
  versionsInstalled: (gameDir) => ipcRenderer.invoke('versions:installed', gameDir),

  // Java
  javaList: () => ipcRenderer.invoke('java:list'),
  javaPick: () => ipcRenderer.invoke('java:pick'),
  javaRequired: (mcVersion) => ipcRenderer.invoke('java:required', mcVersion),
  javaMatch: (mcVersion) => ipcRenderer.invoke('java:match', mcVersion),
  javaInstalled: () => ipcRenderer.invoke('java:installed'),
  javaRemote: (major) => ipcRenderer.invoke('java:remote', major),
  javaHome: () => ipcRenderer.invoke('java:home'),
  javaDownload: (major) => ipcRenderer.invoke('java:download', major),
  javaUninstall: (major) => ipcRenderer.invoke('java:uninstall', major),
  onJavaProgress: (cb) => ipcRenderer.on('java:progress', (_e, p) => cb(p)),

  // 对话框
  pickDir: () => ipcRenderer.invoke('dialog:dir'),
  pickFile: (filters) => ipcRenderer.invoke('dialog:file', filters),

  // 账号
  authOffline: (username) => ipcRenderer.invoke('auth:offline', username),
  authMicrosoft: () => ipcRenderer.invoke('auth:microsoft'),
  authYggdrasil: (data) => ipcRenderer.invoke('auth:yggdrasil', data),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  authSwitch: (uuid) => ipcRenderer.invoke('auth:switch', uuid),
  authRemove: (uuid) => ipcRenderer.invoke('auth:remove', uuid),

  // 实例
  instancesList: () => ipcRenderer.invoke('instances:list'),
  instancesSave: (id, data) => ipcRenderer.invoke('instances:save', id, data),
  instancesDelete: (id) => ipcRenderer.invoke('instances:delete', id),
  instancesExport: (id) => ipcRenderer.invoke('instances:export', id),

  // 实例内容管理
  contentResourcePacks: (gameDir) => ipcRenderer.invoke('content:resourcepacks', gameDir),
  contentResourcePackToggle: (gameDir, name, on) => ipcRenderer.invoke('content:resourcepack:toggle', gameDir, name, on),
  contentShaders: (gameDir) => ipcRenderer.invoke('content:shaders', gameDir),
  contentShaderEnable: (gameDir, name) => ipcRenderer.invoke('content:shader:enable', gameDir, name),
  contentSaves: (gameDir) => ipcRenderer.invoke('content:saves', gameDir),
  contentScreenshots: (gameDir) => ipcRenderer.invoke('content:screenshots', gameDir),
  contentLogs: (gameDir) => ipcRenderer.invoke('content:logs', gameDir),
  contentLogRead: (gameDir, rel) => ipcRenderer.invoke('content:log:read', gameDir, rel),
  contentDelete: (gameDir, category, name) => ipcRenderer.invoke('content:delete', gameDir, category, name),

  // 存档（世界）编辑
  worldList: (gameDir) => ipcRenderer.invoke('world:list', gameDir),
  worldInfo: (saveDir) => ipcRenderer.invoke('world:info', saveDir),
  worldSchema: () => ipcRenderer.invoke('world:schema'),
  worldUpdate: (saveDir, patch) => ipcRenderer.invoke('world:update', saveDir, patch),
  worldInstallUrl: (url, gameDir) => ipcRenderer.invoke('world:installUrl', url, gameDir),

  // Axolotl 实验室
  labRecipeExport: (payload) => ipcRenderer.invoke('lab:recipeExport', payload),
  labSlime: (seed, cx0, cz0, w, h) => ipcRenderer.invoke('lab:slime', seed, cx0, cz0, w, h),
  labSeedFromSave: (saveDir) => ipcRenderer.invoke('lab:seedFromSave', saveDir),
  labChunkbase: (seed, version) => ipcRenderer.invoke('lab:chunkbase', seed, version),
  labSchematicOpen: (presetPath) => ipcRenderer.invoke('lab:schematicOpen', presetPath),
  labSchematicReplace: (from, to) => ipcRenderer.invoke('lab:schematicReplace', from, to),
  labSchematicExport: () => ipcRenderer.invoke('lab:schematicExport'),
  labTranslateJar: () => ipcRenderer.invoke('lab:translateJar'),
  onLabTranslateProgress: (cb) => ipcRenderer.on('lab:translate:progress', (_e, p) => cb(p)),

  // AI / 翻译
  aiProviders: () => ipcRenderer.invoke('ai:providers'),
  aiTest: (cfg) => ipcRenderer.invoke('ai:test', cfg),
  aiTranslate: (cfg, text, targetLang) => ipcRenderer.invoke('ai:translate', cfg, text, targetLang),

  // Mod 更新 / 回滚
  modsCheckUpdates: (gameDir, mcVersion, loader) => ipcRenderer.invoke('mods:checkUpdates', gameDir, mcVersion, loader),
  modsResolve: (gameDir, file) => ipcRenderer.invoke('mods:resolve', gameDir, file),
  modsVersions: (projectId, mcVersion, loader) => ipcRenderer.invoke('mods:versions', projectId, mcVersion, loader),
  modsInstallVersion: (projectId, versionId, gameDir, replaceFile) =>
    ipcRenderer.invoke('mods:installVersion', projectId, versionId, gameDir, replaceFile),

  // Mod Loader
  forgeVersions: (mcVersion) => ipcRenderer.invoke('modloader:forge:versions', mcVersion),
  forgeInstall: (mcVersion, fv, gameDir, javaPath) =>
    ipcRenderer.invoke('modloader:forge:install', mcVersion, fv, gameDir, javaPath),
  fabricLoaders: () => ipcRenderer.invoke('modloader:fabric:loaders'),
  fabricInstall: (mcVersion, lv, gameDir) =>
    ipcRenderer.invoke('modloader:fabric:install', mcVersion, lv, gameDir),
  quiltLoaders: () => ipcRenderer.invoke('modloader:quilt:loaders'),
  quiltInstall: (mcVersion, lv, gameDir) =>
    ipcRenderer.invoke('modloader:quilt:install', mcVersion, lv, gameDir),

  // Mod 管理
  modsList: (gameDir) => ipcRenderer.invoke('mods:list', gameDir),
  modsEnable: (gameDir, fileName, enabled) => ipcRenderer.invoke('mods:enable', gameDir, fileName, enabled),
  modsDelete: (gameDir, fileName) => ipcRenderer.invoke('mods:delete', gameDir, fileName),

  // 搜索（projectType: mod/modpack/shader/resourcepack/datapack；cls: mod/world/resourcepack/modpack）
  cfSearch: (query, mcVersion, modLoader, cls) => ipcRenderer.invoke('search:curseforge', query, mcVersion, modLoader, cls),
  cfFiles: (modId, mcVersion) => ipcRenderer.invoke('search:curseforge:files', modId, mcVersion),
  cfDownload: (file, gameDir) => ipcRenderer.invoke('search:curseforge:download', file, gameDir),
  cfWorldInstall: (file, gameDir) => ipcRenderer.invoke('search:curseforge:world', file, gameDir),
  mrSearch: (query, mcVersion, modLoader, projectType) => ipcRenderer.invoke('search:modrinth', query, mcVersion, modLoader, projectType),
  mrVersions: (projectId, mcVersion, modLoader) => ipcRenderer.invoke('search:modrinth:versions', projectId, mcVersion, modLoader),
  mrDownload: (file, gameDir, projectType) => ipcRenderer.invoke('search:modrinth:download', file, gameDir, projectType),
  mrInstallPack: (file, gameRoot) => ipcRenderer.invoke('search:modrinth:installpack', file, gameRoot),

  // 游戏
  launch: (instanceId, extra) => ipcRenderer.invoke('game:launch', instanceId, extra),
  cancel: () => ipcRenderer.invoke('game:cancel'),
  running: () => ipcRenderer.invoke('game:running'),

  // 首页桌面
  homeNews: (force) => ipcRenderer.invoke('home:news', force),
  homePlayLog: () => ipcRenderer.invoke('home:playLog'),

  // 拖拽智能识别
  dndInspect: (paths) => ipcRenderer.invoke('dnd:inspect', paths),
  dndImport: (items, opts) => ipcRenderer.invoke('dnd:import', items, opts),
  pickFiles: (filters) => ipcRenderer.invoke('dialog:files', filters),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  // 从其他启动器搬家
  migrateDetect: () => ipcRenderer.invoke('migrate:detect'),
  migrateDetectIn: (dir) => ipcRenderer.invoke('migrate:detectIn', dir),
  migrateRun: (payload) => ipcRenderer.invoke('migrate:run', payload),
  onMigrateProgress: (cb) => ipcRenderer.on('migrate:progress', (_e, p) => cb(p)),

  // 皮肤系统
  skinOfficial: (nameOrUuid) => ipcRenderer.invoke('skin:official', nameOrUuid),
  skinDownload: (url, label) => ipcRenderer.invoke('skin:download', url, label),
  skinReadLocal: (p) => ipcRenderer.invoke('skin:readLocal', p),
  skinLocalList: () => ipcRenderer.invoke('skin:localList'),
  skinLocalDelete: (name) => ipcRenderer.invoke('skin:localDelete', name),
  skinUploadOfficial: (filePath, variant) => ipcRenderer.invoke('skin:uploadOfficial', filePath, variant),
  skinUploadYggdrasil: (filePath, variant) => ipcRenderer.invoke('skin:uploadYggdrasil', filePath, variant),
  skinLibrary: (base, query, page) => ipcRenderer.invoke('skin:library', base, query, page),
  skinCurrent: () => ipcRenderer.invoke('skin:current'),

  // 下载任务队列
  downloadsList: () => ipcRenderer.invoke('downloads:list'),
  downloadsAdd: (opts) => ipcRenderer.invoke('downloads:add', opts),
  downloadsCancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
  downloadsRetry: (id) => ipcRenderer.invoke('downloads:retry', id),
  downloadsRemove: (id) => ipcRenderer.invoke('downloads:remove', id),
  downloadsClear: () => ipcRenderer.invoke('downloads:clear'),
  downloadsOpenDir: () => ipcRenderer.invoke('downloads:openDir'),
  onDownloadsChanged: (cb) => ipcRenderer.on('downloads:changed', (_e, list) => cb(list)),

  // 内置浏览器（独立窗口，见 src/renderer/browser.html）
  browserOpen: (url) => ipcRenderer.invoke('browser:open', url),
  browserInfo: () => ipcRenderer.invoke('browser:info'),

  // 运行日志 / 服务器 Ping
  logHistory: () => ipcRenderer.invoke('log:history'),
  serverPing: (address) => ipcRenderer.invoke('server:ping', address),
  serverPingAll: (addresses) => ipcRenderer.invoke('server:pingAll', addresses),

  // 联机助手
  lanDetect: () => ipcRenderer.invoke('lan:detect'),
  lanIps: () => ipcRenderer.invoke('lan:ips'),
  lanSetPath: (id, p, name) => ipcRenderer.invoke('lan:setPath', id, p, name),
  lanLaunch: (id) => ipcRenderer.invoke('lan:launch', id),
  lanInstall: (id, file) => ipcRenderer.invoke('lan:install', id, file),
  lanFetch: (id) => ipcRenderer.invoke('lan:fetch', id),
  lanToolsDir: () => ipcRenderer.invoke('lan:toolsDir'),
  lanUpnp: (port) => ipcRenderer.invoke('lan:upnp', port),
  lanUpnpClose: (port) => ipcRenderer.invoke('lan:upnpClose', port),
  lanPublicEndpoints: (port) => ipcRenderer.invoke('lan:publicEndpoints', port),
  onLanPort: (cb) => ipcRenderer.on('game:lanPort', (_e, info) => cb(info)),

  // 陶瓦联机（内置）
  scaffoldInfo: () => ipcRenderer.invoke('scaffold:info'),
  scaffoldState: () => ipcRenderer.invoke('scaffold:state'),
  scaffoldCodeOf: (name) => ipcRenderer.invoke('scaffold:codeOf', name),
  scaffoldHost: (opts) => ipcRenderer.invoke('scaffold:host', opts),
  scaffoldJoin: (opts) => ipcRenderer.invoke('scaffold:join', opts),
  scaffoldLeave: () => ipcRenderer.invoke('scaffold:leave'),
  onScaffoldState: (cb) => ipcRenderer.on('scaffold:state', (_e, s) => cb(s)),

  // EasyTier 联机（内置）
  easytierInfo: () => ipcRenderer.invoke('easytier:info'),
  easytierState: () => ipcRenderer.invoke('easytier:state'),
  easytierCodeOf: (name) => ipcRenderer.invoke('easytier:codeOf', name),
  easytierNodes: (list) => ipcRenderer.invoke('easytier:nodes', list),
  easytierProbe: (text) => ipcRenderer.invoke('easytier:probe', text),
  easytierHost: (opts) => ipcRenderer.invoke('easytier:host', opts),
  easytierJoin: (opts) => ipcRenderer.invoke('easytier:join', opts),
  easytierLeave: () => ipcRenderer.invoke('easytier:leave'),
  onEasytierState: (cb) => ipcRenderer.on('easytier:state', (_e, s) => cb(s)),

  // 内存管理
  memoryInfo: () => ipcRenderer.invoke('memory:info'),
  memoryRecommend: () => ipcRenderer.invoke('memory:recommend'),
  memoryClean: () => ipcRenderer.invoke('memory:clean'),

  // 外部
  openUrl: (url) => ipcRenderer.invoke('shell:open', url),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openGameDir: () => ipcRenderer.invoke('shell:openGameDir'),
  openModsDir: () => ipcRenderer.invoke('shell:openModsDir'),
  openConfigDir: () => ipcRenderer.invoke('shell:openConfigDir'),
  openSavesDir: () => ipcRenderer.invoke('shell:openSavesDir'),

  // 窗口
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // 主进程事件
  onLog: (cb) => ipcRenderer.on('log', (_e, entry) => cb(entry)),
  onProgress: (cb) => ipcRenderer.on('download:progress', (_e, p) => cb(p)),
  onModloaderProgress: (cb) => ipcRenderer.on('modloader:progress', (_e, p) => cb(p)),
  onGameStarted: (cb) => ipcRenderer.on('game:started', () => cb()),
  onGameExit: (cb) => ipcRenderer.on('game:exit', (_e, code) => cb(code)),
  onDeviceCode: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('auth:devicecode', handler);
    return () => ipcRenderer.removeListener('auth:devicecode', handler);
  },
});
