//! 启动器自更新（对应 Electron 版 minecraft/updater.js）。
//! 流程：读用户填的更新地址拿 JSON 清单 → 数字段比较版本 → 流式下载 + sha256 校验 → 静默安装。

use crate::error::{AppError, CmdResult};
use crate::net::HTTP;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const RAW_CHANGELOG: &str = "https://raw.githubusercontent.com/BlockVibe001/cm-launcher/master/CHANGELOG.md";
const RAW_CHANGELOG_ANDROID: &str = "https://raw.githubusercontent.com/BlockVibe001/cm-launcher/master/CHANGELOG-ANDROID.md";
const GITHUB_RELEASES: &str = "https://api.github.com/repos/BlockVibe001/cm-launcher/releases?per_page=100";
const GITHUB_LATEST: &str = "https://api.github.com/repos/BlockVibe001/cm-launcher/releases/latest";

/// GitHub Releases 列表：更新日志页只读 name/body/发布时间，不需要下载资产。
pub async fn releases() -> Value {
    match HTTP.get(GITHUB_RELEASES).send().await {
        Ok(res) if res.status().is_success() => match res.json::<Vec<Value>>().await {
            Ok(list) => {
                let items: Vec<Value> = list.into_iter().filter(|r| !r.get("draft").and_then(Value::as_bool).unwrap_or(false)).map(|r| {
                    let tag = r.get("tag_name").and_then(Value::as_str).unwrap_or("").to_string();
                    let name = r.get("name").and_then(Value::as_str).unwrap_or(&tag).to_string();
                    let text = format!("{tag} {name}");
                    let lower = text.to_lowercase();
                    let channel = if lower.contains("android") || text.contains("安卓") || lower.contains(".apk") {
                        "android"
                    } else if r.get("prerelease").and_then(Value::as_bool).unwrap_or(false) || lower.contains("beta") {
                        "beta"
                    } else {
                        "stable"
                    };
                    let version = tag.trim_start_matches(|c| c == 'v' || c == 'V').to_string();
                    json!({
                        "id": format!("gh-{}", r.get("id").and_then(Value::as_u64).unwrap_or(0)),
                        "source": "github",
                        "tag": tag,
                        "version": version,
                        "name": name,
                        "body": r.get("body").and_then(Value::as_str).unwrap_or(""),
                        "publishedAt": r.get("published_at").and_then(Value::as_str).unwrap_or(""),
                        "url": r.get("html_url").and_then(Value::as_str).unwrap_or(""),
                        "prerelease": channel == "beta",
                        "channel": channel,
                        "platform": if channel == "android" { "android" } else { "windows" },
                    })
                }).collect();
                json!({ "items": items, "errors": [], "fetchedAt": 0 })
            }
            Err(e) => json!({ "items": [], "errors": [e.to_string()] }),
        },
        Ok(res) => json!({ "items": [], "errors": [format!("HTTP {}", res.status().as_u16())] }),
        Err(e) => json!({ "items": [], "errors": [e.to_string()] }),
    }
}

/// 安卓专用日志和 Windows 日志分开取；raw 直连失败时改用 GitHub contents API。
pub async fn changelog(platform: Option<String>) -> Value {
    let android = platform.as_deref().unwrap_or("windows").eq_ignore_ascii_case("android");
    let name = if android { "CHANGELOG-ANDROID.md" } else { "CHANGELOG.md" };
    let raw = if android { RAW_CHANGELOG_ANDROID } else { RAW_CHANGELOG };
    let api = format!("https://api.github.com/repos/BlockVibe001/cm-launcher/contents/{name}?ref=master");
    let mut text = String::new();
    let mut last_err = String::from("更新日志读取失败");
    if let Ok(res) = try_send(raw).await {
        if res.status().is_success() {
            match res.text().await {
                Ok(t) if !t.trim().is_empty() => text = t,
                _ => last_err = "更新日志内容为空".into(),
            }
        } else {
            last_err = format!("HTTP {}", res.status().as_u16());
        }
    }
    if text.is_empty() {
        if let Ok(res) = HTTP.get(&api).header("Accept", "application/vnd.github.raw").send().await {
            if res.status().is_success() {
                if let Ok(t) = res.text().await {
                    if !t.trim().is_empty() { text = t; }
                }
            }
        }
    }
    if !text.trim().is_empty() {
        json!({ "ok": true, "platform": if android { "android" } else { "windows" }, "text": text, "errors": [] })
    } else {
        json!({ "ok": false, "platform": if android { "android" } else { "windows" }, "text": "", "errors": [last_err] })
    }
}

/// 更新源目录：正式 / 测试 / 安卓 各自独立，和 Electron 版目录结构一致。
pub fn source_info() -> Value {
    let base = crate::config::user_data_dir().join("更新源");
    let mut out = serde_json::Map::new();
    for (ch, folder) in [("stable", "正式"), ("beta", "测试"), ("android", "安卓")] {
        let custom = crate::config::get(&format!("update.source{}", match ch {
            "beta" => "Beta",
            "android" => "Android",
            _ => "Stable",
        }));
        let dir = custom.as_str().map(str::trim).filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| base.join(folder));
        let _ = std::fs::create_dir_all(&dir);
        let url_key = format!("update.url{}", match ch {
            "beta" => "Beta",
            "android" => "Android",
            _ => "Stable",
        });
        let default_url = if ch == "stable" { GITHUB_LATEST } else { GITHUB_RELEASES };
        let url = crate::config::get(&url_key);
        let url = url.as_str().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(default_url);
        out.insert(ch.to_string(), json!({
            "dir": dir.to_string_lossy(),
            "url": url,
        }));
    }
    Value::Object(out)
}

fn version_parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(|c| c == 'v' || c == 'V')
        .split(|c: char| matches!(c, '.' | '-' | '+' | '_'))
        .filter_map(|s| s.parse::<u64>().ok())
        .collect()
}

/// 按数字段逐位比较：字符串比较会把 1.10.0 判成小于 1.9.0。
pub fn compare_version(a: &str, b: &str) -> i32 {
    let x = version_parts(a);
    let y = version_parts(b);
    let n = x.len().max(y.len()).max(1);
    for i in 0..n {
        let p = x.get(i).copied().unwrap_or(0);
        let q = y.get(i).copied().unwrap_or(0);
        if p != q {
            return if p > q { 1 } else { -1 };
        }
    }
    0
}

fn is_http(u: &str) -> bool {
    u.starts_with("http://") || u.starts_with("https://")
}

/// GitHub 资源下载兜底：直连失败（传输层错误），或 302 后落到被 hosts 屏蔽的域上拿到 403/404，
/// 都改经加速镜像重取（镜像在服务端取文件，不受本机 hosts 影响）。镜像前缀可用 config 的 update.mirror 覆盖。
async fn try_send(url: &str) -> CmdResult<reqwest::Response> {
    let first = HTTP.get(url).send().await;
    let needs_fallback = match &first {
        Err(_) => true,
        Ok(r) => url.contains("github.com") && matches!(r.status().as_u16(), 403 | 404),
    };
    if !needs_fallback {
        return first.map_err(|e| AppError::Msg(e.to_string()));
    }
    let direct_note = match &first {
        Err(e) => e.to_string(),
        Ok(r) => format!("HTTP {}", r.status().as_u16()),
    };
    let mv = crate::config::get("update.mirror");
    let prefix = mv
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("https://gh-proxy.com/");
    let mirrored = if prefix.ends_with('/') { format!("{prefix}{url}") } else { format!("{prefix}/{url}") };
    match HTTP.get(&mirrored).send().await {
        Ok(r) => Ok(r),
        Err(_) => Err(AppError::Msg(format!("连不上更新地址：{direct_note}"))),
    }
}

/// 读清单：支持本地 update.json，也支持 GitHub Releases 数组；安卓通道只收 .apk。
pub async fn check(app: &AppHandle, url: &str, channel: Option<String>) -> CmdResult<Value> {
    let target = url.trim();
    if !is_http(target) {
        return Err(AppError::Msg("更新地址无效，需要以 http:// 或 https:// 开头".into()));
    }
    let want = channel.unwrap_or_else(|| "stable".into()).to_lowercase();
    let res = try_send(target).await?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("读取更新清单失败：HTTP {}", res.status().as_u16())));
    }
    let data: Value = res
        .json()
        .await
        .map_err(|_| AppError::Msg("更新清单不是合法的 JSON".into()))?;
    let current = app.package_info().version.to_string();
    let mut manifest = if data.is_array() {
        pick_release(&data, &want).ok_or_else(|| AppError::Msg(format!("GitHub Releases 里没有 {want} 通道的安装包")))? 
    } else {
        data.clone()
    };
    let latest = manifest.get("version").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if latest.is_empty() {
        return Err(AppError::Msg("更新清单缺少 version 字段".into()));
    }
    if let Some(obj) = manifest.as_object_mut() {
        let has_update = compare_version(&latest, &current) > 0;
        obj.insert("current".into(), json!(current));
        obj.insert("latest".into(), json!(latest));
        obj.insert("hasUpdate".into(), json!(has_update));
        obj.insert("platform".into(), json!(if want == "android" { "android" } else { "windows" }));
        obj.insert("channel".into(), json!(want));
    }
    Ok(manifest)
}

/// 从 GitHub Releases 数组里挑目标通道最新一条，安卓只挑带 .apk 资产的 release。
fn pick_release(data: &Value, want: &str) -> Option<Value> {
    for r in data.as_array()? {
        if r.get("draft").and_then(Value::as_bool).unwrap_or(false) { continue; }
        let tag = r.get("tag_name").and_then(Value::as_str).unwrap_or("");
        let name = r.get("name").and_then(Value::as_str).unwrap_or("");
        let text = format!("{tag} {name}").to_lowercase();
        let ch = if text.contains("android") || text.contains("安卓") || text.contains(".apk") {
            "android"
        } else if r.get("prerelease").and_then(Value::as_bool).unwrap_or(false) || text.contains("beta") {
            "beta"
        } else { "stable" };
        if ch != want { continue; }
        let assets = r.get("assets").and_then(Value::as_array).cloned().unwrap_or_default();
        let asset = assets.iter().find(|a| {
            let n = a.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
            if want == "android" { n.ends_with(".apk") } else { n.ends_with(".exe") }
        });
        if want == "android" && asset.is_none() { continue; }
        let a = asset.cloned().unwrap_or(Value::Null);
        let version = tag.trim_start_matches(|c| c == 'v' || c == 'V').to_string();
        let digest = a.get("digest").and_then(Value::as_str).unwrap_or("").to_lowercase();
        return Some(json!({
            "version": version,
            "notes": r.get("body").and_then(Value::as_str).unwrap_or(""),
            "publishedAt": r.get("published_at").and_then(Value::as_str).unwrap_or(""),
            "installer": a.get("browser_download_url").and_then(Value::as_str).unwrap_or(""),
            "sha256": digest.strip_prefix("sha256:").unwrap_or(""),
            "page": r.get("html_url").and_then(Value::as_str).unwrap_or(""),
            "tag": tag,
            "name": name,
        }));
    }
    None
}

/// 流式下载安装包到 <user_data>/update，边下边算 sha256，200ms 节流发进度。
pub async fn download(app: &AppHandle, manifest: &Value) -> CmdResult<Value> {
    let url = manifest.get("installer").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if !is_http(&url) {
        return Err(AppError::Msg("清单里没有可用的安装包地址".into()));
    }
    let dir = crate::config::user_data_dir().join("update");
    tokio::fs::create_dir_all(&dir).await?;
    let bare = url.split('?').next().unwrap_or(&url);
    let base = std::path::Path::new(bare)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("setup.exe")
        .to_string();
    let base = if base.to_lowercase().ends_with(".exe") || base.to_lowercase().ends_with(".apk") {
        base
    } else if manifest.get("platform").and_then(Value::as_str).unwrap_or("") == "android" {
        format!("{base}.apk")
    } else {
        format!("{base}.exe")
    };
    let dest = dir.join(&base);
    let tmp = dir.join(format!("{base}.part"));

    let url_enc = url.replace(' ', "%20"); // GitHub 资源名带空格时必须编码，否则 404
    let res = try_send(&url_enc).await?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("下载安装包失败：HTTP {}", res.status().as_u16())));
    }
    let total = res.content_length().unwrap_or(0);
    let wanted = manifest.get("sha256").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
    let mut hasher = if wanted.is_empty() { None } else { Some(Sha256::new()) };

    let mut f = tokio::fs::File::create(&tmp).await?;
    let mut res = res;
    let mut received: u64 = 0;
    let started = std::time::Instant::now();
    let mut last = std::time::Instant::now();
    loop {
        let chunk = match res.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(AppError::Msg(format!("下载安装包失败：{e}")));
            }
        };
        if let Some(h) = hasher.as_mut() {
            h.update(&chunk);
        }
        f.write_all(&chunk).await?;
        received += chunk.len() as u64;
        if last.elapsed() >= std::time::Duration::from_millis(200) || (total > 0 && received == total) {
            last = std::time::Instant::now();
            let secs = started.elapsed().as_secs_f64();
            let _ = app.emit(crate::events::EV_UPDATE_PROGRESS, json!({
                "percent": if total > 0 { ((received as f64 / total as f64) * 100.0).min(100.0) as u64 } else { 0 },
                "received": received,
                "total": total,
                "speed": if secs > 0.0 { (received as f64 / secs) as u64 } else { 0 },
            }));
        }
    }
    f.flush().await?;
    drop(f);

    if let Some(h) = hasher {
        let got = hex::encode(h.finalize());
        if got != wanted {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(AppError::Msg("安装包校验失败（sha256 不匹配），已丢弃，请重试".into()));
        }
    }
    let _ = tokio::fs::remove_file(&dest).await;
    tokio::fs::rename(&tmp, &dest).await?;
    let _ = app.emit(crate::events::EV_UPDATE_PROGRESS, json!({
        "percent": 100, "received": received, "total": if total > 0 { total } else { received }, "speed": 0
    }));
    crate::logger::info(&format!("更新包已下载：{}（{received} 字节）", dest.to_string_lossy()));
    Ok(json!({ "path": dest.to_string_lossy(), "size": received }))
}

/// 静默安装。起完安装进程稍候退出当前实例，由安装包完成替换（用户数据不受影响）。
#[cfg(windows)]
pub fn install(app: &AppHandle, p: &str) -> CmdResult<Value> {
    if p.trim().is_empty() || !std::path::Path::new(p).exists() {
        return Err(AppError::Msg("安装包不存在，请重新下载".into()));
    }
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let child = std::process::Command::new(p)
        .arg("/S")
        .current_dir(std::path::Path::new(p).parent().unwrap_or_else(|| std::path::Path::new(".")))
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| AppError::Msg(format!("启动安装程序失败：{e}")))?;
    let pid = child.id();
    crate::logger::info(&format!("启动静默安装：{p}"));
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        app2.exit(0);
    });
    Ok(json!({ "pid": pid, "path": p }))
}

/// 安卓端 APK 不能由桌面安装器静默拉起，统一走下载页由系统安装。
#[cfg(not(windows))]
pub fn install(_app: &AppHandle, _p: &str) -> CmdResult<Value> {
    Err(AppError::Msg("当前平台请通过下载页安装 APK".into()))
}

/// 打开下载页（免安装降级路径 / 清单里的 page 字段）。
#[cfg(windows)]
pub fn open_page(url: &str) -> CmdResult<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    Ok(())
}

#[cfg(not(windows))]
pub fn open_page(_url: &str) -> CmdResult<()> {
    Err(AppError::Msg("当前平台请在浏览器打开下载页".into()))
}
