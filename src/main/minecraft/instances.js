const config = require('../config');

function listInstances() {
  return config.get('instances') || {};
}

function getInstance(id) {
  const all = listInstances();
  return all[id] || null;
}

function saveInstance(id, data) {
  const all = listInstances();
  if (all[id]) {
    all[id] = { ...all[id], ...data };
  } else {
    all[id] = {
      name: data.name || id,
      versionId: data.versionId || '',
      gameDir: data.gameDir,
      modLoader: data.modLoader || 'vanilla',
      loaderVersion: data.loaderVersion || '',
      javaPath: data.javaPath || '',
      memory: data.memory || null,
      jvmArgs: data.jvmArgs || '',
      icon: data.icon || '⛏',
      ...data,
    };
  }
  config.set('instances', all);
  return all[id];
}

function deleteInstance(id) {
  const all = listInstances();
  // 所有实例都允许删除（包括最初的默认实例），启动器不保留任何"钉子户"。
  delete all[id];
  config.set('instances', all);
  if (config.get('selectedInstance') === id) {
    // 选中的实例没了：自动落到剩余的第一个；一个都不剩则置空，由界面引导下载。
    const rest = Object.keys(all);
    config.set('selectedInstance', rest[0] || '');
  }
}

module.exports = { listInstances, getInstance, saveInstance, deleteInstance };
