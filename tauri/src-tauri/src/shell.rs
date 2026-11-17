//! 外部打开（shell:*）：移植自 Electron 版 main.js 的 shell:* handle。
//! - http(s) 链接统一收进内置浏览器（登录态/下载接管）
//! - 其余（file://、mailto: 等）交给系统默认程序
//! - 目录类打开前先确保存在

use crate::config;
use crate::error::CmdResult;
use serde_json::{json, Value};
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PS_EXE: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

/// 交给系统默认程序打开（URL / 文件 / 目录），用 PowerShell Start-Process 避免 cmd 的 & 截断问题。
fn open_external(target: &str) -> bool {
    // 拒绝可能破坏命令结构的字符
    if target.contains('\'') || target.contains('"') || target.contains('`') || target.contains('\0') {
        return false;
    }
    let ps = format!("Start-Process -FilePath '{}'", target.replace('\'', "''"));
    std::process::Command::new(PS_EXE)
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok()
}

fn open_in_explorer(p: &PathBuf) -> bool {
    std::process::Command::new("explorer.exe")
        .arg(p.as_os_str())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok()
}

/// channel: shell:open（url）
#[tauri::command(rename = "shell:open")]
pub fn shell_open(url: String, app: tauri::AppHandle) -> CmdResult<bool> {
    let u = url.trim().to_string();
    if u.is_empty() {
        return Ok(false);
    }
    // 网页统一进内置浏览器
    if u.starts_with("http://") || u.starts_with("https://") {
        crate::browser::open_browser_window(&app, &u)?;
        return Ok(true);
    }
    Ok(open_external(&u))
}

/// channel: shell:openPath（p）
#[tauri::command(rename = "shell:openPath")]
pub fn shell_open_path(p: String) -> bool {
    open_in_explorer(&PathBuf::from(p))
}

/// 打开全局游戏目录下的子目录（空串 = 游戏目录本身），不存在则先创建。
fn open_game_sub(sub: &str) -> bool {
    let dir = PathBuf::from(config::get("gameDir").as_str().unwrap_or(""));
    let target = if sub.is_empty() { dir } else { dir.join(sub) };
    let _ = std::fs::create_dir_all(&target);
    open_in_explorer(&target)
}

/// channel: shell:openGameDir
#[tauri::command(rename = "shell:openGameDir")]
pub fn shell_open_game_dir() -> bool {
    open_game_sub("")
}

/// channel: shell:openModsDir
#[tauri::command(rename = "shell:openModsDir")]
pub fn shell_open_mods_dir() -> bool {
    open_game_sub("mods")
}

/// channel: shell:openConfigDir
#[tauri::command(rename = "shell:openConfigDir")]
pub fn shell_open_config_dir() -> bool {
    open_game_sub("config")
}

/// channel: shell:openSavesDir
#[tauri::command(rename = "shell:openSavesDir")]
pub fn shell_open_saves_dir() -> bool {
    open_game_sub("saves")
}

fn env_dir(key: &str, fallback: &str) -> PathBuf {
    PathBuf::from(std::env::var(key).unwrap_or_else(|_| fallback.to_string()))
}

fn known_app_candidates(key: &str) -> Vec<PathBuf> {
    let pf = env_dir("ProgramFiles", "C:\\Program Files");
    let pf86 = env_dir("ProgramFiles(x86)", "C:\\Program Files (x86)");
    let local = env_dir("LOCALAPPDATA", "C:\\Users\\Public\\AppData\\Local");
    let windir = env_dir("SystemRoot", "C:\\Windows");
    match key {
        "微信" | "wechat" | "weixin" => vec![
            pf.join("Tencent\\WeChat\\WeChat.exe"),
            pf86.join("Tencent\\WeChat\\WeChat.exe"),
            pf.join("Tencent\\Weixin\\Weixin.exe"),
            pf86.join("Tencent\\Weixin\\Weixin.exe"),
            local.join("Tencent\\WeChat\\WeChat.exe"),
        ],
        "qq" | "腾讯qq" => vec![
            pf.join("Tencent\\QQNT\\QQ.exe"),
            pf86.join("Tencent\\QQNT\\QQ.exe"),
            pf.join("Tencent\\QQ\\Bin\\QQ.exe"),
            pf86.join("Tencent\\QQ\\Bin\\QQ.exe"),
        ],
        "网易云音乐" | "netease" | "cloudmusic" => vec![
            pf.join("Netease\\CloudMusic\\cloudmusic.exe"),
            pf86.join("Netease\\CloudMusic\\cloudmusic.exe"),
            local.join("Netease\\CloudMusic\\cloudmusic.exe"),
        ],
        "steam" => vec![
            pf.join("Steam\\steam.exe"),
            pf86.join("Steam\\steam.exe"),
        ],
        "edge" => vec![
            pf.join("Microsoft\\Edge\\Application\\msedge.exe"),
            pf86.join("Microsoft\\Edge\\Application\\msedge.exe"),
        ],
        "chrome" => vec![
            pf.join("Google\\Chrome\\Application\\chrome.exe"),
            pf86.join("Google\\Chrome\\Application\\chrome.exe"),
        ],
        "记事本" | "notepad" => vec![windir.join("System32\\notepad.exe")],
        "计算器" | "calc" | "calculator" => vec![windir.join("System32\\calc.exe")],
        "画图" | "mspaint" | "paint" => vec![windir.join("System32\\mspaint.exe")],
        "任务管理器" | "taskmgr" => vec![windir.join("System32\\Taskmgr.exe")],
        "控制面板" | "control" => vec![windir.join("System32\\control.exe")],
        "资源管理器" | "explorer" => vec![windir.join("explorer.exe")],
        _ => Vec::new(),
    }
}

fn start_roots() -> Vec<PathBuf> {
    vec![
        env_dir("APPDATA", "").join("Microsoft\\Windows\\Start Menu\\Programs"),
        env_dir("ProgramData", "C:\\ProgramData").join("Microsoft\\Windows\\Start Menu\\Programs"),
        env_dir("USERPROFILE", "C:\\Users\\Public").join("Desktop"),
    ]
}

fn walk_lnk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_lnk(&path, out);
        } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("lnk")) {
            out.push(path);
        }
    }
}

fn find_app_shortcut(name: &str) -> Option<PathBuf> {
    let key = name.trim().to_lowercase();
    if key.is_empty() || key.len() > 48 || key.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
        return None;
    }
    let bad = ["卸载", "uninstall", "uninst", "修复", "repair", "更新", "update", "readme", "帮助", "help", "官网", "website"];
    let mut files = Vec::new();
    for root in start_roots() {
        walk_lnk(&root, &mut files);
    }
    let mut best: Option<(i32, PathBuf)> = None;
    for path in files {
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let base = stem.to_lowercase();
        if bad.iter().any(|b| base.contains(b)) {
            continue;
        }
        let score = if base == key {
            100
        } else if base.starts_with(&key) {
            60
        } else if base.contains(&key) {
            35
        } else {
            continue;
        };
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, path));
        }
    }
    best.map(|(_, p)| p)
}

fn launch_path(path: &Path, admin: bool) -> bool {
    let raw = path.to_string_lossy().replace('\'', "''");
    let ps = if admin {
        format!("Start-Process -FilePath '{raw}' -Verb RunAs")
    } else {
        format!("Start-Process -FilePath '{raw}'")
    };
    std::process::Command::new(PS_EXE)
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok()
}

/// channel: sys:openApp（name, opts）
/// 按内置表 / 开始菜单快捷方式打开本机软件；只接受名字，不接受命令行参数。
#[tauri::command(rename = "sys:openApp")]
pub fn sys_open_app(name: String, opts: Option<Value>) -> Result<Value, String> {
    let raw = name.trim().to_string();
    if raw.is_empty() || raw.len() > 64 {
        return Err("应用名不能为空或过长".into());
    }
    if raw == "浏览器" {
        return if open_external("https://www.bing.com") {
            Ok(json!({ "ok": true, "app": "浏览器" }))
        } else {
            Err("打开浏览器失败".into())
        };
    }
    let admin = opts.as_ref().and_then(|o| o.get("admin")).and_then(|v| v.as_bool()).unwrap_or(false);
    let key = raw.to_lowercase();
    if Path::new(&raw).is_file() {
        return if launch_path(Path::new(&raw), admin) {
            Ok(json!({ "ok": true, "app": raw, "path": raw }))
        } else {
            Err(format!("打开{}失败", raw))
        };
    }
    if let Some(path) = known_app_candidates(&key).into_iter().find(|p| p.is_file()) {
        let shown = path.to_string_lossy().to_string();
        return if launch_path(&path, admin) {
            Ok(json!({ "ok": true, "app": raw, "path": shown }))
        } else {
            Err(format!("打开{}失败", raw))
        };
    }
    if let Some(shortcut) = find_app_shortcut(&raw) {
        return if launch_path(&shortcut, admin) {
            Ok(json!({ "ok": true, "app": raw, "path": shortcut.to_string_lossy() }))
        } else {
            Err(format!("打开{}失败", raw))
        };
    }
    Err(format!("没找到「{}」，请确认已经安装，或告诉我完整路径", raw))
}
