//! 版本清单：与 Electron 版 minecraft/versions.js 对齐。
//! 优先读本地 versions/<id>/<id>.json（加载器版本只存在本地），
//! 带 inheritsFrom 的子版本与父版本合并。

use crate::error::{AppError, CmdResult};
use crate::net::{mirror::mirror_url, HTTP};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, RwLock};

static MANIFEST_CACHE: LazyLock<RwLock<Option<Value>>> = LazyLock::new(|| RwLock::new(None));

pub async fn get_manifest(force: bool) -> CmdResult<Value> {
    {
        let cache = MANIFEST_CACHE.read().unwrap();
        if !force {
            if let Some(m) = cache.as_ref() {
                return Ok(m.clone());
            }
        }
    }
    let url = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
    let res = HTTP.get(mirror_url(url)).send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("版本清单获取失败 (HTTP {})", res.status().as_u16())));
    }
    let data: Value = res.json().await.map_err(|e| AppError::Msg(e.to_string()))?;
    *MANIFEST_CACHE.write().unwrap() = Some(data.clone());
    Ok(data)
}

async fn get_version_detail(entry: &Value) -> CmdResult<Value> {
    let url = entry.get("url").and_then(Value::as_str).unwrap_or("");
    let res = HTTP.get(mirror_url(url)).send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("版本详情获取失败 (HTTP {})", res.status().as_u16())));
    }
    res.json().await.map_err(|e| AppError::Msg(e.to_string()))
}

/// 读本地 versions/<id>/<id>.json
pub fn read_local_version(game_dir: &Path, id: &str) -> Option<Value> {
    if game_dir.as_os_str().is_empty() || id.is_empty() {
        return None;
    }
    let path = game_dir.join("versions").join(id).join(format!("{id}.json"));
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

/// 库列表按 name 去重：后出现的（子版本）盖掉先出现的（父版本）
fn merge_libraries(parent: Option<&Value>, child: Option<&Value>) -> Value {
    let mut out: Vec<Value> = Vec::new();
    // key -> 位置
    let mut idx: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let libs: Vec<&Value> = parent.and_then(Value::as_array).map(|a| a.iter().collect::<Vec<_>>()).unwrap_or_default()
        .into_iter()
        .chain(child.and_then(Value::as_array).map(|a| a.iter().collect::<Vec<_>>()).unwrap_or_default())
        .collect();
    for lib in libs {
        let key = lib.get("name").and_then(Value::as_str).map(String::from)
            .unwrap_or_else(|| format!("__anon_{}", out.len()));
        if let Some(i) = idx.get(&key) {
            out[*i] = lib.clone();
        } else {
            idx.insert(key, out.len());
            out.push(lib.clone());
        }
    }
    Value::Array(out)
}

/// 子版本（Forge/Fabric/Quilt）与父版本合并成完整可启动清单
fn merge_inherited(child: &Value, parent: &Value) -> Value {
    let mut merged = parent.clone();
    // {...parent, ...child}：child 字段覆盖
    if let (Some(p), Some(c), Value::Object(out)) = (parent.as_object(), child.as_object(), &mut merged) {
        let _ = p;
        for (k, v) in c {
            out.insert(k.clone(), v.clone());
        }
    }
    merged["id"] = child.get("id").or_else(|| parent.get("id")).cloned().unwrap_or(Value::Null);
    merged["mainClass"] = child.get("mainClass").or_else(|| parent.get("mainClass")).cloned().unwrap_or(Value::Null);
    merged["libraries"] = merge_libraries(parent.get("libraries"), child.get("libraries"));

    let pa = parent.get("arguments");
    let ca = child.get("arguments");
    if pa.is_some() || ca.is_some() {
        let get_arr = |v: Option<&Value>, k: &str| {
            v.and_then(|a| a.get(k)).and_then(Value::as_array).cloned().unwrap_or_default()
        };
        let mut game = get_arr(pa, "game");
        game.extend(get_arr(ca, "game"));
        let mut jvm = get_arr(pa, "jvm");
        jvm.extend(get_arr(ca, "jvm"));
        merged["arguments"] = serde_json::json!({"game": game, "jvm": jvm});
    }
    if child.get("minecraftArguments").is_none() {
        if let Some(ma) = parent.get("minecraftArguments") {
            merged["minecraftArguments"] = ma.clone();
        }
    }
    merged["assetIndex"] = child.get("assetIndex").or_else(|| parent.get("assetIndex")).cloned().unwrap_or(Value::Null);
    merged["assets"] = child.get("assets").or_else(|| parent.get("assets")).cloned().unwrap_or(Value::Null);
    merged["downloads"] = child.get("downloads").or_else(|| parent.get("downloads")).cloned().unwrap_or(Value::Null);
    // 继承版（Fabric/Quilt meta API）自身不带 client jar，指向父版本的 client jar
    if let Some(client) = merged.get_mut("downloads").and_then(Value::as_object_mut) {
        if let Some(c) = client.get_mut("client").and_then(Value::as_object_mut) {
            if c.get("path").is_none() {
                let parent_id = parent.get("id").and_then(Value::as_str).unwrap_or("");
                c.insert("path".into(), json!(format!("versions/{parent_id}/{parent_id}.jar")));
            }
        }
    }
    merged["type"] = child.get("type").or_else(|| parent.get("type")).cloned().unwrap_or(Value::String("release".into()));
    merged
}

/// 解析版本清单：优先本地，本地没有再取官方清单（递归处理 inheritsFrom）
pub async fn resolve_version_detail(version_id: &str, game_dir: &Path) -> CmdResult<Value> {
    let local = read_local_version(game_dir, version_id);
    if let Some(local) = local {
        let inherits = local.get("inheritsFrom").and_then(Value::as_str).map(String::from);
        if let Some(parent_id) = inherits {
            if parent_id != version_id {
                let parent = Box::pin(resolve_version_detail(&parent_id, game_dir)).await?;
                return Ok(merge_inherited(&local, &parent));
            }
        }
        return Ok(local);
    }
    let manifest = get_manifest(false).await?;
    let entry = manifest
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|arr| arr.iter().find(|v| v.get("id").and_then(Value::as_str) == Some(version_id)));
    match entry {
        Some(e) => get_version_detail(e).await,
        None => Err(AppError::Msg(format!("版本清单中找不到版本：{version_id}"))),
    }
}

/// 列本地已装版本：含 jar 的目录，或只有 version.json 的继承版（Fabric/Quilt 经 meta API 安装）。
pub fn list_installed(game_dir: Option<&str>) -> Vec<String> {
    let default_dir = crate::config::get("gameDir").as_str().unwrap_or("").to_string();
    let root = game_dir.unwrap_or(&default_dir);
    let versions = PathBuf::from(root).join("versions");
    let Ok(entries) = std::fs::read_dir(&versions) else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            // 有同名 jar → 原版 / Forge / NeoForge / 自带 jar 的 Fabric
            if e.path().join(format!("{name}.jar")).exists() {
                return true;
            }
            // 只有 version.json 的继承版（meta API 装的 Fabric/Quilt）：json 存在且含 id
            let json = e.path().join(format!("{name}.json"));
            if json.exists() {
                if let Ok(s) = std::fs::read_to_string(&json) {
                    if let Ok(v) = serde_json::from_str::<Value>(&s) {
                        return v.get("id").is_some();
                    }
                }
            }
            false
        })
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect()
}
