//! 内置浏览器（Tauri 简化版）：单例 WebviewWindow，无标签页/下载接管。
//! 对应 Electron 版 system/browser.js 的 open/info 部分。

use crate::error::{AppError, CmdResult};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// 默认收藏栏：查资料、找资源、登录三件事的入口（与 browser.js 一致）
const DEFAULT_BOOKMARKS: &[(&str, &str)] = &[
    ("MC 百科", "https://www.mcmod.cn/"),
    ("CurseForge", "https://www.curseforge.com/minecraft"),
    ("Modrinth", "https://modrinth.com/"),
    ("LittleSkin", "https://littleskin.cn/"),
    ("微软账号", "https://www.microsoft.com/link"),
];

const MODES: [&str; 3] = ["auto", "ask", "queue"];

fn is_http(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// 打开/聚焦浏览器窗口并导航到 url。已存在则复用（eval 导航 iframe），否则新建。
/// 窗口加载本地 browser.html（书签栏 + 地址栏 + iframe），供 browser:open 命令和微软设备码登录复用。
pub(crate) fn open_browser_window(app: &AppHandle, url: &str) -> CmdResult<()> {
    // browser.html 通过轮询 window.__pending_nav 消费导航目标；无论窗口新旧都先写入
    let nav_js = |url: &str| -> Result<String, AppError> {
        Ok(format!("window.__pending_nav = {}", serde_json::to_string(url)?))
    };
    if let Some(win) = app.get_webview_window("browser") {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        let _ = win.set_focus();
        let js = nav_js(url)?;
        let _ = win.eval(&js);
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(app, "browser", tauri::WebviewUrl::App("browser.html".into()))
        .title("CM 浏览器")
        .decorations(false)
        .inner_size(1180.0, 760.0)
        .min_inner_size(720.0, 480.0)
        .center()
        .build()
        .map_err(|e| AppError::Msg(e.to_string()))?;
    // 页面可能尚未加载完成：browser.html 初始化与轮询都会消费这个变量
    if let Some(win) = app.get_webview_window("browser") {
        let js = nav_js(url)?;
        let _ = win.eval(&js);
    }
    Ok(())
}

/// channel: browser:open
#[tauri::command(rename = "browser:open")]
pub fn browser_open(url: String, app: AppHandle) -> CmdResult<Value> {
    if !is_http(&url) {
        return Ok(json!(false));
    }
    open_browser_window(&app, &url)?;
    Ok(json!(true))
}

/// channel: browser:info
#[tauri::command(rename = "browser:info")]
pub fn browser_info() -> Value {
    let bookmarks = match crate::config::get("browserBookmarks") {
        // null / 非数组表示「还没自己调过」，用默认那几条；空数组尊重玩家清空
        v if v.is_array() => v,
        _ => json!(DEFAULT_BOOKMARKS
            .iter()
            .map(|(name, url)| json!({ "name": name, "url": url }))
            .collect::<Vec<_>>()),
    };
    let mode = crate::config::get("browserDownloadMode");
    let mode = mode.as_str().filter(|m| MODES.contains(m)).unwrap_or("auto");
    json!({
        "bookmarks": bookmarks,
        "downloadMode": mode,
        "modes": MODES,
        "partition": "persist:cmbrowser",
        "theme": crate::config::get("theme").as_str().unwrap_or("dark").to_string(),
        "accent": crate::config::get("accent").as_str().unwrap_or("axolotl").to_string(),
        "ui": match crate::config::get("ui") { v if v.is_object() => v, _ => json!({}) },
    })
}
