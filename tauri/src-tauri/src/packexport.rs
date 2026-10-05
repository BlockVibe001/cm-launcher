//! 实例导出整合包（.mrpack，对齐 Electron 版 src/main/minecraft/export.js）。
//! 流程：rfd 保存对话框（默认 `${实例名}.mrpack`）→ 哈希 mods（sha1/sha512）→
//! POST api.modrinth.com/v2/version_files 反查来源 → 命中写 files[]（下载链接），
//! 未命中塞 overrides/mods/ → 配置目录（config/defaultconfigs/kubejs/scripts/datapacks）+
//! options.txt / servers.dat → 写 modrinth.index.json → zip 打包。
//!
//! 本文件由 OrganizeAgent 以 todo!() 骨架交付：把 todo!() 替换为真实实现即可，
//! 不得修改 #[tauri::command(rename = "...")] 通道名与函数签名。

use crate::config;
use crate::error::{AppError, CmdResult};
use crate::mc::instance::get_instance;
use crate::net::downloader::hash_buffer;
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const MR_OFFICIAL: &str = "https://api.modrinth.com/v2";
const MR_MCIM: &str = "https://mod.mcimirror.top/modrinth/v2";

fn mr_bases() -> Vec<&'static str> {
    if config::get("mirror").as_str() == Some("bmcl") {
        vec![MR_MCIM, MR_OFFICIAL]
    } else {
        vec![MR_OFFICIAL, MR_MCIM]
    }
}

async fn mr_post(path: &str, body: &Value) -> CmdResult<Value> {
    let mut last = String::new();
    for base in mr_bases() {
        match crate::net::HTTP.post(format!("{base}{path}")).json(body).send().await {
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

struct ModHash {
    file: String,
    sha1: String,
    sha512: String,
    size: u64,
}

struct Override {
    name: String,
    path: PathBuf,
}

/// channel: instances:export
/// 入参 id: String（实例 id）
/// 返回 { canceled: true }（用户取消）或 { outPath, total, resolvedMods, bundledMods }
#[tauri::command(rename = "instances:export")]
pub async fn instances_export(id: String) -> CmdResult<Value> {
    let inst = get_instance(&id).ok_or_else(|| AppError::Msg("实例不存在".into()))?;
    let version_id = inst.get("versionId").and_then(Value::as_str).unwrap_or("").to_string();
    if version_id.is_empty() {
        return Err(AppError::Msg("该实例未选择游戏版本，无法导出".into()));
    }
    let inst_name = inst.get("name").and_then(Value::as_str).unwrap_or("实例").to_string();
    let raw_game_dir = inst.get("gameDir").and_then(Value::as_str).unwrap_or("").to_string();
    // gameDir 为空串 = 跟随全局 gameDir
    let game_dir = if raw_game_dir.is_empty() {
        config::get("gameDir").as_str().unwrap_or("").to_string()
    } else {
        raw_game_dir
    };

    // rfd 保存对话框（默认 `${inst.name}.mrpack`）
    let default_name = format!("{inst_name}.mrpack");
    let picked = rfd::AsyncFileDialog::new()
        .set_title("导出整合包")
        .set_file_name(&default_name)
        .add_filter("Modrinth 整合包", &["mrpack"])
        .save_file()
        .await;
    let out_path = match picked {
        Some(h) => h.path().to_path_buf(),
        None => return Ok(json!({ "canceled": true })),
    };

    // ① 计算 mods/*.jar 的 sha1 + sha512（阻塞，spawn_blocking）
    let mods_dir = Path::new(&game_dir).join("mods");
    let mods_dir_for_hash = mods_dir.clone();
    let mod_hashes: Vec<ModHash> = tauri::async_runtime::spawn_blocking(move || -> Vec<ModHash> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&mods_dir_for_hash) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !name.ends_with(".jar") {
                    continue;
                }
                let full = e.path();
                if let Ok(buf) = fs::read(&full) {
                    let sha1 = hash_buffer(&buf);
                    let sha512 = hex::encode(Sha512::digest(&buf));
                    out.push(ModHash { file: name, sha1, sha512, size: buf.len() as u64 });
                }
            }
        }
        out
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))?;

    // ② 批量反查 Modrinth
    let hashes: Vec<String> = mod_hashes.iter().map(|m| m.sha1.clone()).collect();
    let resolved: Value = if hashes.is_empty() {
        json!({})
    } else {
        mr_post("/version_files", &json!({ "hashes": hashes, "algorithm": "sha1" }))
            .await
            .unwrap_or_else(|_| json!({}))
    };

    // ③ 命中写 files[]，未命中塞 overrides/mods/
    let mut files: Vec<Value> = Vec::new();
    let mut overrides: Vec<Override> = Vec::new();
    for m in &mod_hashes {
        let remote = resolved
            .get(&m.sha1)
            .and_then(|v| v.get("files"))
            .and_then(|f| f.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|f| f.get("primary").and_then(Value::as_bool) == Some(true))
                    .or(arr.first())
                    .cloned()
            });
        match remote {
            Some(rf) => {
                let url = rf.get("url").and_then(Value::as_str).unwrap_or("").to_string();
                files.push(json!({
                    "path": format!("mods/{}", m.file),
                    "hashes": { "sha1": m.sha1, "sha512": m.sha512 },
                    "downloads": [url],
                    "fileSize": m.size,
                }));
            }
            None => overrides.push(Override {
                name: format!("overrides/mods/{}", m.file),
                path: mods_dir.join(&m.file),
            }),
        }
    }

    // ④ 配置类目录全量进 overrides
    for d in ["config", "defaultconfigs", "kubejs", "scripts", "datapacks"] {
        let full = Path::new(&game_dir).join(d);
        if !full.exists() {
            continue;
        }
        for e in WalkDir::new(&full).into_iter().flatten() {
            if !e.file_type().is_file() {
                continue;
            }
            let rel = e.path().strip_prefix(&full).unwrap().to_string_lossy().replace('\\', "/");
            overrides.push(Override {
                name: format!("overrides/{d}/{rel}"),
                path: e.path().to_path_buf(),
            });
        }
    }

    // ⑤ 关键单文件
    for f in ["options.txt", "servers.dat"] {
        let full = Path::new(&game_dir).join(f);
        if full.exists() {
            overrides.push(Override { name: format!("overrides/{f}"), path: full });
        }
    }

    // ⑥ 构建索引
    let mut deps = serde_json::Map::new();
    deps.insert("minecraft".into(), json!(version_id));
    let ml = inst.get("modLoader").and_then(Value::as_str).unwrap_or("vanilla");
    let lv = inst.get("loaderVersion").and_then(Value::as_str).unwrap_or("");
    if !lv.is_empty() {
        match ml {
            "fabric" => { deps.insert("fabric-loader".into(), json!(lv)); }
            "quilt" => { deps.insert("quilt-loader".into(), json!(lv)); }
            "forge" => { deps.insert("forge".into(), json!(lv)); }
            _ => {}
        }
    }

    let index = json!({
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": "1.0.0",
        "name": inst_name,
        "summary": format!("{inst_name} — 由 BlockVibe 启动器导出"),
        "files": files,
        "dependencies": Value::Object(deps),
    });

    let total_entries = 1 + overrides.len();
    let bundled = overrides.iter().filter(|o| o.name.starts_with("overrides/mods/")).count();
    let index_bytes = serde_json::to_vec_pretty(&index)?;

    // ⑦ 写 zip（阻塞，spawn_blocking）
    let out_path_c = out_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<usize> {
        let file = fs::File::create(&out_path_c)?;
        let mut w = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        w.start_file("modrinth.index.json", opts.clone())
            .map_err(|e| AppError::Msg(e.to_string()))?;
        w.write_all(&index_bytes).map_err(|e| AppError::Msg(e.to_string()))?;
        for ov in &overrides {
            let data = fs::read(&ov.path).map_err(|e| AppError::Msg(e.to_string()))?;
            w.start_file(&ov.name, opts.clone())
                .map_err(|e| AppError::Msg(e.to_string()))?;
            w.write_all(&data).map_err(|e| AppError::Msg(e.to_string()))?;
        }
        w.finish().map_err(|e| AppError::Msg(e.to_string()))?;
        Ok(total_entries)
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))??;

    Ok(json!({
        "outPath": out_path.to_string_lossy(),
        "total": total_entries,
        "resolvedMods": files.len(),
        "bundledMods": bundled,
    }))
}
