const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const config = require('../config');
const logger = require('../logger');
const { matchesRules } = require('./rules');
const { resolveVersionDetail } = require('./versions');
const { prepareGame, CanceledError, mavenLibPath } = require('./downloader');
const { listJavas, pickFor, requiredJava } = require('./java');
const microsoftAuth = require('../auth/microsoft');
const yggdrasilAuth = require('../auth/yggdrasil');
const { getInstance } = require('./instances');
const { detectLanPort } = require('./lan');

let child = null;
let abortController = null;

function isRunning() {
  return child !== null;
}

function cancel() {
  if (abortController) abortController.abort();
}

/** 处理带规则的参数数组（JVM / game arguments 通用） */
function filterArgs(args, features) {
  const out = [];
  for (const item of args || []) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (matchesRules(item.rules, features)) {
      if (Array.isArray(item.value)) out.push(...item.value);
      else out.push(item.value);
    }
  }
  return out;
}

/** quickPlay 参数仅 1.20+ 支持 */
function supportsQuickPlay(versionId) {
  const m = /^1\.(\d+)/.exec(String(versionId));
  if (!m) return false;
  return Number(m[1]) >= 20;
}

/**
 * 加速档的堆上限：按物理内存的一半抬高，上限 8G、下限 2G。
 * 只在比用户配置更大时生效，所以设得更大的人不会被压回去。
 */
function boostedMax(configured) {
  const totalMb = Math.floor(os.totalmem() / 1048576);
  const auto = Math.max(2048, Math.min(8192, Math.round(totalMb * 0.5)));
  return Math.max(Number(configured) || 0, auto);
}

/** 加速档追加的 JVM 参数（G1 调优，社区实践里最稳的一套） */
function boostArgs() {
  return [
    '-XX:+UseG1GC',
    // G1NewSizePercent / G1MaxNewSizePercent 在 JDK8/9 上是实验性选项，
    // 不解锁直接报「must be enabled via -XX:+UnlockExperimentalVMOptions」，JVM 直接退出（退出码1）。
    // 必须放在它们前面；高版本 JDK 上该开关无副作用。
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+DisableExplicitGC',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:MaxTenuringThreshold=1',
    '-XX:+PerfDisableSharedMem',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
  ];
}

function buildLaunchArgs(vj, gameDir, account, opts = {}) {
  const cfg = config.getAll();
  const maxMem = opts.maxMemory ?? cfg.maxMemory;
  const minMem = opts.minMemory ?? cfg.minMemory;
  const width = opts.width ?? cfg.width;
  const height = opts.height ?? cfg.height;
  const extraJvm = opts.jvmArgs || cfg.jvmArgs || '';

  const versionsDir = path.join(gameDir, 'versions', vj.id);
  const nativesDir = path.join(versionsDir, 'natives');
  const librariesDir = path.join(gameDir, 'libraries');
  const assetsDir = path.join(gameDir, 'assets');

  // ---- classpath ----
  const cpList = [];
  for (const lib of vj.libraries || []) {
    if (lib.rules && !matchesRules(lib.rules)) continue;
    const art = lib.downloads && lib.downloads.artifact;
    if (art) {
      cpList.push(path.join(librariesDir, art.path));
      continue;
    }
    // Fabric/Quilt 式：库没有 downloads.artifact，只有 maven 坐标 —— 按坐标算路径。
    // 漏了它 fabric-loader 不在 classpath 上，JVM 报「找不到或无法加载主类 KnotClient」。
    const rel = mavenLibPath(lib.name || '');
    if (rel) cpList.push(path.join(librariesDir, rel));
  }
  cpList.push(path.join(versionsDir, `${vj.id}.jar`));
  const cpSep = process.platform === 'win32' ? ';' : ':';
  const classpath = [...new Set(cpList)].join(cpSep);

  const assetIndexId = vj.assetIndex ? vj.assetIndex.id : (vj.assets || 'legacy');

  // 旧版本资源目录推断（virtual / map_to_resources）
  let gameAssets = assetsDir;
  try {
    const idx = JSON.parse(fs.readFileSync(
      path.join(assetsDir, 'indexes', `${assetIndexId}.json`), 'utf8',
    ));
    if (idx.map_to_resources) gameAssets = path.join(gameDir, 'resources');
    else if (idx.virtual) gameAssets = path.join(assetsDir, 'virtual', assetIndexId);
  } catch {
    // 新版本不需要
  }

  // ---- 占位符替换表 ----
  const repl = new Map([
    ['natives_directory', nativesDir],
    ['launcher_name', 'CM-Launcher'],
    ['launcher_version', '1.0.0'],
    ['classpath', classpath],
    ['classpath_separator', cpSep],
    ['library_directory', librariesDir],
    ['auth_player_name', account.username],
    ['version_name', vj.id],
    ['game_directory', gameDir],
    ['assets_root', assetsDir],
    ['game_assets', gameAssets],
    ['assets_index_name', assetIndexId],
    ['auth_uuid', account.uuid],
    ['auth_access_token', account.accessToken],
    ['user_type', account.type === 'microsoft' ? 'msa' : 'legacy'],
    ['version_type', vj.type || 'release'],
    ['user_properties', '{}'],
    ['auth_session', `token:${account.accessToken}:${account.uuid}`],
    ['clientid', ''],
    ['client_id', ''],
    ['auth_xuid', account.xuid || ''],
    ['resolution_width', String(cfg.width)],
    ['resolution_height', String(cfg.height)],
  ]);

  const sub = (s) => s.replace(/\$\{([a-z_]+)\}/gi, (m, key) => (
    repl.has(key) ? repl.get(key) : m
  ));

  // ---- 游戏加速：自适应堆 + JVM 调优 ----
  const boost = opts.speedBoost ?? cfg.speedBoost ?? true;

  // ---- JVM 参数 ----
  const memArgs = [`-Xms${minMem}M`, `-Xmx${boost ? boostedMax(maxMem) : maxMem}M`];
  let jvmArgs;
  if (vj.arguments && Array.isArray(vj.arguments.jvm)) {
    jvmArgs = filterArgs(vj.arguments.jvm, {});
  } else {
    jvmArgs = ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'];
    if (process.platform === 'darwin') jvmArgs.unshift('-XstartOnFirstThread');
  }
  jvmArgs = jvmArgs.map(sub);

  // 追加用户自定义 JVM 参数
  const extra = extraJvm.split(/\s+/).filter(Boolean);

  // 加速档：追加一组 G1 调优参数（社区验证充分的「Aikar's flags」思路），
  // 减少 GC 卡顿、缩短区块加载时的停顿。用户自己已经填了 GC 参数就不重复加，
  // 且放在用户参数前面，用户仍可覆盖。
  const userPickedGc = extra.some((a) => /UseG1GC|UseZGC|UseShenandoahGC/i.test(a));
  if (boost && !userPickedGc) jvmArgs.push(...boostArgs());
  jvmArgs.push(...extra);

  // ---- 游戏参数 ----
  let gameArgs;
  if (vj.arguments && Array.isArray(vj.arguments.game)) {
    // 始终启用自定义分辨率，注入设置中的窗口大小
    gameArgs = filterArgs(vj.arguments.game, { has_custom_resolution: true });
  } else {
    gameArgs = (vj.minecraftArguments || '').split(/\s+/);
  }
  gameArgs = gameArgs.map(sub);

  // ---- 快速进入世界 / 服务器（1.20+ 的 quickPlay） ----
  if (supportsQuickPlay(vj.id)) {
    if (opts.quickPlayWorld) {
      gameArgs.push('--quickPlaySingleplayer', String(opts.quickPlayWorld));
    } else if (opts.quickPlayServer) {
      gameArgs.push('--quickPlayMultiplayer', String(opts.quickPlayServer));
    }
  }

  return [...memArgs, ...jvmArgs, vj.mainClass, ...gameArgs];
}

/**
 * 完整启动流程：解析实例 → 校验账号 → 下载文件 → 刷新令牌 → 找 Java → 启动。
 * @param {string} instanceId 实例 ID
 * @param {(channel: string, payload?: any) => void} send 向渲染进程推事件
 */
async function launch(instanceId, send, extra) {
  if (isRunning()) throw new Error('游戏已经在运行中');

  const instance = getInstance(instanceId) || getInstance(config.get('selectedInstance'));
  if (!instance) throw new Error('实例不存在');
  if (!instance.versionId) throw new Error('该实例未选择游戏版本');

  const account = config.get('account');
  if (!account) throw new Error('请先登录账号');

  const gameDir = instance.gameDir || config.get('gameDir');
  fs.mkdirSync(gameDir, { recursive: true });

  logger.info(`启动实例「${instance.name}」，版本：${instance.versionId}`);
  const vj = await resolveVersionDetail(instance.versionId, gameDir);

  // 下载/校验全部游戏文件
  abortController = new AbortController();
  try {
    await prepareGame(vj, gameDir, {
      signal: abortController.signal,
      onProgress: (p) => send('download:progress', p),
    });
  } catch (e) {
    abortController = null;
    throw e;
  }
  abortController = null;

  // 令牌自动刷新
  let acc = account;
  if (acc.type === 'microsoft') {
    logger.info('检查正版登录令牌…');
    acc = await microsoftAuth.refresh(acc);
    config.setAccount(acc);      // 顺带把续期后的令牌同步回多账号列表
  } else if (acc.type === 'yggdrasil') {
    logger.info('检查皮肤站登录令牌…');
    acc = await yggdrasilAuth.refresh(acc);
    config.setAccount(acc);
  }

  // 确定 Java（实例级优先，其次全局），未指定时按游戏版本自动匹配
  let javaPath = instance.javaPath || config.get('javaPath');
  if (!javaPath) {
    const javas = await listJavas();
    if (javas.length === 0) {
      throw new Error('未找到 Java，请在设置中一键下载或手动指定 java.exe（1.20.5+ 需 Java 21，1.17+ 需 Java 17，旧版需 Java 8）');
    }
    const picked = pickFor(vj.id, javas);
    javaPath = (picked || javas[0]).path;
    logger.info(`${vj.id} 需要 Java ${requiredJava(vj.id).major}，自动匹配：Java ${(picked || javas[0]).major}`);
  }
  logger.info(`Java：${javaPath}`);

  const opts = {
    maxMemory: instance.memory?.max || undefined,
    minMemory: instance.memory?.min || undefined,
    jvmArgs: instance.jvmArgs || undefined,
    quickPlayWorld: extra && extra.quickPlayWorld,
    quickPlayServer: (extra && extra.quickPlayServer) || instance.server || undefined,
  };
  const args = buildLaunchArgs(vj, gameDir, acc, opts);
  logger.info(`启动游戏：${vj.id}，玩家 ${acc.username}`);

  child = spawn(javaPath, args, {
    cwd: gameDir,
    env: { ...process.env },
    windowsHide: false,
  });

  // 加速档：把游戏进程优先级抬到「高于正常」，减少后台程序抢 CPU 造成的卡顿
  if (config.get('speedBoost') !== false) {
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); }
    catch (e) { logger.warn(`提升游戏进程优先级失败：${e.message}`); }
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    if (!d.trim()) return;
    logger.info(d.trim());
    // 抓到「已对局域网开放」的端口就推给界面，公网联机可以直接用它做映射
    const port = detectLanPort(d);
    if (port) send('game:lanPort', { port });
  });
  child.stderr.on('data', (d) => {
    if (d.trim()) logger.warn(d.trim());
  });
  child.on('error', (err) => {
    logger.error(`游戏进程错误：${err.message}`);
    child = null;
    send('game:exit', -1);
  });
  child.on('close', (code) => {
    logger.info(`游戏已退出（退出码 ${code}）`);
    child = null;
    send('game:exit', code);
  });

  send('game:started');
  return true;
}

/**
 * 只下载 / 校验某个版本的全部游戏文件，不启动游戏。
 * 首页「下载版本」用它：先落盘，成功了再建实例，失败就不留残实例。
 * 复用 cancel()，所以界面上的「取消」对下载同样有效。
 */
async function prepare(mcVersion, gameDir, send) {
  const dir = gameDir || config.get('gameDir');
  fs.mkdirSync(dir, { recursive: true });
  const vj = await resolveVersionDetail(mcVersion, dir);
  abortController = new AbortController();
  try {
    await prepareGame(vj, dir, {
      signal: abortController.signal,
      onProgress: (p) => send && send('download:progress', p),
    });
  } finally {
    abortController = null;
  }
  return { id: vj.id };
}

module.exports = { launch, prepare, cancel, isRunning, CanceledError, buildLaunchArgs, boostedMax, boostArgs };
