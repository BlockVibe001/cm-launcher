//! 实例管理：与 Electron 版 minecraft/instances.js 对齐。

use crate::config;
use serde_json::{Map, Value};

pub fn list_instances() -> Value {
    config::get("instances")
}

pub fn get_instance(id: &str) -> Option<Value> {
    list_instances().get(id).cloned()
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
}
