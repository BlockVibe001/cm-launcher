//! feat_skin.rs — HD 皮肤 + 披风本地管理（子代理填充实现）
//! 命令契约已由集成层固定并接入 main.rs，**禁止改名/改通道**；函数体可自由实现。
//!
//! 功能要求：本地导入 HD 皮肤（png）+ 披风文件入库（建议放 config::user_data_dir()/skins_hd 下
//! 或复用 skin.rs 的皮肤目录），支持列库 / 删除 / 应用（当前皮肤）/ 披风应用。
//! 参考：skin.rs（skin_local_list / skin_use 的路径与语义）。

use crate::error::{AppError, CmdResult};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

/// HD 纹理根目录：user_data_dir()/skins_hd（自动创建）
fn hd_root() -> PathBuf {
    let dir = crate::config::user_data_dir().join("skins_hd");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// kind 子目录：skins_hd/skin | skins_hd/cape（自动创建）
fn hd_dir(kind: &str) -> CmdResult<PathBuf> {
    let k = match kind {
        "skin" => "skin",
        "cape" => "cape",
        _ => return Err(AppError::Msg("kind 必须是 skin 或 cape".into())),
    };
    let dir = hd_root().join(k);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 当前毫秒时间戳（对齐 Date.now()）
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 清洗源文件名主干：只保留 [A-Za-z0-9._-]，其余一律丢弃。
/// 返回 (清洗后主干, 是否「原主干全部合规」)。原主干含中文/其它字符时，调用方改用时间戳命名。
fn clean_stem(stem: &str) -> (String, bool) {
    let mut out = String::new();
    let mut all_ok = true;
    for c in stem.chars() {
        match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-' => out.push(c),
            _ => all_ok = false,
        }
    }
    // 去掉前导点（避免隐藏文件）并截断长度
    let trimmed: String = out.trim_start_matches('.').chars().take(60).collect();
    let ok = all_ok && !trimmed.is_empty();
    (trimmed, ok)
}

/// PNG 8 字节签名校验（不校验尺寸，HD 纹理尺寸多变）
fn png_magic_ok(buf: &[u8]) -> bool {
    buf.len() >= 8 && buf[0..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
}

/// 比较两个路径字符串是否指向同一文件（canonicalize 后比对）
fn path_eq(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let ca = fs::canonicalize(a).unwrap_or_else(|_| PathBuf::from(a));
    let cb = fs::canonicalize(b).unwrap_or_else(|_| PathBuf::from(b));
    ca == cb
}

/// 当前「已应用」皮肤路径：优先 account.skinPath，其次 skinHistory[0].path
fn current_applied_skin() -> String {
    let acc = crate::config::get("account");
    if let Some(p) = acc.get("skinPath").and_then(Value::as_str) {
        if !p.is_empty() {
            return p.to_string();
        }
    }
    let hist = crate::config::get("skinHistory");
    hist.as_array()
        .and_then(|a| a.first())
        .and_then(|h| h.get("path"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// 当前「已应用」披风路径（记录在 config["hdCapePath"]）
fn current_applied_cape() -> String {
    crate::config::get("hdCapePath")
        .as_str()
        .unwrap_or("")
        .to_string()
}

/// channel: hd:import
/// kind: "skin" | "cape"。返回 { ok, error?, name, filePath }
#[tauri::command(rename = "hd:import")]
pub fn hd_skin_import(src_path: String, kind: String) -> CmdResult<Value> {
    let dir = hd_dir(&kind)?;
    let src = PathBuf::from(&src_path);
    if !src.is_file() {
        return Err(AppError::Msg("源文件不存在".into()));
    }
    let ext_ok = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("png"))
        .unwrap_or(false);
    if !ext_ok {
        return Err(AppError::Msg("只支持 .png 图片".into()));
    }
    // PNG 签名校验（拒绝非图片文件）
    let buf = fs::read(&src)?;
    if !png_magic_ok(&buf) {
        return Err(AppError::Msg("不是有效的 PNG 图片".into()));
    }

    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("skin");
    let (clean, all_ok) = clean_stem(stem);
    let kind_tag = if kind == "cape" { "cape" } else { "skin" };

    // 目标文件名：原主干全合规 → 清洗后名；否则 <kind>-<时间戳>.png；冲突再加时间戳
    let mut candidate = if all_ok {
        format!("{clean}.png")
    } else {
        format!("{kind_tag}-{}.png", now_ms())
    };
    let mut target = dir.join(&candidate);
    if target.exists() {
        let base = if all_ok { clean.clone() } else { format!("{kind_tag}-{}", now_ms()) };
        candidate = format!("{base}-{}.png", now_ms());
        target = dir.join(&candidate);
    }

    fs::copy(&src, &target)?;
    let fp = target.to_string_lossy().to_string();
    crate::logger::info(&format!("HD 纹理入库[{kind}]：{fp}"));
    Ok(json!({ "ok": true, "name": candidate, "filePath": fp }))
}

/// channel: hd:list
/// 返回 { items: [ { name, kind, filePath, size, mtime, applied } ] }
#[tauri::command(rename = "hd:list")]
pub fn hd_skin_list() -> CmdResult<Value> {
    let cur_skin = current_applied_skin();
    let cur_cape = current_applied_cape();
    let mut items: Vec<Value> = Vec::new();

    for kind in ["skin", "cape"] {
        let dir = hd_dir(kind)?;
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.flatten() {
                let path = e.path();
                let name = match e.file_name().into_string() {
                    Ok(n) => n,
                    Err(_) => continue,
                };
                if !name.to_lowercase().ends_with(".png") {
                    continue;
                }
                let meta = match fs::metadata(&path) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if !meta.is_file() {
                    continue;
                }
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let fp = path.to_string_lossy().to_string();
                let applied = if kind == "skin" {
                    path_eq(&fp, &cur_skin)
                } else {
                    path_eq(&fp, &cur_cape)
                };
                items.push(json!({
                    "name": name,
                    "kind": kind,
                    "filePath": fp,
                    "size": meta.len(),
                    "mtime": mtime,
                    "applied": applied,
                }));
            }
        }
    }
    // 按 mtime 倒序
    items.sort_by(|a, b| {
        b.get("mtime")
            .and_then(Value::as_i64)
            .cmp(&a.get("mtime").and_then(Value::as_i64))
    });
    Ok(json!({ "items": items }))
}

/// channel: hd:delete
/// 按条目名删除。返回 { ok, error? }
#[tauri::command(rename = "hd:delete")]
pub fn hd_skin_delete(name: String, kind: String) -> CmdResult<Value> {
    let dir = hd_dir(&kind)?;
    // canonicalize 白名单校验（参考 skin_local_delete）
    let dir_c = fs::canonicalize(&dir).map_err(|_| AppError::Msg("非法路径".into()))?;
    let full_c = fs::canonicalize(dir.join(&name)).map_err(|_| AppError::Msg("文件不存在".into()))?;
    if !full_c.starts_with(&dir_c) {
        return Err(AppError::Msg("非法路径".into()));
    }
    if !full_c.to_string_lossy().to_lowercase().ends_with(".png") {
        return Err(AppError::Msg("只允许删除 png 文件".into()));
    }
    fs::remove_file(&full_c)?;
    // 若删的是当前已应用的披风，清空记录
    if kind == "cape" && path_eq(&full_c.to_string_lossy(), &current_applied_cape()) {
        crate::config::set("hdCapePath", json!(""));
    }
    crate::logger::info(&format!("HD 纹理已删除[{kind}]：{name}"));
    Ok(json!({ "ok": true }))
}

/// channel: hd:apply
/// 把本地 HD 皮肤应用为当前皮肤。返回 { ok, error?, filePath }
#[tauri::command(rename = "hd:apply")]
pub fn hd_skin_apply(file_path: String) -> CmdResult<Value> {
    // 复用 skin.rs skin:use 的核心逻辑：校验 PNG + 写 skinHistory + 绑定 account.skinPath
    let res = crate::skin::skin_use(file_path)?;
    let fp = res.get("path").and_then(Value::as_str).unwrap_or("").to_string();
    crate::logger::info(&format!("HD 皮肤已应用：{fp}"));
    Ok(json!({ "ok": true, "filePath": fp }))
}

/// channel: hd:capeApply
/// 应用本地披风。返回 { ok, error?, filePath }
/// （离线模式游戏内不渲染披风属 Minecraft 限制，这里仅如实记录当前披风路径。）
#[tauri::command(rename = "hd:capeApply")]
pub fn hd_cape_apply(file_path: String) -> CmdResult<Value> {
    let canonical = fs::canonicalize(&file_path).unwrap_or_else(|_| PathBuf::from(&file_path));
    if fs::metadata(&canonical).is_err() {
        return Err(AppError::Msg("披风文件不存在".into()));
    }
    let buf = fs::read(&canonical)?;
    if !png_magic_ok(&buf) {
        return Err(AppError::Msg("不是有效的 PNG 图片".into()));
    }
    let fp = canonical.to_string_lossy().to_string();
    crate::config::set("hdCapePath", json!(fp));
    crate::logger::info(&format!("HD 披风已记录：{fp}（离线模式游戏内不渲染披风）"));
    Ok(json!({ "ok": true, "filePath": fp }))
}
