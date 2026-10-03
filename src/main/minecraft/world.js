// 存档（世界）编辑：读写 level.dat
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { TAG, parseNbt, writeNbt } = require('./nbt');
const content = require('./content');

const GAMEMODES = [
  { id: 0, name: '生存' },
  { id: 1, name: '创造' },
  { id: 2, name: '冒险' },
  { id: 3, name: '旁观' },
];

const DIFFICULTIES = [
  { id: 0, name: '和平' },
  { id: 1, name: '简单' },
  { id: 2, name: '普通' },
  { id: 3, name: '困难' },
];

// 常用游戏规则（type: bool | int）
const GAMERULES = [
  { key: 'keepInventory', label: '死亡不掉落', type: 'bool' },
  { key: 'doDaylightCycle', label: '昼夜循环', type: 'bool' },
  { key: 'doWeatherCycle', label: '天气变化', type: 'bool' },
  { key: 'doMobSpawning', label: '生物自然生成', type: 'bool' },
  { key: 'doMobLoot', label: '生物掉落物', type: 'bool' },
  { key: 'doTileDrops', label: '方块掉落', type: 'bool' },
  { key: 'mobGriefing', label: '生物破坏方块', type: 'bool' },
  { key: 'doFireTick', label: '火焰蔓延', type: 'bool' },
  { key: 'naturalRegeneration', label: '自然回血', type: 'bool' },
  { key: 'fallDamage', label: '摔落伤害', type: 'bool' },
  { key: 'fireDamage', label: '火焰伤害', type: 'bool' },
  { key: 'drowningDamage', label: '溺水伤害', type: 'bool' },
  { key: 'freezeDamage', label: '冰冻伤害', type: 'bool' },
  { key: 'doImmediateRespawn', label: '立即重生', type: 'bool' },
  { key: 'showDeathMessages', label: '显示死亡消息', type: 'bool' },
  { key: 'sendCommandFeedback', label: '命令反馈', type: 'bool' },
  { key: 'commandBlockOutput', label: '命令方块输出', type: 'bool' },
  { key: 'announceAdvancements', label: '播报进度', type: 'bool' },
  { key: 'logAdminCommands', label: '记录管理员命令', type: 'bool' },
  { key: 'reducedDebugInfo', label: '简化调试信息', type: 'bool' },
  { key: 'doInsomnia', label: '幻翼生成', type: 'bool' },
  { key: 'doPatrolSpawning', label: '灾厄巡逻队', type: 'bool' },
  { key: 'doTraderSpawning', label: '流浪商人', type: 'bool' },
  { key: 'doWardenSpawning', label: '监守者生成', type: 'bool' },
  { key: 'spectatorsGenerateChunks', label: '旁观者加载区块', type: 'bool' },
  { key: 'disableElytraMovementCheck', label: '关闭鞘翅移动检测', type: 'bool' },
  { key: 'doLimitedCrafting', label: '限制合成配方', type: 'bool' },
  { key: 'universalAnger', label: '通用愤怒', type: 'bool' },
  { key: 'forgiveDeadPlayers', label: '原谅死亡玩家', type: 'bool' },
  { key: 'globalSoundEvents', label: '全局音效事件', type: 'bool' },
  { key: 'spawnRadius', label: '出生点半径', type: 'int' },
  { key: 'randomTickSpeed', label: '随机刻速度', type: 'int' },
  { key: 'maxEntityCramming', label: '实体挤压上限', type: 'int' },
  { key: 'maxCommandChainLength', label: '命令链最大长度', type: 'int' },
  { key: 'playersSleepingPercentage', label: '睡觉跳过夜晚百分比', type: 'int' },
];

function levelDatPath(saveDir) {
  return path.join(saveDir, 'level.dat');
}

/** 读取并解析 level.dat，返回 { file, root, data } */
function readLevel(saveDir) {
  const file = levelDatPath(saveDir);
  if (!fs.existsSync(file)) throw new Error('该存档缺少 level.dat');
  let buf;
  try { buf = zlib.gunzipSync(fs.readFileSync(file)); }
  catch { throw new Error('level.dat 解压失败，可能已损坏'); }
  const root = parseNbt(buf);
  const data = root.v && root.v.Data ? root.v.Data.v : null;
  if (!data) throw new Error('level.dat 结构异常：缺少 Data');
  return { file, root, data };
}

function num(node, def = 0) {
  return node ? Number(node.v) : def;
}

function buildInfo(saveDir, data, withRules) {
  const info = {
    dirName: path.basename(saveDir),
    name: data.LevelName ? String(data.LevelName.v) : path.basename(saveDir),
    gameType: num(data.GameType, 0),
    difficulty: num(data.Difficulty, 2),
    hardcore: !!(data.hardcore && Number(data.hardcore.v)),
    allowCommands: !!(data.allowCommands && Number(data.allowCommands.v)),
    difficultyLocked: !!(data.DifficultyLocked && Number(data.DifficultyLocked.v)),
    seed: data.RandomSeed ? String(data.RandomSeed.v) : '0',
    dataVersion: num(data.DataVersion, 0),
    version: data.Version && data.Version.v
      ? {
        name: data.Version.v.Name ? String(data.Version.v.Name.v) : '',
        id: num(data.Version.v.Id, 0),
      }
      : null,
  };
  if (withRules) {
    const rules = {};
    if (data.GameRules && data.GameRules.v) {
      for (const [k, node] of Object.entries(data.GameRules.v)) rules[k] = String(node.v);
    }
    info.gamerules = rules;
  }
  return info;
}

/** 存档列表（附带 level.dat 元信息） */
function listWorlds(gameDir) {
  const saves = content.listSaves(gameDir);
  return saves.map((s) => {
    let meta = null;
    if (s.hasLevel) {
      try {
        const { data } = readLevel(s.path);
        meta = buildInfo(s.path, data, false);
      } catch { meta = null; }
    }
    return { ...s, meta };
  });
}

/** 完整存档信息（含游戏规则），供编辑器使用 */
function worldInfo(saveDir) {
  const { data } = readLevel(saveDir);
  return buildInfo(saveDir, data, true);
}

function setVal(compound, name, value, type) {
  if (compound[name]) compound[name].v = value;
  else compound[name] = { t: type, v: value };
}

/** 应用修改并写回 level.dat（写入前备份为 level.dat_old） */
function updateWorld(saveDir, patch) {
  const { file, root, data } = readLevel(saveDir);

  if (patch.name != null && String(patch.name).trim()) {
    setVal(data, 'LevelName', String(patch.name).trim(), TAG.STRING);
  }
  if (patch.gameType != null) {
    const gt = Number(patch.gameType) | 0;
    setVal(data, 'GameType', gt, TAG.INT);
    // 单人存档中玩家自身模式会覆盖世界默认值，一并修改
    if (data.Player && data.Player.v && data.Player.v.playerGameType) {
      data.Player.v.playerGameType.v = gt;
    }
  }
  if (patch.difficulty != null) {
    setVal(data, 'Difficulty', Number(patch.difficulty) | 0, TAG.BYTE);
  }
  if (patch.hardcore != null) {
    setVal(data, 'hardcore', patch.hardcore ? 1 : 0, TAG.BYTE);
  }
  if (patch.allowCommands != null) {
    setVal(data, 'allowCommands', patch.allowCommands ? 1 : 0, TAG.BYTE);
  }
  if (patch.seed != null && String(patch.seed).trim() !== '') {
    let seed;
    try { seed = BigInt(String(patch.seed).trim()); }
    catch { throw new Error('种子必须是整数'); }
    setVal(data, 'RandomSeed', seed, TAG.LONG);
  }
  if (patch.gamerules && typeof patch.gamerules === 'object') {
    if (!data.GameRules) data.GameRules = { t: TAG.COMPOUND, v: {} };
    for (const [k, val] of Object.entries(patch.gamerules)) {
      data.GameRules.v[k] = { t: TAG.STRING, v: String(val) };
    }
  }

  // 备份原始文件后再写入
  try { fs.copyFileSync(file, file + '_old'); } catch { /* 备份失败不阻断 */ }
  fs.writeFileSync(file, zlib.gzipSync(writeNbt(root)));
  return buildInfo(saveDir, data, true);
}

module.exports = {
  GAMEMODES,
  DIFFICULTIES,
  GAMERULES,
  listWorlds,
  worldInfo,
  updateWorld,
};