const { EventEmitter } = require('events');

const emitter = new EventEmitter();
const buffer = [];
const MAX_BUFFER = 2000;

function push(level, message) {
  const entry = { level, message: String(message), time: new Date().toISOString() };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  emitter.emit('log', entry);
}

module.exports = {
  on: (fn) => emitter.on('log', fn),
  history: () => [...buffer],
  info: (m) => push('info', m),
  warn: (m) => push('warn', m),
  error: (m) => push('error', m),
};
