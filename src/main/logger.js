const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const emitter = new EventEmitter();
const buffer = [];
const MAX_BUFFER = 2000;

// 日志同时落盘。以前只存在内存里，玩家一出问题、重启一下证据就没了，
// 只能靠复述现象来猜。写到 userData/logs 下按天分文件，非 Electron 环境
// （冒烟脚本等）拿不到 userData 就自动跳过，不影响功能。
let stream = null;
try {
  const { app } = require('electron');
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  stream = fs.createWriteStream(
    path.join(dir, `launcher-${new Date().toISOString().slice(0, 10)}.log`),
    { flags: 'a' },
  );
} catch {
  // 拿不到目录就不落盘
}

function push(level, message) {
  const entry = { level, message: String(message), time: new Date().toISOString() };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  if (stream) stream.write(`[${entry.time}] [${level}] ${entry.message}\n`);
  emitter.emit('log', entry);
}

module.exports = {
  on: (fn) => emitter.on('log', fn),
  history: () => [...buffer],
  info: (m) => push('info', m),
  warn: (m) => push('warn', m),
  error: (m) => push('error', m),
};
