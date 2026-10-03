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
  if (id === 'default') throw new Error('默认实例不可删除');
  delete all[id];
  config.set('instances', all);
  if (config.get('selectedInstance') === id) {
    config.set('selectedInstance', 'default');
  }
}

module.exports = { listInstances, getInstance, saveInstance, deleteInstance };
