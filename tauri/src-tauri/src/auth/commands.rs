//! 账号 IPC 命令层：与 Electron 版 main.js 的 auth:* handle 对齐。
//! 账号存储：config["accounts"] 为数组，config["selectedAccount"] 为当前账号 uuid 字符串。

use crate::error::{AppError, CmdResult};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// 用内置浏览器窗口打开授权页（与 browser.rs 的单例逻辑一致；browser 模块接入后迁过去）。
/// 已存在 "browser" 窗口则聚焦并导航，否则新建。失败仅记录，不阻塞登录流程。
fn open_auth_page(app: &AppHandle, url: &str) -> CmdResult<()> {
    if let Some(win) = app.get_webview_window("browser") {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        let _ = win.set_focus();
        let js = format!("location.href = {}", serde_json::to_string(url)?);
        win.eval(&js).map_err(|e| AppError::Msg(e.to_string()))?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(app, "browser", tauri::WebviewUrl::External(url.parse().map_err(|_| AppError::Msg("地址无效".into()))?))
        .title("CM 浏览器")
        .inner_size(980.0, 660.0)
        .min_inner_size(640.0, 440.0)
        .build()
        .map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(())
}

/// 读取账号列表
fn accounts() -> Vec<Value> {
    crate::config::get("accounts").as_array().cloned().unwrap_or_default()
}

/// 存入账号（同 uuid 已存在则更新并保留旧字段），置为当前账号，返回合并后的账号对象。
/// 与 config.js setAccount 语义一致，但选中键用 selectedAccount（任务约定）。
fn save_account(acc: Value) -> Value {
    let mut cur = acc;
    if let Some(uuid) = cur.get("uuid").and_then(Value::as_str).map(str::to_string) {
        let mut list = accounts();
        if let Some(idx) = list.iter().position(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str())) {
            // 旧的在前：旧字段（皮肤等）保留，新字段覆盖
            let mut merged = list[idx].clone();
            if let (Some(old_m), Some(new_m)) = (merged.as_object_mut(), cur.as_object()) {
                for (k, v) in new_m {
                    old_m.insert(k.clone(), v.clone());
                }
            }
            list[idx] = merged.clone();
            cur = merged;
        } else {
            list.push(cur.clone());
        }
        let mut patch = serde_json::Map::new();
        patch.insert("accounts".into(), json!(list));
        patch.insert("selectedAccount".into(), json!(uuid));
        crate::config::update(patch);
    }
    cur
}

/// channel: auth:offline
#[tauri::command(rename = "auth:offline")]
pub fn auth_offline(username: String) -> CmdResult<Value> {
    let name = username.trim().to_string();
    let acc = json!({
        "type": "offline",
        "username": name,
        "uuid": offline_uuid(&name),
        "accessToken": "0",
        "expiresAt": 0,
    });
    crate::logger::info(&format!("离线登录：{name}"));
    Ok(save_account(acc))
}

/// channel: auth:microsoft
#[tauri::command(rename = "auth:microsoft")]
pub async fn auth_microsoft(app: tauri::AppHandle) -> CmdResult<Value> {
    let device = super::microsoft::get_device_code().await?;
    let _ = app.emit(crate::events::EV_DEVICE_CODE, &device);
    // 拿到设备码后立即用内置浏览器打开授权页（既定行为，不用系统浏览器）
    let verify = device
        .get("verificationUri")
        .or_else(|| device.get("verification_uri"))
        .and_then(Value::as_str)
        .unwrap_or("https://www.microsoft.com/link");
    // 浏览器窗口逻辑属下一阶段（browser.rs 尚未接入 main.rs），失败不阻塞轮询
    let _ = open_auth_page(&app, verify);
    let code = device.get("device_code").and_then(Value::as_str).unwrap_or("").to_string();
    let interval = device.get("interval").and_then(Value::as_i64).unwrap_or(5);
    let ms = super::microsoft::poll_for_token(&code, interval).await?;
    let acc = super::microsoft::ms_token_to_minecraft_account(&ms).await?;
    let name = acc.get("username").and_then(Value::as_str).unwrap_or("").to_string();
    crate::logger::info(&format!("正版登录：{name}"));
    Ok(save_account(acc))
}

/// channel: auth:yggdrasil
#[tauri::command(rename = "auth:yggdrasil")]
pub async fn auth_yggdrasil(data: Value) -> CmdResult<Value> {
    let base_url = data.get("baseUrl").and_then(Value::as_str).unwrap_or("");
    let username = data.get("username").and_then(Value::as_str).unwrap_or("");
    let password = data.get("password").and_then(Value::as_str).unwrap_or("");
    let character_id = data.get("characterId").and_then(Value::as_str);
    let acc = super::yggdrasil::login(base_url, username, password, character_id).await?;
    let name = acc.get("username").and_then(Value::as_str).unwrap_or("").to_string();
    crate::logger::info(&format!("皮肤站登录：{name}"));
    Ok(save_account(acc))
}

/// channel: auth:logout —— 返回当前账号列表供前端刷新（登出=remove 由前端组合调用）
#[tauri::command(rename = "auth:logout")]
pub fn auth_logout() -> Value {
    json!(accounts())
}

/// channel: auth:switch
#[tauri::command(rename = "auth:switch")]
pub async fn auth_switch(uuid: String) -> CmdResult<Value> {
    let list = accounts();
    let acc = list
        .iter()
        .find(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()))
        .cloned()
        .ok_or_else(|| AppError::Msg("账号不存在".into()))?;
    // 切换本身是本地操作；微软账号过期则顺手续期，失败不挡着切
    let mut warn = String::new();
    let fresh = if super::microsoft::is_microsoft(&acc) {
        match super::microsoft::refresh(acc.clone()).await {
            Ok(a) => a,
            Err(e) => {
                warn = e.to_string();
                acc
            }
        }
    } else {
        acc
    };
    let saved = save_account(fresh);
    let name = saved.get("username").and_then(Value::as_str).unwrap_or("").to_string();
    crate::logger::info(&format!(
        "切换账号：{name}{}",
        if warn.is_empty() { String::new() } else { format!("（令牌未续期：{warn}）") }
    ));
    Ok(json!({ "account": saved, "warn": warn }))
}

/// channel: auth:remove
#[tauri::command(rename = "auth:remove")]
pub fn auth_remove(uuid: String) -> CmdResult<Value> {
    let list: Vec<Value> = accounts()
        .into_iter()
        .filter(|a| a.get("uuid").and_then(Value::as_str) != Some(uuid.as_str()))
        .collect();
    let selected = crate::config::get("selectedAccount").as_str().map(str::to_string).unwrap_or_default();
    let mut patch = serde_json::Map::new();
    patch.insert("accounts".into(), json!(list.clone()));
    // 删掉的是当前选中账号 → 落到剩余第一个，空则空串
    if selected == uuid {
        let next = list
            .first()
            .and_then(|a| a.get("uuid"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        patch.insert("selectedAccount".into(), json!(next));
    }
    crate::config::update(patch);
    crate::logger::info(&format!("删除账号：{uuid}"));
    Ok(json!(list))
}

/// 与官方启动器一致的离线 UUID：
/// UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))，即 MD5 版本号置 3。
fn offline_uuid(username: &str) -> String {
    let mut hash = md5(format!("OfflinePlayer:{username}").as_bytes());
    hash[6] = (hash[6] & 0x0f) | 0x30; // 版本 3
    hash[8] = (hash[8] & 0x3f) | 0x80; // IETF 变体
    let h = hex::encode(hash);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// MD5（RFC 1321）最小实现：标准离线 UUID 算法依赖它，crate 列表里没有现成的。
/// 自验：md5("") == d41d8cd98f00b204e9800998ecf8427e
pub(crate) fn md5(data: &[u8]) -> [u8; 16] {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
    ];

    // 填充：追加 0x80，补 0 到长度 ≡ 56 (mod 64)，最后 8 字节小端位长
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    let (mut a0, mut b0, mut c0, mut d0): (u32, u32, u32, u32) = (0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476);
    for chunk in msg.chunks_exact(64) {
        let mut m = [0u32; 16];
        for (i, w) in m.iter_mut().enumerate() {
            *w = u32::from_le_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let tmp = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                a.wrapping_add(f)
                    .wrapping_add(K[i])
                    .wrapping_add(m[g])
                    .rotate_left(S[i]),
            );
            a = tmp;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&a0.to_le_bytes());
    out[4..8].copy_from_slice(&b0.to_le_bytes());
    out[8..12].copy_from_slice(&c0.to_le_bytes());
    out[12..16].copy_from_slice(&d0.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_known_vectors() {
        assert_eq!(hex::encode(md5(b"")), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(hex::encode(md5(b"abc")), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(
            hex::encode(md5(b"The quick brown fox jumps over the lazy dog")),
            "9e107d9d372bb6826bd81d3542a419d6"
        );
    }

    #[test]
    fn offline_uuid_format() {
        let u = offline_uuid("Steve");
        assert_eq!(u.len(), 36);
        assert_eq!(u.chars().filter(|c| *c == '-').count(), 4);
        assert_eq!(u.as_bytes()[14], b'3'); // 版本 3
        assert!(matches!(u.as_bytes()[19], b'8' | b'9' | b'a' | b'b')); // IETF 变体
    }
}
