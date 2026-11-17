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

/// 打开/聚焦浏览器窗口并导航到 url。
/// Tauri 的 WebView2 不支持 Electron 的 `<webview>` 壳，这里直接开一个原生 WebView 窗口，
/// 这样内置浏览器至少能真正显示网页，而不是卡在空壳页面。
pub(crate) fn open_browser_window(app: &AppHandle, url: &str) -> CmdResult<()> {
    let raw = if url.trim().is_empty() { "https://www.mcmod.cn/" } else { url.trim() };
    let target = tauri::Url::parse(raw).map_err(|e| AppError::Msg(e.to_string()))?;
    if !is_http(raw) {
        return Err(AppError::Msg("内置浏览器只允许 http/https 地址".into()));
    }
    if let Some(win) = app.get_webview_window("browser") {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        let _ = win.set_focus();
        win.navigate(target).map_err(|e| AppError::Msg(e.to_string()))?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(app, "browser", tauri::WebviewUrl::External(target))
        .title("星云浏览器")
        .inner_size(1180.0, 760.0)
        .min_inner_size(720.0, 480.0)
        .center()
        .build()
        .map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(())
}

/// channel: browser:open
#[tauri::command(rename = "browser:open")]
pub async fn browser_open(url: Option<String>, app: AppHandle) -> CmdResult<Value> {
    let target = url.unwrap_or_default();
    if !target.trim().is_empty() && !is_http(target.trim()) {
        return Ok(json!(false));
    }
    // 窗口创建必须回到主线程；放进回调后立即返回，避免前端 invoke 一直挂着。
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let _ = open_browser_window(&app2, &target);
    })
    .map_err(|e| AppError::Msg(e.to_string()))?;
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
