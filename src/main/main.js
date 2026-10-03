const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

// 打包后 package.json 里的 productName 会顶替 name，app.getPath('userData') 就跟着挪到
// 「CM Minecraft Launcher」那个目录，用户原有的账号 / 设置 / 皮肤会像凭空消失。
// 只在打包态把目录名钉死成开发时一直在用的那个，源码运行和安装包共用同一份配置；
// 开发态和冒烟测试保持原样（冒烟有它自己的沙箱目录）。
if (app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'cm-minecraft-launcher'));
}

const config = require('./config');
const logger = require('./logger');
const { getManifest } = require('./minecraft/versions');
const java = require('./minecraft/java');
const { listJavas } = java;
const offlineAuth = require('./auth/offline');
const microsoftAuth = require('./auth/microsoft');
const yggdrasilAuth = require('./auth/yggdrasil');
const launcher = require('./minecraft/launch');
const instances = require('./minecraft/instances');
const modloaders = require('./minecraft/modloaders');
const mods = require('./minecraft/mods');
const curseforge = require('./minecraft/curseforge');
const modrinth = require('./minecraft/modrinth');
const content = require('./minecraft/content');
const world = require('./minecraft/world');
const modUpdate = require('./minecraft/update');
const packExport = require('./minecraft/export');
const recipe = require('./minecraft/recipe');
const seedmap = require('./minecraft/seedmap');
const schematic = require('./minecraft/schematic');
const translator = require('./minecraft/translate');
const memory = require('./system/memory');
const home = require('./system/home');
const dnd = require('./minecraft/dnd');
const { downloadFile } = require('./minecraft/downloader');
const migrate = require('./minecraft/migrate');
const skin = require('./minecraft/skin');
const downloads = require('./system/downloads');
const serverping = require('./minecraft/serverping');
const lan = require('./minecraft/lan');
const terracotta = require('./minecraft/terracotta');
const easytier = require('./minecraft/easytier');
const wallpaper = require('./system/wallpaper');
const browser = require('./system/browser');
const { pathToFileURL } = require('url');

// 启用 V8 垃圾回收暴露，供一键清理内存使用
app.commandLine.appendSwitch('js-flags', '--expose-gc');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    // 窗口恒定实心不透明：既不透出桌面，截图 / 发布也不带 alpha。
    // 所谓的「完全透明」是卡片与侧栏自己（--panel-a 归零），它们透出来的是
    // 应用自己的深空背景 / 用户壁纸，不是桌面。
    backgroundColor: '#0a0a0c',
    transparent: false,
    frame: false,
    title: 'CM Minecraft Launcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------- 配置 ----------------
ipcMain.handle('config:get', () => config.getAll());
ipcMain.handle('config:set', (_e, key, value) => config.set(key, value));
ipcMain.handle('config:update', (_e, obj) => config.update(obj));

// ---------------- 自定义背景 ----------------
ipcMain.handle('wallpaper:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择背景：图片 / 动图 / 视频 / 实况照片',
    filters: [
      { name: '全部支持的背景', extensions: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif', 'apng', 'mp4', 'webm', 'mkv', 'mov', 'heic', 'heif'] },
      { name: '图片与动图', extensions: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif', 'apng'] },
      { name: '视频', extensions: ['mp4', 'webm', 'mkv', 'mov'] },
      { name: '实况照片', extensions: ['jpg', 'jpeg', 'heic', 'heif', 'mov'] },
    ],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const file = res.filePaths[0];
  return Object.assign(wallpaper.describe(file), {
    path: file,
    url: pathToFileURL(file).href,
  });
});

/** 实况照片：把动态部分解析成一个可播放的视频 */
ipcMain.handle('wallpaper:live', (_e, file) => {
  const r = wallpaper.resolveLivePhoto(file, path.join(app.getPath('userData'), 'wallpaper'));
  return {
    path: r.video,
    url: r.video ? pathToFileURL(r.video).href : '',
    reason: r.reason,
  };
});

// ---------------- 版本 ----------------
ipcMain.handle('versions:manifest', (_e, force) => getManifest(force));
// 可以传 gameDir：实例能自带游戏目录（启动用的就是实例那份），
// 这时「已装版本」必须按实例目录去列，否则会把别的目录里的版本列出来 —— 选中也启动不了。
ipcMain.handle('versions:installed', (_e, gameDir) => {
  const versionsDir = path.join(gameDir || config.get('gameDir'), 'versions');
  try {
    return fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => fs.existsSync(path.join(versionsDir, d.name, `${d.name}.jar`)))
      .map((d) => d.name);
  } catch { return []; }
});

// ---------------- Java ----------------
ipcMain.handle('java:list', () => listJavas());
ipcMain.handle('java:required', (_e, mcVersion) => java.requiredJava(mcVersion));
ipcMain.handle('java:match', async (_e, mcVersion) => {
  const list = await listJavas();
  const picked = java.pickFor(mcVersion, list);
  return { need: java.requiredJava(mcVersion).major, picked, javas: list };
});
ipcMain.handle('java:installed', () => java.listInstalled());
ipcMain.handle('java:remote', (_e, major) => java.adoptiumRelease(major));
ipcMain.handle('java:home', () => java.javaHome());
ipcMain.handle('java:download', async (_e, major) => {
  const res = await java.install(major, (p) => send('java:progress', { major, ...p }));
  logger.info(`Java ${major} 已安装到 ${res.path}`);
  return res;
});
ipcMain.handle('java:uninstall', (_e, major) => java.uninstall(major));
ipcMain.handle('java:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择 java.exe',
    filters: [{ name: 'Java 可执行文件', patterns: ['java.exe', 'java'] }],
    properties: ['openFile'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:dir', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:file', async (_e, filters) => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择文件',
    filters: filters || [],
    properties: ['openFile'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:files', async (_e, filters) => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择要导入的文件',
    filters: filters || [{ name: '可导入的内容', extensions: ['jar', 'zip', 'mrpack', 'schem', 'schematic', 'litematic', 'nbt'] }],
    properties: ['openFile', 'multiSelections'],
  });
  return res.canceled ? [] : res.filePaths;
});

// ---------------- 账号 ----------------
/** 登录成功后把账号存入多账号列表（按 uuid 去重），并设为当前账号 */
function saveAccountToList(acc) {
  config.setAccount(acc);
}

ipcMain.handle('auth:offline', (_e, username) => {
  const acc = offlineAuth.login(username);
  saveAccountToList(acc);
  logger.info(`离线登录：${acc.username}`);
  return acc;
});

ipcMain.handle('auth:microsoft', async () => {
  const acc = await microsoftAuth.login((deviceInfo) => {
    // 推送设备码到渲染层显示
    if (win && !win.isDestroyed()) {
      win.webContents.send('auth:devicecode', deviceInfo);
    }
  });
  saveAccountToList(acc);
  logger.info(`正版登录：${acc.username}`);
  return acc;
});

ipcMain.handle('auth:yggdrasil', async (_e, { baseUrl, username, password, characterId }) => {
  const acc = await yggdrasilAuth.login(baseUrl, username, password, characterId);
  saveAccountToList(acc);
  logger.info(`皮肤站登录：${acc.username}`);
  return acc;
});

ipcMain.handle('auth:logout', () => {
  config.set('account', null);
  logger.info('已退出登录');
});

/** 静默续期：正版用 refresh_token 换新的游戏令牌，皮肤站走 refresh 接口 */
async function refreshAccountToken(acc) {
  if (acc.type === 'microsoft') return microsoftAuth.refresh(acc);
  if (acc.type === 'yggdrasil') return yggdrasilAuth.refresh(acc);
  return acc;
}

ipcMain.handle('auth:switch', async (_e, uuid) => {
  const list = config.get('accounts') || [];
  const acc = list.find((a) => a && a.uuid === uuid);
  if (!acc) throw new Error('账号不存在');
  // 切换本身就该是本地操作，续期失败不挡着切，只把原因告诉界面
  let fresh = acc;
  let warn = '';
  try {
    fresh = await refreshAccountToken(acc);
  } catch (e) {
    warn = e.message;
  }
  config.setAccount(fresh);
  logger.info(`切换账号：${fresh.username}${warn ? `（令牌未续期：${warn}）` : ''}`);
  return { account: fresh, warn };
});

ipcMain.handle('auth:remove', (_e, uuid) => {
  let list = config.get('accounts') || [];
  list = list.filter((a) => a.uuid !== uuid);
  config.set('accounts', list);
  const cur = config.get('account');
  if (cur && cur.uuid === uuid) config.set('account', null);
  logger.info(`删除账号：${uuid}`);
});

// ---------------- 实例 ----------------
ipcMain.handle('instances:list', () => instances.listInstances());
ipcMain.handle('instances:save', (_e, id, data) => instances.saveInstance(id, data));
ipcMain.handle('instances:delete', (_e, id) => instances.deleteInstance(id));

// ---------------- 实例内容管理 ----------------
ipcMain.handle('content:resourcepacks', (_e, gameDir) => content.listResourcePacks(gameDir));
ipcMain.handle('content:resourcepack:toggle', (_e, gameDir, name, on) => content.toggleResourcePack(gameDir, name, on));
ipcMain.handle('content:shaders', (_e, gameDir) => content.listShaderPacks(gameDir));
ipcMain.handle('content:shader:enable', (_e, gameDir, name) => content.enableShaderPack(gameDir, name));
ipcMain.handle('content:saves', (_e, gameDir) => content.listSaves(gameDir));
ipcMain.handle('content:screenshots', (_e, gameDir) => content.listScreenshots(gameDir));
ipcMain.handle('content:logs', (_e, gameDir) => content.listLogs(gameDir));
ipcMain.handle('content:log:read', (_e, gameDir, rel) => content.readLogFile(gameDir, rel));
ipcMain.handle('content:delete', (_e, gameDir, category, name) => content.deleteInDir(gameDir, category, name));

// ---------------- 存档（世界）编辑 ----------------
ipcMain.handle('world:list', (_e, gameDir) => world.listWorlds(gameDir));
ipcMain.handle('world:info', (_e, saveDir) => world.worldInfo(saveDir));
ipcMain.handle('world:schema', () => ({
  gamemodes: world.GAMEMODES,
  difficulties: world.DIFFICULTIES,
  gamerules: world.GAMERULES,
}));
ipcMain.handle('world:update', (_e, saveDir, patch) => world.updateWorld(saveDir, patch));
// 直接把世界 zip 直链下载并解压进本实例的 saves。
// CurseForge 的搜索 / 下载接口现在统一要求 API Key（无 Key 一律 403），所以地图类资源
// 得留一条不依赖它的路：随便哪个站点的 zip 直链都能收。
ipcMain.handle('world:installUrl', async (_e, url, gameDir) => {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('请填写 http/https 的世界 zip 直链');
  const dir = gameDir || config.get('gameDir');
  const tmp = path.join(os.tmpdir(), `cm-world-url-${Date.now()}.zip`);
  await downloadFile(u, tmp, null);
  try {
    return dnd.extractWorld(tmp, path.join(dir, 'saves'));
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件删不掉不影响结果 */ }
  }
});

// ---------------- Axolotl 实验室 ----------------
// 缓存当前打开的投影
let schCache = null;

ipcMain.handle('lab:recipeExport', async (_e, payload) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出配方数据包',
    defaultPath: `${payload.namespace || 'cm_craft'}.zip`,
    filters: [{ name: '数据包 ZIP', extensions: ['zip'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  return recipe.buildDatapack(filePath, payload);
});

ipcMain.handle('lab:slime', (_e, seed, cx0, cz0, w, h) => seedmap.slimeChunks(seed, cx0, cz0, w, h));
ipcMain.handle('lab:seedFromSave', (_e, saveDir) => seedmap.seedFromSave(saveDir));
ipcMain.handle('lab:chunkbase', (_e, seed, version) => seedmap.chunkbaseUrl(seed, version));

ipcMain.handle('lab:schematicOpen', async (_e, presetPath) => {
  let file = presetPath;
  if (!file) {
    const res = await dialog.showOpenDialog(win, {
      title: '选择投影 / 结构文件',
      filters: [{ name: '结构文件', extensions: ['litematic', 'schematic', 'schem', 'nbt'] }],
      properties: ['openFile'],
    });
    if (res.canceled) return { canceled: true };
    file = res.filePaths[0];
  }
  const sch = schematic.readSchematic(file);
  schCache = { path: file, sch };
  // 记录最近预览
  try {
    const list = (config.get('recentSchematics') || []).filter((p) => p !== file);
    list.unshift(file);
    config.set('recentSchematics', list.slice(0, 12));
  } catch { /* ignore */ }
  return {
    path: file,
    format: sch.format,
    size: sch.size,
    palette: sch.palette,
    blocks: sch.blocks,
    counts: schematic.countBlocks(sch),
    name: sch.name,
    author: sch.author,
  };
});

ipcMain.handle('lab:schematicReplace', (_e, from, to) => {
  if (!schCache) throw new Error('尚未打开投影');
  const changed = schematic.replaceBlock(schCache.sch, from, to);
  return {
    changed,
    counts: schematic.countBlocks(schCache.sch),
    palette: schCache.sch.palette,
    blocks: schCache.sch.blocks,
  };
});

ipcMain.handle('lab:schematicExport', async () => {
  if (!schCache) throw new Error('尚未打开投影');
  const base = require('path').basename(schCache.path).replace(/\.[^.]+$/, '');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出结构文件',
    defaultPath: `${base}-edited.schem`,
    filters: [{ name: 'Sponge 结构文件', extensions: ['schem'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  return schematic.exportSponge(schCache.sch, filePath);
});

ipcMain.handle('lab:translateJar', async () => {
  const pick = await dialog.showOpenDialog(win, {
    title: '选择要汉化的模组 jar',
    filters: [{ name: 'Minecraft Mod', extensions: ['jar'] }],
    properties: ['openFile'],
  });
  if (pick.canceled) return { canceled: true };
  const jar = pick.filePaths[0];
  const save = await dialog.showSaveDialog(win, {
    title: '保存汉化后的 jar',
    defaultPath: require('path').basename(jar).replace(/\.jar$/i, '-zh_cn.jar'),
    filters: [{ name: 'Minecraft Mod', extensions: ['jar'] }],
  });
  if (save.canceled || !save.filePath) return { canceled: true };
  return translator.translateJar(jar, save.filePath, config.get('ai'), (p) => send('lab:translate:progress', p));
});

// ---------------- AI / 翻译 ----------------
ipcMain.handle('ai:providers', () => translator.PROVIDERS);
ipcMain.handle('ai:test', (_e, cfg) => translator.testConnection(cfg || config.get('ai')));
ipcMain.handle('ai:translate', (_e, cfg, text, targetLang) => translator.translateText(cfg || config.get('ai'), text, targetLang));

// ---------------- Mod 更新 / 回滚 ----------------
ipcMain.handle('mods:checkUpdates', (_e, gameDir, mcVersion, loader) => modUpdate.checkUpdates(gameDir, mcVersion, loader));
ipcMain.handle('mods:resolve', (_e, gameDir, file) => modUpdate.resolveMod(gameDir, file));
ipcMain.handle('mods:versions', (_e, projectId, mcVersion, loader) => modUpdate.getProjectVersions(projectId, mcVersion, loader));
ipcMain.handle('mods:installVersion', (_e, projectId, versionId, gameDir, replaceFile) =>
  modUpdate.installVersion(projectId, versionId, gameDir, replaceFile));

// ---------------- 实例导出整合包 ----------------
ipcMain.handle('instances:export', async (_e, instanceId) => {
  const inst = instances.getInstance(instanceId);
  if (!inst) throw new Error('实例不存在');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出整合包',
    defaultPath: `${inst.name}.mrpack`,
    filters: [{ name: 'Modrinth 整合包', extensions: ['mrpack'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  return packExport.exportModpack(instanceId, filePath);
});

// ---------------- Mod Loader ----------------
ipcMain.handle('modloader:forge:versions', (_e, mcVersion) => modloaders.getForgeVersions(mcVersion));
ipcMain.handle('modloader:forge:install', (_e, mcVersion, forgeVersion, gameDir, javaPath) =>
  modloaders.installForge(mcVersion, forgeVersion, gameDir, javaPath, (p) => send('modloader:progress', p))
);
ipcMain.handle('modloader:fabric:loaders', () => modloaders.getFabricLoaders());
ipcMain.handle('modloader:fabric:install', (_e, mcVersion, loaderVersion, gameDir) =>
  modloaders.installFabric(mcVersion, loaderVersion, gameDir, (p) => send('modloader:progress', p))
);
ipcMain.handle('modloader:quilt:loaders', () => modloaders.getQuiltLoaders());
ipcMain.handle('modloader:quilt:install', (_e, mcVersion, loaderVersion, gameDir) =>
  modloaders.installQuilt(mcVersion, loaderVersion, gameDir, (p) => send('modloader:progress', p))
);

// ---------------- Mod 管理 ----------------
ipcMain.handle('mods:list', (_e, gameDir) => mods.listMods(gameDir));
ipcMain.handle('mods:enable', (_e, gameDir, fileName, enabled) => mods.setModEnabled(gameDir, fileName, enabled));
ipcMain.handle('mods:delete', (_e, gameDir, fileName) => mods.deleteMod(gameDir, fileName));

// ---------------- 搜索下载 ----------------
ipcMain.handle('search:curseforge', (_e, query, mcVersion, modLoader, cls) => curseforge.searchMods(query, mcVersion, modLoader, 20, cls));
ipcMain.handle('search:curseforge:files', (_e, modId, mcVersion) => curseforge.getFiles(modId, mcVersion));
ipcMain.handle('search:curseforge:download', (_e, file, gameDir) =>
  downloads.track(file.fileName || file.displayName || 'CurseForge 文件', 'curseforge', () => curseforge.downloadMod(file, gameDir)));
ipcMain.handle('search:curseforge:world', (_e, file, gameDir) =>
  downloads.track(file.fileName || file.displayName || '世界存档', 'world', () => curseforge.installWorld(file, gameDir)));
ipcMain.handle('search:modrinth', (_e, query, mcVersion, modLoader, projectType) =>
  modrinth.searchMods(query, mcVersion, modLoader, 20, projectType));
ipcMain.handle('search:modrinth:versions', (_e, projectId, mcVersion, modLoader) => modrinth.getVersions(projectId, mcVersion, modLoader));
ipcMain.handle('search:modrinth:download', (_e, file, gameDir, projectType) =>
  downloads.track(file.filename || file.name || 'Modrinth 文件', projectType || 'mod', () => modrinth.downloadMod(file, gameDir, projectType)));
ipcMain.handle('search:modrinth:installpack', async (_e, file, gameRoot) => {
  const info = await downloads.track(file.name || file.filename || '整合包', 'modpack', () => modrinth.installMrpack(file, gameRoot, send));
  // 注册为新实例
  instances.saveInstance(info.instanceId, {
    name: info.name,
    versionId: info.versionId,
    gameDir: info.gameDir,
    modLoader: info.modLoader,
    loaderVersion: info.loaderVersion,
    icon: '🗃️',
  });
  return info;
});

// ---------------- 游戏启动 ----------------
ipcMain.handle('game:launch', async (_e, instanceId, extra) => {
  const r = await launcher.launch(instanceId, send, extra);
  try { home.recordPlay(instanceId); } catch { /* 记录失败不影响启动 */ }
  return r;
});
ipcMain.handle('game:cancel', () => launcher.cancel());
ipcMain.handle('game:running', () => launcher.isRunning());

// ---------------- 首页桌面 ----------------
ipcMain.handle('home:news', (_e, force) => home.fetchNews(force));
ipcMain.handle('home:playLog', () => home.playLog());

// ---------------- 拖拽智能识别 ----------------
ipcMain.handle('dnd:inspect', (_e, paths) => dnd.inspect(paths));
ipcMain.handle('dnd:import', (_e, items, opts) => dnd.importItems(items, opts || {}, send));

// ---------------- 从其他启动器搬家 ----------------
ipcMain.handle('migrate:detect', () => migrate.detect());
ipcMain.handle('migrate:detectIn', (_e, dir) => migrate.detectIn(dir));
ipcMain.handle('migrate:run', (_e, payload) => migrate.run(payload || {}, (p) => send('migrate:progress', p)));

// ---------------- 皮肤系统 ----------------
ipcMain.handle('skin:official', (_e, nameOrUuid) => skin.fetchOfficialSkin(nameOrUuid));
ipcMain.handle('skin:download', (_e, url, label) => skin.downloadSkin(url, label));
ipcMain.handle('skin:readLocal', (_e, p) => skin.readLocal(p));
ipcMain.handle('skin:localList', () => skin.listLocal());
ipcMain.handle('skin:localDelete', (_e, name) => skin.deleteLocal(name));
ipcMain.handle('skin:uploadOfficial', (_e, filePath, variant) => skin.uploadOfficial(filePath, variant));
ipcMain.handle('skin:uploadYggdrasil', (_e, filePath, variant) => skin.uploadYggdrasil(filePath, variant));
ipcMain.handle('skin:library', (_e, base, query, page) => skin.browseLibrary(base, query, page));
ipcMain.handle('skin:current', () => skin.currentSkin());

// ---------------- 下载任务队列 ----------------
downloads.setNotifier((list) => send('downloads:changed', list));
ipcMain.handle('downloads:list', () => downloads.list());
ipcMain.handle('downloads:add', (_e, opts) => downloads.enqueue(opts || {}));
ipcMain.handle('downloads:cancel', (_e, id) => downloads.cancel(id));
ipcMain.handle('downloads:retry', (_e, id) => downloads.retry(id));
ipcMain.handle('downloads:remove', (_e, id) => downloads.remove(id));
ipcMain.handle('downloads:clear', () => downloads.clearFinished());
ipcMain.handle('downloads:openDir', () => {
  const dir = downloads.defaultDir();
  shell.openPath(dir);
  return dir;
});

// ---------------- 内置浏览器 ----------------
// 独立窗口，网页里的下载统一走上面的下载队列
ipcMain.handle('browser:open', (_e, url) => browser.open(/^https?:\/\//i.test(String(url || '')) ? url : ''));
ipcMain.handle('browser:info', () => browser.info());
ipcMain.handle('browser:setBookmarks', (_e, list) => browser.setBookmarks(list));
ipcMain.handle('browser:setDownloadMode', (_e, mode) => browser.setDownloadMode(mode));

// ---------------- 运行日志 ----------------
ipcMain.handle('log:history', () => logger.history());

// ---------------- 服务器 Ping ----------------
ipcMain.handle('server:ping', (_e, address) => serverping.ping(address));
ipcMain.handle('server:pingAll', (_e, addresses) => serverping.pingAll(addresses));

// ---------------- 联机助手 ----------------
ipcMain.handle('lan:detect', () => lan.detect());
ipcMain.handle('lan:ips', () => lan.localIPs());
ipcMain.handle('lan:setPath', (_e, id, p, name) => lan.setPath(id, p, name));
ipcMain.handle('lan:launch', (_e, id) => lan.launch(id));
ipcMain.handle('lan:install', (_e, id, file) => lan.install(id, file));
ipcMain.handle('lan:fetch', (_e, id) => lan.fetchTool(id));
ipcMain.handle('lan:toolsDir', () => lan.toolsRoot());
let upnpPort = 0;   // 当前映射出去的端口，退出时尽量撤销掉，别在路由器里留垃圾
ipcMain.handle('lan:upnp', async (_e, port) => {
  const res = await lan.upnpMap(port);
  if (res) upnpPort = port;
  return res;
});
ipcMain.handle('lan:upnpClose', async (_e, port) => {
  if (upnpPort === port) upnpPort = 0;
  return lan.upnpUnmap(port);
});
app.on('before-quit', () => { if (upnpPort) lan.upnpUnmap(upnpPort).catch(() => {}); });
ipcMain.handle('lan:publicEndpoints', (_e, port) => lan.publicEndpoints(port));

// ---------------- 陶瓦联机（内置客户端） ----------------
// 只跟官方 HTTP 接口打交道，二进制原样内置，界面里按 AGPL 例外条款②署名
ipcMain.handle('scaffold:info', () => ({
  available: terracotta.available(),
  exe: terracotta.exePath(),
  running: terracotta.isRunning(),
}));
ipcMain.handle('scaffold:state', () => terracotta.getState());
ipcMain.handle('scaffold:codeOf', (_e, name) => terracotta.normalizeRoom(name));
ipcMain.handle('scaffold:host', (_e, opts) => terracotta.host({
  ...(opts || {}),
  onState: (s) => send('scaffold:state', s),
}));
ipcMain.handle('scaffold:join', (_e, opts) => terracotta.join({
  ...(opts || {}),
  onState: (s) => send('scaffold:state', s),
}));
ipcMain.handle('scaffold:leave', () => terracotta.leave());
// 陶瓦后台进程按官方设计长期驻留（下次点一下就能用），退出启动器时只把房间退掉
app.on('before-quit', () => { terracotta.leave().catch(() => {}); });

// ---------------- EasyTier 联机（内置客户端） ----------------
// 二进制原样内置（LGPL-3.0），只当独立子进程调用，界面里按许可证要求署名
ipcMain.handle('easytier:info', () => ({
  available: easytier.available(),
  exe: easytier.exePath(),
  running: easytier.isRunning(),
  hostIp: easytier.HOST_IP,
  mcPort: easytier.MC_PORT,
  nodes: config.get('easytierNodes') || [],
  defaults: easytier.SHARED_NODES,
}));
ipcMain.handle('easytier:state', () => easytier.getState());
ipcMain.handle('easytier:codeOf', (_e, name) => {
  const n = easytier.networkOf(name);
  return n ? n.code : '';
});
ipcMain.handle('easytier:nodes', (_e, list) => config.set('easytierNodes', easytier.parseNodes((list || []).join(' '))));
// 开打之前先探一遍节点：连得上的排前面，全不通时界面直接给出「自己填中转地址」的指引
ipcMain.handle('easytier:probe', (_e, text) => easytier.probe(text || ''));
ipcMain.handle('easytier:host', (_e, opts) => easytier.host({
  ...(opts || {}),
  onState: (s) => send('easytier:state', s),
}));
ipcMain.handle('easytier:join', (_e, opts) => easytier.join({
  ...(opts || {}),
  onState: (s) => send('easytier:state', s),
}));
ipcMain.handle('easytier:leave', () => easytier.leave());
app.on('before-quit', () => { easytier.shutdown().catch(() => {}); });

// ---------------- 内存管理 ----------------
ipcMain.handle('memory:info', () => memory.getMemoryInfo());
ipcMain.handle('memory:recommend', () => memory.recommendMemory());
ipcMain.handle('memory:clean', () => memory.cleanMemory());

// ---------------- 外部打开 ----------------
ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:openGameDir', () => {
  const dir = config.get('gameDir');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});
ipcMain.handle('shell:openModsDir', () => {
  const dir = path.join(config.get('gameDir'), 'mods');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});
ipcMain.handle('shell:openConfigDir', () => {
  const dir = path.join(config.get('gameDir'), 'config');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});
ipcMain.handle('shell:openSavesDir', () => {
  const dir = path.join(config.get('gameDir'), 'saves');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

// 浏览器窗口自己的三个按钮
ipcMain.on('bw:window', (_e, action) => browser.windowAction(action));

// ---------------- 窗口控制（无边框） ----------------
ipcMain.on('window:minimize', () => win && win.minimize());
ipcMain.on('window:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('window:close', () => win && win.close());

// 主进程日志转发
logger.on((entry) => send('log', entry));

// ---------------- 生命周期 ----------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
