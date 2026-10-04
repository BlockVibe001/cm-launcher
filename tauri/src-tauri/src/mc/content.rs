//! 实例内容扫描：资源包 / 光影 / 存档 / 截图 / 日志。
//! 对齐 Electron 版 minecraft/content.js。

use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

fn sub(game_dir: &str, parts: &[&str]) -> PathBuf {
    let mut p = PathBuf::from(game_dir);
    for part in parts {
        p.push(part);
    }
    p
}

/// 递归计算目录大小（深度上限 3）
fn dir_size(dir: &Path, depth: u32) -> u64 {
    if depth > 3 {
        return 0;
    }
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let full = entry.path();
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.is_dir() {
                total += dir_size(&full, depth + 1);
            } else {
                total += md.len();
            }
        }
    }
    total
}

/* ---------- options.txt ---------- */

fn parse_options_txt(game_dir: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if let Ok(text) = fs::read_to_string(sub(game_dir, &["options.txt"])) {
        for line in text.split(['\r', '\n']) {
            if let Some(i) = line.find(':') {
                let key = line[..i].to_string();
                let val = line[i + 1..].to_string();
                out.insert(key, val);
            }
        }
    }
    out
}

fn write_option(game_dir: &str, key: &str, value: &str) {
    let p = sub(game_dir, &["options.txt"]);
    let mut lines: Vec<String> = Vec::new();
    if let Ok(text) = fs::read_to_string(&p) {
        lines = text.split(['\r', '\n']).map(|s| s.to_string()).collect();
    }
    let prefix = format!("{key}:");
    let mut found = false;
    for line in lines.iter_mut() {
        if line.starts_with(&prefix) {
            *line = format!("{key}:{value}");
            found = true;
            break;
        }
    }
    if !found {
        lines.push(format!("{key}:{value}"));
    }
    let _ = fs::write(&p, lines.join("\n"));
}

/* ---------- properties ---------- */

fn read_prop(file: &Path) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if let Ok(text) = fs::read_to_string(file) {
        for line in text.split(['\r', '\n']) {
            if let Some(i) = line.find('=') {
                out.insert(line[..i].to_string(), line[i + 1..].to_string());
            }
        }
    }
    out
}

fn write_prop(file: &Path, key: &str, value: &str) {
    let mut lines: Vec<String> = Vec::new();
    if let Ok(text) = fs::read_to_string(file) {
        lines = text.split(['\r', '\n']).map(|s| s.to_string()).collect();
    }
    let prefix = format!("{key}=");
    let mut found = false;
    for line in lines.iter_mut() {
        if line.starts_with(&prefix) {
            *line = format!("{key}={value}");
            found = true;
            break;
        }
    }
    if !found {
        lines.push(format!("{key}={value}"));
    }
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(file, lines.join("\n"));
}

/* ---------- 资源包 ---------- */

pub fn list_resource_packs(game_dir: &str) -> Value {
    let dir = sub(game_dir, &["resourcepacks"]);
    let opts = parse_options_txt(game_dir);
    let mut enabled = std::collections::HashSet::new();
    if let Some(rp) = opts.get("resourcePacks") {
        if let Ok(arr) = serde_json::from_str::<Vec<Value>>(rp) {
            for v in arr {
                if let Some(s) = v.as_str() {
                    enabled.insert(s.trim_start_matches("file/").to_string());
                }
            }
        }
    }

    let mut items: Vec<Value> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let full = dir.join(&name);
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_zip = name.to_lowercase().ends_with(".zip");
            if !md.is_dir() && !is_zip {
                continue;
            }
            let size = if md.is_dir() { dir_size(&full, 0) } else { md.len() };
            let icon = if md.is_dir() {
                let ic = full.join("pack.png");
                if ic.exists() {
                    Some(ic.to_string_lossy().to_string())
                } else {
                    None
                }
            } else {
                None
            };
            items.push(json!({
                "name": name,
                "type": if md.is_dir() { "folder" } else { "zip" },
                "enabled": enabled.contains(&name),
                "size": size,
                "icon": icon,
                "path": full.to_string_lossy(),
            }));
        }
    }
    Value::Array(items)
}

pub fn toggle_resource_pack(game_dir: &str, name: &str, on: bool) -> Value {
    let opts = parse_options_txt(game_dir);
    let mut list: Vec<String> = Vec::new();
    if let Some(rp) = opts.get("resourcePacks") {
        if let Ok(arr) = serde_json::from_str::<Vec<Value>>(rp) {
            for v in arr {
                if let Some(s) = v.as_str() {
                    let clean = s.trim_start_matches("file/").to_string();
                    if clean != name {
                        list.push(s.to_string());
                    }
                }
            }
        }
    }
    if on {
        list.push(format!("file/{name}"));
    }
    write_option(game_dir, "resourcePacks", &serde_json::to_string(&list).unwrap_or_default());
    list_resource_packs(game_dir)
}

/* ---------- 光影 ---------- */

fn current_shader_pack(game_dir: &str) -> String {
    let iris = read_prop(&sub(game_dir, &["config", "iris.properties"]));
    if let Some(s) = iris.get("shaderPack") {
        if !s.is_empty() {
            return s.clone();
        }
    }
    let of = read_prop(&sub(game_dir, &["optionsshaders.txt"]));
    of.get("shaderPack").cloned().unwrap_or_default()
}

pub fn list_shader_packs(game_dir: &str) -> Value {
    let dir = sub(game_dir, &["shaderpacks"]);
    let active = current_shader_pack(game_dir);
    let mut items: Vec<Value> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let full = dir.join(&name);
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_zip = name.to_lowercase().ends_with(".zip");
            if !md.is_dir() && !is_zip {
                continue;
            }
            let size = if md.is_dir() { dir_size(&full, 0) } else { md.len() };
            items.push(json!({
                "name": name,
                "type": if md.is_dir() { "folder" } else { "zip" },
                "enabled": active == name,
                "size": size,
                "path": full.to_string_lossy(),
            }));
        }
    }
    Value::Array(items)
}

pub fn enable_shader_pack(game_dir: &str, name: &str) -> Value {
    write_prop(&sub(game_dir, &["config", "iris.properties"]), "shaderPack", name);
    write_prop(&sub(game_dir, &["optionsshaders.txt"]), "shaderPack", name);
    list_shader_packs(game_dir)
}

/* ---------- 存档 ---------- */

pub fn list_saves(game_dir: &str) -> Value {
    let dir = sub(game_dir, &["saves"]);
    let mut items: Vec<Value> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let full = dir.join(&name);
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !md.is_dir() {
                continue;
            }
            let icon = full.join("icon.png");
            items.push(json!({
                "name": name,
                "path": full.to_string_lossy(),
                "lastPlayed": md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
                "size": dir_size(&full, 0),
                "icon": if icon.exists() { Some(icon.to_string_lossy().to_string()) } else { None },
                "hasLevel": full.join("level.dat").exists(),
            }));
        }
    }
    Value::Array(items)
}

/* ---------- 截图 ---------- */

pub fn list_screenshots(game_dir: &str) -> Value {
    let dir = sub(game_dir, &["screenshots"]);
    let mut items: Vec<Value> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if !lower.ends_with(".png") && !lower.ends_with(".jpg") && !lower.ends_with(".jpeg") {
                continue;
            }
            let full = dir.join(&name);
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            items.push(json!({
                "name": name,
                "path": full.to_string_lossy(),
                "size": md.len(),
                "mtime": md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
            }));
        }
    }
    Value::Array(items)
}

/* ---------- 日志 ---------- */

pub fn list_logs(game_dir: &str) -> Value {
    let mut items: Vec<Value> = Vec::new();
    let game_path = Path::new(game_dir);

    let mut push = |dir: &Path, rel: &str, kind: &str| {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let full = dir.join(&name);
                let md = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if !md.is_file() {
                    continue;
                }
                items.push(json!({
                    "name": name,
                    "rel": if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") },
                    "size": md.len(),
                    "mtime": md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
                    "kind": kind,
                }));
            }
        }
    };

    push(&game_path.join("logs"), "logs", "log");
    push(&game_path.join("crash-reports"), "crash-reports", "crash");

    // JVM 崩溃日志在游戏根目录
    if let Ok(entries) = fs::read_dir(game_path) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("hs_err_pid") || !name.ends_with(".log") {
                continue;
            }
            let full = game_path.join(&name);
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            items.push(json!({
                "name": name,
                "rel": name,
                "size": md.len(),
                "mtime": md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
                "kind": "jvm",
            }));
        }
    }
    Value::Array(items)
}

pub fn read_log_file(game_dir: &str, rel: &str, max_bytes: usize) -> Result<String, String> {
    let full = Path::new(game_dir).join(rel);
    let game_abs = Path::new(game_dir).canonicalize().map_err(|e| e.to_string())?;
    let full_abs = full.canonicalize().map_err(|e| e.to_string())?;
    if !full_abs.starts_with(&game_abs) {
        return Err("非法路径".into());
    }
    let mut buf = Vec::new();
    let mut f = fs::File::open(&full_abs).map_err(|e| e.to_string())?;
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if full_abs.to_string_lossy().ends_with(".gz") {
        use flate2::read::GzDecoder;
        let mut d = GzDecoder::new(&buf[..]);
        let mut out = Vec::new();
        d.read_to_end(&mut out).map_err(|e| e.to_string())?;
        buf = out;
    }
    let text = String::from_utf8_lossy(&buf).to_string();
    if text.len() > max_bytes {
        let start = text.len() - max_bytes;
        Ok(format!("…（仅显示最后 {}KB）\n{}", max_bytes / 1024, &text[start..]))
    } else {
        Ok(text)
    }
}

/* ---------- 删除 ---------- */

pub fn delete_in_dir(game_dir: &str, category: &str, name: &str) -> Result<(), String> {
    let folder = match category {
        "resourcepacks" => "resourcepacks",
        "shaderpacks" => "shaderpacks",
        "saves" => "saves",
        "screenshots" => "screenshots",
        _ => return Err("未知分类".into()),
    };
    let folder_path = Path::new(game_dir).join(folder);
    let full = folder_path.join(name);
    let folder_abs = folder_path.canonicalize().unwrap_or(folder_path.clone());
    let full_abs = full.canonicalize().unwrap_or(full.clone());
    if !full_abs.starts_with(&folder_abs) {
        return Err("非法路径".into());
    }
    if !full_abs.exists() {
        return Err("文件不存在".into());
    }
    if full_abs.is_dir() {
        fs::remove_dir_all(&full_abs).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&full_abs).map_err(|e| e.to_string())?;
    }
    Ok(())
}
