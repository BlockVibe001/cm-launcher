//! 实例管理：与 Electron 版 minecraft/instances.js 对齐。

use crate::config;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 递归复制目录（保留子目录结构，不跟随符号链接）
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_file() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

pub fn list_instances() -> Value {
    config::get("instances")
}

pub fn get_instance(id: &str) -> Option<Value> {
    list_instances().get(id).cloned()
}

/// 实例复制（clone）：深拷贝实例目录 → 新 id、新目录、「副本」命名，重置游玩统计。
pub fn copy_instance(id: &str) -> Value {
    let src = get_instance(id).unwrap_or(Value::Null);
    if src.is_null() {
        return Value::Null;
    }

    let src_obj = src.as_object().cloned().unwrap_or_default();
    let name = src_obj
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(id)
        .to_string();
    let src_dir = src_obj
        .get("gameDir")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // 唯一新 id（时间戳 36 进制风格，与前端 inst_ 前缀一致）
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let new_id = format!("inst_{:x}{:06x}", ts.as_secs(), ts.subsec_nanos());

    // 新目录：旧目录同级追加「-副本」；旧目录为空时落在基目录 instances/ 下
    let base = config::get("gameDir")
        .as_str()
        .unwrap_or_default()
        .to_string();
    let new_dir = if src_dir.is_empty() {
        format!("{}/instances/{new_id}", base.trim_end_matches(&['/', '\\'][..]))
    } else {
        format!("{}-副本", src_dir.trim_end_matches(&['/', '\\'][..]))
    };

    // 深拷贝目录（源不存在则不拷，记录仍可创建）
    let src_path = PathBuf::from(&src_dir);
    if src_path.exists() {
        let _ = copy_dir_recursive(&src_path, Path::new(&new_dir));
    }

    // 新记录 = 旧记录副本，改名/换目录/重置游玩统计
    let mut data = src;
    if let Some(m) = data.as_object_mut() {
        m.insert("name".into(), Value::String(format!("{name} 副本")));
        m.insert("gameDir".into(), Value::String(new_dir));
        m.remove("lastPlayedAt");
        m.remove("playTimeMs");
    }
    save_instance(&new_id, data)
}

pub fn save_instance(id: &str, data: Value) -> Value {
    let mut all = config::get("instances");
    let all_map = all.as_object_mut().expect("instances is object");

    let new_val = if all_map.contains_key(id) {
        // 已有：合并 data
        let mut existing = all_map[id].clone();
        if let (Some(e), Some(d)) = (existing.as_object_mut(), data.as_object()) {
            for (k, v) in d {
                e.insert(k.clone(), v.clone());
            }
        }
        existing
    } else {
        // 新建：默认字段 + data（data 优先）
        let d = data.as_object().cloned().unwrap_or_default();
        let name = d.get("name").and_then(Value::as_str).unwrap_or(id).to_string();
        let mut m = Map::new();
        m.insert("name".into(), Value::String(name));
        m.insert("versionId".into(), Value::String(d.get("versionId").and_then(Value::as_str).unwrap_or("").into()));
        m.insert("gameDir".into(), d.get("gameDir").cloned().unwrap_or(Value::Null));
        m.insert("modLoader".into(), Value::String(d.get("modLoader").and_then(Value::as_str).unwrap_or("vanilla").into()));
        m.insert("loaderVersion".into(), Value::String(d.get("loaderVersion").and_then(Value::as_str).unwrap_or("").into()));
        m.insert("javaPath".into(), Value::String(d.get("javaPath").and_then(Value::as_str).unwrap_or("").into()));
        m.insert("memory".into(), d.get("memory").cloned().unwrap_or(Value::Null));
        m.insert("jvmArgs".into(), Value::String(d.get("jvmArgs").and_then(Value::as_str).unwrap_or("").into()));
        m.insert("icon".into(), Value::String(d.get("icon").and_then(Value::as_str).unwrap_or("⛏").into()));
        for (k, v) in d {
            m.insert(k, v);
        }
        Value::Object(m)
    };

    all_map.insert(id.to_string(), new_val.clone());
    config::set("instances", Value::Object(all_map.clone()));
    new_val
}

pub fn delete_instance(id: &str) {
    // 先取实例记录：gameDir 用于删除实例目录（修复：原实现只删记录，几 GB 游戏文件残留磁盘）
    let game_dir = get_instance(id)
        .and_then(|v| v.get("gameDir").cloned())
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();

    let mut all = config::get("instances");
    if let Some(map) = all.as_object_mut() {
        map.remove(id);
        config::set("instances", Value::Object(map.clone()));
    }
    if config::get("selectedInstance").as_str() == Some(id) {
        // 选中的没了：落到剩余第一个；一个不剩置空，界面引导下载
        let rest: Vec<String> = config::get("instances").as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
        config::set("selectedInstance", Value::String(rest.first().cloned().unwrap_or_default()));
    }

    // 删除实例目录（安全白名单）：目录必须非空、绝对路径，canonicalize 后必须位于配置的实例基目录之下，
    // 防路径穿越——绝不删基目录之外的东西。删除失败（目录已不在/无权）不阻塞记录删除。
    if game_dir.is_empty() || !Path::new(&game_dir).is_absolute() {
        return;
    }
    let base = config::get("gameDir")
        .as_str()
        .unwrap_or_default()
        .to_string();
    if base.is_empty() {
        return;
    }
    match (fs::canonicalize(&game_dir), fs::canonicalize(&base)) {
        (Ok(dir_c), Ok(base_c)) if dir_c.starts_with(&base_c) => {
            let _ = fs::remove_dir_all(&dir_c);
        }
        _ => {}
    }
}
