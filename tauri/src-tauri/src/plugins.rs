//! Tauri 插件系统（v1 兼容层）：用随包 Node 运行时执行本机插件。
//! 插件目录 %APPDATA%\cm-minecraft-launcher\plugins\<id>，一个目录一个插件。

use crate::config;
use crate::error::{AppError, CmdResult};
use serde_json::{json, Value};
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const ALLOWED: [&str; 5] = ["command", "ui.entry", "notify", "config", "fs.pluginDir"];
const SAMPLE_JSON: &str =
    include_str!("../../../src/main/plugins-sample/example-hello/plugin.json");
const SAMPLE_INDEX: &str =
    include_str!("../../../src/main/plugins-sample/example-hello/index.js");

fn plugin_root() -> PathBuf {
    config::user_data_dir().join("plugins")
}

fn safe_id(id: &str) -> bool {
    let t = id.trim();
    !t.is_empty()
        && t.len() <= 64
        && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn plugin_dir(id: &str) -> Option<PathBuf> {
    if !safe_id(id) {
        return None;
    }
    let p = plugin_root().join(id);
    p.is_dir().then_some(p)
}

fn disabled_ids() -> Vec<String> {
    config::get("plugins")
        .get("disabled")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

fn set_disabled(id: &str, off: bool) {
    let mut cur = config::get("plugins").as_object().cloned().unwrap_or_default();
    let mut ids: Vec<String> = disabled_ids();
    if off {
        if !ids.iter().any(|x| x == id) {
            ids.push(id.to_string());
        }
    } else {
        ids.retain(|x| x != id);
    }
    cur.insert("disabled".into(), json!(ids));
    config::set("plugins", Value::Object(cur));
}

fn resource_path(app: &AppHandle, rel: &str) -> PathBuf {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(rel));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources").join(rel));
        }
    }
    candidates.into_iter().find(|p| p.is_file()).unwrap_or_else(|| PathBuf::from(rel))
}

fn run_runner(app: &AppHandle, dir: &Path, action: &str, id: &str) -> CmdResult<Value> {
    let node = resource_path(app, "tools/runtime/node.exe");
    let runner = resource_path(app, "tools/plugins-runner.js");
    if !node.is_file() {
        return Err(AppError::Msg("缺少随包 Node 运行时，无法运行插件".into()));
    }
    if !runner.is_file() {
        return Err(AppError::Msg("缺少插件运行器，无法运行插件".into()));
    }
    let out = Command::new(&node)
        .arg(&runner)
        .arg(dir)
        .arg(action)
        .arg(id)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(AppError::Io)?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text
        .lines()
        .filter(|l| l.trim_start().starts_with('{'))
        .last()
        .ok_or_else(|| AppError::Msg("插件运行器没有返回结果".into()))?;
    let value: Value = serde_json::from_str(line)?;
    if !value.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let msg = value.get("error").and_then(Value::as_str).unwrap_or("插件执行失败");
        return Err(AppError::Msg(msg.to_string()));
    }
    if let Some(notes) = value.get("notifications").and_then(Value::as_array) {
        if action != "list" {
            for n in notes {
                let _ = app.emit("plugin:notify", n.clone());
            }
        }
    }
    Ok(value)
}

fn record(dir: &Path, enabled: bool) -> Value {
    let dir_name = dir.file_name().and_then(|s| s.to_str()).unwrap_or("plugin").to_string();
    let mut rec = json!({
        "id": dir_name, "dirName": dir_name, "name": dir_name,
        "version": "—", "description": "", "author": "",
        "apiVersion": 0, "permissions": [], "enabled": enabled,
        "loaded": false, "error": "", "warnings": [],
        "commands": [], "entries": []
    });
    let text = match fs::read_to_string(dir.join("plugin.json")) {
        Ok(t) => t,
        Err(_) => {
            rec["error"] = json!("缺少 plugin.json");
            return rec;
        }
    };
    let m: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            rec["error"] = json!(format!("plugin.json 解析失败：{e}"));
            return rec;
        }
    };
    if !m.is_object() {
        rec["error"] = json!("plugin.json 必须是对象");
        return rec;
    }
    let id = m.get("id").and_then(Value::as_str).unwrap_or(&dir_name).trim().to_string();
    if !safe_id(&id) {
        rec["error"] = json!("id 只能包含字母、数字、点、下划线、短横线，且不超过 64 个字符");
        return rec;
    }
    let main_rel = m.get("main").and_then(Value::as_str).unwrap_or("index.js");
    if !dir.join(main_rel).is_file() {
        rec["error"] = json!(format!("入口文件不存在：{main_rel}"));
    }
    let perms: Vec<String> = m
        .get("permissions")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).filter(|p| ALLOWED.contains(p)).map(str::to_string).collect())
        .unwrap_or_default();
    let unknown: Vec<String> = m
        .get("permissions")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).filter(|p| !ALLOWED.contains(p)).map(str::to_string).collect())
        .unwrap_or_default();
    rec["id"] = json!(id);
    rec["name"] = json!(m.get("name").and_then(Value::as_str).unwrap_or(&id));
    rec["version"] = json!(m.get("version").and_then(Value::as_str).unwrap_or("0.0.0"));
    rec["description"] = json!(m.get("description").and_then(Value::as_str).unwrap_or(""));
    rec["author"] = json!(m.get("author").and_then(Value::as_str).unwrap_or(""));
    rec["apiVersion"] = json!(m.get("apiVersion").and_then(Value::as_i64).unwrap_or(1));
    rec["permissions"] = json!(perms);
    if !unknown.is_empty() {
        rec["warnings"] = json!([format!("已忽略未知权限：{}", unknown.join(", "))]);
    }
    rec
}

fn scan(app: &AppHandle) -> Vec<Value> {
    let mut list = Vec::new();
    let root = plugin_root();
    let _ = fs::create_dir_all(&root);
    let disabled = disabled_ids();
    let Ok(rd) = fs::read_dir(&root) else { return list };
    for ent in rd.flatten() {
        let dir = ent.path();
        if !dir.is_dir() {
            continue;
        }
        let id = dir.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let mut rec = record(&dir, true);
        let rec_id = rec.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let enabled = !disabled.iter().any(|x| x == &id || x == &rec_id);
        rec["enabled"] = json!(enabled);
        if enabled && rec.get("error").and_then(Value::as_str).unwrap_or("").is_empty() {
            match run_runner(app, &dir, "list", "") {
                Ok(v) => {
                    rec["loaded"] = json!(true);
                    rec["commands"] = v.get("commands").cloned().unwrap_or(json!([]));
                    rec["entries"] = v.get("entries").cloned().unwrap_or(json!([]));
                }
                Err(e) => rec["error"] = json!(e.to_string()),
            }
        }
        list.push(rec);
    }
    list
}

#[tauri::command(rename = "plugins:list")]
pub fn plugins_list(app: AppHandle) -> CmdResult<Value> {
    Ok(Value::Array(scan(&app)))
}

#[tauri::command(rename = "plugins:reload")]
pub fn plugins_reload(app: AppHandle) -> CmdResult<Value> {
    Ok(Value::Array(scan(&app)))
}

#[tauri::command(rename = "plugins:install-sample")]
pub fn plugins_install_sample() -> CmdResult<Value> {
    let dir = plugin_root().join("example-hello");
    let existed = dir.join("plugin.json").is_file();
    if !existed {
        fs::create_dir_all(&dir)?;
        fs::write(dir.join("plugin.json"), SAMPLE_JSON)?;
        fs::write(dir.join("index.js"), SAMPLE_INDEX)?;
    }
    Ok(json!({ "ok": true, "installed": !existed, "path": dir.to_string_lossy() }))
}

#[tauri::command(rename = "plugins:create")]
pub fn plugins_create(id: String, name: String, description: Option<String>) -> CmdResult<Value> {
    let id = id.trim().to_lowercase();
    if !safe_id(&id) {
        return Err(AppError::Msg("插件 id 只能包含小写字母、数字、点、下划线、短横线".into()));
    }
    let dir = plugin_root().join(&id);
    if dir.join("plugin.json").is_file() {
        return Err(AppError::Msg("同名插件已存在".into()));
    }
    fs::create_dir_all(&dir)?;
    let name = if name.trim().is_empty() { id.clone() } else { name.trim().to_string() };
    let description = description.unwrap_or_else(|| "我自己创建的插件".into());
    let manifest = json!({
        "id": id, "name": name, "version": "1.0.0", "description": description,
        "author": "我", "main": "index.js", "apiVersion": 1,
        "permissions": ["command", "notify"]
    });
    fs::write(dir.join("plugin.json"), serde_json::to_string_pretty(&manifest)?)?;
    let title = format!("{} 已加载", name.replace('\'', "\\'"));
    let index = format!(r#"module.exports = {{
  activate(ctx) {{
    ctx.registerCommand({{
      id: 'hello',
      title: '打个招呼',
      run() {{ return '你好，这是「{name}」的第一个命令。'; }}
    }});
    ctx.notify('插件已加载', '{title}');
  }}
}};
"#, name = name.replace('\'', "\\'"));
    fs::write(dir.join("index.js"), index)?;
    Ok(json!({ "ok": true, "path": dir.to_string_lossy(), "id": id }))
}

#[tauri::command(rename = "plugins:open-dir")]
pub fn plugins_open_dir() -> CmdResult<Value> {
    let dir = plugin_root();
    fs::create_dir_all(&dir)?;
    let ok = crate::shell::shell_open_path(dir.to_string_lossy().to_string());
    Ok(json!({ "ok": ok, "path": dir.to_string_lossy() }))
}

#[tauri::command(rename = "plugins:toggle")]
pub fn plugins_toggle(app: AppHandle, id: String, on: bool) -> CmdResult<Value> {
    let dir = plugin_dir(&id).ok_or_else(|| AppError::Msg("插件不存在".into()))?;
    set_disabled(&id, !on);
    let mut rec = record(&dir, on);
    if on && rec.get("error").and_then(Value::as_str).unwrap_or("").is_empty() {
        match run_runner(&app, &dir, "list", "") {
            Ok(v) => {
                rec["loaded"] = json!(true);
                rec["commands"] = v.get("commands").cloned().unwrap_or(json!([]));
                rec["entries"] = v.get("entries").cloned().unwrap_or(json!([]));
            }
            Err(e) => rec["error"] = json!(e.to_string()),
        }
    }
    Ok(json!({ "ok": true, "plugin": rec }))
}

#[tauri::command(rename = "plugins:run-command")]
pub fn plugins_run_command(app: AppHandle, id: String, cmd_id: String) -> CmdResult<Value> {
    let dir = plugin_dir(&id).ok_or_else(|| AppError::Msg("插件不存在".into()))?;
    if disabled_ids().iter().any(|x| x == &id) {
        return Err(AppError::Msg("插件已停用".into()));
    }
    run_runner(&app, &dir, "run-command", &cmd_id)
}

#[tauri::command(rename = "plugins:run-entry")]
pub fn plugins_run_entry(app: AppHandle, id: String, entry_id: String) -> CmdResult<Value> {
    let dir = plugin_dir(&id).ok_or_else(|| AppError::Msg("插件不存在".into()))?;
    if disabled_ids().iter().any(|x| x == &id) {
        return Err(AppError::Msg("插件已停用".into()));
    }
    run_runner(&app, &dir, "run-entry", &entry_id)
}
