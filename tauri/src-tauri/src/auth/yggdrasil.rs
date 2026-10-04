//! 皮肤站（Yggdrasil）登录：与 Electron 版 auth/yggdrasil.js 对齐，兼容 Blessing Skin Server。
//! 第 2 阶段使用 refresh（失败不阻塞）；登录命令第 4 阶段接线。

use crate::error::{AppError, CmdResult};
use crate::net::HTTP;
use serde_json::{json, Value};

async fn post_json(url: &str, body: Value) -> CmdResult<Value> {
    let res = HTTP
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let status = res.status();
    let data: Value = res.json().await.unwrap_or(json!({}));
    if !status.is_success() {
        let msg = data
            .get("errorMessage")
            .or_else(|| data.get("error"))
            .and_then(Value::as_str)
            .unwrap_or(&format!("HTTP {}", status.as_u16()))
            .to_string();
        return Err(AppError::Msg(msg));
    }
    Ok(data)
}

/// 密码模式登录：authserver/authenticate
#[allow(dead_code)]
pub async fn login(base_url: &str, username: &str, password: &str, character_id: Option<&str>) -> CmdResult<Value> {
    if base_url.is_empty() {
        return Err(AppError::Msg("皮肤站地址未配置".into()));
    }
    let root = base_url.trim_end_matches('/').to_string();
    let client_token = uuid::Uuid::new_v4().simple().to_string();

    let mut body = json!({
        "username": username,
        "password": password,
        "clientToken": client_token,
        "requestUser": true,
        "agent": {"name": "Minecraft", "version": 1},
    });
    if let Some(cid) = character_id {
        body["selectedProfile"] = json!({"id": cid});
    }

    let res = post_json(&format!("{root}/authserver/authenticate"), body).await?;

    // 多角色处理
    let profile = if let Some(p) = res.get("selectedProfile").filter(|p| p.get("id").and_then(Value::as_str).is_some()) {
        p.clone()
    } else if let Some(available) = res.get("availableProfiles").and_then(Value::as_array).filter(|a| !a.is_empty()) {
        let picked = character_id.and_then(|cid| available.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(cid)));
        picked.cloned().unwrap_or_else(|| available[0].clone())
    } else {
        return Err(AppError::Msg("该账号没有可用角色".into()));
    };

    Ok(json!({
        "type": "yggdrasil",
        "stationUrl": root,
        "clientToken": client_token,
        "accessToken": res.get("accessToken"),
        "username": profile.get("name"),
        "uuid": profile.get("id"),
        "properties": profile.get("properties").cloned().unwrap_or(json!([])),
        "expiresAt": 0,
    }))
}

/// 启动前校验/刷新；失败不阻塞，用旧令牌尝试启动（对齐 JS try/catch）
pub async fn refresh(account: Value) -> Value {
    if account.get("type").and_then(Value::as_str) != Some("yggdrasil") {
        return account;
    }
    let root = account.get("stationUrl").and_then(Value::as_str).unwrap_or("").to_string();
    match post_json(
        &format!("{root}/authserver/refresh"),
        json!({
            "accessToken": account.get("accessToken"),
            "clientToken": account.get("clientToken"),
            "selectedProfile": {"id": account.get("uuid"), "name": account.get("username")},
        }),
    )
    .await
    {
        Ok(res) => {
            let mut out = account;
            out["accessToken"] = res.get("accessToken").cloned().unwrap_or(Value::Null);
            out
        }
        Err(_) => account,
    }
}
