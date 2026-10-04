//! 配置模块：与 Electron 版 src/main/config.js 逐行对齐。
//! 读写同一个文件 %APPDATA%\cm-minecraft-launcher\config.json，
//! 迁移期两个版本交替打开互不丢数据。

use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

static CACHE: OnceLock<RwLock<Value>> = OnceLock::new();

fn appdata() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| String::from(".")))
}

/// 用户数据目录：与 Electron 版 app.getPath('userData') 钉死的目录一致
pub fn user_data_dir() -> PathBuf {
    appdata().join("cm-minecraft-launcher")
}

pub fn config_path() -> PathBuf {
    user_data_dir().join("config.json")
}

fn defaults() -> Value {
    json!({
        "gameDir": appdata().join(".minecraft").to_string_lossy(),
        "javaPath": "",
        "minMemory": 512,
        "maxMemory": 4096,
        "width": 854,
        "height": 480,
        "jvmArgs": "",
        "speedBoost": true,           // 游戏加速：自适应堆 + G1 调优参数 + 提升进程优先级
        "mirror": "bmcl",
        "showSnapshots": false,
        "selectedInstance": "default",
        "instances": {
            "default": {
                "name": "默认",
                "versionId": "",
                // 空串 = 跟随全局 gameDir（与 config.js 注释一致）
                "gameDir": "",
                "modLoader": "vanilla",
                "loaderVersion": "",
                "javaPath": "",
                "memory": null,
                "jvmArgs": "",
                "icon": "⛏",
            }
        },
        "account": null,
        "accounts": [],
        "skinHistory": [],
        "accent": "axolotl",
        "theme": "dark",
        "wallpaperType": "builtin",
        "wallpaperUrl": "",
        "wallpaperKind": "",
        "wallpaperLive": "",
        "ui": {
            "glassLevel": 55,
            "glassMaterial": "custom",
            "glassAuto": true,
            "density": "normal",
            "aura": "std",
        },
        "servers": [],
        "easytierNodes": [],
        "browserDownloadMode": "auto",
        "browserBookmarks": null,
        "skinStations": [
            { "name": "LittleSkin", "authUrl": "https://littleskin.cn/api/yggdrasil" },
            { "name": "BlessingSkin 自建", "authUrl": "" },
        ],
        "activeSkinStation": "LittleSkin",
        "ai": {
            "baseUrl": "https://api.openai.com/v1",
            "apiKey": "",
            "model": "gpt-4o-mini",
        },
        "recentSchematics": [],
        "recipeNamespace": "cm_craft",
        "recipePackFormat": 15,
        "homeMode": "widget",
        "homeWidgets": [
            { "id": "greeting", "visible": true, "span": 2 },
            { "id": "pinnedInstances", "visible": true, "span": 1 },
            { "id": "pinnedWorlds", "visible": true, "span": 1 },
            { "id": "pinnedServers", "visible": true, "span": 1 },
            { "id": "recentWorlds", "visible": true, "span": 1 },
            { "id": "calendar", "visible": true, "span": 1 },
            { "id": "news", "visible": true, "span": 1 },
            { "id": "stats", "visible": true, "span": 2 },
        ],
        "update": { "url": "", "autoCheck": true, "lastCheckAt": 0 },
        "pinned": { "instances": [], "servers": [], "worlds": [] },
        "playLog": {},
        "newsCache": null,
        "newsCacheAt": 0,
        "islandEnabled": false,
    })
}

/// 与 JS deepMerge 一致：两边都是纯对象才递归，其余（含数组）直接覆盖
fn deep_merge(base: &Value, over: &Value) -> Value {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            let mut out = b.clone();
            for (k, v) in o {
                let merged = match (out.get(k), v) {
                    (Some(bv @ Value::Object(_)), Value::Object(_)) => deep_merge(bv, v),
                    _ => v.clone(),
                };
                out.insert(k.clone(), merged);
            }
            Value::Object(out)
        }
        _ => over.clone(),
    }
}

fn obj_mut<'a>(v: &'a mut Value, key: &str) -> Option<&'a mut Map<String, Value>> {
    v.get_mut(key)?.as_object_mut()
}

/// 与 JS sanitize 一致：纠正老配置里废弃/非法的取值
fn sanitize(c: &mut Value) {
    const THEMES: [&str; 4] = ["dark", "light", "oled", "system"];
    let theme_ok = c.get("theme").and_then(Value::as_str).map(|t| THEMES.contains(&t)).unwrap_or(false);
    if !theme_ok {
        c["theme"] = json!("dark");
    }

    // ---- ui ----
    if c.get("ui").is_none() || !c["ui"].is_object() {
        c["ui"] = json!({});
    }
    if let Some(ui) = obj_mut(c, "ui") {
        let density_ok = ui.get("density").and_then(Value::as_str).map(|d| ["compact", "normal", "cozy"].contains(&d)).unwrap_or(false);
        if !density_ok {
            ui.insert("density".into(), json!("normal"));
        }
        let aura_ok = ui.get("aura").and_then(Value::as_str).map(|a| ["off", "soft", "std", "strong"].contains(&a)).unwrap_or(false);
        if !aura_ok {
            ui.insert("aura".into(), json!("std"));
        }
        let g = ui.get("glassLevel").and_then(Value::as_f64);
        let g = match g {
            Some(g) if g.is_finite() => g.clamp(0.0, 100.0).round(),
            _ => 55.0,
        };
        ui.insert("glassLevel".into(), json!(g as i64));
        // 档位只认这四个；认不出来的回落「自定义」（与 JS 注释一致）
        let mat = ui.get("glassMaterial").and_then(Value::as_str).unwrap_or("custom");
        if !["custom", "clear", "acrylic", "solid"].contains(&mat) {
            ui.insert("glassMaterial".into(), json!("custom"));
        }
        // 档位与滑杆值必须自洽，否则回落自定义
        let mat = ui.get("glassMaterial").and_then(Value::as_str).unwrap_or("custom");
        if mat != "custom" {
            let preset = match mat {
                "clear" => 100,
                "acrylic" => 45,
                "solid" => 4,
                _ => 55,
            };
            let cur = ui.get("glassLevel").and_then(Value::as_i64).unwrap_or(55);
            if cur != preset {
                ui.insert("glassMaterial".into(), json!("custom"));
            }
        }
        let auto = ui.get("glassAuto").map(|v| v != &Value::Bool(false)).unwrap_or(true);
        ui.insert("glassAuto".into(), json!(auto));
        ui.remove("glass"); // 旧字符串档位已废弃
    }

    // ---- 账号列表兜底 ----
    if !c.get("accounts").map(Value::is_array).unwrap_or(false) {
        c["accounts"] = json!([]);
    }
    if !c.get("skinHistory").map(Value::is_array).unwrap_or(false) {
        c["skinHistory"] = json!([]);
    }
    let acc_uuid = c.get("account").and_then(|a| a.get("uuid")).and_then(Value::as_str).map(str::to_string);
    if let Some(uuid) = acc_uuid {
        let exists = c["accounts"].as_array().map(|l| {
            l.iter().any(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()))
        }).unwrap_or(false);
        if !exists {
            let acc = c["account"].clone();
            if let Some(list) = c["accounts"].as_array_mut() {
                list.push(acc);
            }
        }
    }

    // ---- 皮肤站地址纠错（littleservice.cn 是当年写错的地址）----
    if let Some(stations) = c.get_mut("skinStations").and_then(Value::as_array_mut) {
        for s in stations.iter_mut() {
            if let Some(url) = s.get("authUrl").and_then(Value::as_str) {
                if url.to_lowercase().contains("littleservice.cn") {
                    s["authUrl"] = json!("https://littleskin.cn/api/yggdrasil");
                }
            }
        }
    }

    c["speedBoost"] = json!(c.get("speedBoost") != Some(&Value::Bool(false)));

    // 默认实例必须跟随全局游戏目录：值等于旧默认路径时清空交回全局
    let old_default = appdata().join(".minecraft").to_string_lossy().to_string();
    if let Some(insts) = obj_mut(c, "instances") {
        if let Some(def) = insts.get_mut("default") {
            if def.get("gameDir").and_then(Value::as_str) == Some(old_default.as_str()) {
                def["gameDir"] = json!("");
            }
        }
    }

    c["islandEnabled"] = json!(c.get("islandEnabled") == Some(&Value::Bool(true)));
    let kind_ok = c.get("wallpaperKind").and_then(Value::as_str)
        .map(|k| ["", "image", "animated", "video", "live"].contains(&k)).unwrap_or(true);
    if !kind_ok {
        c["wallpaperKind"] = json!("");
    }
    if c.get("wallpaperType").and_then(Value::as_str) != Some("custom") {
        c["wallpaperType"] = json!("builtin");
    }

    // ---- 更新配置兜底 ----
    if c.get("update").is_none() || !c["update"].is_object() {
        c["update"] = json!({});
    }
    if let Some(up) = obj_mut(c, "update") {
        let url = up.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
        up.insert("url".into(), json!(url));
        let t = up.get("lastCheckAt").and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0);
        up.insert("lastCheckAt".into(), json!(t));
        let auto = up.get("autoCheck").map(|v| v != &Value::Bool(false)).unwrap_or(true);
        up.insert("autoCheck".into(), json!(auto));
    }
}

/// 从磁盘读取配置：重试 3 次（防共享冲突），UTF-8 失败再按 UTF-16/GBK 解码。
/// 任何失败都记日志，绝不再「静默」回退空配置。
fn read_from_disk() -> Option<Value> {
    let path = config_path();
    let mut last_err = String::new();
    for attempt in 0..3u32 {
        match fs::read(&path) {
            Ok(bytes) => {
                // 1) UTF-8（含 BOM）
                let text: String = match std::str::from_utf8(&bytes) {
                    Ok(s) => s.trim_start_matches('\u{feff}').to_string(),
                    Err(_) => {
                        // 2) UTF-16 LE/BE BOM
                        if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
                            let le = bytes[0] == 0xFF;
                            let u16s: Vec<u16> = bytes[2..]
                                .chunks_exact(2)
                                .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
                                .collect();
                            String::from_utf16_lossy(&u16s)
                        } else {
                            // 3) GBK/GB18030（中文 Windows 常见的非 UTF-8 配置来源）
                            let (dec, _enc, had_errors) = encoding_rs::GBK.decode(&bytes);
                            if had_errors {
                                last_err = "GBK 解码仍有错误字节".into();
                                continue;
                            }
                            dec.into_owned()
                        }
                    }
                };
                match serde_json::from_str::<Value>(&text) {
                    Ok(v) if v.is_object() => return Some(v),
                    Ok(_) => last_err = "配置不是 JSON 对象".into(),
                    Err(e) => last_err = format!("JSON 解析失败：{e}"),
                }
            }
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return None;
                }
                last_err = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(120 * (attempt as u64 + 1)));
            }
        }
    }
    crate::logger::warn(&format!("配置读取失败：{last_err}"));
    None
}

fn ensure() {
    if CACHE.get().is_some() {
        return;
    }
    let mut data: Value = match read_from_disk() {
        Some(v) => v,
        None => {
            // 只有文件不存在才允许空配置；其余损坏也要让用户知道
            let exists = config_path().exists();
            crate::logger::warn(if exists {
                "配置文件无法读取，已使用默认配置（不会覆盖原文件之外的数据）"
            } else {
                "未找到配置文件，将创建默认配置"
            });
            json!({})
        }
    };

    // 玩家删掉默认实例后 deepMerge 会把它合回来（重启复活），记住这种情形合并完再删
    let default_removed = data.get("instances")
        .and_then(Value::as_object)
        .map(|m| !m.contains_key("default"))
        .unwrap_or(false);

    let mut c = deep_merge(&defaults(), &data);
    sanitize(&mut c);
    if default_removed {
        if let Some(insts) = obj_mut(&mut c, "instances") {
            insts.remove("default");
        }
    }

    // selectedInstance 兜底：指向已删除实例时落到剩余第一个，全删光则置空
    let ids: Vec<String> = c.get("instances").and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect()).unwrap_or_default();
    let sel = c.get("selectedInstance").and_then(Value::as_str).unwrap_or("").to_string();
    if !ids.iter().any(|i| *i == sel) {
        c["selectedInstance"] = json!(ids.first().cloned().unwrap_or_default());
    }

    data = c;
    let _ = CACHE.set(RwLock::new(data));
}

fn with_cache<R>(f: impl FnOnce(&mut Value) -> R) -> R {
    ensure();
    let lock = CACHE.get().unwrap();
    let mut guard = lock.write().unwrap();
    f(&mut guard)
}

pub fn save() {
    let data = with_cache(|c| c.clone());
    let path = config_path();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    // to_string_pretty 与 JSON.stringify(x, null, 2) 同为两空格缩进
    if let Ok(s) = serde_json::to_string_pretty(&data) {
        let _ = fs::write(path, s);
    }
}

pub fn get_all() -> Value {
    with_cache(|c| c.clone())
}

#[allow(dead_code)]
pub fn get(key: &str) -> Value {
    with_cache(|c| c.get(key).cloned().unwrap_or(Value::Null))
}

pub fn set(key: &str, value: Value) {
    with_cache(|c| {
        if let Value::Object(m) = c {
            m.insert(key.to_string(), value);
        }
    });
    save();
}

pub fn update(obj: Map<String, Value>) {
    with_cache(|c| {
        if let Value::Object(m) = c {
            for (k, v) in obj {
                m.insert(k, v);
            }
        }
    });
    save();
}

/// 设置当前账号并按 uuid 同步进多账号列表（与 config.js setAccount 一致）：
/// 同名账号重新登录时保留旧对象上绑定的皮肤等字段。
#[allow(dead_code)]
pub fn set_account(acc: Value) -> Value {
    let result = with_cache(|c| {
        let mut cur = acc;
        if let Some(uuid) = cur.get("uuid").and_then(Value::as_str).map(str::to_string) {
            let list = c.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut list = list;
            if let Some(idx) = list.iter().position(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str())) {
                // 旧的在前：旧字段（皮肤等）保留，新字段覆盖
                let mut merged = list[idx].clone();
                if let (Some(old_m), Some(new_m)) = (merged.as_object_mut(), cur.as_object()) {
                    for (k, v) in new_m {
                        old_m.insert(k.clone(), v.clone());
                    }
                }
                list[idx] = merged.clone();
                cur = merged;
            } else {
                list.push(cur.clone());
            }
            c["accounts"] = json!(list);
        }
        c["account"] = cur.clone();
        cur
    });
    save();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_merge_objects_recurse_arrays_overwrite() {
        let base = json!({"a": {"x": 1, "y": 2}, "b": [1, 2], "c": 3});
        let over = json!({"a": {"y": 20}, "b": [9], "c": {"nested": true}});
        let m = deep_merge(&base, &over);
        assert_eq!(m["a"]["x"], json!(1));
        assert_eq!(m["a"]["y"], json!(20));
        assert_eq!(m["b"], json!([9]));
        assert_eq!(m["c"], json!({"nested": true}));
    }

    #[test]
    fn sanitize_presets_consistency() {
        let mut c = json!({"ui": {"glassLevel": 45, "glassMaterial": "acrylic"}});
        sanitize(&mut c);
        // 档位与滑杆自洽 → 保持 acrylic
        assert_eq!(c["ui"]["glassMaterial"], json!("acrylic"));
        let mut c2 = json!({"ui": {"glassLevel": 59, "glassMaterial": "solid"}});
        sanitize(&mut c2);
        // 不自洽 → 回落自定义
        assert_eq!(c2["ui"]["glassMaterial"], json!("custom"));
    }
}
