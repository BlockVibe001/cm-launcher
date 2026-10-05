//! 皮肤系统（对齐 Electron 版 src/main/minecraft/skin.js）。
//! 用户皮肤目录：config::user_data_dir()/skins；「最近使用」写 config["skinHistory"]，
//! 绑定皮肤写 config::set_account（更新 account + accounts 双写，与 auth 语义一致）。
//!
//! 本文件由 OrganizeAgent 以 todo!() 骨架交付：把 todo!() 替换为真实实现即可，
//! 不得修改 #[tauri::command(rename = "...")] 通道名与函数签名。

use crate::error::{AppError, CmdResult};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 皮肤目录（自动创建）
pub fn skin_dir() -> PathBuf {
    let dir = crate::config::user_data_dir().join("skins");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 当前毫秒时间戳（对齐 Date.now()）
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 校验 PNG：读签名与尺寸，返回 (w, h)；非法抛 AppError::Msg（对齐 validatePng）
pub fn validate_png(buf: &[u8]) -> CmdResult<(u32, u32)> {
    if buf.len() < 24 || u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) != 0x89504e47 {
        return Err(AppError::Msg("不是有效的 PNG 图片".into()));
    }
    let w = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
    let h = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
    if w % 64 != 0 || (h != w / 2 && h != w) {
        return Err(AppError::Msg(format!(
            "皮肤尺寸异常（{w}×{h}），应为 64×32 / 64×64 或其整数倍"
        )));
    }
    Ok((w, h))
}

/// 仅校验 PNG 签名（不校验尺寸，用于服务器纹理）
fn png_ok(buf: &[u8]) -> bool {
    buf.len() >= 24 && u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) == 0x89504e47
}

/// 图片字节 → data:image/png;base64（对齐 toDataUrl）
pub fn to_data_url(buf: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf)
    )
}

/* ---------- 通用小工具 ---------- */

/// 安全文件名（对齐 safeName）
fn safe_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();
    let cleaned: String = cleaned.chars().take(60).collect();
    if cleaned.is_empty() { "skin".into() } else { cleaned }
}

/// 最小 encodeURIComponent
fn encode_uri(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// GET JSON（带超时）
async fn get_json(url: &str, timeout_ms: u64) -> CmdResult<Value> {
    let fut = crate::net::HTTP.get(url).send();
    let res = match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
        Ok(r) => r.map_err(|e| AppError::Msg(e.to_string()))?,
        Err(_) => return Err(AppError::Msg("请求超时".into())),
    };
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("HTTP {}", res.status().as_u16())));
    }
    let v = res
        .json::<Value>()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(v)
}

/// 当前登录账号：优先 selectedAccount→accounts 数组（Rust auth 语义），
/// 回退 config["account"]（Electron 迁移配置）。
fn current_account() -> Value {
    let uuid = crate::config::get("selectedAccount")
        .as_str()
        .unwrap_or("")
        .to_string();
    if !uuid.is_empty() {
        if let Some(a) = crate::config::get("accounts")
            .as_array()
            .and_then(|arr| arr.iter().find(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str())))
        {
            return a.clone();
        }
    }
    let acc = crate::config::get("account");
    if !acc.is_null() { acc } else { Value::Null }
}

/* ---------- ① 玩家 ID → UUID ---------- */

async fn resolve_uuid(q: &str) -> CmdResult<(String, String)> {
    let q = q.trim();
    if q.is_empty() {
        return Err(AppError::Msg("请输入玩家 ID".into()));
    }
    let clean: String = q.chars().filter(|c| *c != '-').collect();
    if clean.len() == 32 && clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok((clean.to_lowercase(), String::new()));
    }
    // Mojang 主源
    if let Ok(d) = get_json(
        &format!("https://api.mojang.com/users/profiles/minecraft/{}", encode_uri(q)),
        15000,
    )
    .await
    {
        if let Some(id) = d.get("id").and_then(Value::as_str) {
            let name = d.get("name").and_then(Value::as_str).unwrap_or(q).to_string();
            return Ok((id.to_string(), name));
        }
    }
    // playerdb 备用
    if let Ok(d) = get_json(
        &format!("https://playerdb.co/api/player/minecraft/{}", encode_uri(q)),
        15000,
    )
    .await
    {
        if let Some(p) = d.pointer("/data/player") {
            if let Some(id) = p.get("id").and_then(Value::as_str) {
                let id: String = id.chars().filter(|c| *c != '-').collect();
                let name = p.get("username").and_then(Value::as_str).unwrap_or(q).to_string();
                return Ok((id.to_lowercase(), name));
            }
        }
    }
    Err(AppError::Msg(format!(
        "找不到玩家「{q}」（可能拼写有误或网络不可达）"
    )))
}

/* ---------- ② 正版纹理 ---------- */

/// 解码 textures 属性（base64 → json），返回 (skinUrl, capeUrl, model)
fn decode_textures(prop_value: &str) -> (String, String, String) {
    use base64::Engine;
    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(prop_value) {
        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
            let t = v.get("textures");
            let skin = t
                .and_then(|x| x.get("SKIN"))
                .and_then(|x| x.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let cape = t
                .and_then(|x| x.get("CAPE"))
                .and_then(|x| x.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let slim = t
                .and_then(|x| x.get("SKIN"))
                .and_then(|x| x.get("metadata"))
                .and_then(|x| x.get("model"))
                .and_then(Value::as_str)
                == Some("slim");
            return (skin, cape, if slim { "slim" } else { "classic" }.to_string());
        }
    }
    (String::new(), String::new(), "classic".to_string())
}

/// 按玩家 ID 或 UUID 查询正版皮肤（对齐 fetchOfficialSkin）
async fn fetch_official_skin(name_or_uuid: &str, timeout_ms: u64) -> CmdResult<Value> {
    let trimmed = name_or_uuid.trim();
    let no_dash: String = trimmed.chars().filter(|c| *c != '-').collect();
    let (id, mut name) = if no_dash.len() == 32 && no_dash.chars().all(|c| c.is_ascii_hexdigit()) {
        (no_dash.to_lowercase(), String::new())
    } else {
        resolve_uuid(trimmed).await?
    };

    let mut skin_url = String::new();
    let mut cape_url = String::new();
    let mut model = "classic".to_string();
    if let Ok(prof) = get_json(
        &format!("https://sessionserver.mojang.com/session/minecraft/profile/{id}"),
        timeout_ms,
    )
    .await
    {
        if name.is_empty() {
            if let Some(n) = prof.get("name").and_then(Value::as_str) {
                name = n.to_string();
            }
        }
        if let Some(props) = prof.get("properties").and_then(Value::as_array) {
            if let Some(tex) = props
                .iter()
                .find(|p| p.get("name").and_then(Value::as_str) == Some("textures"))
            {
                if let Some(val) = tex.get("value").and_then(Value::as_str) {
                    let (s, c, m) = decode_textures(val);
                    skin_url = s;
                    cape_url = c;
                    model = m;
                }
            }
        }
    }
    if skin_url.is_empty() {
        skin_url = format!("https://crafatar.com/skins/{id}");
    }
    Ok(json!({"uuid": id, "name": name, "skinUrl": skin_url, "capeUrl": cape_url, "model": model}))
}

/// channel: skin:official —— 按玩家 ID 或 UUID 抓取正版皮肤
/// 入参 nameOrUuid: Option<String>
/// 返回 { uuid, name, skinUrl, capeUrl, model }（对齐 fetchOfficialSkin）
#[tauri::command(rename = "skin:official")]
pub async fn skin_official(name_or_uuid: Option<String>) -> CmdResult<Value> {
    fetch_official_skin(&name_or_uuid.unwrap_or_default(), 15000).await
}

/* ---------- ③ 下载 / 本地皮肤库 ---------- */

/// channel: skin:download —— 下载皮肤并存入本地皮肤库
/// 入参 url: String、label: Option<String>
/// 返回 { path, name, size, dim: {w,h}, dataUrl }（对齐 downloadSkin）
#[tauri::command(rename = "skin:download")]
pub async fn skin_download(url: String, label: Option<String>) -> CmdResult<Value> {
    let fut = crate::net::HTTP.get(&url).send();
    let res = match tokio::time::timeout(Duration::from_millis(30000), fut).await {
        Ok(r) => r.map_err(|e| AppError::Msg(e.to_string()))?,
        Err(_) => return Err(AppError::Msg("下载皮肤超时".into())),
    };
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("下载皮肤失败（HTTP {}）", res.status().as_u16())));
    }
    let buf = res
        .bytes()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let (w, h) = validate_png(&buf)?;
    let safe = safe_name(label.as_deref().unwrap_or(""));
    let file = skin_dir().join(format!("{safe}-{}.png", now_ms()));
    tokio::fs::write(&file, &buf).await?;
    crate::logger::info(&format!("皮肤已保存：{}", file.to_string_lossy()));
    let size = buf.len();
    Ok(json!({
        "path": file.to_string_lossy(),
        "name": file.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
        "size": size,
        "dim": {"w": w, "h": h},
        "dataUrl": to_data_url(&buf),
    }))
}

/// channel: skin:readLocal —— 读取本地皮肤文件（校验 + dataUrl）
/// 入参 p: String
/// 返回 { path, name, size, dim, dataUrl }
#[tauri::command(rename = "skin:readLocal")]
pub fn skin_read_local(p: String) -> CmdResult<Value> {
    if std::fs::metadata(&p).is_err() {
        return Err(AppError::Msg("文件不存在".into()));
    }
    let buf = std::fs::read(&p)?;
    let (w, h) = validate_png(&buf)?;
    let name = Path::new(&p)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    Ok(json!({
        "path": p,
        "name": name,
        "size": buf.len(),
        "dim": {"w": w, "h": h},
        "dataUrl": to_data_url(&buf),
    }))
}

/// channel: skin:localList —— 本地皮肤库列表（按 mtime 倒序，≤512KB 带 dataUrl）
/// 返回 [{ name, path, size, mtime, dataUrl }]
#[tauri::command(rename = "skin:localList")]
pub fn skin_local_list() -> Value {
    let dir = skin_dir();
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let path = e.path();
            let name = match e.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue,
            };
            if !name.to_lowercase().ends_with(".png") {
                continue;
            }
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !meta.is_file() {
                continue;
            }
            let mut data_url = String::new();
            if meta.len() <= 512 * 1024 {
                if let Ok(buf) = std::fs::read(&path) {
                    data_url = to_data_url(&buf);
                }
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            out.push(json!({
                "name": name,
                "path": path.to_string_lossy(),
                "size": meta.len(),
                "mtime": mtime,
                "dataUrl": data_url,
            }));
        }
    }
    out.sort_by(|a, b| {
        b.get("mtime")
            .and_then(Value::as_i64)
            .cmp(&a.get("mtime").and_then(Value::as_i64))
    });
    Value::Array(out)
}

/// channel: skin:localDelete —— 删除本地皮肤（防路径穿越）
/// 返回 true
#[tauri::command(rename = "skin:localDelete")]
pub fn skin_local_delete(name: String) -> CmdResult<bool> {
    let dir = skin_dir();
    let dir_c = std::fs::canonicalize(&dir).map_err(|_| AppError::Msg("非法路径".into()))?;
    let full_c = std::fs::canonicalize(dir.join(&name)).map_err(|_| AppError::Msg("文件不存在".into()))?;
    if !full_c.starts_with(&dir_c) {
        return Err(AppError::Msg("非法路径".into()));
    }
    std::fs::remove_file(&full_c)?;
    Ok(true)
}

/* ---------- ④ 上传皮肤 ---------- */

/// channel: skin:uploadOfficial —— 微软正版上传皮肤（multipart POST）
/// 入参 filePath: String、variant: String（"slim"/"classic"）
/// 返回 { ok, variant, profile }
#[tauri::command(rename = "skin:uploadOfficial")]
pub async fn skin_upload_official(file_path: String, variant: String) -> CmdResult<Value> {
    let account = current_account();
    if account.get("type").and_then(Value::as_str) != Some("microsoft") {
        return Err(AppError::Msg(
            "只有已登录的微软正版账号才能上传到官方服务器".into(),
        ));
    }
    let buf = std::fs::read(&file_path)?;
    validate_png(&buf)?;
    let v = if variant == "slim" { "slim" } else { "classic" };
    let token = account.get("accessToken").and_then(Value::as_str).unwrap_or("");
    let part = reqwest::multipart::Part::bytes(buf)
        .file_name("skin.png")
        .mime_str("image/png")
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let form = reqwest::multipart::Form::new().text("variant", v).part("file", part);
    let res = crate::net::HTTP
        .post("https://api.minecraftservices.com/minecraft/profile/skins")
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let status = res.status();
    let txt = res
        .text()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    if !status.is_success() {
        let d: Value = serde_json::from_str(&txt).unwrap_or(Value::Null);
        let default_msg = format!("上传失败（HTTP {status}）");
        let msg = d
            .get("errorMessage")
            .and_then(Value::as_str)
            .or_else(|| d.get("message").and_then(Value::as_str))
            .unwrap_or(&default_msg);
        return Err(AppError::Msg(msg.to_string()));
    }
    let data: Value = serde_json::from_str(&txt).unwrap_or(Value::Null);
    Ok(json!({"ok": true, "variant": v, "profile": data}))
}

/// 去掉皮肤站地址的 /api/yggdrasil 后缀与尾部斜杠
fn strip_station_suffix(raw: &str) -> String {
    let s = raw.trim();
    let lower = s.to_lowercase();
    let s = if let Some(r) = lower.strip_suffix("/api/yggdrasil/") {
        let _ = r;
        &s[..s.len() - "/api/yggdrasil/".len()]
    } else if lower.ends_with("/api/yggdrasil") {
        &s[..s.len() - "/api/yggdrasil".len()]
    } else {
        s
    };
    s.trim_end_matches('/').to_string()
}

/// channel: skin:uploadYggdrasil —— 皮肤站上传（multipart PUT）
/// 入参 filePath: String、variant: String
/// 返回 { ok, variant, station }
#[tauri::command(rename = "skin:uploadYggdrasil")]
pub async fn skin_upload_yggdrasil(file_path: String, variant: String) -> CmdResult<Value> {
    let account = current_account();
    if account.get("type").and_then(Value::as_str) != Some("yggdrasil") {
        return Err(AppError::Msg("请先用皮肤站账号登录".into()));
    }
    let raw = account.get("stationUrl").and_then(Value::as_str).unwrap_or("");
    let base = strip_station_suffix(raw);
    if base.is_empty() {
        return Err(AppError::Msg("皮肤站地址缺失，请在设置中检查".into()));
    }
    let buf = std::fs::read(&file_path)?;
    validate_png(&buf)?;
    let model = if variant == "slim" { "alex" } else { "steve" };
    let token = account.get("accessToken").and_then(Value::as_str).unwrap_or("");
    let uuid = account.get("uuid").and_then(Value::as_str).unwrap_or("");
    let part = reqwest::multipart::Part::bytes(buf)
        .file_name("skin.png")
        .mime_str("image/png")
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let form = reqwest::multipart::Form::new().text("model", model).part("file", part);
    let url = format!("{base}/api/v1/user/profile/{uuid}/skin");
    let res = crate::net::HTTP
        .put(&url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let status = res.status();
    let txt = res
        .text()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    if !status.is_success() {
        let mut msg = format!("上传失败（HTTP {status}）");
        if let Ok(d) = serde_json::from_str::<Value>(&txt) {
            if let Some(m) = d.get("message").and_then(Value::as_str) {
                msg = m.to_string();
            } else if let Some(m) = d.get("error").and_then(Value::as_str) {
                msg = m.to_string();
            }
        }
        return Err(AppError::Msg(msg));
    }
    Ok(json!({"ok": true, "variant": if variant == "slim" { "slim" } else { "classic" }, "station": base}))
}

/* ---------- ⑤ 皮肤库浏览 ---------- */

/// channel: skin:library —— 皮肤库浏览（抓 skinlib HTML 抽 /raw/{hash}）
/// 入参 base/query/page 均为 Option<String>（可缺省）
/// 返回 { root, url, page, items: [{ hash, url }] }
#[tauri::command(rename = "skin:library")]
pub async fn skin_library(base: Option<String>, query: Option<String>, page: Option<String>) -> CmdResult<Value> {
    let raw = base.unwrap_or_else(|| "https://littleskin.cn".to_string());
    let root = strip_station_suffix(&raw);
    let p = page
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(1)
        .max(1);
    let q = query.unwrap_or_default();
    let url = format!("{root}/skinlib?filter={}&sort=time&page={p}", encode_uri(&q));
    let fut = crate::net::HTTP.get(&url).header("Accept", "text/html").send();
    let res = match tokio::time::timeout(Duration::from_millis(20000), fut).await {
        Ok(r) => r.map_err(|e| AppError::Msg(e.to_string()))?,
        Err(_) => return Err(AppError::Msg("皮肤库请求超时".into())),
    };
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("皮肤库打开失败（HTTP {}）", res.status().as_u16())));
    }
    let html = res
        .text()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let re = regex::Regex::new(r"(?i)/raw/[0-9a-f]{64}").unwrap();
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::new();
    for cap in re.find_iter(&html) {
        let s = cap.as_str();
        let hash = &s[s.len() - 64..];
        if seen.insert(hash.to_string()) {
            items.push(json!({"hash": hash, "url": format!("{root}/raw/{hash}")}));
        }
    }
    Ok(json!({"root": root, "url": url, "page": p, "items": items}))
}

/* ---------- ⑥ 读取「我的皮肤」 ---------- */

/// 把纹理地址抓成 dataURL（不落盘）
async fn fetch_texture(url: &str, timeout_ms: u64) -> CmdResult<String> {
    if url.is_empty() {
        return Err(AppError::Msg("缺少纹理地址".into()));
    }
    let fut = crate::net::HTTP.get(url).send();
    let res = match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
        Ok(r) => r.map_err(|e| AppError::Msg(e.to_string()))?,
        Err(_) => return Err(AppError::Msg("纹理下载超时".into())),
    };
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("纹理下载失败（HTTP {}）", res.status().as_u16())));
    }
    let buf = res
        .bytes()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    if !png_ok(&buf) {
        return Err(AppError::Msg("纹理不是 PNG".into()));
    }
    Ok(to_data_url(&buf))
}

/// channel: skin:current —— 当前登录账号的实时皮肤纹理（不落盘），拿不到返回 null
/// 返回 { dataUrl, model, name, source } 或 null
#[tauri::command(rename = "skin:current")]
pub async fn skin_current() -> CmdResult<Value> {
    let account = current_account();
    if account.is_null() {
        return Ok(Value::Null);
    }
    let uuid = account.get("uuid").and_then(Value::as_str).unwrap_or("").to_string();
    if uuid.is_empty() {
        return Ok(Value::Null);
    }
    let fallback_name = account.get("username").and_then(Value::as_str).unwrap_or("").to_string();
    let acc_type = account.get("type").and_then(Value::as_str).unwrap_or("").to_string();

    // 离线账号：显示自己绑定过的本地皮肤
    if acc_type == "offline" {
        if let Some(sp) = account.get("skinPath").and_then(Value::as_str) {
            if !sp.is_empty() && std::fs::metadata(sp).is_ok() {
                if let Ok(buf) = std::fs::read(sp) {
                    if validate_png(&buf).is_ok() {
                        let model = account
                            .get("skinModel")
                            .and_then(Value::as_str)
                            .unwrap_or("classic")
                            .to_string();
                        return Ok(json!({
                            "dataUrl": to_data_url(&buf),
                            "model": model,
                            "name": fallback_name,
                            "source": "local",
                        }));
                    }
                }
            }
        }
    }

    let result = async {
        if acc_type == "microsoft" {
            let info = fetch_official_skin(&uuid, 6000).await?;
            let skin_url = info.get("skinUrl").and_then(Value::as_str).unwrap_or("").to_string();
            if skin_url.is_empty() {
                return Err::<Value, AppError>(AppError::Msg("无皮肤".into()));
            }
            let du = fetch_texture(&skin_url, 8000).await?;
            let model = info.get("model").and_then(Value::as_str).unwrap_or("classic").to_string();
            let name = info
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .unwrap_or(&fallback_name)
                .to_string();
            Ok(json!({"dataUrl": du, "model": model, "name": name, "source": "mojang"}))
        } else if acc_type == "yggdrasil" {
            let root = account
                .get("stationUrl")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim_end_matches('/')
                .to_string();
            if root.is_empty() {
                return Err(AppError::Msg("皮肤站地址缺失".into()));
            }
            let id: String = uuid.chars().filter(|c| *c != '-').collect::<String>().to_lowercase();
            let prof = get_json(&format!("{root}/sessionserver/session/minecraft/profile/{id}"), 6000).await?;
            if let Some(props) = prof.get("properties").and_then(Value::as_array) {
                if let Some(tex) = props
                    .iter()
                    .find(|p| p.get("name").and_then(Value::as_str) == Some("textures"))
                {
                    if let Some(val) = tex.get("value").and_then(Value::as_str) {
                        let (s, _, m) = decode_textures(val);
                        if !s.is_empty() {
                            let du = fetch_texture(&s, 8000).await?;
                            let name = prof
                                .get("name")
                                .and_then(Value::as_str)
                                .filter(|n| !n.is_empty())
                                .unwrap_or(&fallback_name)
                                .to_string();
                            return Ok(json!({"dataUrl": du, "model": m, "name": name, "source": "yggdrasil"}));
                        }
                    }
                }
            }
            Err(AppError::Msg("无皮肤".into()))
        } else {
            Err(AppError::Msg("不支持的账号类型".into()))
        }
    }
    .await;

    match result {
        Ok(v) => Ok(v),
        Err(e) => {
            crate::logger::warn(&format!("读取当前皮肤失败：{e}"));
            Ok(Value::Null)
        }
    }
}

/* ---------- ⑦ 最近使用 ---------- */

/// channel: skin:use —— 使用一张皮肤：写「最近使用」（12 条去重置顶）并绑定当前账号
/// 入参 filePath: String
/// 返回 { path, name, dataUrl }
#[tauri::command(rename = "skin:use")]
pub fn skin_use(file_path: String) -> CmdResult<Value> {
    let canonical = std::fs::canonicalize(&file_path).unwrap_or_else(|_| PathBuf::from(&file_path));
    if std::fs::metadata(&canonical).is_err() {
        return Err(AppError::Msg("皮肤文件不存在".into()));
    }
    let buf = std::fs::read(&canonical)?;
    validate_png(&buf)?;
    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("skin")
        .to_string();

    // 皮肤入库：把当前图复制一份到皮肤库（userData/skins/），历史引用库内副本。
    // 这样原始文件（如临时预览图）被删/被清理后，「最近使用」依然能显示。
    let skins_dir = skin_dir();
    let stored = if canonical.starts_with(&skins_dir) {
        canonical.clone()
    } else {
        let dst = skins_dir.join(&name);
        let _ = std::fs::copy(&canonical, &dst);
        dst
    };
    let stored_full = stored.to_string_lossy().to_string();

    // 写「最近使用」：去重去重置顶，保留 12 条
    let hist = crate::config::get("skinHistory");
    let mut new_hist: Vec<Value> = hist
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|h| h.get("path").and_then(Value::as_str) != Some(stored_full.as_str()))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    new_hist.insert(0, json!({"path": stored_full, "name": name, "t": now_ms()}));
    let trimmed: Vec<Value> = new_hist.into_iter().take(12).collect();
    crate::config::set("skinHistory", json!(trimmed));

    // 绑定到当前账号（双写 account + accounts，保留旧字段）
    let account = current_account();
    if !account.is_null() {
        let mut merged = account;
        if let Some(m) = merged.as_object_mut() {
            m.insert("skinPath".into(), json!(stored_full));
        }
        crate::config::set_account(merged);
    }
    crate::logger::info(&format!("使用皮肤：{stored_full}"));
    Ok(json!({"path": stored_full, "name": name, "dataUrl": to_data_url(&buf)}))
}

/// channel: skin:history —— 最近使用列表（剔除已删文件）
/// 返回 [{ path, name, t, dataUrl }]
#[tauri::command(rename = "skin:history")]
pub fn skin_history() -> Value {
    let hist = crate::config::get("skinHistory");
    let mut out = Vec::new();
    if let Some(arr) = hist.as_array() {
        for h in arr {
            let p = match h.get("path").and_then(Value::as_str) {
                Some(p) => p.to_string(),
                None => continue,
            };
            if std::fs::metadata(&p).is_err() {
                continue;
            }
            let mut data_url = String::new();
            if let Ok(meta) = std::fs::metadata(&p) {
                if meta.len() <= 512 * 1024 {
                    if let Ok(buf) = std::fs::read(&p) {
                        data_url = to_data_url(&buf);
                    }
                }
            }
            let name = h
                .get("name")
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| {
                    Path::new(&p)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("skin")
                        .to_string()
                });
            out.push(json!({
                "path": p,
                "name": name,
                "t": h.get("t").cloned().unwrap_or(json!(0)),
                "dataUrl": data_url,
            }));
        }
    }
    Value::Array(out)
}
