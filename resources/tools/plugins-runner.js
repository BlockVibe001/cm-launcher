/* 星云启动器 Tauri 插件运行器（由 node.exe 调用）
 * 用法：node plugins-runner.js <pluginDir> <list|run-command|run-entry> [id]
 * 结果只写一行 JSON 到 stdout；插件日志走 stderr，避免污染结果。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const fail = (message) => { out({ ok: false, error: String(message || '插件执行失败') }); process.exit(0); };
process.on('uncaughtException', (e) => fail(e && e.message));
process.on('unhandledRejection', (e) => fail(e && e.message));

try {
  const dir = path.resolve(process.argv[2] || '');
  const action = process.argv[3] || 'list';
  const wanted = process.argv[4] || '';
  const manifestPath = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) fail('缺少 plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object') fail('plugin.json 必须是对象');
  const id = String(manifest.id || path.basename(dir)).trim();
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [];
  const mainRel = String(manifest.main || 'index.js').replace(/\\/g, '/');
  const entryPath = path.resolve(dir, mainRel);
  if (!entryPath.startsWith(dir + path.sep)) fail('main 不能指向插件目录之外');
  if (!fs.existsSync(entryPath)) fail('入口文件不存在：' + mainRel);

  const guard = (perm) => {
    if (!permissions.includes(perm)) throw new Error('缺少权限：' + perm);
  };
  const configPath = path.join(dir, 'config.json');
  const readConfig = () => {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) || {}; } catch { return {}; }
  };
  const writeConfig = (data) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  };
  const notifications = [];
  const commands = [];
  const entries = [];
  const ctx = {
    id,
    version: String(manifest.version || '0.0.0'),
    apiVersion: 1,
    dir,
    log: (...args) => process.stderr.write('[plugin:' + id + '] ' + args.map(String).join(' ') + '\n'),
    notify(title, body) {
      guard('notify');
      notifications.push({
        plugin: id,
        name: String(manifest.name || id),
        title: String(title || '').slice(0, 120),
        body: String(body || '').slice(0, 300),
      });
    },
    registerCommand(cmd) {
      guard('command');
      if (!cmd || typeof cmd !== 'object') throw new Error('registerCommand 需要对象');
      const cid = String(cmd.id || '').trim();
      if (!cid) throw new Error('命令 id 不合法');
      if (typeof cmd.run !== 'function') throw new Error('命令需要 run 函数');
      commands.push({ id: cid, title: String(cmd.title || cid).slice(0, 60), run: cmd.run });
    },
    registerUiEntry(entry) {
      guard('ui.entry');
      if (!entry || typeof entry !== 'object') throw new Error('registerUiEntry 需要对象');
      const eid = String(entry.id || '').trim();
      if (!eid) throw new Error('入口 id 不合法');
      if (typeof entry.render !== 'function') throw new Error('入口需要 render 函数');
      entries.push({ id: eid, title: String(entry.title || eid).slice(0, 60), render: entry.render });
    },
    getConfig() { guard('config'); return readConfig(); },
    setConfig(patch) { guard('config'); writeConfig(Object.assign(readConfig(), patch || {})); },
  };

  const requireFromPlugin = createRequire(entryPath);
  let plugin = requireFromPlugin(entryPath);
  // 兼容常见写法：export default、module.exports = activate、module.exports.default
  if (plugin && plugin.__esModule && plugin.default) plugin = plugin.default;
  else if (plugin && typeof plugin.activate !== 'function' && plugin.default) plugin = plugin.default;
  if (typeof plugin === 'function') plugin = { activate: plugin };
  if (!plugin || typeof plugin.activate !== 'function') fail('插件没有导出 activate 函数');
  plugin.activate(ctx);

  const finish = (obj) => out(Object.assign({ ok: true, loaded: true, notifications }, obj));
  if (action === 'list') {
    finish({
      commands: commands.map((c) => ({ id: c.id, title: c.title })),
      entries: entries.map((e) => ({ id: e.id, title: e.title })),
    });
  } else if (action === 'run-command') {
    const cmd = commands.find((c) => c.id === wanted);
    if (!cmd) fail('命令不存在');
    Promise.resolve().then(() => cmd.run(ctx)).then((message) => {
      out({ ok: true, message: message == null ? '' : (typeof message === 'string' ? message : JSON.stringify(message)), notifications });
    }).catch((e) => fail(e && e.message));
  } else if (action === 'run-entry') {
    const entry = entries.find((e) => e.id === wanted);
    if (!entry) fail('界面入口不存在');
    Promise.resolve().then(() => entry.render(ctx)).then((html) => {
      out({ ok: true, title: entry.title, html: typeof html === 'string' ? html : String((html && html.html) || ''), notifications });
    }).catch((e) => fail(e && e.message));
  } else {
    fail('未知操作');
  }
} catch (e) {
  fail(e && e.message ? e.message : e);
}
