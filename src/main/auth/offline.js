const crypto = require('crypto');

/**
 * 与官方启动器一致的离线 UUID：
 * UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))，即 MD5 版本号置 3。
 */
function offlineUuid(username) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // 版本 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // IETF 变体
  const hex = hash.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function login(username) {
  const name = username.trim();
  return {
    type: 'offline',
    username: name,
    uuid: offlineUuid(name),
    accessToken: '0',
  };
}

module.exports = { login, offlineUuid };
