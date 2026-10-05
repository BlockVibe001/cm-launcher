//! 从其他启动器搬家（PCL2 / HMCL / 手动目录）。移植自 Electron 版 minecraft/migrate.js。

use crate::config;
use crate::error::{AppError, CmdResult};
use crate::logger;
use crate::mc::instance::{get_instance, list_instances, save_instance};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::Emitter;

struct Launcher {
    id: &'static str,
    name: &'static str,
    full_name: &'static str,
    icon: &'static str,
    dir_names: &'static [&'static str],
}

const LAUNCHERS: &[Launcher] = &[
    Launcher { id: "pcl2", name: "PCL2", full_name: "Plain Craft Launcher 2", icon: "🟦", dir_names: &["PCL", "Plain Craft Launcher 2"] },
    Launcher { id: "hmcl", name: "HMCL", full_name: "Hello Minecraft! Launcher", icon: "🟩", dir_names: &["HMCL", ".hmcl"] },
];

/* ---------- 工具 ---------- */

fn exists(p: &Path) -> bool {
    p.exists()
}

fn is_dir(p: &Path) -> bool {
    p.is_dir()
}

fn subdirs(root: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(root) else { return vec![] };
    rd.filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

fn count_files(dir: &Path, exts: Option<&[&str]>) -> usize {
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    rd.filter_map(|e| e.ok())
        .filter(|e| match exts {
            None => true,
            Some(list) => {
                let ext = e.path().extension()
                    .map(|x| format!(".{}", x.to_string_lossy().to_lowercase()))
                    .unwrap_or_default();
                !ext.is_empty() && list.contains(&ext.as_str())
            }
        })
        .count()
}

fn read_text(p: &Path) -> String {
    fs::read_to_string(p).unwrap_or_default()
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&read_text(p)).ok()
}

fn base_name(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| p.to_string_lossy().into_owned())
}

fn safe_name(s: &str) -> String {
    let cleaned = ILLEGAL_RE.with(|re| re.replace_all(if s.is_empty() { "实例" } else { s }, "_"));
    let cleaned = cleaned.trim();
    if cleaned.is_empty() { "实例".to_string() } else { cleaned.to_string() }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let d = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &d)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), &d)?;
        }
    }
    Ok(())
}

fn unique_dir(root: &Path, name: &str) -> PathBuf {
    let mut dir = root.join(name);
    let mut n = 1;
    while dir.exists() {
        n += 1;
        dir = root.join(format!("{name}-{n}"));
    }
    dir
}

/// 等价 Node path.resolve：补成绝对路径并文本化消解 . / ..（不碰文件系统）
fn resolve(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(p)
    };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var(var).ok().filter(|s| !s.is_empty()).map(PathBuf::from)
}

/// 等价 Electron app.getPath('home')
fn home_dir() -> PathBuf {
    env_dir("USERPROFILE").unwrap_or_else(|| PathBuf::from("."))
}

/// 等价 Electron app.getPath('appData')
fn app_data_dir() -> PathBuf {
    env_dir("APPDATA").unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
}

fn base36(mut n: i64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n <= 0 {
        return "0".into();
    }
    let mut buf = Vec::new();
    while n > 0 {
        buf.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).unwrap_or_default()
}

macro_rules! lazy_re {
    ($name:ident, $pat:expr) => {
        fn $name() -> &'static regex::Regex {
            static RE: OnceLock<regex::Regex> = OnceLock::new();
            RE.get_or_init(|| regex::Regex::new($pat).expect("regex"))
        }
    };
}

lazy_re!(ini_path_re, r#"([A-Za-z]:\\[^\r\n"']+)"#);
lazy_re!(ini_ok_re, r#"(^|\\)(versions|saves|mods)(\\)?$"#);
lazy_re!(mc_end_re, r"(?i)\.minecraft$");
lazy_re!(mc_mid_re, r"(?i)\.minecraft\\");
lazy_re!(ram_set_re, r"(?i)RamSet\s*=\s*(\d+)");
lazy_re!(loader_re, r"(?i)(forge|neoforge|fabric|quilt|optifine)-?([\d.]*)");

thread_local! {
    static ILLEGAL_RE: regex::Regex = regex::Regex::new(r#"[\\/:*?"<>|]"#).expect("regex");
}

/* ---------- 探测启动器数据目录 ---------- */

fn launcher_data_dirs(spec: &Launcher) -> Vec<PathBuf> {
    let home = home_dir();
    let bases = vec![
        app_data_dir(),
        env_dir("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local")),
        home.clone(),
        home.join("Desktop"),
        home.join("Documents"),
        home.join("Downloads"),
        home.join("OneDrive").join("Desktop"),
        home.join("OneDrive").join("Documents"),
    ];
    let mut out: Vec<PathBuf> = vec![];
    for base in &bases {
        for name in spec.dir_names {
            let dir = base.join(name);
            if is_dir(&dir) && !out.contains(&dir) {
                out.push(dir);
            }
        }
    }
    out
}

/// 除了启动器数据目录，官方 / PCL2 默认的游戏目录也要算进来
fn default_game_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    let cands = vec![
        app_data_dir().join(".minecraft"),
        home.join(".minecraft"),
        home.join("AppData").join("Roaming").join(".minecraft"),
        home.join("Desktop").join(".minecraft"),
        home.join("Documents").join(".minecraft"),
    ];
    let mut out: Vec<PathBuf> = vec![];
    for d in cands {
        if !out.contains(&d) && looks_like_game_dir(&d) {
            out.push(d);
        }
    }
    out
}

/// 从 PCL2 的 ini 中提取可能是 .minecraft 的路径
fn game_dirs_from_pcl_ini(data_dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for f in ["Setup.ini", "PCL.ini", "pcl.ini"] {
        let text = read_text(&data_dir.join(f));
        if text.is_empty() {
            continue;
        }
        for cap in ini_path_re().captures_iter(&text) {
            let p = cap[1].trim().trim_end_matches('\\').to_string();
            if p.is_empty() || out.contains(&p) {
                continue;
            }
            if ini_ok_re().is_match(&p) || mc_end_re().is_match(&p) || mc_mid_re().is_match(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// 定位 HMCL 的游戏目录
fn game_dirs_from_hmcl(data_dir: &Path) -> Vec<String> {
    let files = [
        data_dir.join("hmcl.json"),
        data_dir.join(".hmcl.json"),
        home_dir().join(".hmcl.json"),
    ];
    let mut out: Vec<String> = vec![];
    for f in files {
        let Some(j) = read_json(&f) else { continue };
        for key in ["gameDir", "selectedGameDir", "gameDirectory"] {
            if let Some(s) = j.get(key).and_then(Value::as_str) {
                if exists(Path::new(s)) {
                    out.push(s.to_string());
                }
            }
        }
    }
    out
}

/// 判断一个目录是否像游戏根目录
fn looks_like_game_dir(dir: &Path) -> bool {
    if !is_dir(dir) {
        return false;
    }
    ["versions", "saves", "mods", "libraries"].iter().any(|k| dir.join(k).exists())
}

struct VersionInfo {
    id: String,
    dir: PathBuf,
    jar: bool,
    inherits: String,
    mod_loader: String,
    loader_version: String,
    isolated: bool,
    game_root: PathBuf,
    mods: usize,
    saves: usize,
}

impl VersionInfo {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "dir": self.dir.to_string_lossy(),
            "jar": self.jar,
            "inherits": self.inherits,
            "modLoader": self.mod_loader,
            "loaderVersion": self.loader_version,
            "isolated": self.isolated,
            "gameRoot": self.game_root.to_string_lossy(),
            "mods": self.mods,
            "saves": self.saves,
            "size": 0,
        })
    }
}

/// 读取一个版本目录的信息
fn read_version(game_dir: &Path, id: &str) -> Option<VersionInfo> {
    let dir = game_dir.join("versions").join(id);
    let json_path = dir.join(format!("{id}.json"));
    if !json_path.exists() {
        return None;
    }
    let jar_path = dir.join(format!("{id}.jar"));
    let j = read_json(&json_path).unwrap_or(Value::Null);
    let inherits = j.get("inheritsFrom").and_then(Value::as_str).unwrap_or("").to_string();
    let mut mod_loader = String::from("vanilla");
    let mut loader_version = String::new();
    // JS: String(inherits || j.id || id)，j.id 为空串 / 0 / null 时落到 id
    let src = if !inherits.is_empty() {
        inherits.clone()
    } else {
        match j.get("id") {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            Some(Value::Number(n)) if n.as_f64().map(|x| x != 0.0).unwrap_or(false) => n.to_string(),
            _ => id.to_string(),
        }
    };
    if let Some(cap) = loader_re().captures(&src) {
        mod_loader = cap[1].to_lowercase();
        loader_version = cap.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
    }

    // PCL2 版本隔离：版本目录下的 .minecraft 才是真正的游戏目录
    let isolated = dir.join(".minecraft");
    let isolated_dir = if is_dir(&isolated) { Some(isolated) } else { None };
    let game_root = isolated_dir.clone().unwrap_or_else(|| game_dir.to_path_buf());

    Some(VersionInfo {
        id: id.to_string(),
        dir,
        jar: jar_path.exists(),
        inherits,
        mod_loader,
        loader_version,
        isolated: isolated_dir.is_some(),
        mods: count_files(&game_root.join("mods"), Some(&[".jar", ".disabled"])),
        saves: subdirs(&game_root.join("saves")).len(),
        game_root,
    })
}

/// 扫描一个游戏目录
fn scan_game_dir(dir: &Path) -> Value {
    let versions: Vec<Value> = subdirs(&dir.join("versions"))
        .iter()
        .filter_map(|id| read_version(dir, id).map(|v| v.to_json()))
        .collect();
    let saves: Vec<Value> = subdirs(&dir.join("saves"))
        .into_iter()
        .filter(|n| dir.join("saves").join(n).join("level.dat").exists())
        .map(Value::String)
        .collect();
    json!({
        "dir": dir.to_string_lossy(),
        "name": base_name(dir),
        "versions": versions,
        "saves": saves,
        "mods": count_files(&dir.join("mods"), Some(&[".jar", ".disabled"])),
        "resourcepacks": count_files(&dir.join("resourcepacks"), None),
        "shaderpacks": count_files(&dir.join("shaderpacks"), None),
    })
}

/// 读取启动器中的内存设置（尽力而为）
fn read_settings(spec: &Launcher, data_dir: &Path) -> Value {
    let mut max_memory = 0i64;
    let mut source = String::new();
    if spec.id == "hmcl" {
        for f in [data_dir.join("hmcl.json"), home_dir().join(".hmcl.json")] {
            if let Some(j) = read_json(&f) {
                if let Some(n) = j.get("maxMemory").and_then(Value::as_f64) {
                    if n > 0.0 {
                        max_memory = n as i64;
                        source = base_name(&f);
                        break;
                    }
                }
            }
        }
    } else if spec.id == "pcl2" {
        let text = read_text(&data_dir.join("Setup.ini"));
        // PCL2 使用 RamSet（单位 MB）
        if let Some(cap) = ram_set_re().captures(&text) {
            if let Ok(n) = cap[1].parse::<i64>() {
                if n > 0 {
                    max_memory = n;
                    source = "Setup.ini".into();
                }
            }
        }
    }
    json!({ "maxMemory": max_memory, "source": source })
}

/// 探测单个启动器数据目录下的可搬家内容
fn collect_for(spec: &Launcher, data_dir: &Path, guessed: Vec<String>) -> Option<Value> {
    // 兜底：数据目录旁 / 内部的 .minecraft
    let fallbacks = [data_dir.join(".minecraft"), data_dir.join("minecraft")];
    let mut dirs: Vec<PathBuf> = vec![];
    for d in guessed.iter().map(PathBuf::from).chain(fallbacks) {
        if !dirs.contains(&d) && looks_like_game_dir(&d) {
            dirs.push(d);
        }
    }

    let game_dirs: Vec<Value> = dirs.iter().map(|d| scan_game_dir(d)).filter(has_content).collect();
    if game_dirs.is_empty() {
        return None;
    }
    Some(json!({
        "id": spec.id,
        "name": spec.name,
        "fullName": spec.full_name,
        "icon": spec.icon,
        "dataDir": data_dir.to_string_lossy(),
        "settings": read_settings(spec, data_dir),
        "gameDirs": game_dirs,
    }))
}

/// scanGameDir 结果里要有版本或存档才算有内容
fn has_content(g: &Value) -> bool {
    let non_empty = |k: &str| g.get(k).and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false);
    non_empty("versions") || non_empty("saves")
}

/// channel: migrate:detect
/// 探测全部可搬家的内容
#[tauri::command(rename = "migrate:detect")]
pub fn detect() -> Vec<Value> {
    let mut found: Vec<Value> = vec![];
    let mut claimed: Vec<PathBuf> = vec![];

    for spec in LAUNCHERS {
        for data_dir in launcher_data_dirs(spec) {
            let guessed = if spec.id == "pcl2" {
                game_dirs_from_pcl_ini(&data_dir)
            } else {
                game_dirs_from_hmcl(&data_dir)
            };
            let Some(item) = collect_for(spec, &data_dir, guessed) else { continue };
            if let Some(arr) = item.get("gameDirs").and_then(Value::as_array) {
                for g in arr {
                    if let Some(d) = g.get("dir").and_then(Value::as_str) {
                        claimed.push(resolve(Path::new(d)));
                    }
                }
            }
            found.push(item);
        }
    }

    // 启动器数据目录一个都没探到，但本机确实存在 .minecraft 时也要能搬。
    // PCL2 绝大多数情况下管的正是这个目录，把它挂到 PCL2 名下比直接报「未检测到」有用得多。
    let leftovers: Vec<PathBuf> = default_game_dirs()
        .into_iter()
        .filter(|d| !claimed.contains(&resolve(d)))
        .collect();
    let game_dirs: Vec<Value> = leftovers.iter().map(|d| scan_game_dir(d)).filter(has_content).collect();
    if !game_dirs.is_empty() {
        found.push(json!({
            "id": "pcl2",
            "name": "PCL2",
            "fullName": "Plain Craft Launcher 2（默认游戏目录）",
            "icon": "🟦",
            "dataDir": leftovers.first().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
            "settings": { "maxMemory": 0, "source": "" },
            "gameDirs": game_dirs,
        }));
    }

    found
}

/// 把一个目录解析成游戏根目录：既接受游戏目录本身，也接受装着 .minecraft 的启动器目录
fn resolve_game_dir(dir: &Path) -> Option<PathBuf> {
    if !is_dir(dir) {
        return None;
    }
    if looks_like_game_dir(dir) {
        return Some(dir.to_path_buf());
    }
    for c in [".minecraft", "minecraft"] {
        let p = dir.join(c);
        if looks_like_game_dir(&p) {
            return Some(p);
        }
    }
    for name in subdirs(dir) {
        let p = dir.join(&name);
        if looks_like_game_dir(&p) {
            return Some(p);
        }
    }
    None
}

/// channel: migrate:detectIn（参数：dir）
/// 手动指定目录：扫描它（以及它里面的 .minecraft），当成一个搬家来源
#[tauri::command(rename = "migrate:detectIn")]
pub fn detect_in(dir: String) -> CmdResult<Value> {
    let root = PathBuf::from(&dir);
    if dir.is_empty() || !is_dir(&root) {
        return Err("目录不存在或不可读".into());
    }
    let mut candidates: Vec<PathBuf> = vec![];
    if let Some(resolved) = resolve_game_dir(&root) {
        candidates.push(resolved);
    }
    // 指定的是启动器目录时，配置里还可能写着别的游戏目录
    for d in game_dirs_from_pcl_ini(&root) {
        let p = PathBuf::from(&d);
        if looks_like_game_dir(&p) && !candidates.contains(&p) {
            candidates.push(p);
        }
    }

    let game_dirs: Vec<Value> = candidates.iter().map(|d| scan_game_dir(d)).filter(has_content).collect();
    if game_dirs.is_empty() {
        return Err("这个目录里没找到 versions / saves，请选游戏根目录（含 .minecraft 的那一层）".into());
    }
    Ok(json!([{
        "id": "manual",
        "name": "手动指定",
        "fullName": "手动指定的目录",
        "icon": "📁",
        "dataDir": dir,
        "settings": { "maxMemory": 0, "source": "" },
        "gameDirs": game_dirs,
    }]))
}

/* ---------- 执行导入 ---------- */

enum VerOutcome {
    Imported(Value),
    Skipped(String),
    Failed(String),
}

fn import_version(src_game_dir: &Path, id: &str, mode: &str, our_game_dir: &Path, seq: usize) -> VerOutcome {
    let Some(v) = read_version(src_game_dir, id) else {
        return VerOutcome::Failed("版本文件已丢失".into());
    };
    let inst_name = safe_name(id);
    let dup = list_instances().as_object().map(|m| {
        m.values().any(|x| {
            x.get("versionId").and_then(Value::as_str) == Some(id)
                && resolve(Path::new(x.get("gameDir").and_then(Value::as_str).unwrap_or(""))) == resolve(&v.game_root)
        })
    }).unwrap_or(false);
    if dup {
        return VerOutcome::Skipped("已导入过，跳过".into());
    }

    let mut target_game_dir = v.game_root.clone();
    if mode == "copy" {
        // 复制版本核心文件
        let dest_ver = our_game_dir.join("versions").join(id);
        if !dest_ver.exists() {
            if let Err(e) = copy_dir_recursive(&v.dir, &dest_ver) {
                return VerOutcome::Failed(e.to_string());
            }
        }
        if v.isolated {
            target_game_dir = unique_dir(&our_game_dir.join("instances"), &inst_name);
            if let Err(e) = copy_dir_recursive(&v.game_root, &target_game_dir) {
                return VerOutcome::Failed(e.to_string());
            }
        } else {
            target_game_dir = src_game_dir.to_path_buf();
        }
    }

    let inst_id = format!("mg-{}-{}", base36(chrono::Utc::now().timestamp_millis()), seq);
    let icon = match v.mod_loader.as_str() {
        "fabric" => "🧵",
        "forge" => "🔥",
        _ => "⛏",
    };
    save_instance(&inst_id, json!({
        "name": inst_name,
        "versionId": id,
        "gameDir": target_game_dir.to_string_lossy(),
        "modLoader": v.mod_loader,
        "loaderVersion": v.loader_version,
        "icon": icon,
    }));
    logger::info(format!("搬家导入实例「{}」（{}）", inst_name, if mode == "copy" { "复制" } else { "引用" }));
    VerOutcome::Imported(json!({
        "id": inst_id,
        "name": inst_name,
        "versionId": id,
        "mods": v.mods,
        "isolated": v.isolated,
        "mode": mode,
    }))
}

fn import_save(src_game_dir: &Path, dest_game_dir: &Path, name: &str) -> Result<Value, String> {
    let src = src_game_dir.join("saves").join(name);
    if !src.join("level.dat").exists() {
        return Err("不是有效的世界存档".into());
    }
    let saves_dir = dest_game_dir.join("saves");
    fs::create_dir_all(&saves_dir).map_err(|e| e.to_string())?;
    let target = unique_dir(&saves_dir, &safe_name(name));
    copy_dir_recursive(&src, &target).map_err(|e| e.to_string())?;
    Ok(json!({ "name": base_name(&target), "from": name }))
}

/// channel: migrate:run（参数：payload；每项完成 emit `migrate:progress` { done, total, label }）
/// payload: { mode: "link"|"copy", gameDir, versions: [], saves: [], applySettings, settings, targetGameDir? }
#[tauri::command(rename = "migrate:run")]
pub async fn run(payload: Value, app: tauri::AppHandle) -> CmdResult<Value> {
    tokio::task::spawn_blocking(move || run_blocking(payload, app))
        .await
        .map_err(|e| AppError::Msg(format!("搬家任务中断：{e}")))?
}

fn run_blocking(payload: Value, app: tauri::AppHandle) -> CmdResult<Value> {
    let mode = if payload.get("mode").and_then(Value::as_str) == Some("copy") { "copy" } else { "link" };
    let src_game_dir = payload.get("gameDir").and_then(Value::as_str).unwrap_or("").to_string();
    let src_path = PathBuf::from(&src_game_dir);
    if !looks_like_game_dir(&src_path) {
        return Err("源游戏目录无效".into());
    }

    let our_game_dir = config::get("gameDir").as_str().unwrap_or("").to_string();
    let our_path = PathBuf::from(&our_game_dir);
    fs::create_dir_all(&our_path)?;

    let mut r_instances: Vec<Value> = vec![];
    let mut r_saves: Vec<Value> = vec![];
    let mut r_skipped: Vec<Value> = vec![];
    let mut r_failed: Vec<Value> = vec![];
    let mut r_settings = Value::Null;

    let str_list = |key: &str| -> Vec<String> {
        payload.get(key).and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    let version_ids = str_list("versions");
    let save_names = str_list("saves");
    let total = version_ids.len() + save_names.len();
    let mut done = 0usize;
    let mut tick = |label: &str| {
        done += 1;
        let _ = app.emit("migrate:progress", json!({ "done": done, "total": total, "label": label }));
    };

    for id in &version_ids {
        match import_version(&src_path, id, mode, &our_path, r_instances.len()) {
            VerOutcome::Imported(v) => r_instances.push(v),
            VerOutcome::Skipped(msg) => r_skipped.push(json!({ "name": id, "message": msg })),
            VerOutcome::Failed(msg) => r_failed.push(json!({ "name": id, "message": msg })),
        }
        tick(id);
    }

    // 存档导入到目标实例（或默认实例）的 saves 目录
    let sel = config::get("selectedInstance").as_str().unwrap_or("").to_string();
    let inst_game_dir = get_instance(&sel)
        .and_then(|v| v.get("gameDir").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let dest_game_dir = payload.get("targetGameDir").and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or(if inst_game_dir.is_empty() { None } else { Some(inst_game_dir) })
        .unwrap_or(our_game_dir);
    let dest_path = PathBuf::from(&dest_game_dir);
    for name in &save_names {
        match import_save(&src_path, &dest_path, name) {
            Ok(v) => r_saves.push(v),
            Err(msg) => r_failed.push(json!({ "name": name, "message": msg })),
        }
        tick(name);
    }

    let apply = payload.get("applySettings").and_then(Value::as_bool).unwrap_or(false);
    if apply {
        if let Some(mm) = payload.get("settings").and_then(|s| s.get("maxMemory")).cloned()
            .filter(|v| v.as_f64().map(|n| n > 0.0).unwrap_or(false))
        {
            config::set("maxMemory", mm.clone());
            r_settings = json!({ "maxMemory": mm });
        }
    }

    logger::info(format!("搬家完成：实例 {} · 存档 {} · 失败 {}", r_instances.len(), r_saves.len(), r_failed.len()));
    Ok(json!({
        "instances": r_instances,
        "saves": r_saves,
        "skipped": r_skipped,
        "failed": r_failed,
        "settings": r_settings,
    }))
}

/* ============================================================================
 * 全局游戏目录变更（设置页「游戏目录」）
 * ========================================================================== */

/// 纯函数：把「位于 old_dir 之下」的实例目录前缀替换为 new_dir。
///  - gameDir 为空（跟随全局，如默认实例）→ 不动
///  - 恰好等于旧目录 → 映射到新目录本身
///  - 在旧目录之外或跨盘符（strip_prefix 失败）→ 不动，尊重单独指定
/// 返回 (新实例映射, {id: 新路径})
fn rewrite_instance_dirs(list: &Value, old_dir: &Path, new_dir: &Path) -> (Value, Map<String, Value>) {
    let o = resolve(old_dir);
    let n = resolve(new_dir);
    let mut out = Map::new();
    let mut changed = Map::new();
    if let Some(m) = list.as_object() {
        for (id, inst) in m {
            let nd = inst.get("gameDir").and_then(Value::as_str).unwrap_or("");
            if nd.is_empty() {
                out.insert(id.clone(), inst.clone());
                continue;
            }
            match resolve(Path::new(nd)).strip_prefix(&o) {
                Ok(rel) => {
                    let np = if rel.as_os_str().is_empty() { n.clone() } else { n.join(rel) };
                    let mut ni = inst.clone();
                    ni["gameDir"] = json!(np.to_string_lossy());
                    changed.insert(id.clone(), json!(np.to_string_lossy()));
                    out.insert(id.clone(), ni);
                }
                Err(_) => {
                    out.insert(id.clone(), inst.clone());
                }
            }
        }
    }
    (Value::Object(out), changed)
}

/// 用系统自带 robocopy 把旧目录整体移动到新目录（跨盘也可）。退出码 0~7 为成功，≥8 为失败。
fn robocopy_move(from: &Path, to: &Path) -> (i32, String) {
    use std::os::windows::process::CommandExt;
    let result = std::process::Command::new("robocopy")
        .args(["/E", "/MOVE", "/IS", "/NFL", "/NDL", "/NP", "/R:1", "/W:1"])
        .arg(from)
        .arg(to)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW，等同 JS windowsHide
        .output();
    match result {
        Ok(o) => {
            let mut log = String::from_utf8_lossy(&o.stdout).into_owned();
            log.push_str(&String::from_utf8_lossy(&o.stderr));
            (o.status.code().unwrap_or(-1), log)
        }
        Err(e) => (-1, e.to_string()),
    }
}

/// channel: gameDir:change（前端参数键名：dir、move；move 在此映射为 r#move）
/// 变更全局游戏目录，可选把旧目录文件一起移动过去
#[tauri::command(rename = "gameDir:change")]
pub async fn change_game_dir(dir: String, r#move: bool) -> CmdResult<Value> {
    let old_dir = resolve(Path::new(config::get("gameDir").as_str().unwrap_or("")));
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err("请选择有效的游戏目录".into());
    }
    let target = resolve(Path::new(trimmed));
    if target == old_dir {
        return Err("新目录与当前目录相同".into());
    }
    // 不允许把游戏目录设到启动器自己的数据目录里（配置会和游戏文件互相嵌套）
    if target == resolve(&config::user_data_dir()) {
        return Err("游戏目录不能设置为启动器的数据目录".into());
    }

    fs::create_dir_all(&target)?;

    let old_exists = old_dir.exists();
    let mut robocopy_code = Value::Null;
    if r#move && old_exists {
        let (from, to) = (old_dir.clone(), target.clone());
        let (code, log) = tokio::task::spawn_blocking(move || robocopy_move(&from, &to))
            .await
            .map_err(|e| AppError::Msg(format!("robocopy 任务中断：{e}")))?;
        robocopy_code = json!(code);
        if code >= 8 {
            let n = log.chars().count();
            let tail: String = log.chars().skip(n.saturating_sub(400)).collect();
            logger::warn(format!("robocopy move {} -> {} failed ({}): {}", old_dir.display(), target.display(), code, tail));
            return Err(AppError::Msg(format!(
                "文件移动失败（robocopy 退出码 {code}），目录设置未更改。通常是文件被占用，请先关闭游戏后重试。"
            )));
        }
        logger::info(format!("robocopy move -> {}, code {}", target.display(), code));
    }

    let list = config::get("instances");
    let (rewritten, changed) = rewrite_instance_dirs(&list, &old_dir, &target);
    let mut upd = Map::new();
    upd.insert("gameDir".into(), json!(target.to_string_lossy()));
    upd.insert("instances".into(), rewritten);
    config::update(upd);

    Ok(json!({
        "oldDir": old_dir.to_string_lossy(),
        "newDir": target.to_string_lossy(),
        "moved": r#move && old_exists,
        "changed": Value::Object(changed),
        "robocopyCode": robocopy_code,
    }))
}
