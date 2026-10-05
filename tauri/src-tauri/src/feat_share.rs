//! feat_share.rs — 实例/整合包分享码
//! 命令契约已由集成层固定并接入 main.rs，**禁止改名/改通道**；函数体可自由实现。
//!
//! 功能：把实例配置（mod 清单 + 版本 + 加载器 + 关键配置）序列化为一段可分享文本，
//! 支持「粘贴码导入 → 按清单复现」。零元方案：分享文本即载体，不依赖自建服务器。
//! 分享码 = "CM-SHARE-1." + base64url(JSON)，JSON schema = "cm-share-1"。

use crate::config;
use crate::error::{AppError, CmdResult};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const PREFIX: &str = "CM-SHARE-1.";
const SCHEMA: &str = "cm-share-1";

fn mc_version_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"1\.\d+(?:\.\d+)?").expect("mc version regex"))
}

/// 从 versionId 里抠出 MC 版本号（fabric-loader-0.15.0-1.20.1 → 1.20.1）。
/// 抠不出来就原样返回（兜底展示用）。
fn extract_mc_version(version_id: &str) -> String {
    mc_version_re()
        .find(version_id)
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| version_id.to_string())
}

/// 分享码 → 结构化 JSON（encode/decode/import 共用）。
/// 校验前缀与 schema；失败返回带中文说明的错误。
fn parse_share_code(code: &str) -> CmdResult<Value> {
    use base64::Engine;
    let rest = code
        .trim()
        .strip_prefix(PREFIX)
        .ok_or_else(|| AppError::Msg("不是 CM 分享码（缺少 CM-SHARE-1. 前缀）".into()))?;
    // base64url → 标准 base64（- _ → + /），再用 NO_PAD 解码
    let b64 = rest.replace('-', "+").replace('_', "/");
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(b64.as_bytes())
        .map_err(|e| AppError::Msg(format!("分享码内容无法解码：{e}")))?;
    let v: Value = serde_json::from_slice(&bytes)?;
    if v.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err(AppError::Msg("分享码格式不匹配（schema 不是 cm-share-1）".into()));
    }
    Ok(v)
}

/// encode 的 async 主体（网络反查 mod 用）；sync 命令体里 block_on 调用。
async fn encode_impl(instance_id: &str) -> CmdResult<Value> {
    let inst = crate::mc::instance::get_instance(instance_id)
        .ok_or_else(|| AppError::Msg("实例不存在".into()))?;
    let name = inst.get("name").and_then(Value::as_str).unwrap_or("未命名实例").to_string();
    let version_id = inst.get("versionId").and_then(Value::as_str).unwrap_or("").to_string();
    let mod_loader = inst.get("modLoader").and_then(Value::as_str).unwrap_or("vanilla").to_string();
    let loader_version = inst.get("loaderVersion").and_then(Value::as_str).unwrap_or("").to_string();
    let memory = inst.get("memory").cloned();
    let jvm_args = inst.get("jvmArgs").and_then(Value::as_str).unwrap_or("").to_string();
    let raw_gd = inst.get("gameDir").and_then(Value::as_str).unwrap_or("").to_string();
    // gameDir 空串 = 跟随全局 gameDir（与 packexport.rs 一致）
    let game_dir = if raw_gd.is_empty() {
        config::get("gameDir").as_str().unwrap_or("").to_string()
    } else {
        raw_gd
    };

    // 列 mods → 逐个反查 Modrinth projectId/versionId。
    // 反查失败（无网络 / 未收录 / 识别不了）一律跳过该 mod，分享码照常生成。
    let listed = crate::mc::mods::list(&game_dir);
    let arr = listed.as_array().cloned().unwrap_or_default();
    let mut mods_out: Vec<Value> = Vec::new();
    for item in arr {
        let fname = item.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        if fname.is_empty() || fname.ends_with(".disabled") {
            continue; // 禁用中的 mod 不进分享清单
        }
        match crate::modupdate::mods_resolve(game_dir.clone(), fname.clone()).await {
            Ok(Value::Null) => continue, // Modrinth 未收录
            Ok(res) => {
                let pid = res.get("projectId").and_then(Value::as_str).unwrap_or("").to_string();
                let vid = res.get("currentVersionId").and_then(Value::as_str).unwrap_or("").to_string();
                let pname = res.get("projectName").and_then(Value::as_str).unwrap_or("").to_string();
                if pid.is_empty() || vid.is_empty() {
                    continue;
                }
                mods_out.push(json!({
                    "fileName": fname,
                    "projectId": pid,
                    "versionId": vid,
                    "name": pname,
                }));
            }
            Err(_) => continue, // 网络错误：跳过，不阻断导出
        }
    }

    let mut payload = serde_json::Map::new();
    payload.insert("schema".into(), json!(SCHEMA));
    payload.insert("name".into(), json!(name));
    payload.insert("versionId".into(), json!(version_id));
    payload.insert("modLoader".into(), json!(mod_loader));
    payload.insert("loaderVersion".into(), json!(loader_version));
    if let Some(mem) = &memory {
        if !mem.is_null() {
            payload.insert("memory".into(), mem.clone());
        }
    }
    if !jvm_args.is_empty() {
        payload.insert("jvmArgs".into(), json!(jvm_args));
    }
    payload.insert("mods".into(), Value::Array(mods_out.clone()));

    let bytes = serde_json::to_vec(&Value::Object(payload))?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(&bytes);
    let code = format!("{PREFIX}{}", b64.replace('+', "-").replace('/', "_"));

    Ok(json!({
        "code": code,
        "name": name,
        "mcVersion": extract_mc_version(&version_id),
        "modLoader": mod_loader,
        "modCount": mods_out.len(),
    }))
}

/// channel: share:encode
/// 返回 { code: String, name, mcVersion, modLoader, modCount }
#[tauri::command(rename = "share:encode")]
pub fn share_encode(instance_id: String) -> CmdResult<Value> {
    // sync 命令体里跑 async 反查（网络请求在运行时其它 worker 上推进，不死锁）
    tauri::async_runtime::block_on(encode_impl(&instance_id))
}

/// channel: share:decode
/// 解析分享码，返回可预览清单（不落盘）：{ ok, error?, name, mcVersion, modLoader, mods: [...] }
#[tauri::command(rename = "share:decode")]
pub fn share_decode(code: String) -> CmdResult<Value> {
    match parse_share_code(&code) {
        Ok(v) => {
            let version_id = v.get("versionId").and_then(Value::as_str).unwrap_or("");
            Ok(json!({
                "ok": true,
                "name": v.get("name").cloned().unwrap_or(json!("")),
                "mcVersion": extract_mc_version(version_id),
                "modLoader": v.get("modLoader").cloned().unwrap_or(json!("vanilla")),
                "loaderVersion": v.get("loaderVersion").cloned().unwrap_or(json!("")),
                "mods": v.get("mods").cloned().unwrap_or(json!([])),
                "memory": v.get("memory").cloned().unwrap_or(Value::Null),
                "jvmArgs": v.get("jvmArgs").cloned().unwrap_or(Value::Null),
            }))
        }
        Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
    }
}

/// channel: share:import
/// 按清单复现实例（建实例 + 安装 mod 版本），返回新实例信息：
/// { ok, error?, instanceId, name, gameDir, installedMods, failedMods }
#[tauri::command(rename = "share:import")]
pub async fn share_import(code: String) -> CmdResult<Value> {
    let v = match parse_share_code(&code) {
        Ok(v) => v,
        Err(e) => return Ok(json!({ "ok": false, "error": e.to_string() })),
    };
    let name = v.get("name").and_then(Value::as_str).unwrap_or("分享导入").to_string();
    let version_id = v.get("versionId").and_then(Value::as_str).unwrap_or("").to_string();
    let mod_loader = v.get("modLoader").and_then(Value::as_str).unwrap_or("vanilla").to_string();
    let loader_version = v.get("loaderVersion").and_then(Value::as_str).unwrap_or("").to_string();
    let memory = v.get("memory").cloned();
    let jvm_args = v.get("jvmArgs").and_then(Value::as_str).unwrap_or("").to_string();

    // 新实例 id：share-<毫秒时间戳>
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let id = format!("share-{ts}");

    // gameDir：gameRoot/instances/<清洗名>，重名加 -2 -3（对齐 mrpack.rs）
    let game_root = config::get("gameDir").as_str().unwrap_or("").to_string();
    let inst_root = Path::new(&game_root).join("instances");
    let safe = crate::mrpack::sanitize_name(&name);
    let mut game_dir = inst_root.join(&safe);
    let mut n = 1;
    while game_dir.exists() {
        n += 1;
        game_dir = inst_root.join(format!("{safe}-{n}"));
    }
    tokio::fs::create_dir_all(&game_dir).await?;
    let game_dir_str = game_dir.to_string_lossy().to_string();

    // 注册实例（save_instance 同 id 合并；新 id 走默认字段 + 传入字段）
    let mut data = serde_json::Map::new();
    data.insert("name".into(), json!(name));
    data.insert("versionId".into(), json!(version_id));
    data.insert("modLoader".into(), json!(mod_loader));
    data.insert("loaderVersion".into(), json!(loader_version));
    data.insert("gameDir".into(), json!(game_dir_str));
    data.insert("icon".into(), json!("🔗"));
    if let Some(mem) = &memory {
        if !mem.is_null() {
            data.insert("memory".into(), mem.clone());
        }
    }
    if !jvm_args.is_empty() {
        data.insert("jvmArgs".into(), json!(jvm_args));
    }
    crate::mc::instance::save_instance(&id, Value::Object(data));

    // 逐个 mod 按 versionId 下载（失败收集进 failedMods，不中断整体）
    let mods = v.get("mods").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut installed: i64 = 0;
    let mut failed: Vec<Value> = Vec::new();
    for m in mods {
        let pid = m.get("projectId").and_then(Value::as_str).unwrap_or("").to_string();
        let vid = m.get("versionId").and_then(Value::as_str).unwrap_or("").to_string();
        let mname = m.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        if pid.is_empty() || vid.is_empty() {
            continue;
        }
        match crate::modupdate::mods_install_version(pid, vid, game_dir_str.clone(), None).await {
            Ok(_) => installed += 1,
            Err(e) => failed.push(json!({ "name": mname, "error": e.to_string() })),
        }
    }

    Ok(json!({
        "ok": true,
        "instanceId": id,
        "name": name,
        "gameDir": game_dir_str,
        "installedMods": installed,
        "failedMods": failed,
    }))
}
