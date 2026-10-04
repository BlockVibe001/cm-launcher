//! 启动器自更新（对应 Electron 版 minecraft/updater.js）。
//! 流程：读用户填的更新地址拿 JSON 清单 → 数字段比较版本 → 流式下载 + sha256 校验 → 静默安装。

use crate::error::{AppError, CmdResult};
use crate::net::HTTP;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
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

/// 传输层失败时经 GitHub 加速镜像重试（国内直连 GitHub 常不可达；本机 hosts 指向 127.0.0.1 的加速方案同理兜不住）。
/// 仅对“发不出去”回退，HTTP 状态错误原样抛出。镜像前缀可用 config 的 update.mirror 覆盖。
async fn try_send(url: &str) -> CmdResult<reqwest::Response> {
    match HTTP.get(url).send().await {
        Ok(r) => Ok(r),
        Err(direct_err) => {
            let mv = crate::config::get("update.mirror");
            let prefix = mv
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("https://gh-proxy.com/");
            let mirrored = if prefix.ends_with('/') { format!("{prefix}{url}") } else { format!("{prefix}/{url}") };
            match HTTP.get(&mirrored).send().await {
                Ok(r) => Ok(r),
                Err(_) => Err(AppError::Msg(format!("连不上更新地址：{direct_err}"))),
            }
        }
    }
}

/// 读清单。地址由用户自己填，任何 host 都接受，不套国内镜像替换。
pub async fn check(url: &str) -> CmdResult<Value> {
    let target = url.trim();
    if !is_http(target) {
        return Err(AppError::Msg("更新地址无效，需要以 http:// 或 https:// 开头".into()));
    }
    let res = try_send(target).await?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("读取更新清单失败：HTTP {}", res.status().as_u16())));
    }
    let data: Value = res
        .json()
        .await
        .map_err(|_| AppError::Msg("更新清单不是合法的 JSON".into()))?;
    let latest = data.get("version").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if latest.is_empty() {
        return Err(AppError::Msg("更新清单缺少 version 字段".into()));
    }
    let current = version();
    Ok(json!({
        "current": current,
        "latest": latest,
        "hasUpdate": compare_version(&latest, current) > 0,
        "notes": data.get("notes").and_then(Value::as_str).unwrap_or(""),
        "publishedAt": data.get("publishedAt").and_then(Value::as_str).unwrap_or(""),
        "installer": data.get("installer").and_then(Value::as_str).unwrap_or(""),
        "sha256": data.get("sha256").and_then(Value::as_str).unwrap_or(""),
        "page": data.get("page").and_then(Value::as_str).unwrap_or(""),
        "portable": false,
    }))
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
    let base = if base.to_lowercase().ends_with(".exe") { base } else { format!("{base}.exe") };
    let dest = dir.join(&base);
    let tmp = dir.join(format!("{base}.part"));

    let res = try_send(&url).await?;
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

/// 打开下载页（免安装降级路径 / 清单里的 page 字段）。
pub fn open_page(url: &str) -> CmdResult<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    Ok(())
}
