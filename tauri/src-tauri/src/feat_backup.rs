//! feat_backup.rs — 世界备份管理（子代理填充实现）
//! 命令契约已由集成层固定并接入 main.rs，**禁止改名/改通道**；函数体可自由实现。
//!
//! 功能要求：实例 saves 目录下的世界支持一键备份（zip 到备份目录，含时间戳）、
//! 恢复（解压回 saves）、删除备份。
//! 备份目录：game_dir/backups（在 saves 外，避免被 world:list 扫到）。
//! zip crate 已可用（features = ["deflate"]），walkdir 已可用。

use crate::error::{AppError, CmdResult};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use zip::write::SimpleFileOptions;

/* ---------- 通用小工具 ---------- */

/// 备份目录（game_dir/backups，自动创建）
fn backups_dir(game_dir: &str) -> PathBuf {
    let dir = PathBuf::from(game_dir).join("backups");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 当前时间戳 yyyyMMdd-HHmmss
fn ts_now() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 尾部 _yyyyMMdd-HHmmss 时间戳后缀正则
fn ts_suffix_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"_\d{8}-\d{6}$").unwrap())
}

/// 由备份文件名（xxx_yyyyMMdd-HHmmss.zip）反推世界名
fn save_name_from_zip(file_name: &str) -> String {
    let stem = file_name
        .strip_suffix(".zip")
        .or_else(|| file_name.strip_suffix(".ZIP"))
        .unwrap_or(file_name);
    ts_suffix_re().replace(stem, "").into_owned()
}

/// 文件 mtime → 毫秒时间戳（对齐 skin.rs / content.rs 口径）
fn mtime_millis(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把路径转成 zip 条目名（统一用 / 分隔，跨平台可解压）
fn rel_zip_name(base: &Path, full: &Path) -> Option<String> {
    let rel = full.strip_prefix(base).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    if parts.iter().all(|p| !p.is_empty()) {
        Some(parts.join("/"))
    } else {
        None
    }
}

/// 把业务错误包成 { ok:false, error }，命令永远返回 Ok(Value)（对齐 share:* 契约）
fn fail<E: std::fmt::Display>(e: E) -> Value {
    json!({ "ok": false, "error": e.to_string() })
}

/// channel: backup:create
/// 备份 saves/<save_name> 到备份目录。返回 { ok, error?, file }
#[tauri::command(rename = "backup:create")]
pub fn backup_create(game_dir: String, save_name: String) -> CmdResult<Value> {
    let work = || -> CmdResult<Value> {
        let save_dir = PathBuf::from(&game_dir).join("saves").join(&save_name);
        if !save_dir.is_dir() {
            return Err(AppError::Msg(format!("世界不存在：{save_name}")));
        }
        let backups = backups_dir(&game_dir);
        let ts = ts_now();
        let zip_path = backups.join(format!("{save_name}_{ts}.zip"));

        let file = fs::File::create(&zip_path)?;
        let mut zw = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(6));

        for ent in walkdir::WalkDir::new(&save_dir) {
            let ent = ent.map_err(|e| AppError::Msg(e.to_string()))?;
            let path = ent.path();
            let Some(name) = rel_zip_name(&save_dir, path) else {
                continue;
            };
            if path.is_dir() {
                zw.add_directory(format!("{name}/"), opts)
                    .map_err(|e| AppError::Msg(e.to_string()))?;
            } else {
                zw.start_file(&name, opts)
                    .map_err(|e| AppError::Msg(e.to_string()))?;
                let mut f = fs::File::open(path)?;
                io::copy(&mut f, &mut zw)?;
            }
        }
        zw.finish().map_err(|e| AppError::Msg(e.to_string()))?;
        Ok(json!({
            "ok": true,
            "file": zip_path.to_string_lossy(),
        }))
    };
    match work() {
        Ok(v) => Ok(v),
        Err(e) => Ok(fail(e)),
    }
}

/// channel: backup:list
/// 返回 { items: [ { file, saveName, size, mtime } ] }
#[tauri::command(rename = "backup:list")]
pub fn backup_list(game_dir: String) -> CmdResult<Value> {
    let backups = PathBuf::from(&game_dir).join("backups");
    let mut items: Vec<Value> = Vec::new();
    if let Ok(rd) = fs::read_dir(&backups) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.to_lowercase().ends_with(".zip") {
                continue;
            }
            let full = e.path();
            let md = match fs::metadata(&full) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !md.is_file() {
                continue;
            }
            items.push(json!({
                "file": full.to_string_lossy(),
                "saveName": save_name_from_zip(&name),
                "size": md.len(),
                "mtime": mtime_millis(&full),
            }));
        }
    }
    items.sort_by(|a, b| {
        b.get("mtime")
            .and_then(Value::as_i64)
            .cmp(&a.get("mtime").and_then(Value::as_i64))
    });
    Ok(json!({ "items": items }))
}

/// channel: backup:restore
/// 把 backup_file 解压回 saves（目标世界已存在则先改名加后缀防覆盖）。
/// 返回 { ok, error?, saveName }
#[tauri::command(rename = "backup:restore")]
pub fn backup_restore(game_dir: String, backup_file: String) -> CmdResult<Value> {
    let work = || -> CmdResult<Value> {
        let game = PathBuf::from(&game_dir);
        let backups = backups_dir(&game_dir);
        let bk_c = fs::canonicalize(&backups).unwrap_or_else(|_| backups.clone());
        let f_c = fs::canonicalize(&backup_file).map_err(|_| AppError::Msg("备份文件不存在".to_string()))?;
        if !f_c.starts_with(&bk_c) {
            return Err(AppError::Msg("非法路径".to_string()));
        }
        let file_name = f_c
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let save_name = save_name_from_zip(&file_name);
        if save_name.is_empty() {
            return Err(AppError::Msg("无法识别备份对应的世界".to_string()));
        }

        // 临时解压目录放在 backups 内（与 saves 同盘，rename 才可靠）
        let staging = backups.join(format!(".restore_staging_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&staging)?;

        let result: CmdResult<()> = (|| {
            // 解压
            let f = fs::File::open(&f_c)?;
            let mut archive = zip::ZipArchive::new(f).map_err(|e| AppError::Msg(e.to_string()))?;
            for i in 0..archive.len() {
                let mut entry = archive
                    .by_index(i)
                    .map_err(|e| AppError::Msg(e.to_string()))?;
                let name = entry.name().to_string();
                // 防路径穿越：跳过绝对路径 / .. / Windows 盘符
                if name.contains("..") || name.starts_with('/') || name.contains(':') {
                    continue;
                }
                let rel = Path::new(&name);
                let out = staging.join(rel);
                if entry.is_dir() {
                    fs::create_dir_all(&out)?;
                } else {
                    if let Some(p) = out.parent() {
                        fs::create_dir_all(p)?;
                    }
                    let mut outf = fs::File::create(&out)?;
                    io::copy(&mut entry, &mut outf)?;
                }
            }

            // 定位真实根：staging 直接含 level.dat，否则退化为唯一子目录
            let mut root = staging.clone();
            if !root.join("level.dat").exists() {
                let subs: Vec<PathBuf> = fs::read_dir(&root)?
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .collect();
                if subs.len() == 1 {
                    root = subs.into_iter().next().unwrap();
                }
            }

            // 目标世界已存在 → 改名加后缀，防覆盖
            let saves = game.join("saves");
            fs::create_dir_all(&saves)?;
            let target = saves.join(&save_name);
            if target.exists() {
                let renamed = saves.join(format!("{save_name}_restored_{}", ts_now()));
                fs::rename(&target, &renamed)?;
            }

            fs::rename(&root, &target)?;
            Ok(())
        })();

        // 清理临时目录（root 已被移走时忽略错误）
        let _ = fs::remove_dir_all(&staging);

        result?;
        Ok(json!({ "ok": true, "saveName": save_name }))
    };
    match work() {
        Ok(v) => Ok(v),
        Err(e) => Ok(fail(e)),
    }
}

/// channel: backup:delete
/// 删除备份文件。返回 { ok, error? }
#[tauri::command(rename = "backup:delete")]
pub fn backup_delete(game_dir: String, backup_file: String) -> CmdResult<Value> {
    let work = || -> CmdResult<()> {
        let backups = backups_dir(&game_dir);
        let bk_c = fs::canonicalize(&backups).unwrap_or_else(|_| backups.clone());
        let f_c = fs::canonicalize(&backup_file).map_err(|_| AppError::Msg("备份文件不存在".to_string()))?;
        if !f_c.starts_with(&bk_c) {
            return Err(AppError::Msg("非法路径".to_string()));
        }
        fs::remove_file(&f_c)?;
        Ok(())
    };
    match work() {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(e) => Ok(fail(e)),
    }
}

/* ---------- 自动备份 ---------- */

fn auto_opts() -> Value {
    let mut opts = json!({
        "enabled": false,
        "intervalHours": 6,
        "keep": 5,
        "onExit": true,
        "lastRunAt": 0,
    });
    if let (Value::Object(dst), Value::Object(src)) = (&mut opts, crate::config::get("autoBackup")) {
        for (k, v) in src {
            dst.insert(k, v);
        }
    }
    opts
}

fn auto_game_dir() -> String {
    let sel = crate::config::get("selectedInstance").as_str().unwrap_or("").to_string();
    let insts = crate::config::get("instances");
    insts
        .get(&sel)
        .and_then(|v| v.get("gameDir"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| crate::config::get("gameDir").as_str().map(str::to_string))
        .unwrap_or_default()
}

/// channel: autobackup:opts
#[tauri::command(rename = "autobackup:opts")]
pub fn autobackup_opts() -> CmdResult<Value> {
    Ok(auto_opts())
}

/// channel: autobackup:save
#[tauri::command(rename = "autobackup:save")]
pub fn autobackup_save(patch: Value) -> CmdResult<Value> {
    let mut opts = auto_opts();
    if let (Value::Object(dst), Value::Object(src)) = (&mut opts, patch) {
        for (k, v) in src {
            dst.insert(k, v);
        }
    }
    crate::config::set("autoBackup", opts.clone());
    Ok(opts)
}

/// channel: autobackup:run
#[tauri::command(rename = "autobackup:run")]
pub fn autobackup_run() -> CmdResult<Value> {
    let game_dir = auto_game_dir();
    if game_dir.is_empty() {
        return Ok(fail("没有游戏目录"));
    }
    let saves_root = PathBuf::from(&game_dir).join("saves");
    let mut saves = Vec::new();
    if let Ok(rd) = fs::read_dir(&saves_root) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() && path.join("level.dat").is_file() {
                saves.push(e.file_name().to_string_lossy().to_string());
            }
        }
    }
    if saves.is_empty() {
        return Ok(fail("没有可备份的存档"));
    }

    let mut made = Vec::new();
    for save in &saves {
        if let Ok(v) = backup_create(game_dir.clone(), save.clone()) {
            if v.get("ok").and_then(Value::as_bool) == Some(true) {
                if let Some(file) = v.get("file").and_then(Value::as_str) {
                    made.push(file.to_string());
                }
            }
        }
    }

    let keep = std::cmp::max(1, auto_opts().get("keep").and_then(Value::as_u64).unwrap_or(5)) as usize;
    let mut removed = 0usize;
    if let Ok(v) = backup_list(game_dir.clone()) {
        let mut groups: HashMap<String, Vec<Value>> = HashMap::new();
        if let Some(items) = v.get("items").and_then(Value::as_array) {
            for it in items {
                if let Some(name) = it.get("saveName").and_then(Value::as_str) {
                    groups.entry(name.to_string()).or_default().push(it.clone());
                }
            }
        }
        for mut list in groups.into_values() {
            list.sort_by(|a, b| {
                b.get("mtime").and_then(Value::as_i64).cmp(&a.get("mtime").and_then(Value::as_i64))
            });
            for it in list.into_iter().skip(keep) {
                if let Some(file) = it.get("file").and_then(Value::as_str) {
                    if let Ok(r) = backup_delete(game_dir.clone(), file.to_string()) {
                        if r.get("ok").and_then(Value::as_bool) == Some(true) { removed += 1; }
                    }
                }
            }
        }
    }

    let mut opts = auto_opts();
    if let Value::Object(m) = &mut opts {
        m.insert("lastRunAt".into(), json!(chrono::Local::now().timestamp_millis()));
    }
    crate::config::set("autoBackup", opts);
    Ok(json!({ "ok": true, "count": made.len(), "removed": removed, "files": made }))
}
