// Npcap / WinPcap 运行时探测
// 说明：Npcap 不是开源软件，许可证不允许随星云安装包再分发。
// 因此安装包不再内置 Packet.dll；EasyTier 启动时优先用自身目录里的 DLL，
// 没有则从系统已安装的 Npcap 目录读取（通过 PATH 传给子进程）。
const fs = require('fs');
const path = require('path');

const ROOT = process.env.SystemRoot || 'C:\\Windows';

const DIRS = [
  path.join(ROOT, 'System32', 'Npcap'),
  path.join(ROOT, 'System32'),
  path.join(ROOT, 'SysWOW64', 'Npcap'),
  path.join(ROOT, 'SysWOW64'),
  'C:\\Program Files\\Npcap',
  'C:\\Program Files (x86)\\Npcap',
];

function localDir(core) {
  return core ? path.dirname(core) : '';
}

/** EasyTier 目录自带 Packet.dll（例如用户自己解压的官方包） */
function hasLocal(core) {
  if (!core) return false;
  try { return fs.existsSync(path.join(localDir(core), 'Packet.dll')); } catch { return false; }
}

function installedDirs() {
  return DIRS.filter((d) => {
    try { return fs.existsSync(path.join(d, 'Packet.dll')); } catch { return false; }
  });
}

function available(core) {
  return hasLocal(core) || installedDirs().length > 0;
}

/** 返回给子进程 PATH 前缀；没有系统 Npcap 时返回空串 */
function pathPrefix() {
  return installedDirs().join(';');
}

/** 给 spawn 用的环境变量；只在需要时改写 PATH，避免大小写重复 */
function childEnv(base) {
  const env = { ...(base || process.env) };
  if (pathPrefix()) {
    delete env.Path;
    env.PATH = `${pathPrefix()};${process.env.PATH || process.env.Path || ''}`;
  }
  return env;
}

function ensure(core) {
  if (available(core)) return true;
  throw new Error(
    'EasyTier 联机需要系统已安装 Npcap（未检测到 Packet.dll）。\n'
    + '请到 https://npcap.com/#download 下载安装，安装时勾选「Install Npcap in WinPcap API-compatible Mode」，装完重试。\n'
    + '为遵守 Npcap 许可证，星云启动器不再随包附带该组件。',
  );
}

module.exports = { hasLocal, installedDirs, available, pathPrefix, childEnv, ensure };
