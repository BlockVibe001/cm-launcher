//! 微软设备码登录（Device Code Flow）：与 Electron 版 auth/microsoft.js 对齐。
//! 公共客户端 ID（开源启动器圈共用），无需注册审核。
//! 第 2 阶段使用 refresh；登录主流程命令在第 4 阶段接线。

use crate::error::{AppError, CmdResult};
use crate::net::HTTP;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

const CLIENT_ID: &str = "6a3728d6-27a3-4180-99bb-479895b8f88e";
const SCOPE: &str = "XboxLive.signin offline_access";

pub fn is_microsoft(acc: &Value) -> bool {
    acc.get("type").and_then(Value::as_str) == Some("microsoft")
}

async fn post_form(url: &str, params: &[(&str, String)]) -> CmdResult<Value> {
    let mut form: HashMap<&str, String> = HashMap::new();
    for (k, v) in params {
        form.insert(*k, v.clone());
    }
    let res = HTTP.post(url).form(&form).send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    let status = res.status().as_u16();
    let data: Value = res.json().await.unwrap_or(json!({}));
    if status < 200 || status >= 300 {
        return Err(AppError::Auth {
            code: data.get("error").and_then(Value::as_str).unwrap_or("").to_string(),
            status,
            message: data
                .get("error_description")
                .or_else(|| data.get("error"))
                .and_then(Value::as_str)
                .unwrap_or(&format!("请求失败 HTTP {status}"))
                .to_string(),
        });
    }
    Ok(data)
}

async fn post_json(url: &str, body: Value) -> CmdResult<Value> {
    let res = HTTP
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let status = res.status().as_u16();
    let data: Value = res.json().await.unwrap_or(json!({}));
    if status < 200 || status >= 300 {
        return Err(AppError::Auth {
            code: data.get("error").and_then(Value::as_str).unwrap_or("").to_string(),
            status,
            message: data
                .get("errorMessage")
                .or_else(|| data.get("message"))
                .and_then(Value::as_str)
                .unwrap_or(&format!("请求失败 HTTP {status}"))
                .to_string(),
        });
    }
    Ok(data)
}

// ① 请求设备码
#[allow(dead_code)]
pub async fn get_device_code() -> CmdResult<Value> {
    let data = post_form(
        "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode",
        &[("client_id", CLIENT_ID.into()), ("scope", SCOPE.into())],
    )
    .await?;
    if data.get("device_code").and_then(Value::as_str).is_none() || data.get("user_code").and_then(Value::as_str).is_none() {
        return Err(AppError::Msg("获取设备码失败".into()));
    }
    Ok(data)
}

/// ② 轮询等待授权。on_status 在等待中回调。
#[allow(dead_code)]
pub async fn poll_for_token(device_code: &str, interval: i64) -> CmdResult<Value> {
    // slow_down 时按规范加 5 秒
    let mut poll_ms = (interval.max(3)) * 1000;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15 * 60);

    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::Msg("等待超时，请重新登录".into()));
        }
        tokio::time::sleep(Duration::from_millis(poll_ms as u64)).await;
        let r = post_form(
            "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
            &[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code".into()),
                ("client_id", CLIENT_ID.into()),
                ("device_code", device_code.into()),
            ],
        )
        .await;
        match r {
            Ok(data) => {
                if data.get("access_token").and_then(Value::as_str).is_some() {
                    return Ok(data);
                }
            }
            Err(e) => {
                let code = e.code();
                if code.contains("authorization_pending") {
                    continue;
                }
                if code.contains("slow_down") {
                    poll_ms += 5000;
                    continue;
                }
                if code.contains("authorization_declined") {
                    return Err(AppError::Msg("你拒绝了授权请求".into()));
                }
                if code.contains("expired_token") {
                    return Err(AppError::Msg("设备码已过期，请重新登录".into()));
                }
                if code.contains("bad_verification_code") {
                    return Err(AppError::Msg("验证码错误，请重新登录".into()));
                }
                // 4xx 带明确错误码：再轮询也没用
                if e.status() > 0 && e.status() < 500 && !code.is_empty() {
                    return Err(AppError::Msg(e.to_string()));
                }
                // 网络波动 / 5xx：继续
            }
        }
    }
}

/// ③④⑤⑥：msToken → XBL → XSTS → Minecraft → 角色资料
pub async fn ms_token_to_minecraft_account(ms: &Value) -> CmdResult<Value> {
    // ③ Xbox Live
    let xbl = post_json(
        "https://user.auth.xboxlive.com/user/authenticate",
        json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={}", ms.get("access_token").and_then(Value::as_str).unwrap_or("")),
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT",
        }),
    )
    .await?;
    if xbl.get("Token").and_then(Value::as_str).is_none() {
        return Err(AppError::Msg("Xbox Live 认证失败".into()));
    }
    let xui0 = xbl.pointer("/DisplayClaims/xui/0");
    let uhs = xui0.and_then(|x| x.get("uhs")).and_then(Value::as_str).unwrap_or("");
    let xuid = xui0.and_then(|x| x.get("xid")).and_then(Value::as_str).unwrap_or("").to_string();

    // ④ XSTS
    let xsts = post_json(
        "https://xsts.auth.xboxlive.com/xsts/authorize",
        json!({
            "Properties": {
                "SandboxId": "RETAIL",
                "UserTokens": [xbl.get("Token").cloned().unwrap_or(Value::Null)],
            },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT",
        }),
    )
    .await?;

    if let Some(xerr) = xsts.get("XErr") {
        let messages: HashMap<i64, &str> = HashMap::from([
            (2148916233, "该微软账号没有 Xbox 档案，请先用 Xbox 应用注册"),
            (2148916235, "Xbox Live 服务在当前地区不可用"),
            (2148916236, "需要成人验证后才能登录"),
            (2148916237, "需要成人验证后才能登录"),
            (2148916238, "未成年账号需要加入家庭组并由成年人添加权限"),
        ]);
        let key = xerr.as_i64().unwrap_or(0);
        return Err(AppError::Msg(messages.get(&key).copied().unwrap_or("Xbox XSTS 授权失败").to_string()));
    }
    if xsts.get("Token").and_then(Value::as_str).is_none() {
        return Err(AppError::Msg("XSTS 授权失败".into()));
    }

    // ⑤ Minecraft 登录
    let mc = post_json(
        "https://api.minecraftservices.com/authentication/login_with_xbox",
        json!({"identityToken": format!("XBL3.0 x={uhs};{}", xsts.get("Token").and_then(Value::as_str).unwrap_or(""))}),
    )
    .await?;
    if mc.get("access_token").and_then(Value::as_str).is_none() {
        return Err(AppError::Msg("Minecraft 服务登录失败".into()));
    }

    // ⑥ 角色资料（同时判断是否拥有游戏）
    let profile_res = HTTP
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(mc.get("access_token").and_then(Value::as_str).unwrap_or(""))
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let pstatus = profile_res.status();
    if pstatus == 403 || pstatus == 404 {
        return Err(AppError::Msg("该账号未购买 Minecraft，无法正版登录".into()));
    }
    if !pstatus.is_success() {
        return Err(AppError::Msg(format!("获取角色资料失败 (HTTP {})", pstatus.as_u16())));
    }
    let profile: Value = profile_res.json().await.map_err(|e| AppError::Msg(e.to_string()))?;

    Ok(json!({
        "type": "microsoft",
        "username": profile.get("name"),
        "uuid": profile.get("id"),
        "accessToken": mc.get("access_token"),
        "expiresAt": chrono::Utc::now().timestamp_millis() + mc.get("expires_in").and_then(Value::as_i64).unwrap_or(86400) * 1000,
        "msRefreshToken": ms.get("refresh_token"),
        "xuid": xuid,
    }))
}

async fn refresh_ms_token(refresh_token: &str) -> CmdResult<Value> {
    post_form(
        "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        &[
            ("client_id", CLIENT_ID.into()),
            ("grant_type", "refresh_token".into()),
            ("refresh_token", refresh_token.into()),
            ("scope", SCOPE.into()),
        ],
    )
    .await
}

/// 启动前静默续期：5 分钟内过期才刷新（对齐 JS）
pub async fn refresh(account: Value) -> CmdResult<Value> {
    if !is_microsoft(&account) {
        return Ok(account);
    }
    let expires_at = account.get("expiresAt").and_then(Value::as_i64).unwrap_or(0);
    if expires_at - chrono::Utc::now().timestamp_millis() > 5 * 60 * 1000 {
        return Ok(account);
    }
    let rt = account.get("msRefreshToken").and_then(Value::as_str).ok_or_else(|| AppError::Msg("登录已过期，请重新正版登录".into()))?;
    let ms = refresh_ms_token(rt).await?;
    ms_token_to_minecraft_account(&ms).await
}

// 供序列化引用
#[allow(dead_code)]
#[derive(Serialize)]
struct _Marker;
