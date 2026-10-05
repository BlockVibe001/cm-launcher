//! Mod 更新检查与版本回滚（基于 Modrinth，对齐 Electron 版 src/main/minecraft/update.js）。
//! 反查接口 POST /version_files（sha1 批量）；版本列表 /project/{id}/version?loaders=&game_versions=。
//! 可参考 crate::mc::search 的 Modrinth 镜像（官方 + MCIM）写法，但本模块是独立命令组。
//!
//! 本文件由 OrganizeAgent 以 todo!() 骨架交付：把 todo!() 替换为真实实现即可，
//! 不得修改 #[tauri::command(rename = "...")] 通道名与函数签名。

use crate::config;
use crate::error::{AppError, CmdResult};
use crate::net::downloader::hash_file;
use crate::net::mirror::mirror_url;
use crate::net::HTTP;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MR_OFFICIAL: &str = "https://api.modrinth.com/v2";
const MR_MCIM: &str = "https://mod.mcimirror.top/modrinth/v2";

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

async fn mr_post(path: &str, body: &Value) -> CmdResult<Value> {
    let mut last = String::new();
    for base in mr_bases() {
        match HTTP.post(format!("{base}{path}")).json(body).send().await {
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

/// channel: mods:checkUpdates
/// 入参 gameDir/mcVersion/loader: String
/// 返回 [{ file, known, projectId?, projectName?, currentVersion?, currentVersionId?,
///         versionType?, updateAvailable?, latestVersion?, latestVersionId?, latestDate? }]
#[tauri::command(rename = "mods:checkUpdates")]
pub async fn mods_check_updates(game_dir: String, mc_version: String, loader: String) -> CmdResult<Value> {
    let mods_dir = Path::new(&game_dir).join("mods");
    let mut mods: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&mods_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // 对齐 localMods：只收 .jar（.disabled 已禁用，不参与更新检查）
            if name.to_lowercase().ends_with(".jar") {
                mods.push((name, e.path()));
            }
        }
    }
    if mods.is_empty() {
        return Ok(json!([]));
    }

    let mut by_sha1: Vec<(String, String)> = Vec::new(); // (sha1, file)
    for (name, path) in &mods {
        if let Ok(sha) = hash_file(path).await {
            by_sha1.push((sha, name.clone()));
        }
    }
    if by_sha1.is_empty() {
        return Ok(json!([]));
    }

    let hashes: Vec<String> = by_sha1.iter().map(|(s, _)| s.clone()).collect();
    let resolved: Value = mr_post("/version_files", &json!({ "hashes": hashes, "algorithm": "sha1" }))
        .await
        .unwrap_or_else(|_| json!({}));

    let mut results: Vec<Value> = Vec::new();
    for (sha, file) in &by_sha1 {
        match resolved.get(sha) {
            None => results.push(json!({ "file": file, "known": false })),
            Some(v) => results.push(json!({
                "file": file,
                "known": true,
                "projectId": v.get("project_id"),
                "projectName": v.get("name"),
                "currentVersion": v.get("version_number"),
                "currentVersionId": v.get("id"),
                "versionType": v.get("version_type"),
            })),
        }
    }

    // 查已知 Mod 在当前 MC 版本 + 加载器下的最新版本（最多 40 个，对齐 Electron）
    let loaders = serde_json::to_string(&[if loader.is_empty() { "fabric" } else { loader.as_str() }]).unwrap_or_default();
    let game_versions = serde_json::to_string(&[mc_version.as_str()]).unwrap_or_default();
    let qs = serde_urlencoded::to_string(&[("loaders", loaders), ("game_versions", game_versions)]).unwrap_or_default();

    let known_idx: Vec<usize> = results
        .iter()
        .enumerate()
        .filter(|(_, r)| r.get("known").and_then(Value::as_bool) == Some(true))
        .map(|(i, _)| i)
        .take(40)
        .collect();

    // 提前取出每个已知 Mod 的 projectId，让 future 自拥有数据（避免借用 results）
    let targets: Vec<(usize, String)> = known_idx
        .iter()
        .map(|&i| {
            let pid = results[i].get("projectId").and_then(Value::as_str).unwrap_or("").to_string();
            (i, pid)
        })
        .collect();

    let futs: Vec<_> = targets
        .into_iter()
        .map(|(i, project_id)| {
            let url = format!("/project/{project_id}/version?{qs}");
            async move {
                match mr_get(&url).await {
                Ok(list) => {
                    let arr = list.as_array().cloned().unwrap_or_default();
                    if arr.is_empty() {
                        (i, None)
                    } else {
                        let first = &arr[0];
                        (
                            i,
                            Some((
                                first.get("version_number").and_then(Value::as_str).unwrap_or("").to_string(),
                                first.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                                first.get("date_published").and_then(Value::as_str).unwrap_or("").to_string(),
                            )),
                        )
                    }
                }
                Err(_) => (i, None),
            }
        }
    })
        .collect();
    let outcomes = futures_util::future::join_all(futs).await;

    for (i, data) in outcomes {
        match data {
            None => results[i]["updateAvailable"] = json!(false),
            Some((lv, lid, ld)) => {
                results[i]["latestVersion"] = json!(lv);
                results[i]["latestVersionId"] = json!(lid);
                results[i]["latestDate"] = json!(ld);
                let cur = results[i]["currentVersionId"].as_str().unwrap_or("");
                results[i]["updateAvailable"] = json!(lid != cur);
            }
        }
    }

    Ok(Value::Array(results))
}

/// channel: mods:resolve —— 反查单个 Mod 文件对应的 Modrinth 项目
/// 入参 gameDir/file: String；返回 null 或 { projectId, projectName, currentVersion, currentVersionId }
#[tauri::command(rename = "mods:resolve")]
pub async fn mods_resolve(game_dir: String, file: String) -> CmdResult<Value> {
    let full = Path::new(&game_dir).join("mods").join(&file);
    if !full.exists() {
        return Err(AppError::Msg("Mod 文件不存在".into()));
    }
    let sha = hash_file(&full).await?;
    let data = mr_post("/version_files", &json!({ "hashes": [sha], "algorithm": "sha1" })).await?;
    let v = match data.get(&sha) {
        Some(v) => v,
        None => return Ok(Value::Null),
    };
    Ok(json!({
        "projectId": v.get("project_id"),
        "projectName": v.get("name"),
        "currentVersion": v.get("version_number"),
        "currentVersionId": v.get("id"),
    }))
}

/// channel: mods:versions —— 项目在指定 MC 版本/加载器下的所有历史版本
/// 入参 projectId/mcVersion/loader: String
/// 返回 [{ id, name, versionNumber, versionType, date, downloads, filename }]
#[tauri::command(rename = "mods:versions")]
pub async fn mods_versions(project_id: String, mc_version: String, loader: String) -> CmdResult<Value> {
    let l = if loader.is_empty() { "fabric" } else { loader.as_str() };
    let params = [
        ("loaders", serde_json::to_string(&[l]).unwrap_or_default()),
        ("game_versions", serde_json::to_string(&[mc_version.as_str()]).unwrap_or_default()),
    ];
    let qs = serde_urlencoded::to_string(&params).unwrap_or_default();
    let list = mr_get(&format!("/project/{project_id}/version?{qs}")).await?;
    let arr = list.as_array().cloned().unwrap_or_default();
    let out: Vec<Value> = arr
        .into_iter()
        .map(|v| {
            let files = v.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
            let primary = files
                .iter()
                .find(|f| f.get("primary").and_then(Value::as_bool) == Some(true))
                .or(files.first())
                .cloned();
            json!({
                "id": v.get("id"),
                "name": v.get("name"),
                "versionNumber": v.get("version_number"),
                "versionType": v.get("version_type"),
                "date": v.get("date_published"),
                "downloads": v.get("downloads"),
                "filename": primary.and_then(|f| f.get("filename").cloned()).unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(Value::Array(out))
}

/// channel: mods:installVersion —— 下载指定版本并替换旧 Mod 文件
/// 入参 projectId/versionId/gameDir: String、replaceFile: Option<String>
/// 返回 { file, size, versionNumber }
#[tauri::command(rename = "mods:installVersion")]
pub async fn mods_install_version(
    project_id: String,
    version_id: String,
    game_dir: String,
    replace_file: Option<String>,
) -> CmdResult<Value> {
    let _ = &project_id; // 通道契约入参，实际定位用 versionId
    let v = mr_get(&format!("/version/{version_id}")).await?;
    let files = v.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    let file = files
        .iter()
        .find(|f| f.get("primary").and_then(Value::as_bool) == Some(true))
        .or(files.first())
        .cloned()
        .ok_or_else(|| AppError::Msg("该版本没有可下载的文件".into()))?;
    let filename = file.get("filename").and_then(Value::as_str).unwrap_or("").to_string();
    let url = file.get("url").and_then(Value::as_str).unwrap_or("").to_string();
    if filename.is_empty() || url.is_empty() {
        return Err(AppError::Msg("该版本没有可下载的文件".into()));
    }

    let mods_dir = Path::new(&game_dir).join("mods");
    tokio::fs::create_dir_all(&mods_dir).await?;

    if let Some(rf) = &replace_file {
        let old = mods_dir.join(rf);
        let _ = tokio::fs::remove_file(&old).await;
    }
    let dest = mods_dir.join(&filename);
    let _ = tokio::fs::remove_file(&dest).await;

    let resp = HTTP.get(mirror_url(&url)).send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(AppError::Msg(format!("下载失败 HTTP {}", resp.status().as_u16())));
    }
    let bytes = resp.bytes().await.map_err(|e| AppError::Msg(e.to_string()))?;
    tokio::fs::write(&dest, &bytes).await?;

    Ok(json!({
        "file": filename,
        "size": file.get("size").cloned().unwrap_or(Value::Null),
        "versionNumber": v.get("version_number").cloned().unwrap_or(Value::Null),
    }))
}
