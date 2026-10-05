//! 外部打开（shell:*）：移植自 Electron 版 main.js 的 shell:* handle。
//! - http(s) 链接统一收进内置浏览器（登录态/下载接管）
//! - 其余（file://、mailto: 等）交给系统默认程序
//! - 目录类打开前先确保存在

use crate::config;
use crate::error::CmdResult;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 交给系统默认程序打开（URL / 文件 / 目录），用 PowerShell Start-Process 避免 cmd 的 & 截断问题。
fn open_external(target: &str) -> bool {
    // 拒绝可能破坏命令结构的字符
    if target.contains('\'') || target.contains('"') || target.contains('`') || target.contains('\0') {
        return false;
    }
    let ps = format!("Start-Process -FilePath '{}'", target.replace('\'', "''"));
    std::process::Command::new("powershell.exe")
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
