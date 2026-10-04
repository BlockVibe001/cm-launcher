//! 模组管理：列出 / 启用禁用 / 删除。
//! 对齐 Electron 版 minecraft/mods.js。

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn mods_dir(game_dir: &str) -> PathBuf {
    Path::new(game_dir).join("mods")
}

pub fn list(game_dir: &str) -> Value {
    let dir = mods_dir(game_dir);
    let mut items: Vec<Value> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jar")
                && !name.ends_with(".disabled")
                && !name.ends_with(".zip")
            {
                continue;
            }
            let full = dir.join(&name);
            let metadata = match fs::metadata(&full) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !metadata.is_file() {
                continue;
            }
            let disabled = name.ends_with(".disabled");
            items.push(json!({
                "name": name,
                "disabled": disabled,
                "size": metadata.len(),
                "path": full.to_string_lossy(),
            }));
        }
    }
    items.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Value::Array(items)
}

pub fn set_enabled(game_dir: &str, file_name: &str, enabled: bool) -> Result<(), String> {
    let dir = mods_dir(game_dir);
    let current = dir.join(file_name);
    if !current.exists() {
        return Err("Mod 文件不存在".into());
    }
    let target = if enabled {
        let new_name = file_name.trim_end_matches(".disabled");
        dir.join(new_name)
    } else if file_name.ends_with(".disabled") {
        current.clone()
    } else {
        dir.join(format!("{file_name}.disabled"))
    };
    if current != target {
        fs::rename(&current, &target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn delete(game_dir: &str, file_name: &str) -> Result<(), String> {
    let file = mods_dir(game_dir).join(file_name);
    if file.exists() {
        fs::remove_file(&file).map_err(|e| e.to_string())?;
    }
    Ok(())
}
