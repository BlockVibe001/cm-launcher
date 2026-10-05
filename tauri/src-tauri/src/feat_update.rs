//! feat_update.rs — 整合包增量更新
//! 命令契约已由集成层固定并接入 main.rs，禁止改名/改通道；函数体为本文件实现。
//!
//! 功能：对 .mrpack 安装的实例检查 Modrinth 新版本，按文件清单（sha1）对比，
//! 只下载变动文件并替换，保留 overrides/存档。
//! 参考：modupdate.rs（Modrinth 镜像/fallback 请求封装）、net/downloader.rs（sha1/下载）。

use crate::config;
use crate::error::{AppError, CmdResult};
use crate::net::downloader::hash_buffer;
use crate::net::mirror::mirror_url;
use crate::net::HTTP;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

const MR_OFFICIAL: &str = "https://api.modrinth.com/v2";
const MR_MCIM: &str = "https://mod.mcimirror.top/modrinth/v2";

/// 实例内永不删除/改写的受保护目录前缀（正斜杠相对路径）
const PROTECTED: [&str; 4] = ["overrides/", "saves/", "logs/", "config/"];

fn mr_bases() -> Vec<&'static str> {
    if config::get("mirror").as_str() == Some("bmcl") {
        vec![MR_MCIM, MR_OFFICIAL]
    } else {
        vec![MR_OFFICIAL, MR_MCIM]
    }
}

async fn mr_get(path: &str) -> CmdResult<Value> {
    let mut last = String::new();
    for base in mr_bases() {
        match HTTP.get(format!("{base}{path}")).send().await {
            Ok(r) if r.status().is_success() => match r.json::<Value>().await {
                Ok(v) => return Ok(v),
                Err(e) => last = e.to_string(),
            },
            Ok(r) => last = format!("HTTP {}", r.status()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(AppError::Msg(format!("Modrinth 请求失败：{last}")))
}

/// 归一化实例相对路径：统一正斜杠、去掉 ./ 前缀、拒绝绝对路径与 .. 穿越。
/// 非法路径返回空串（调用方跳过该条目）。
fn normalize_rel(raw: Option<&str>) -> String {
    let r = raw.unwrap_or("").replace('\\', "/");
    let r = r.trim_start_matches("./").to_string();
    if r.is_empty() {
        return String::new();
    }
    if r.starts_with('/') || r.contains(':') {
        return String::new();
    }
    if r.split('/').any(|seg| seg == "..") {
        return String::new();
    }
    r
}

fn is_protected(rel: &str) -> bool {
    PROTECTED.iter().any(|p| rel.starts_with(p))
}

/// channel: pack:status
/// 检查实例整合包是否有新版本，返回：
/// { ok, error?, installedPackName?, installedVersionId?, latestVersionId?,
///   latestVersionNumber?, hasUpdate,
///   diff: { changed: [{rel,size,url,sha1,path}], added: [...], removed: [rel] } }
#[tauri::command(rename = "pack:status")]
pub async fn pack_status(
    game_dir: String,
    project_id: Option<String>,
    pack_version: Option<String>,
) -> CmdResult<Value> {
    let pid = project_id.clone().unwrap_or_default();
    let pver = pack_version.clone().unwrap_or_default();
    let pid = pid.trim().to_string();
    let pver = pver.trim().to_string();

    // project_id 缺失 = 无法定位 Modrinth 项目（旧版本安装的整合包没记录来源）
    if pid.is_empty() {
        return Ok(json!({
            "ok": false,
            "error": "无法识别整合包来源（旧版本安装的整合包需重新导入才能增量更新）"
        }));
    }

    // 拉取版本列表（Modrinth 按发布时间倒序）
    let versions = match mr_get(&format!("/project/{pid}/version")).await {
        Ok(v) => v,
        Err(e) => {
            return Ok(json!({ "ok": false, "error": format!("检查更新失败：{e}") }));
        }
    };
    let arr = versions.as_array().cloned().unwrap_or_default();
    if arr.is_empty() {
        return Ok(json!({ "ok": false, "error": "未找到该整合包的任何版本" }));
    }
    // 选最新 release；没有 release 则取列表第一个（最新 beta/alpha）
    let latest = arr
        .iter()
        .find(|v| v.get("version_type").and_then(Value::as_str) == Some("release"))
        .cloned()
        .unwrap_or_else(|| arr[0].clone());
    let latest_id = latest.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let latest_num = latest
        .get("version_number")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    // 项目名（尽力而为，失败不阻塞检查）
    let installed_pack_name: Option<String> = match mr_get(&format!("/project/{pid}")).await {
        Ok(v) => v.get("name").and_then(Value::as_str).map(|s| s.to_string()),
        Err(_) => None,
    };

    let game_root = Path::new(&game_dir);
    let files = latest.get("files").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut changed: Vec<Value> = Vec::new();
    let mut added: Vec<Value> = Vec::new();
    let mut new_rels: HashSet<String> = HashSet::new();

    for f in &files {
        // Modrinth 文件对象：优先 path，兼容 filename
        let rel = normalize_rel(
            f.get("path")
                .and_then(Value::as_str)
                .or_else(|| f.get("filename").and_then(Value::as_str)),
        );
        if rel.is_empty() {
            continue;
        }
        // 保护清单目录不参与 diff（overrides/saves/logs/config）
        if is_protected(&rel) {
            continue;
        }
        new_rels.insert(rel.clone());

        let sha = f.pointer("/hashes/sha1").and_then(Value::as_str).unwrap_or("").to_string();
        let url = f.get("url").and_then(Value::as_str).unwrap_or("").to_string();
        let size = f.get("size").cloned().unwrap_or(json!(0));
        let entry = || {
            json!({
                "rel": rel,
                "path": rel,
                "size": size,
                "url": url,
                "sha1": sha,
            })
        };

        let dest = game_root.join(&rel);
        match tokio::fs::try_exists(&dest).await {
            Ok(true) => {
                if sha.is_empty() {
                    // 没有期望 hash：无法判定，视为需更新
                    changed.push(entry());
                } else {
                    match crate::net::downloader::hash_file(&dest).await {
                        Ok(local) if local == sha => {} // 一致，跳过
                        Ok(_) => changed.push(entry()), // hash 不同
                        Err(_) => changed.push(entry()), // 读不出也按变动处理
                    }
                }
            }
            Ok(false) => added.push(entry()),
            Err(_) => added.push(entry()),
        }
    }

    // removed：实例 mods/ 下、不在新文件清单里的 .jar
    let mut removed: Vec<String> = Vec::new();
    let mods_dir = game_root.join("mods");
    if let Ok(rd) = std::fs::read_dir(&mods_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.to_lowercase().ends_with(".jar") {
                continue;
            }
            let rel = format!("mods/{name}");
            if !new_rels.contains(&rel) {
                removed.push(rel);
            }
        }
    }

    let has_update = !changed.is_empty()
        || !added.is_empty()
        || (!pver.is_empty() && pver != latest_id);

    Ok(json!({
        "ok": true,
        "installedPackName": installed_pack_name,
        "installedVersionId": pver,
        "latestVersionId": latest_id,
        "latestVersionNumber": latest_num,
        "hasUpdate": has_update,
        "diff": {
            "changed": changed,
            "added": added,
            "removed": removed,
        }
    }))
}

/// channel: pack:apply
/// files 为前端回传的 diff 对象：{ changed:[{rel/path,url,sha1,size}],
///   added:[...], removed:[rel] }。逐个下载并校验 sha1 后替换；
/// removed 只删除实例 mods/ 下文件；overrides/saves/logs/config 永不触碰。
/// 返回 { ok, error?, applied:[rel], failed:[{rel,error}] }
#[tauri::command(rename = "pack:apply")]
pub async fn pack_apply(game_dir: String, version_id: String, files: Value) -> CmdResult<Value> {
    let _ = &version_id; // 契约入参；具体下载地址由 files 条目自带 url
    let game_root = Path::new(&game_dir);
    let mut applied: Vec<String> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();

    // 收集待下载条目（changed + added）
    let mut todo: Vec<Value> = Vec::new();
    for key in ["changed", "added"] {
        if let Some(arr) = files.get(key).and_then(Value::as_array) {
            todo.extend(arr.iter().cloned());
        }
    }

    for item in &todo {
        let rel = normalize_rel(
            item.get("rel")
                .and_then(Value::as_str)
                .or_else(|| item.get("path").and_then(Value::as_str)),
        );
        if rel.is_empty() {
            continue;
        }
        // 保护目录防御：即使前端误传也绝不触碰
        if is_protected(&rel) {
            continue;
        }
        let url = item.get("url").and_then(Value::as_str).unwrap_or("").to_string();
        let sha = item.get("sha1").and_then(Value::as_str).unwrap_or("").to_string();
        if url.is_empty() {
            failed.push(json!({ "rel": rel, "error": "缺少下载地址" }));
            continue;
        }

        let resp = match HTTP.get(mirror_url(&url)).send().await {
            Ok(r) => r,
            Err(e) => {
                failed.push(json!({ "rel": rel, "error": e.to_string() }));
                continue;
            }
        };
        if !resp.status().is_success() {
            failed.push(json!({
                "rel": rel,
                "error": format!("下载失败 HTTP {}", resp.status().as_u16())
            }));
            continue;
        }
        let bytes = match resp.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => {
                failed.push(json!({ "rel": rel, "error": e.to_string() }));
                continue;
            }
        };
        if !sha.is_empty() && hash_buffer(&bytes) != sha {
            failed.push(json!({ "rel": rel, "error": "SHA1 校验失败" }));
            continue;
        }

        let dest = game_root.join(&rel);
        if let Some(parent) = dest.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                failed.push(json!({ "rel": rel, "error": e.to_string() }));
                continue;
            }
        }
        match tokio::fs::write(&dest, &bytes).await {
            Ok(_) => applied.push(rel),
            Err(e) => failed.push(json!({ "rel": rel, "error": e.to_string() })),
        }
    }

    // removed：仅作用于 mods/ 下文件，删除实例中被新版本移除的 mod
    if let Some(removed) = files.get("removed").and_then(Value::as_array) {
        for r in removed {
            let rel = normalize_rel(r.as_str());
            if rel.is_empty() || is_protected(&rel) {
                continue;
            }
            if !rel.starts_with("mods/") {
                continue;
            }
            let dest = game_root.join(&rel);
            let _ = tokio::fs::remove_file(&dest).await;
        }
    }

    let ok = failed.is_empty();
    Ok(json!({
        "ok": ok,
        "applied": applied,
        "failed": failed,
    }))
}
