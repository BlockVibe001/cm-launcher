//! ModLoader 安装：Fabric / Forge / NeoForge / Quilt，与 Electron 版 modloaders.js 对齐。
//!
//! - Fabric / Quilt：直接从 meta API 拉取完整 version.json，无需安装器。
//! - Forge / NeoForge：下载 installer.jar，用 `java -jar ... --installClient --gameDir` 执行。

use crate::error::{AppError, CmdResult};
use crate::net::downloader::download_file;
use crate::net::mirror::mirror_url;
use crate::net::HTTP;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
struct MlProgress {
    step: String,
    percent: u32,
}

fn emit_progress(app: &AppHandle, step: &str, percent: u32) {
    let _ = app.emit(
        crate::events::EV_MODLOADER_PROGRESS,
        MlProgress {
            step: step.to_string(),
            percent,
        },
    );
}

/// 运行 `java -jar <installer> --installClient --gameDir <dir>`，等待退出。
/// 失败时把进程尾部输出带回来便于排错。
async fn run_jar(java_path: &str, args: &[String], cwd: &str) -> CmdResult<()> {
    let mut cmd = tokio::process::Command::new(java_path);
    cmd.arg("-jar").args(args).current_dir(cwd);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = cmd.output().await?;
    if output.status.success() {
        return Ok(());
    }
    let mut tail = String::new();
    for chunk in [&output.stdout, &output.stderr] {
        let s = String::from_utf8_lossy(chunk);
        tail.push_str(&s);
    }
    let code = output.status.code().unwrap_or(-1);
    Err(AppError::Msg(format!(
        "安装器退出码 {code}\n{}",
        tail.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>()
    )))
}

// ===================== Forge =====================

pub async fn forge_versions(mc_version: &str) -> CmdResult<Value> {
    let url = mirror_url(&format!(
        "https://bmclapi2.bangbang93.com/forge/minecraft/{mc_version}"
    ));
    let res = HTTP.get(&url).send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!(
            "获取 Forge 版本列表失败 (HTTP {})",
            res.status().as_u16()
        )));
    }
    let list: Value = res.json().await.map_err(|e| AppError::Msg(e.to_string()))?;
    let out: Vec<Value> = list
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|v| {
                    json!({
                        "mcVersion": v.get("mcversion").and_then(Value::as_str).unwrap_or(""),
                        "version": v.get("version").and_then(Value::as_str).unwrap_or(""),
                        "isLatest": v.get("latest").and_then(Value::as_bool).unwrap_or(false),
                        "isRecommended": v.get("recommended").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Value::Array(out))
}

pub async fn install_forge(
    mc_version: &str,
    forge_version: &str,
    game_dir: &str,
    java_path: &str,
    app: AppHandle,
) -> CmdResult<String> {
    if java_path.is_empty() {
        return Err(AppError::Msg("安装 Forge 需要 Java，请在设置中指定 java.exe".into()));
    }
    let cancel = Arc::new(AtomicUsize::new(0));
    let installer_url = mirror_url(&format!(
        "https://bmclapi2.bangbang93.com/forge/download?mcversion={mc_version}&version={forge_version}&category=installer"
    ));
    let installer_file = PathBuf::from(game_dir)
        .join(format!("forge-{mc_version}-{forge_version}-installer.jar"));
    tokio::fs::create_dir_all(game_dir).await?;

    emit_progress(&app, "下载 Forge 安装器…", 10);
    download_file(&installer_url, &installer_file, None, &cancel).await?;

    emit_progress(&app, "运行 Forge 安装器…", 30);
    run_jar(
        java_path,
        &[
            installer_file.to_string_lossy().to_string(),
            "--installClient".into(),
            "--gameDir".into(),
            game_dir.into(),
        ],
        game_dir,
    )
    .await?;

    let _ = tokio::fs::remove_file(&installer_file).await;
    emit_progress(&app, "Forge 安装完成", 100);
    Ok(format!("{mc_version}-forge-{forge_version}"))
}

// ===================== NeoForge =====================

pub async fn neoforge_versions(mc_version: &str) -> CmdResult<Value> {
    let url = format!("https://bmclapi2.bangbang93.com/neoforge/list/{mc_version}");
    let res = HTTP.get(&url).send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!(
            "获取 NeoForge 版本列表失败 (HTTP {})",
            res.status().as_u16()
        )));
    }
    let list: Value = res.json().await.map_err(|e| AppError::Msg(e.to_string()))?;
    let out: Vec<Value> = list
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|v| {
                    json!({
                        "mcVersion": v.get("mcversion").and_then(Value::as_str).unwrap_or(""),
                        "version": v.get("version").and_then(Value::as_str).unwrap_or(""),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Value::Array(out))
}

pub async fn install_neoforge(
    mc_version: &str,
    neo_version: &str,
    game_dir: &str,
    java_path: &str,
    app: AppHandle,
) -> CmdResult<String> {
    if java_path.is_empty() {
        return Err(AppError::Msg("安装 NeoForge 需要 Java，请在设置中指定 java.exe".into()));
    }
    let cancel = Arc::new(AtomicUsize::new(0));
    let installer_url = mirror_url(&format!(
        "https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/{neo_version}/neoforge-{neo_version}-installer.jar"
    ));
    let installer_file = PathBuf::from(game_dir)
        .join(format!("neoforge-{mc_version}-{neo_version}-installer.jar"));
    tokio::fs::create_dir_all(game_dir).await?;

    emit_progress(&app, "下载 NeoForge 安装器…", 10);
    download_file(&installer_url, &installer_file, None, &cancel).await?;

    emit_progress(&app, "运行 NeoForge 安装器…", 30);
    run_jar(
        java_path,
        &[
            installer_file.to_string_lossy().to_string(),
            "--installClient".into(),
            "--gameDir".into(),
            game_dir.into(),
        ],
        game_dir,
    )
    .await?;

    let _ = tokio::fs::remove_file(&installer_file).await;
    emit_progress(&app, "NeoForge 安装完成", 100);
    Ok(format!("neoforge-{neo_version}"))
}

// ===================== Fabric =====================

pub async fn fabric_loaders() -> CmdResult<Value> {
    let res = HTTP
        .get("https://meta.fabricmc.net/v2/versions/loader")
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::Msg("获取 Fabric loader 版本失败".into()));
    }
    res.json().await.map_err(|e| AppError::Msg(e.to_string()))
}

pub async fn install_fabric(
    mc_version: &str,
    loader_version: &str,
    game_dir: &str,
    app: AppHandle,
) -> CmdResult<String> {
    let url = format!(
        "https://meta.fabricmc.net/v2/versions/loader/{mc_version}/{loader_version}/profile/json"
    );
    let res = HTTP.get(&url).send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!(
            "Fabric profile 获取失败 (HTTP {})",
            res.status().as_u16()
        )));
    }
    let profile: Value = res.json().await.map_err(|e| AppError::Msg(e.to_string()))?;
    let id = profile
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return Err(AppError::Msg("Fabric profile 缺少 id".into()));
    }
    let ver_dir = Path::new(game_dir).join("versions").join(&id);
    tokio::fs::create_dir_all(&ver_dir).await?;
    let json = serde_json::to_string_pretty(&profile).map_err(|e| AppError::Msg(e.to_string()))?;
    tokio::fs::write(ver_dir.join(format!("{id}.json")), json).await?;
    emit_progress(&app, &format!("Fabric {id} 版本清单已生成"), 100);
    Ok(id)
}

// ===================== Quilt =====================

pub async fn quilt_loaders() -> CmdResult<Value> {
    let res = HTTP
        .get("https://meta.quiltmc.org/v3/versions/loader")
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::Msg("获取 Quilt loader 版本失败".into()));
    }
    res.json().await.map_err(|e| AppError::Msg(e.to_string()))
}

pub async fn install_quilt(
    mc_version: &str,
    loader_version: &str,
    game_dir: &str,
    app: AppHandle,
) -> CmdResult<String> {
    let url = format!(
        "https://meta.quiltmc.org/v3/versions/loader/{mc_version}/{loader_version}/profile/json"
    );
    let res = HTTP.get(&url).send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!(
            "Quilt profile 获取失败 (HTTP {})",
            res.status().as_u16()
        )));
    }
    let profile: Value = res.json().await.map_err(|e| AppError::Msg(e.to_string()))?;
    let id = profile
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return Err(AppError::Msg("Quilt profile 缺少 id".into()));
    }
    let ver_dir = Path::new(game_dir).join("versions").join(&id);
    tokio::fs::create_dir_all(&ver_dir).await?;
    let json = serde_json::to_string_pretty(&profile).map_err(|e| AppError::Msg(e.to_string()))?;
    tokio::fs::write(ver_dir.join(format!("{id}.json")), json).await?;
    emit_progress(&app, &format!("Quilt {id} 版本清单已生成"), 100);
    Ok(id)
}
