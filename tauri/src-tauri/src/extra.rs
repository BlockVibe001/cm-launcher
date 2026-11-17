//! 补齐 Electron 版已有、Tauri 端还缺的少量系统能力：
//! options.txt 读写、实例目录占用统计、镜像健康探测、Horizon 版本列表/下载。

use crate::error::{AppError, CmdResult};
use crate::net::HTTP;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

const OPTION_FIELDS: &[(&str, &str, &str, &str)] = &[
    ("graphicsMode", "图像品质", "seg", "fancy"),
    ("renderDistance", "渲染距离", "range", "12"),
    ("simulationDistance", "模拟距离", "range", "12"),
    ("maxFps", "最大帧率", "range", "120"),
    ("enableVsync", "垂直同步", "switch", "true"),
    ("ao", "平滑光照", "switch", "true"),
    ("entityShadows", "实体阴影", "switch", "true"),
    ("renderClouds", "云", "seg", "true"),
    ("particles", "粒子效果", "seg", "all"),
    ("gamma", "亮度", "range", "0.5"),
    ("guiScale", "界面缩放", "seg", "0"),
    ("soundCategory_master", "主音量", "range", "1"),
    ("mipmapLevels", "mipmap 等级", "seg", "4"),
    ("pauseOnLostFocus", "失焦暂停", "switch", "true"),
    ("autoJump", "自动跳跃", "switch", "false"),
    ("fullscreen", "全屏", "switch", "false"),
];

fn options_path(game_dir: &str) -> PathBuf {
    Path::new(game_dir).join("options.txt")
}

fn default_value(kind: &str, def: &str) -> Value {
    if kind == "switch" { json!(def == "true") }
    else if kind == "range" { json!(def.parse::<f64>().unwrap_or(0.0)) }
    else { json!(def) }
}

fn field_json(key: &str, label: &str, kind: &str, def: &str) -> Value {
    let mut v = json!({ "key": key, "label": label, "kind": kind, "def": default_value(kind, def) });
    if kind == "range" {
        v["min"] = json!(0.0);
        v["max"] = json!(260.0);
        v["step"] = json!(1.0);
    }
    if key == "graphicsMode" {
        v["options"] = json!([["fast", "流畅"], ["fancy", "高品质"], ["fabulous", "极佳"]]);
    } else if key == "renderClouds" {
        v["options"] = json!([["false", "关"], ["fast", "流畅"], ["true", "精细"]]);
    } else if key == "particles" {
        v["options"] = json!([["minimal", "最少"], ["decreased", "减少"], ["all", "全部"]]);
    } else if key == "guiScale" {
        v["options"] = json!([["0", "自动"], ["1", "小"], ["2", "中"], ["3", "大"], ["4", "特大"]]);
    } else if key == "mipmapLevels" {
        v["options"] = json!([["0", "0"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]]);
    }
    v
}

fn read_values(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        if let Some(i) = line.find(':') {
            if i > 0 {
                map.insert(line[..i].to_string(), line[i + 1..].to_string());
            }
        }
    }
    map
}

fn unquote(s: &str) -> &str {
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') { &s[1..s.len() - 1] } else { s }
}

#[tauri::command(rename = "options:read")]
pub fn options_read(game_dir: Option<String>) -> CmdResult<Value> {
    let dir = game_dir.unwrap_or_default();
    let p = options_path(&dir);
    let text = std::fs::read_to_string(&p).unwrap_or_default();
    let exists = p.is_file();
    let map = read_values(&text);
    let mut fields = Vec::new();
    let mut values = Map::new();
    for (key, label, kind, def) in OPTION_FIELDS.iter().copied() {
        fields.push(field_json(key, label, kind, def));
        let raw = map.get(key).map(|s| unquote(s).to_string()).unwrap_or_default();
        let v = if raw.is_empty() {
            default_value(kind, def)
        } else if kind == "switch" {
            json!(raw.eq_ignore_ascii_case("true") || raw == "1")
        } else if kind == "range" {
            json!(raw.parse::<f64>().unwrap_or_else(|_| def.parse::<f64>().unwrap_or(0.0)))
        } else {
            json!(raw)
        };
        values.insert(key.to_string(), v);
    }
    Ok(json!({
        "exists": exists,
        "path": p.to_string_lossy(),
        "fields": fields,
        "values": Value::Object(values),
        "extraKeys": map.len().saturating_sub(OPTION_FIELDS.len()),
    }))
}

#[tauri::command(rename = "options:apply")]
pub fn options_apply(game_dir: Option<String>, patch: Map<String, Value>) -> CmdResult<Value> {
    let dir = game_dir.unwrap_or_default();
    if dir.is_empty() { return Err(AppError::Msg("没有可用的游戏目录".into())); }
    let p = options_path(&dir);
    let text = std::fs::read_to_string(&p).unwrap_or_default();
    let nl = if text.contains("\r\n") { "\r\n" } else if text.contains('\n') { "\n" } else { "\r\n" };
    let had_trailing = text.ends_with('\n');
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let mut wanted: HashMap<String, String> = HashMap::new();
    for (key, val) in patch {
        if !OPTION_FIELDS.iter().any(|(k, _, _, _)| *k == key) { continue; }
        let kind = OPTION_FIELDS.iter().find(|(k, _, _, _)| *k == key).map(|(_, _, k, _)| *k).unwrap_or("seg");
        let out = if kind == "switch" {
            (val == json!(true) || val.as_str().map(|s| s == "true" || s == "1").unwrap_or(false)).to_string()
        } else if kind == "range" {
            let n = val.as_f64().unwrap_or(0.0);
            let n = n.clamp(0.0, 260.0);
            format!("{n}")
        } else {
            val.as_str().map(str::to_string).unwrap_or_else(|| val.to_string()).trim_matches('"').to_string()
        };
        wanted.insert(key, out);
    }
    if wanted.is_empty() { return Err(AppError::Msg("没有需要写入的设置项".into())); }
    let mut applied = Map::new();
    for line in lines.iter_mut() {
        if let Some(i) = line.find(':') {
            if i > 0 {
                let key = line[..i].to_string();
                if let Some(v) = wanted.get(&key) {
                    let v = v.clone();
                    *line = format!("{key}:{v}");
                    applied.insert(key, json!(v));
                }
            }
        }
    }
    for (key, v) in wanted {
        if !applied.contains_key(&key) {
            lines.push(format!("{key}:{v}"));
            applied.insert(key, json!(v));
        }
    }
    if !text.is_empty() && !p.with_extension("txt.bak").exists() {
        let _ = std::fs::write(p.with_extension("txt.bak"), &text);
    }
    let mut out = lines.join(nl);
    if had_trailing || text.is_empty() { out.push_str(nl); }
    std::fs::write(&p, out)?;
    Ok(json!({ "ok": true, "path": p.to_string_lossy(), "applied": Value::Object(applied.clone()), "count": applied.len() }))
}

fn dir_size(path: &Path, budget: &mut u64) -> u64 {
    if *budget > 400_000 { return 0; }
    let Ok(rd) = std::fs::read_dir(path) else { return 0; };
    let mut total = 0u64;
    for e in rd.flatten() {
        if *budget > 400_000 { break; }
        let p = e.path();
        let Ok(md) = e.metadata() else { continue; };
        if md.is_dir() { total += dir_size(&p, budget); }
        else if md.is_file() { total += md.len(); *budget += 1; }
    }
    total
}

#[tauri::command(rename = "instances:usage")]
pub fn instances_usage(game_dir: Option<String>) -> CmdResult<Value> {
    let dir = game_dir.unwrap_or_default();
    let root = Path::new(&dir);
    if dir.is_empty() || !root.is_dir() {
        return Ok(json!({ "gameDir": dir, "exists": false, "total": 0, "parts": [] }));
    }
    let parts = [
        ("mods", "模组", vec!["mods"]),
        ("saves", "存档", vec!["saves"]),
        ("resourcepacks", "资源包", vec!["resourcepacks"]),
        ("shaderpacks", "光影", vec!["shaderpacks"]),
        ("datapacks", "数据包", vec!["datapacks"]),
        ("screenshots", "截图", vec!["screenshots"]),
        ("config", "配置", vec!["config"]),
        ("logs", "日志", vec!["logs", "crash-reports"]),
        ("backups", "本地备份", vec!["backups"]),
    ];
    let mut out = Vec::new();
    let mut total = 0u64;
    for (key, label, dirs) in parts {
        let mut size = 0u64;
        for d in dirs {
            let mut budget = 0u64;
            size += dir_size(&root.join(d), &mut budget);
        }
        total += size;
        out.push(json!({ "key": key, "label": label, "size": size }));
    }
    Ok(json!({ "gameDir": dir, "exists": true, "total": total, "parts": out }))
}

#[tauri::command(rename = "mirror:health")]
pub async fn mirror_health() -> CmdResult<Value> {
    let current = crate::config::get("mirror");
    let url = if current.as_str().unwrap_or("bmcl") == "official" {
        "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
    } else {
        "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json"
    };
    let started = Instant::now();
    let ok = matches!(HTTP.get(url).send().await, Ok(r) if r.status().is_success());
    Ok(json!({
        "current": current.as_str().unwrap_or("bmcl"),
        "result": { "ok": ok, "ms": started.elapsed().as_millis() as u64 },
        "failCount": 0,
        "nextCheckDelay": 30,
    }))
}

fn horizon_root(game_dir: &str) -> PathBuf {
    if game_dir.is_empty() {
        crate::config::user_data_dir().join("horizon")
    } else {
        Path::new(game_dir).join("horizon")
    }
}

/// 把已经下完的文件补进「下载与日志」记录（mods / 资源包 / 光影 / 整合包统一走这里）。
pub fn record_download(app: &tauri::AppHandle, name: &str, path: &str, kind: &str) {
    use tauri::Manager;
    let state = app.state::<crate::downloads::DownloadsState>();
    let now = chrono::Utc::now().timestamp_millis();
    let total = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let task = json!({
        "id": format!("dl-record-{now}"),
        "name": name,
        "kind": kind,
        "url": "",
        "dest": path,
        "status": "done",
        "percent": 100,
        "received": total,
        "total": total,
        "speed": 0,
        "error": "",
        "addedAt": now,
        "finishedAt": now,
        "startedAt": now,
    });
    let mut g = state.tasks.lock().unwrap();
    g.push(task);
    let len = g.len();
    if len > 120 {
        let extra = len - 120;
        g.drain(0..extra);
    }
    drop(g);
    crate::downloads::emit_changed(app);
}

#[tauri::command(rename = "bedrock:windows-versions")]
pub async fn bedrock_windows_versions(force: Option<bool>) -> CmdResult<Value> {
    let _ = force;
    let res = HTTP
        .get("https://data.mcappx.com/v2/bedrock.json")
        .header("User-Agent", "NebulaLauncher/1.0.1 (Minecraft Bedrock version list; credit mcappx.com)")
        .send()
        .await
        .map_err(|e| AppError::Msg(format!("基岩版清单读取失败：{e}")))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("基岩版清单读取失败：HTTP {}", res.status().as_u16())));
    }
    let data: Value = res.json().await.map_err(|e| AppError::Msg(format!("基岩版清单解析失败：{e}")))?;
    let Some(obj) = data.get("From_mcappx.com").and_then(Value::as_object) else {
        return Err(AppError::Msg("mcappx 数据源格式异常".into()));
    };
    let mut versions = Vec::new();
    for (version, v) in obj {
        let vars = v.get("Variations").and_then(Value::as_array).cloned().unwrap_or_default();
        let pick = vars.iter().find(|x| x.get("Arch").and_then(Value::as_str) == Some("x64") && x.get("ArchivalStatus").and_then(Value::as_i64) == Some(3))
            .or_else(|| vars.iter().find(|x| x.get("ArchivalStatus").and_then(Value::as_i64) == Some(3)))
            .or_else(|| vars.first());
        let Some(pick) = pick else { continue; };
        let direct = if v.get("BuildType").and_then(Value::as_str) == Some("GDK") {
            pick.get("MetaData").and_then(Value::as_array).and_then(|a| a.iter().find_map(|x| x.as_str())).unwrap_or("")
        } else { "" };
        versions.push(json!({
            "version": version,
            "type": v.get("Type").and_then(Value::as_str).unwrap_or(""),
            "buildType": v.get("BuildType").and_then(Value::as_str).unwrap_or(""),
            "date": v.get("Date").and_then(Value::as_str).unwrap_or(""),
            "arch": pick.get("Arch").and_then(Value::as_str).unwrap_or(""),
            "osbuild": pick.get("OSbuild").and_then(Value::as_str).unwrap_or(""),
            "md5": pick.get("MD5").and_then(Value::as_str).unwrap_or(""),
            "directUrl": direct,
        }));
    }
    versions.sort_by(|a, b| b["date"].as_str().unwrap_or("").cmp(a["date"].as_str().unwrap_or("")));
    Ok(json!({ "total": versions.len(), "versions": versions }))
}

#[tauri::command(rename = "bedrock:versions")]
pub async fn bedrock_versions(force: Option<bool>) -> CmdResult<Value> {
    let _ = force;
    let res = HTTP
        .get("https://mcapks.com/api/get-vslist.php")
        .header("User-Agent", "NebulaLauncher/1.0.1")
        .send()
        .await
        .map_err(|e| AppError::Msg(format!("基岩版安卓清单读取失败：{e}")))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("基岩版安卓清单读取失败：HTTP {}", res.status().as_u16())));
    }
    let data: Value = res.json().await.map_err(|e| AppError::Msg(format!("基岩版安卓清单解析失败：{e}")))?;
    if data.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(AppError::Msg("mcapks 版本清单请求失败".into()));
    }
    let versions: Vec<Value> = data
        .get("data")
        .and_then(|d| d.get("versions"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| {
            let ver = v.get("version").and_then(Value::as_str)?.trim().to_string();
            if ver.is_empty() { return None; }
            Some(json!({
                "version": ver,
                "beta": v.get("beta").and_then(Value::as_bool).unwrap_or(false),
                "date": v.get("date").and_then(Value::as_str).unwrap_or(""),
                "size": v.get("size").and_then(Value::as_str).unwrap_or(""),
            }))
        })
        .collect();
    Ok(json!({ "total": versions.len(), "versions": versions }))
}

#[tauri::command(rename = "bedrock:version-downloads")]
pub async fn bedrock_version_downloads(version: String, kind: Option<String>) -> CmdResult<Value> {
    let t = if kind.as_deref() == Some("v7a") { "v7a" } else { "v8a" };
    let url = format!("https://mcapks.com/api/get-download.php?version={}&type={t}", version.trim());
    let res = HTTP.get(url).header("User-Agent", "NebulaLauncher/1.0.1").send().await
        .map_err(|e| AppError::Msg(format!("基岩版下载链接读取失败：{e}")))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("基岩版下载链接读取失败：HTTP {}", res.status().as_u16())));
    }
    let data: Value = res.json().await.map_err(|e| AppError::Msg(format!("基岩版下载链接解析失败：{e}")))?;
    if data.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(AppError::Msg("mcapks 下载链接请求失败".into()));
    }
    let d = data.get("data").cloned().unwrap_or(json!({}));
    let downloads: Vec<Value> = d
        .get("downloads")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|x| json!({
            "name": x.get("name").and_then(Value::as_str).unwrap_or(""),
            "url": x.get("url").and_then(Value::as_str).unwrap_or(""),
            "password": x.get("password").and_then(Value::as_str).unwrap_or(""),
        }))
        .collect();
    Ok(json!({ "version": d.get("version").and_then(Value::as_str).unwrap_or(version.as_str()), "type": t, "downloads": downloads }))
}

#[tauri::command(rename = "horizon:releases")]
pub async fn horizon_releases(force: Option<bool>) -> CmdResult<Value> {
    let _ = force;
    let res = HTTP
        .get("https://api.github.com/repos/horizon-rust/horizon/releases?per_page=100")
        .header("User-Agent", "NebulaLauncher/1.0")
        .send()
        .await
        .map_err(|e| AppError::Msg(format!("Horizon 版本读取失败：{e}")))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("Horizon 版本读取失败：HTTP {}", res.status().as_u16())));
    }
    let list: Vec<Value> = res.json().await.unwrap_or_default();
    let releases: Vec<Value> = list
        .into_iter()
        .filter(|r| !r.get("draft").and_then(Value::as_bool).unwrap_or(false))
        .map(|r| {
            let tag = r.get("tag_name").and_then(Value::as_str).unwrap_or("").to_string();
            let version = tag.rsplit('@').next().unwrap_or(&tag).trim_start_matches(['v', 'V']).to_string();
            let assets: Vec<Value> = r
                .get("assets")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|a| json!({
                    "name": a.get("name").and_then(Value::as_str).unwrap_or(""),
                    "url": a.get("browser_download_url").and_then(Value::as_str).unwrap_or(""),
                    "size": a.get("size").and_then(Value::as_u64).unwrap_or(0),
                }))
                .collect();
            json!({
                "version": version,
                "tag": tag,
                "date": r.get("published_at").and_then(Value::as_str).unwrap_or("").get(0..10).unwrap_or(""),
                "prerelease": r.get("prerelease").and_then(Value::as_bool).unwrap_or(false),
                "url": r.get("html_url").and_then(Value::as_str).unwrap_or(""),
                "assets": assets,
            })
        })
        .collect();
    Ok(json!({ "total": releases.len(), "releases": releases }))
}

#[tauri::command(rename = "horizon:download")]
pub async fn horizon_download(url: String, name: String, game_dir: Option<String>) -> CmdResult<Value> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(AppError::Msg("Horizon 下载地址无效".into()));
    }
    let file = Path::new(&name).file_name().and_then(|s| s.to_str()).unwrap_or("horizon-launcher.exe");
    let dir = horizon_root(&game_dir.unwrap_or_default());
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(file);
    let res = HTTP.get(&url).send().await.map_err(|e| AppError::Msg(format!("Horizon 下载失败：{e}")))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("Horizon 下载失败：HTTP {}", res.status().as_u16())));
    }
    let bytes = res.bytes().await.map_err(|e| AppError::Msg(format!("Horizon 下载失败：{e}")))?;
    std::fs::write(&path, bytes)?;
    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
}

#[tauri::command(rename = "horizon:openDir")]
pub fn horizon_open_dir(game_dir: Option<String>) -> CmdResult<Value> {
    let dir = horizon_root(&game_dir.unwrap_or_default());
    std::fs::create_dir_all(&dir)?;
    let ok = crate::shell::shell_open_path(dir.to_string_lossy().to_string());
    Ok(json!({ "ok": ok, "path": dir.to_string_lossy() }))
}
