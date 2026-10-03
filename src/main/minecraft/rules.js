const os = require('os');

const osName = process.platform === 'win32' ? 'windows'
  : process.platform === 'darwin' ? 'osx' : 'linux';

function osMatches(osRule) {
  if (!osRule) return true;
  if (osRule.name && osRule.name !== osName) return false;
  if (osRule.arch && osRule.arch !== process.arch) return false;
  if (osRule.version) {
    try {
      if (!new RegExp(osRule.version).test(os.release())) return false;
    } catch {
      // 非法正则忽略
    }
  }
  return true;
}

function matchesRules(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let applies = true;
    if (rule.os) applies = osMatches(rule.os);
    if (applies && rule.features) {
      for (const [key, expected] of Object.entries(rule.features)) {
        if (Boolean(features[key]) !== Boolean(expected)) {
          applies = false;
          break;
        }
      }
    }
    if (applies) allowed = rule.action === 'allow';
  }
  return allowed;
}

module.exports = { matchesRules, osName };
