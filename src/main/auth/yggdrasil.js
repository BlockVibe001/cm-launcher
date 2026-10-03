const crypto = require('crypto');

/**
 * 皮肤站（Yggdrasil）登录，兼容 Blessing Skin Server。
 * 走密码模式：authserver/authenticate -> 拿 accessToken 与角色信息。
 */

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 无 JSON 响应 */ }
  if (!res.ok) {
    const msg = data && (data.errorMessage || data.error)
      ? data.errorMessage || data.error
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/**
 * @param {string} baseUrl 皮肤站根地址（如 https://mcskin.littleservice.cn/api/yggdrasil）
 * @param {string} username
 * @param {string} password
 * @param {string} characterId 可选，多角色时指定
 */
async function login(baseUrl, username, password, characterId) {
  if (!baseUrl) throw new Error('皮肤站地址未配置');
  const root = baseUrl.replace(/\/+$/, '');
  const clientToken = crypto.randomUUID().replace(/-/g, '');

  const body = {
    username,
    password,
    clientToken,
    requestUser: true,
    agent: { name: 'Minecraft', version: 1 },
  };
  if (characterId) body.selectedProfile = { id: characterId };

  const res = await postJson(`${root}/authserver/authenticate`, body);

  // 处理多角色
  let profile;
  if (res.selectedProfile && res.selectedProfile.id) {
    profile = res.selectedProfile;
  } else if (res.availableProfiles && res.availableProfiles.length > 0) {
    if (characterId) {
      profile = res.availableProfiles.find((p) => p.id === characterId);
    }
    if (!profile) profile = res.availableProfiles[0];
  } else {
    throw new Error('该账号没有可用角色');
  }

  return {
    type: 'yggdrasil',
    stationUrl: root,
    clientToken,
    accessToken: res.accessToken,
    username: profile.name,
    uuid: profile.id,
    properties: profile.properties || [],
    expiresAt: 0, // Yggdrasil 令牌通常长期有效，按需 refresh
  };
}

/** 启动前校验/刷新令牌 */
async function refresh(account) {
  if (account.type !== 'yggdrasil') return account;
  const root = account.stationUrl;
  try {
    const res = await postJson(`${root}/authserver/refresh`, {
      accessToken: account.accessToken,
      clientToken: account.clientToken,
      selectedProfile: { id: account.uuid, name: account.username },
    });
    return { ...account, accessToken: res.accessToken };
  } catch {
    // refresh 失败不阻塞，直接用旧令牌尝试启动
    return account;
  }
}

module.exports = { login, refresh };
