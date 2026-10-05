//! Modrinth 整合包安装（.mrpack，对齐 Electron 版 minecraft/modrinth.js 的 installMrpack）。
//! 流程：准备本地/下载 .mrpack → 解压 → 读 modrinth.index.json → 在 gameRoot/instances/<name> 建实例目录 →
//! 下载客户端文件（过滤 env.client=false，sha1 校验，已有文件跳过，优先 cdn.modrinth.com 直链）→
//! 应用 overrides / client-overrides → 解析 dependencies → 清理临时文件。
//! 进度沿 events::EV_MODLOADER_PROGRESS 下发（载荷 { pct, label }）。
//!
//! 本文件由 OrganizeAgent 以 todo!() 骨架交付：把 todo!() 替换为真实实现即可，
//! 不得修改 #[tauri::command(rename = "...")] 通道名与函数签名；install_mrpack 是
//! dnd:import 复用的跨模块契约，签名冻结。

use crate::error::{AppError, CmdResult};
use crate::net::downloader::{download_file, extract_zip_blocking};
use crate::events::EV_MODLOADER_PROGRESS;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// 文件名清洗：去掉 Windows 非法字符（对齐 JS 的 replace(/[\\/:*?"<>|]/g,'_')）
pub(crate) fn sanitize_name(n: &str) -> String {
    let s: String = n
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();
    if s.is_empty() { "modpack".to_string() } else { s }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn prog(app: &AppHandle, pct: i64, label: &str) {
    let _ = app.emit(EV_MODLOADER_PROGRESS, json!({ "pct": pct, "label": label }));
}

fn copy_dir_recursive_blocking(src: &Path, dest: &Path) -> CmdResult<()> {
    std::fs::create_dir_all(dest)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let s = e.path();
        let d = dest.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir_recursive_blocking(&s, &d)?;
        } else {
            std::fs::copy(&s, &d)?;
        }
    }
    Ok(())
}

/// 【跨模块契约】安装 .mrpack 整合包，返回
/// { instanceId, name, gameDir, versionId, modLoader, loaderVersion }
/// 入参 file: Value { localPath?: String, url?: String }、gameRoot: &str
pub async fn install_mrpack(file: &Value, game_root: &str, app: &AppHandle) -> CmdResult<Value> {
    let local = file.get("localPath").and_then(Value::as_str);
    let remote = file.get("url").and_then(Value::as_str);

    // 1. 准备 mrpack（本地文件直接复制，网络来源则下载）
    prog(
        app,
        2,
        if local.is_some() { "读取本地整合包…" } else { "下载整合包文件…" },
    );
    let ts = now_ms();
    let tmp_zip = std::env::temp_dir().join(format!("cm-mrpack-{ts}.mrpack"));
    match local {
        Some(p) => {
            tokio::fs::copy(p, &tmp_zip).await?;
        }
        None => {
            let url = remote.ok_or_else(|| AppError::Msg("整合包缺少 localPath / url".into()))?;
            let cancel = AtomicUsize::new(0);
            download_file(url, &tmp_zip, None, &cancel).await?;
        }
    }

    // 2. 解压
    prog(app, 8, "解压整合包…");
    let tmp_dir = std::env::temp_dir().join(format!("cm-mrpack-{ts}"));
    tokio::fs::create_dir_all(&tmp_dir).await?;
    {
        let z = tmp_zip.clone();
        let d = tmp_dir.clone();
        tauri::async_runtime::spawn_blocking(move || extract_zip_blocking(&z, &d, |_,_| {}))
            .await
            .map_err(|e| AppError::Msg(e.to_string()))??;
    }

    let index: Value = {
        let text = tokio::fs::read_to_string(tmp_dir.join("modrinth.index.json")).await?;
        serde_json::from_str(&text)?
    };

    // 3. 创建实例目录（重名加 -2 -3）
    let raw_name = index.get("name").and_then(Value::as_str).unwrap_or("modpack").to_string();
    let safe = sanitize_name(&raw_name);
    let inst_root = Path::new(game_root).join("instances");
    let mut game_dir = inst_root.join(&safe);
    let mut n = 1;
    while game_dir.exists() {
        n += 1;
        game_dir = inst_root.join(format!("{safe}-{n}"));
    }
    tokio::fs::create_dir_all(&game_dir).await?;

    // 4. 下载客户端文件（过滤 env.client === 'false'）
    let files = index.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    let client_files: Vec<Value> = files
        .into_iter()
        .filter(|f| f.pointer("/env/client").and_then(Value::as_str) != Some("false"))
        .collect();
    let total = client_files.len();
    let cancel = AtomicUsize::new(0);
    for (i, f) in client_files.iter().enumerate() {
        let rel = f.get("path").and_then(Value::as_str).unwrap_or("");
        let base_name = Path::new(rel)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(rel);
        let pct = if total == 0 {
            85
        } else {
            10 + ((i + 1) as i64 * 75) / total as i64
        };
        prog(app, pct, &format!("下载 Mod 文件 {i}/{total}：{base_name}"));
        let dest = game_dir.join(rel);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if tokio::fs::try_exists(&dest).await.unwrap_or(false) {
            continue;
        }
        let urls: Vec<&str> = f
            .get("downloads")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|u| u.as_str()).collect())
            .unwrap_or_default();
        let dl = urls
            .iter()
            .find(|u| u.contains("cdn.modrinth.com"))
            .copied()
            .or_else(|| urls.first().copied())
            .ok_or_else(|| AppError::Msg("文件缺少下载链接".into()))?;
        let sha1 = f.pointer("/hashes/sha1").and_then(Value::as_str);
        download_file(dl, &dest, sha1, &cancel).await?;
    }

    // 5. 应用 overrides + client-overrides
    prog(app, 90, "应用整合包配置…");
    for ov in ["overrides", "client-overrides"] {
        let src = tmp_dir.join(ov);
        if tokio::fs::try_exists(&src).await.unwrap_or(false) {
            let gd = game_dir.clone();
            tauri::async_runtime::spawn_blocking(move || copy_dir_recursive_blocking(&src, &gd))
                .await
                .map_err(|e| AppError::Msg(e.to_string()))??;
        }
    }

    // 6. 解析依赖
    let deps = index.get("dependencies").cloned().unwrap_or_else(|| json!({}));
    let (mod_loader, loader_version): (String, String) =
        if deps.get("forge").and_then(Value::as_str).is_some() {
            ("forge".to_string(), deps["forge"].as_str().unwrap_or("").to_string())
        } else if deps.get("neoforge").and_then(Value::as_str).is_some() {
            ("neoforge".to_string(), deps["neoforge"].as_str().unwrap_or("").to_string())
        } else if deps.get("fabric-loader").and_then(Value::as_str).is_some() {
            ("fabric".to_string(), deps["fabric-loader"].as_str().unwrap_or("").to_string())
        } else if deps.get("quilt-loader").and_then(Value::as_str).is_some() {
            ("quilt".to_string(), deps["quilt-loader"].as_str().unwrap_or("").to_string())
        } else {
            ("vanilla".to_string(), String::new())
        };

    // 清理临时文件
    let _ = tokio::fs::remove_file(&tmp_zip).await;
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;

    prog(app, 100, "整合包安装完成");
    Ok(json!({
        "instanceId": format!("mp-{ts}"),
        "name": raw_name,
        "gameDir": game_dir.to_string_lossy(),
        "versionId": deps.get("minecraft").and_then(Value::as_str).unwrap_or(""),
        "modLoader": mod_loader,
        "loaderVersion": loader_version,
    }))
}

/// channel: search:modrinth:installpack
/// 入参 file: Value { localPath?/url? }、gameRoot: String
/// 返回 { instanceId, name, gameDir, versionId, modLoader, loaderVersion }
#[tauri::command(rename = "search:modrinth:installpack")]
pub async fn installpack(app: AppHandle, file: Value, game_root: String) -> CmdResult<Value> {
    let info = install_mrpack(&file, &game_root, &app).await?;
    // 注册为新实例（对齐 Electron main.js：saveInstance(info.instanceId, …)）
    crate::mc::instance::save_instance(
        info["instanceId"].as_str().unwrap_or(""),
        json!({
            "name": info["name"],
            "versionId": info["versionId"],
            "gameDir": info["gameDir"],
            "modLoader": info["modLoader"],
            "loaderVersion": info["loaderVersion"],
            "icon": "🗃️",
        }),
    );
    Ok(info)
}
