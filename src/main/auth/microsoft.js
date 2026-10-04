// 微软设备码登录（Device Code Flow）
// 使用开源启动器圈共用的公共客户端 ID，无需注册、无需审核

const CLIENT_ID = '6a3728d6-27a3-4180-99bb-479895b8f88e';
const SCOPE = 'XboxLive.signin offline_access';

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 把 OAuth 错误码单独挂在 err.code 上：响应里 error_description 是一句英文说明，
    // 里面并不含 authorization_pending 这类错误码，靠 message 文本匹配会全部漏判。
    const err = new Error(data.error_description || data.error || `请求失败 HTTP ${res.status}`);
    err.code = data.error || '';
    err.status = res.status;
    throw err;
  }
  return data;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.errorMessage || data.message || `请求失败 HTTP ${res.status}`);
    err.code = data.error || '';
    err.status = res.status;
    throw err;
  }
  return data;
}

/** ① 向微软请求设备码 */
async function getDeviceCode() {
  const data = await postForm('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
    client_id: CLIENT_ID,
    scope: SCOPE,
  });
  if (!data.device_code || !data.user_code) {
    throw new Error('获取设备码失败');
  }
  return data;
}

/** ② 轮询等待用户在浏览器中完成授权 */
async function pollForToken(deviceCode, interval, onStatus) {
  // 服务端返回 slow_down 时要按 OAuth 规范把间隔调大，所以这里用 let
  let pollInterval = Math.max(Number(interval) || 5, 3) * 1000;
  const deadline = Date.now() + 15 * 60 * 1000; // 最多等 15 分钟

  while (Date.now() < deadline) {
    await sleep(pollInterval);
    try {
      const data = await postForm('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CLIENT_ID,
        device_code: deviceCode,
      });
      if (data.access_token) return data;
      // 没拿到 access_token 但没报错，继续轮询
    } catch (e) {
      const code = e.code || e.message || '';
      if (code.includes('authorization_pending')) {
        if (onStatus) onStatus('waiting');
        continue;
      }
      if (code.includes('slow_down')) {
        pollInterval += 5000;      // 按规范每次至少加 5 秒
        if (onStatus) onStatus('waiting');
        continue;
      }
      if (code.includes('authorization_declined')) {
        throw new Error('你拒绝了授权请求');
      }
      if (code.includes('expired_token')) {
        throw new Error('设备码已过期，请重新登录');
      }
      if (code.includes('bad_verification_code')) {
        throw new Error('验证码错误，请重新登录');
      }
      // 4xx 且带明确错误码，说明这次请求本身不会被接受，再轮询到超时也没用，直接报错。
      // 只有网络波动 / 5xx 这类才继续重试。
      if (e.status && e.status < 500 && e.code) throw new Error(e.message);
      if (onStatus) onStatus('waiting');
    }
  }
  throw new Error('等待超时，请重新登录');
}

/** ③④⑤⑥：msToken → XBL → XSTS → Minecraft，并查询角色资料 */
async function msTokenToMinecraftAccount(ms) {
  // ③ Xbox Live
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${ms.access_token}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  if (!xbl.Token) throw new Error('Xbox Live 认证失败');
  const uhs = xbl.DisplayClaims.xui[0].uhs;
  const xuid = xbl.DisplayClaims.xui[0].xid || '';

  // ④ XSTS
  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: {
      SandboxId: 'RETAIL',
      UserTokens: [xbl.Token],
    },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });

  if (xsts.XErr) {
    const messages = {
      2148916233: '该微软账号没有 Xbox 档案，请先用 Xbox 应用注册',
      2148916235: 'Xbox Live 服务在当前地区不可用',
      2148916236: '需要成人验证后才能登录',
      2148916237: '需要成人验证后才能登录',
      2148916238: '未成年账号需要加入家庭组并由成年人添加权限',
    };
    throw new Error(messages[xsts.XErr] || `Xbox XSTS 授权失败 (${xsts.XErr})`);
  }
  if (!xsts.Token) throw new Error('XSTS 授权失败');

  // ⑤ Minecraft 登录
  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
  });
  if (!mc.access_token) throw new Error('Minecraft 服务登录失败');

  // ⑥ 角色资料（同时判断是否拥有游戏）
  const profileRes = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.access_token}` },
  });
  if (profileRes.status === 403 || profileRes.status === 404) {
    throw new Error('该账号未购买 Minecraft，无法正版登录');
  }
  if (!profileRes.ok) throw new Error(`获取角色资料失败 (HTTP ${profileRes.status})`);
  const profile = await profileRes.json();

  return {
    type: 'microsoft',
    username: profile.name,
    uuid: profile.id,
    accessToken: mc.access_token,
    expiresAt: Date.now() + (mc.expires_in || 86400) * 1000,
    msRefreshToken: ms.refresh_token,
    xuid,
  };
}

/**
 * 设备码登录主流程
 * onDeviceCode: 回调 { userCode, verificationUri } 让 UI 展示给玩家
 */
async function login(onDeviceCode) {
  // ① 获取设备码
  const device = await getDeviceCode();
  if (onDeviceCode) {
    onDeviceCode({
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      message: device.message,
    });
  }

  // ② 轮询等授权
  const ms = await pollForToken(device.device_code, device.interval, (status) => {
    if (status === 'waiting' && onDeviceCode) {
      onDeviceCode({ status: 'waiting', userCode: device.user_code, verificationUri: device.verification_uri });
    }
  });

  // ③④⑤⑥ 换 Minecraft 令牌
  return msTokenToMinecraftAccount(ms);
}

/** 用 refresh_token 静默续期 */
function refreshMsToken(refreshToken) {
  return postForm('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPE,
  });
}

/** 启动前调用：令牌即将过期则自动刷新 */
async function refresh(account) {
  if (account.type !== 'microsoft') return account;
  if (account.expiresAt && account.expiresAt - Date.now() > 5 * 60 * 1000) {
    return account;
  }
  if (!account.msRefreshToken) throw new Error('登录已过期，请重新正版登录');
  const ms = await refreshMsToken(account.msRefreshToken);
  return msTokenToMinecraftAccount(ms);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { login, refresh };
