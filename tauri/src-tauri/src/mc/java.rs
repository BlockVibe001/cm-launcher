//! Java 管理：与 Electron 版 minecraft/java.js 对齐。
//! 发现候选（配置/JAVA_HOME/托管目录/PATH/注册表/常见目录/官方运行时）、
//! 版本匹配、Adoptium JRE 下载安装。

use crate::config;
use crate::error::{AppError, CmdResult};
use crate::events::EV_JAVA_PROGRESS;
use crate::net::downloader::extract_zip_blocking;
use crate::net::HTTP;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::os::windows::process::CommandExt;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const EXE_NAME: &str = "java.exe";
const UA: &str = "BlockVibeLauncher/1.0.0 (minecraft launcher)";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct JavaInfo {
    pub path: String,
    pub major: i64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RequiredJava {
    pub major: i64,
    pub text: String,
    pub tip: String,
}

/// 本启动器托管 Java 目录（userData/java）
pub fn java_home() -> PathBuf {
    let dir = crate::config::user_data_dir().join("java");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

async fn version_info(java_path: &str) -> Option<(i64, String)> {
    let out = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(java_path).arg("-version").creation_flags(0x08000000).output(), // CREATE_NO_WINDOW
    )
    .await;
    let output = match out {
        Ok(Ok(o)) => o,
        _ => return None,
    };
    let text = format!("{}{}", String::from_utf8_lossy(&output.stderr), String::from_utf8_lossy(&output.stdout));
    let line = text.lines().find(|l| l.contains("version")).unwrap_or("");
    let captures = regex::Regex::new(r#"version "(\d+)(?:\.(\d+))?"#).unwrap().captures(line);
    match captures {
        Some(c) => {
            let mut major = c[1].parse().unwrap_or(0);
            if major == 1 {
                major = c.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0); // 1.8 -> 8
            }
            Some((major, line.trim().to_string()))
        }
        None => Some((0, line.trim().to_string())),
    }
}

fn accessible(p: &Path) -> bool {
    std::fs::metadata(p).is_ok()
}

fn list_subdirs(root: &Path) -> Vec<String> {
    std::fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}

// ---------------- 候选发现（阻塞） ----------------

fn find_candidates_blocking(game_dir: String, appdata: String) -> Vec<String> {
    let mut found: std::collections::HashSet<String> = std::collections::HashSet::new();
    let add = |found: &mut std::collections::HashSet<String>, p: PathBuf| {
        if !p.as_os_str().is_empty() && accessible(&p) {
            let resolved = std::fs::canonicalize(&p).unwrap_or(p);
            found.insert(resolved.to_string_lossy().to_string());
        }
    };

    // 已配置
    let cfg_java = config::get("javaPath").as_str().unwrap_or("").to_string();
    if !cfg_java.is_empty() {
        add(&mut found, PathBuf::from(cfg_java));
    }
    // JAVA_HOME
    if let Ok(jh) = std::env::var("JAVA_HOME") {
        add(&mut found, PathBuf::from(jh).join("bin").join(EXE_NAME));
    }
    // 本启动器下载的 Java
    let home = java_home();
    for dir in list_subdirs(&home) {
        add(&mut found, home.join(&dir).join("bin").join(EXE_NAME));
    }

    // PATH：where java
    if let Ok(out) = std::process::Command::new("where").arg("java").creation_flags(0x08000000).output() {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let s = line.trim();
                if !s.is_empty() {
                    add(&mut found, PathBuf::from(s));
                }
            }
        }
    }

    // 注册表
    let reg_roots = [
        r"HKLM\SOFTWARE\JavaSoft\Java Runtime Environment",
        r"HKLM\SOFTWARE\JavaSoft\JRE",
        r"HKLM\SOFTWARE\JavaSoft\Java Development Kit",
        r"HKLM\SOFTWARE\JavaSoft\JDK",
        r"HKLM\SOFTWARE\WOW6432Node\JavaSoft\Java Runtime Environment",
        r"HKLM\SOFTWARE\WOW6432Node\JavaSoft\Java Development Kit",
    ];
    let re = regex::Regex::new(r"JavaHome\s+REG_SZ\s+(.+)").unwrap();
    for root in reg_roots {
        if let Ok(out) = std::process::Command::new("reg")
            .args(["query", root, "/s", "/v", "JavaHome"])
            .creation_flags(0x08000000)
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for cap in re.captures_iter(&text) {
                add(&mut found, PathBuf::from(cap[1].trim()).join("bin").join(EXE_NAME));
            }
        }
    }

    // 常见安装目录（深度 1）
    let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let roots: Vec<PathBuf> = [
        r"C:\Program Files\Java",
        r"C:\Program Files (x86)\Java",
        r"C:\Program Files\Eclipse Adoptium",
        r"C:\Program Files (x86)\Eclipse Adoptium",
        r"C:\Program Files\Microsoft",
        r"C:\Program Files\Zulu",
        r"C:\Program Files\Amazon Corretto",
        r"C:\Program Files\BellSoft",
        r"C:\Program Files\IBM",
        r"C:\Program Files\Semeru",
    ]
    .iter()
    .map(PathBuf::from)
    .chain(std::iter::once(PathBuf::from(local_appdata).join("Programs").join("Eclipse Adoptium")))
    .collect();
    for root in roots {
        for dir in list_subdirs(&root) {
            add(&mut found, root.join(&dir).join("bin").join(EXE_NAME));
        }
    }

    // 官方启动器自带运行时：runtime\<组件>\windows-x64\<组件>\bin\java.exe
    let rt_roots = [PathBuf::from(&game_dir).join("runtime"), PathBuf::from(&appdata).join(".minecraft").join("runtime")];
    for rt in rt_roots {
        for comp in list_subdirs(&rt) {
            let arch_dir = rt.join(&comp).join("windows-x64");
            for inner in list_subdirs(&arch_dir) {
                add(&mut found, arch_dir.join(&inner).join("bin").join(EXE_NAME));
            }
        }
    }

    found.into_iter().collect()
}

pub async fn list_javas() -> CmdResult<Vec<JavaInfo>> {
    let game_dir = config::get("gameDir").as_str().unwrap_or("").to_string();
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let candidates = tauri::async_runtime::spawn_blocking(move || find_candidates_blocking(game_dir, appdata))
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;

    let mut results = Vec::new();
    for p in candidates {
        if let Some((major, text)) = version_info(&p).await {
            results.push(JavaInfo { path: p, major, text });
        }
    }
    // 去重
    let mut uniq: std::collections::BTreeMap<String, JavaInfo> = std::collections::BTreeMap::new();
    for r in results {
        uniq.insert(r.path.clone(), r);
    }
    let mut out: Vec<JavaInfo> = uniq.into_values().collect();
    out.sort_by(|a, b| b.major.cmp(&a.major));
    Ok(out)
}

// ---------------- 版本匹配 ----------------

/// 根据 MC 版本推断所需 Java 大版本
pub fn required_java(mc_version: &str) -> RequiredJava {
    let v = mc_version;
    let c = regex::Regex::new(r"^1\.(\d+)(?:\.(\d+))?").unwrap().captures(v);
    let Some(c) = c else {
        return RequiredJava { major: 21, text: "Java 21".into(), tip: "相对较新的版本 / 快照，建议 Java 21".into() };
    };
    let minor: i64 = c[1].parse().unwrap_or(0);
    let patch: i64 = c.get(2).map(|m| m.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0);
    let major = if minor >= 21 {
        21
    } else if minor == 20 {
        if patch >= 5 { 21 } else { 17 }
    } else if minor >= 17 {
        17
    } else {
        8
    };
    RequiredJava { major, text: format!("Java {major}"), tip: format!("{v} 需要 Java {major}") }
}

/// 从已安装列表挑最合适的 Java
pub fn pick_for(mc_version: &str, javas: &[JavaInfo]) -> Option<JavaInfo> {
    let need = required_java(mc_version).major;
    let list: Vec<&JavaInfo> = javas.iter().filter(|j| j.major > 0).collect();
    if list.is_empty() {
        return None;
    }
    if let Some(exact) = list.iter().find(|j| j.major == need) {
        return Some((*exact).clone());
    }
    // 高于所需：取最接近的
    let mut higher: Vec<JavaInfo> = list.iter().filter(|j| j.major > need).cloned().cloned().collect();
    if !higher.is_empty() {
        higher.sort_by_key(|j| j.major);
        return Some(higher[0].clone());
    }
    // 低于所需：取最高的
    let mut lower: Vec<JavaInfo> = list.iter().filter(|j| j.major < need).cloned().cloned().collect();
    lower.sort_by_key(|j| -j.major);
    lower.first().cloned()
}

// ---------------- 托管目录 ----------------

#[derive(Serialize)]
pub struct InstalledJava {
    pub major: i64,
    pub dir: String,
    pub path: String,
}

pub fn list_installed() -> Vec<InstalledJava> {
    let home = java_home();
    let mut out = Vec::new();
    let re = regex::Regex::new(r"(\d+)$").unwrap();
    for dir in list_subdirs(&home) {
        if dir.starts_with('.') {
            continue;
        }
        let exe = home.join(&dir).join("bin").join(EXE_NAME);
        if accessible(&exe) {
            let major = re.captures(&dir).and_then(|c| c[1].parse().ok()).unwrap_or(0);
            out.push(InstalledJava { major, dir: dir.clone(), path: exe.to_string_lossy().to_string() });
        }
    }
    out.sort_by(|a, b| b.major.cmp(&a.major));
    out
}

pub fn uninstall(major: Option<i64>) -> i64 {
    let home = java_home();
    let re = regex::Regex::new(r"(\d+)$").unwrap();
    let mut removed = 0;
    for dir in list_subdirs(&home) {
        if !dir.starts_with("jre-") {
            continue;
        }
        let m: i64 = re.captures(&dir).and_then(|c| c[1].parse().ok()).unwrap_or(0);
        if let Some(want) = major {
            if m != want {
                continue;
            }
        }
        if std::fs::remove_dir_all(home.join(&dir)).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ---------------- Adoptium 下载 ----------------

fn adoptium_url(major: i64) -> String {
    let params: Vec<(&str, &str)> = vec![
        ("architecture", "x64"),
        ("image_type", "jre"),
        ("os", "windows"),
        ("vendor", "eclipse"),
        ("page_size", "1"),
    ];
    let qs: String = params.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    format!("https://api.adoptium.net/v3/assets/latest/{major}/hotspot?{qs}")
}

#[derive(Serialize)]
pub struct AdoptiumRelease {
    pub major: i64,
    pub name: String,
    pub link: String,
    pub size: u64,
    pub version: String,
}

async fn adoptium_release(major: i64) -> CmdResult<AdoptiumRelease> {
    let res = HTTP.get(adoptium_url(major)).header("User-Agent", UA).send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("Adoptium 查询失败（HTTP {}）", res.status().as_u16())));
    }
    let arr: Value = res.json().await.map_err(|e| AppError::Msg(e.to_string()))?;
    let first = arr.as_array().and_then(|a| a.first());
    let pkg = first.and_then(|f| f.pointer("/binary/package"));
    let link = pkg.and_then(|p| p.get("link")).and_then(Value::as_str);
    let Some(link) = link else {
        return Err(AppError::Msg(format!("Adoptium 未提供 Java {major} 的安装包")));
    };
    Ok(AdoptiumRelease {
        major,
        name: pkg.and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or("").to_string(),
        link: link.to_string(),
        size: pkg.and_then(|p| p.get("size")).and_then(Value::as_u64).unwrap_or(0),
        version: first.and_then(|f| f.pointer("/version/semver")).and_then(Value::as_str).unwrap_or(&major.to_string()).to_string(),
    })
}

/// 命令层公开包装（java:remote）
pub async fn adoptium_release_public(major: i64) -> CmdResult<AdoptiumRelease> {
    adoptium_release(major).await
}

/// 流式下载并汇报进度（计量就在写循环里，天然只有一个消费者）
async fn stream_download(url: &str, dest: &Path, total_size: u64, mut on_progress: impl FnMut(u64, u64)) -> CmdResult<PathBuf> {
    let res = HTTP.get(url).header("User-Agent", UA).send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("下载失败（HTTP {}）", res.status().as_u16())));
    }
    let total = res.content_length().unwrap_or(total_size);
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let mut file = tokio::fs::File::create(dest).await?;
    let mut stream = res.bytes_stream();
    let mut received = 0u64;
    let mut last = 0u128;
    use tokio::io::AsyncWriteExt;
    use std::time::SystemTime;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Msg(e.to_string()))?;
        file.write_all(&chunk).await?;
        received += chunk.len() as u64;
        let now = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        if now - last > 300 {
            last = now;
            on_progress(received, total);
        }
    }
    file.flush().await?;
    on_progress(received, total.max(received));
    Ok(dest.to_path_buf())
}

/// 在解压目录中查找 java.exe（bin 目录优先）
fn find_java_exe(root: &Path) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) { Ok(e) => e, Err(_) => continue };
        for it in entries.filter_map(Result::ok) {
            let full = it.path();
            if full.is_dir() {
                if it.file_name() == "bin" {
                    let exe = full.join(EXE_NAME);
                    if accessible(&exe) {
                        return Some(exe);
                    }
                }
                stack.push(full);
            }
        }
    }
    None
}

#[derive(Serialize)]
pub struct InstallResult {
    pub major: i64,
    #[serde(rename = "home")]
    pub home_dir: String,
    pub path: String,
    pub version: String,
    pub detected: i64,
    pub name: String,
}

/// 下载并解压 Java 到 userData/java/jre-<major>
pub async fn install(major: i64, app: &AppHandle) -> CmdResult<InstallResult> {
    let info = adoptium_release(major).await?;
    let home = java_home();
    let zip_path = home.join(format!(".tmp-jre-{major}.zip"));
    let tmp_dir = home.join(format!(".tmp-extract-{major}-{}", chrono::Utc::now().timestamp()));

    crate::logger::info(&format!("开始下载 Java {major}（{}）", info.name));
    let app2 = app.clone();
    stream_download(&info.link, &zip_path, info.size, move |received, total| {
        let percent = if total > 0 { (received as f64 / total as f64 * 100.0) as i64 } else { 0 };
        let _ = app2.emit(EV_JAVA_PROGRESS, json!({"major": major, "stage": "download", "received": received, "total": total, "percent": percent}));
    })
    .await?;

    // 解压
    tokio::fs::create_dir_all(&tmp_dir).await?;
    let zip_c = zip_path.clone();
    let tmp_c = tmp_dir.clone();
    let app3 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        extract_zip_blocking(&zip_c, &tmp_c, |done, total| {
            let percent = (done as f64 / total as f64 * 100.0) as i64;
            let _ = app3.emit(EV_JAVA_PROGRESS, json!({"major": major, "stage": "extract", "percent": percent}));
        })
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))??;

    let exe = find_java_exe(&tmp_dir).ok_or_else(|| AppError::Msg("安装包中未找到 java 可执行文件".into()))?;
    // 顶层目录即 JAVA_HOME，移动为 jre-<major>
    // exe = <root>/bin/java.exe；两次 dirname（对齐 JS）得到 <root>
    let root_dir = exe.parent().and_then(Path::parent).unwrap_or(&tmp_dir).to_path_buf();
    let dest = home.join(format!("jre-{major}"));
    let _ = std::fs::remove_dir_all(&dest);
    if same_path(&root_dir, &tmp_dir) {
        // 压缩包没有顶层目录：直接搬临时目录
        std::fs::rename(&tmp_dir, &dest)?;
    } else {
        std::fs::rename(&root_dir, &dest)?;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    let final_exe = dest.join("bin").join(EXE_NAME);
    let ver = version_info(&final_exe.to_string_lossy()).await;
    crate::logger::info(&format!("Java {major} 安装完成：{}", final_exe.display()));
    let _ = std::fs::remove_file(&zip_path);

    Ok(InstallResult {
        major,
        home_dir: dest.to_string_lossy().to_string(),
        path: final_exe.to_string_lossy().to_string(),
        version: ver.as_ref().map(|(_, t)| t.clone()).unwrap_or(info.version),
        detected: ver.map(|(m, _)| m).unwrap_or(major),
        name: info.name,
    })
}

fn same_path(a: &Path, b: &Path) -> bool {
    std::fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf()) == std::fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf())
}
