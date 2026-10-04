//! 下载器：与 Electron 版 minecraft/downloader.js 对齐。
//! 关键语义：
//! - 单文件 3 次重试、sha1 命中跳过；
//! - 批量 8 并发，个别文件失败不拖垮整批，跑完逐个补下一次；
//! - 进度计量只在任务收尾处累计，无并行 data listener；
//! - maven 坐标解析（Fabric/Quilt 库自愈）与 natives 解压。

use crate::error::{AppError, CmdResult};
use crate::mc::rules::matches_rules_value;
use crate::net::mirror::mirror_url;
use crate::net::HTTP;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const CONCURRENCY: usize = 8;

// ---------------- SHA1 ----------------

/// 流式计算文件 sha1（对应 JS hashFile）
pub async fn hash_file(file: &Path) -> CmdResult<String> {
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(file).await?;
    let mut hasher = Sha1::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// 缓冲区 sha1（对应 JS hashBuffer）
pub fn hash_buffer(buf: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(buf);
    hex::encode(hasher.finalize())
}

fn check_cancel(cancel: &AtomicUsize) -> CmdResult<()> {
    if cancel.load(Ordering::SeqCst) != 0 {
        Err(AppError::Canceled)
    } else {
        Ok(())
    }
}

async fn fetch_bytes(url: &str, cancel: &AtomicUsize) -> CmdResult<Vec<u8>> {
    check_cancel(cancel)?;
    let res = HTTP.get(mirror_url(url)).send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::Msg(format!("HTTP {}", res.status().as_u16())));
    }
    let bytes = res.bytes().await.map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(bytes.to_vec())
}

/**
 * 下载单个文件（已存在且 sha1 匹配则跳过），最多重试 3 次。
 * @returns 是否实际发生了网络下载
 */
pub async fn download_file(
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    cancel: &AtomicUsize,
) -> CmdResult<bool> {
    check_cancel(cancel)?;

    if tokio::fs::try_exists(dest).await.unwrap_or(false) {
        if expected_sha1.is_none() || hash_file(dest).await.ok().as_deref() == expected_sha1 {
            return Ok(false);
        }
    }

    let mut last_err = AppError::Msg("unknown".into());
    for attempt in 1..=3u64 {
        match fetch_bytes(url, cancel).await {
            Ok(buf) => {
                if let Some(sha) = expected_sha1 {
                    if hash_buffer(&buf) != sha {
                        return Err(AppError::Msg("SHA1 校验失败".into()));
                    }
                }
                if let Some(dir) = dest.parent() {
                    tokio::fs::create_dir_all(dir).await?;
                }
                tokio::fs::write(dest, &buf).await?;
                return Ok(true);
            }
            Err(e) => {
                if matches!(e, AppError::Canceled) {
                    return Err(e);
                }
                crate::logger::warn(&format!("下载重试 {attempt}/3：{}（{}）", dest.file_name().and_then(|n| n.to_str()).unwrap_or(""), e));
                last_err = e;
                if attempt < 3 {
                    // 网络抖动立刻重试往往还失败，退避一下
                    tokio::time::sleep(std::time::Duration::from_millis(400 * attempt)).await;
                }
            }
        }
    }
    Err(AppError::Msg(format!(
        "下载失败：{}（{}）",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or(""),
        last_err
    )))
}

// ---------------- Maven ----------------

#[derive(Debug)]
pub struct MavenName {
    pub group: String,
    pub artifact: String,
    pub version: String,
    pub classifier: Option<String>,
}

pub fn parse_maven_name(name: &str) -> MavenName {
    let p: Vec<&str> = name.split(':').collect();
    let get = |i: usize| p.get(i).map(|s| s.to_string()).unwrap_or_default();
    MavenName {
        group: get(0),
        artifact: get(1),
        version: get(2),
        classifier: p.get(3).map(|s| s.to_string()),
    }
}

/// maven 坐标 → libraries 目录下相对路径；坐标不完整返回 ''（对应 JS mavenLibPath）
pub fn maven_lib_path(name: &str) -> String {
    let m = parse_maven_name(name);
    if m.group.is_empty() || m.artifact.is_empty() || m.version.is_empty() {
        return String::new();
    }
    let cls = m.classifier.map(|c| format!("-{c}")).unwrap_or_default();
    let file = format!("{}-{}{}.jar", m.artifact, m.version, cls);
    let group_path = m.group.replace('.', "/");
    // 统一正斜杠
    format!("{group_path}/{}/{}/{}", m.artifact, m.version, file)
}

fn is_current_os_classifier(classifier: &str) -> bool {
    let c = classifier;
    cfg!(target_os = "windows") && c.contains("windows")
        || cfg!(target_os = "macos") && (c.contains("osx") || c.contains("macos"))
        || cfg!(target_os = "linux") && c.contains("linux")
}

// ---------------- ZIP 解压（阻塞，spawn_blocking 调用） ----------------

/// 解压 zip 到目录，保留目录层级，含越界路径防护；每 20 条目回调一次进度。
pub fn extract_zip_blocking(
    zip_path: &Path,
    dest_dir: &Path,
    mut on_progress: impl FnMut(usize, usize),
) -> CmdResult<usize> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AppError::Msg(e.to_string()))?;
    std::fs::create_dir_all(dest_dir)?;
    let total = archive.len();
    for i in 0..total {
        let mut entry = archive.by_index(i).map_err(|e| AppError::Msg(e.to_string()))?;
        // 去掉 .. 与绝对路径（等价 JS safeEntryPath），zip 已内置防护
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let out = dest_dir.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut f = std::fs::File::create(&out)?;
            std::io::copy(&mut entry, &mut f)?;
        }
        if (i + 1) % 20 == 0 || i + 1 == total {
            on_progress(i + 1, total);
        }
    }
    Ok(total)
}

/// 解压 natives 并清理 excludes（如 META-INF/）
pub async fn extract_natives(
    zip_file: &Path,
    dest_dir: &Path,
    excludes: &[String],
    cancel: &AtomicUsize,
) -> CmdResult<()> {
    check_cancel(cancel)?;
    let zip = zip_file.to_path_buf();
    let dest = dest_dir.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        extract_zip_blocking(&zip, &dest, |_, _| {})
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))??;

    for ex in excludes {
        let trimmed = ex.trim_end_matches(['/', '\\']);
        let target = dest_dir.join(trimmed);
        let _ = if target.is_dir() {
            std::fs::remove_dir_all(&target)
        } else {
            std::fs::remove_file(&target)
        };
    }
    Ok(())
}

// ---------------- 版本文件准备 ----------------

#[derive(Clone, Debug)]
struct DownloadTask {
    url: String,
    dest: PathBuf,
    sha1: Option<String>,
    size: u64,
    label: String,
}

#[derive(Clone)]
struct Extraction {
    zip: PathBuf,
    dest_dir: PathBuf,
    excludes: Vec<String>,
}

#[derive(Serialize, Clone)]
#[allow(non_snake_case)]
struct Progress {
    completed: usize,
    total: usize,
    bytesDone: u64,
    bytesTotal: u64,
    current: String,
    percent: i64,
}

/// 组装并 emit 下载进度
fn report_progress(
    app: &AppHandle,
    total: usize,
    bytes_total: u64,
    completed: &AtomicUsize,
    bytes_done: &AtomicU64,
    current: &str,
) {
    let done = completed.load(Ordering::SeqCst);
    let p = Progress {
        completed: done,
        total,
        bytesDone: bytes_done.load(Ordering::SeqCst),
        bytesTotal: bytes_total,
        current: current.to_string(),
        percent: if total == 0 { 100 } else { (done as i64 * 100) / total as i64 },
    };
    let _ = app.emit(crate::events::EV_DOWNLOAD_PROGRESS, p);
}

/// 确保版本所有文件就绪：client、libraries、natives、assets。
pub async fn prepare_game(
    vj: &serde_json::Value,
    game_dir: &Path,
    app: &AppHandle,
    cancel: Arc<AtomicUsize>,
) -> CmdResult<()> {
    let id = vj.get("id").and_then(serde_json::Value::as_str).unwrap_or("");
    let versions_dir = game_dir.join("versions").join(id);
    let natives_dir = versions_dir.join("natives");
    let libraries_dir = game_dir.join("libraries");
    let assets_dir = game_dir.join("assets");

    tokio::fs::create_dir_all(&versions_dir).await?;
    // 只在本地还没有版本清单时才写：加载器版本清单带 inheritsFrom，
    // 用合并结果覆盖会让下次解析重复叠一遍父版本参数。
    let version_json = versions_dir.join(format!("{id}.json"));
    if !tokio::fs::try_exists(&version_json).await.unwrap_or(false) {
        tokio::fs::write(&version_json, serde_json::to_vec_pretty(vj)?).await?;
    }

    let mut downloads: Vec<DownloadTask> = Vec::new();
    let mut extractions: Vec<Extraction> = Vec::new();
    let mut copies: Vec<(PathBuf, PathBuf)> = Vec::new();

    // 1) 客户端主 jar（继承版指向父版本目录）
    let client = vj.pointer("/downloads/client").ok_or_else(|| AppError::Msg("版本清单缺少 client 下载信息".into()))?;
    let client_dest = match client.get("path").and_then(serde_json::Value::as_str) {
        Some(p) => game_dir.join(p),
        None => versions_dir.join(format!("{id}.jar")),
    };
    let client_label = client_dest.file_name().and_then(|n| n.to_str()).unwrap_or(&id).to_string();
    downloads.push(DownloadTask {
        url: client["url"].as_str().unwrap_or("").to_string(),
        dest: client_dest,
        sha1: client["sha1"].as_str().map(String::from),
        size: client["size"].as_u64().unwrap_or(0),
        label: client_label,
    });

    // 2) 库文件与原生库
    if let Some(libs) = vj.get("libraries").and_then(serde_json::Value::as_array) {
        for lib in libs {
            if let Some(rules) = lib.get("rules") {
                if !matches_rules_value(rules) {
                    continue;
                }
            }

            let artifact = lib.pointer("/downloads/artifact");
            if let Some(art) = artifact {
                let path = art["path"].as_str().unwrap_or("").to_string();
                downloads.push(DownloadTask {
                    url: art["url"].as_str().unwrap_or("").to_string(),
                    dest: libraries_dir.join(&path),
                    sha1: art["sha1"].as_str().map(String::from),
                    size: art["size"].as_u64().unwrap_or(0),
                    label: path,
                });
            } else if lib.get("natives").is_none() {
                // Fabric/Quilt profile：库只给 name + maven url，不补会导致 loader 从不下载 / 无法自愈
                let name = lib.get("name").and_then(serde_json::Value::as_str).unwrap_or("");
                let rel = maven_lib_path(name);
                let m = parse_maven_name(name);
                if !rel.is_empty() && m.classifier.is_none() {
                    let base_raw = lib.get("url").and_then(serde_json::Value::as_str)
                        .unwrap_or("https://libraries.minecraft.net/");
                    // 对齐 JS：结尾补一个斜杠
                    let base = if base_raw.ends_with('/') { base_raw.to_string() } else { format!("{base_raw}/") };
                    downloads.push(DownloadTask {
                        url: format!("{base}{rel}"),
                        dest: libraries_dir.join(&rel),
                        sha1: None,
                        size: 0,
                        label: rel,
                    });
                }
            }

            // 新格式：natives 作为带 classifier 的普通库，需要解压
            let name = lib.get("name").and_then(serde_json::Value::as_str).unwrap_or("");
            let maven = parse_maven_name(name);
            if let Some(cls) = &maven.classifier {
                if cls.starts_with("natives-") && is_current_os_classifier(cls) && artifact.is_some() {
                    let art_path = artifact.and_then(|a| a.get("path")).and_then(serde_json::Value::as_str).unwrap_or("");
                    extractions.push(Extraction {
                        zip: libraries_dir.join(art_path),
                        dest_dir: natives_dir.clone(),
                        excludes: vec!["META-INF/".into()],
                    });
                }
            }

            // 旧格式：natives + classifiers
            if lib.get("natives").is_some() {
                if let Some(classifiers) = lib.pointer("/downloads/classifiers") {
                    let os_key = if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "osx" } else { "linux" };
                    if let Some(key_tmpl) = lib["natives"].get(os_key).and_then(serde_json::Value::as_str) {
                        let arch = if std::env::consts::ARCH == "x86_64" { "64" } else { "32" };
                        let key = key_tmpl.replace("${arch}", arch);
                        if let Some(cls) = classifiers.get(&key) {
                            let cls_path = cls["path"].as_str().unwrap_or("").to_string();
                            let zip_dest = libraries_dir.join(&cls_path);
                            downloads.push(DownloadTask {
                                url: cls["url"].as_str().unwrap_or("").to_string(),
                                dest: zip_dest.clone(),
                                sha1: cls["sha1"].as_str().map(String::from),
                                size: cls["size"].as_u64().unwrap_or(0),
                                label: cls_path,
                            });
                            let excludes = lib.pointer("/extract/exclude")
                                .and_then(serde_json::Value::as_array)
                                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                                .unwrap_or_else(|| vec!["META-INF/".into()]);
                            extractions.push(Extraction { zip: zip_dest, dest_dir: natives_dir.clone(), excludes });
                        }
                    }
                }
            }
        }
    }

    // 3) 资源索引与资源文件
    if let Some(asset_index) = vj.get("assetIndex") {
        let idx_id = asset_index["id"].as_str().unwrap_or("");
        let index_dest = assets_dir.join("indexes").join(format!("{idx_id}.json"));
        download_file(
            asset_index["url"].as_str().unwrap_or(""),
            &index_dest,
            asset_index["sha1"].as_str(),
            &cancel,
        )
        .await?;
        let index: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&index_dest).await?)?;

        if let Some(objects) = index.get("objects").and_then(serde_json::Value::as_object) {
            for (name, obj) in objects {
                let hash = obj["hash"].as_str().unwrap_or("");
                let sub = hash.get(0..2).unwrap_or("");
                let dest = assets_dir.join("objects").join(sub).join(hash);
                downloads.push(DownloadTask {
                    url: format!("https://resources.download.minecraft.net/{sub}/{hash}"),
                    dest: dest.clone(),
                    sha1: Some(hash.to_string()),
                    size: obj["size"].as_u64().unwrap_or(0),
                    label: name.clone(),
                });
                if index.get("virtual").and_then(serde_json::Value::as_bool) == Some(true) {
                    copies.push((dest, assets_dir.join("virtual").join(idx_id).join(name)));
                } else if index.get("map_to_resources").and_then(serde_json::Value::as_bool) == Some(true) {
                    copies.push((dest, game_dir.join("resources").join(name)));
                }
            }
        }
    }

    // 4) 并发执行下载并上报进度
    let total = downloads.len() + extractions.len() + copies.len();
    let completed = Arc::new(AtomicUsize::new(0));
    let bytes_done = Arc::new(AtomicU64::new(0));
    let bytes_total: u64 = downloads.iter().map(|d| d.size).sum();
    let cursor = Arc::new(AtomicUsize::new(0));

    // 自由函数式上报：计数器 Arc 在各任务间共享，避免闭包借用逃逸
    let report = |completed: &Arc<AtomicUsize>, bytes_done: &Arc<AtomicU64>, current: &str| {
        report_progress(app, total, bytes_total, completed, bytes_done, current);
    };
    report(&completed, &bytes_done, "");

    // 个别文件失败不能拖垮整批：收集失败，跑完逐个补一次，仍失败才报错。
    let failed: Arc<Mutex<Vec<(DownloadTask, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for _ in 0..CONCURRENCY {
        let cursor = cursor.clone();
        let cancel = cancel.clone();
        let failed = failed.clone();
        let completed = completed.clone();
        let bytes_done = bytes_done.clone();
        let downloads = downloads.clone();
        let app_w = app.clone();
        handles.push(tokio::spawn(async move {
            loop {
                if cancel.load(Ordering::SeqCst) != 0 {
                    return Err::<(), AppError>(AppError::Canceled);
                }
                let i = cursor.fetch_add(1, Ordering::SeqCst);
                let task = match downloads.get(i) {
                    Some(t) => t.clone(),
                    None => return Ok(()),
                };
                match download_file(&task.url, &task.dest, task.sha1.as_deref(), &cancel).await {
                    Ok(_) => {}
                    Err(e) => {
                        if matches!(e, AppError::Canceled) {
                            return Err(e);
                        }
                        failed.lock().unwrap().push((task.clone(), e.to_string()));
                    }
                }
                bytes_done.fetch_add(task.size, Ordering::SeqCst);
                completed.fetch_add(1, Ordering::SeqCst);
                report_progress(&app_w, total, bytes_total, &completed, &bytes_done, &task.label);
            }
        }));
    }
    for h in handles {
        h.await.map_err(|e| AppError::Msg(e.to_string()))??;
    }

    let failed_list: Vec<(DownloadTask, String)> = std::mem::take(&mut *failed.lock().unwrap());
    if !failed_list.is_empty() {
        crate::logger::warn(&format!("{} 个文件本轮下载失败，正在逐个补下载…", failed_list.len()));
        let mut still = Vec::new();
        for (task, _err) in failed_list {
            if cancel.load(Ordering::SeqCst) != 0 {
                return Err(AppError::Canceled);
            }
            match download_file(&task.url, &task.dest, task.sha1.as_deref(), &cancel).await {
                Ok(_) => crate::logger::info(&format!("补下载成功：{}", task.label)),
                Err(e) => {
                    if matches!(e, AppError::Canceled) {
                        return Err(e);
                    }
                    still.push(task);
                }
            }
        }
        if !still.is_empty() {
            let names: Vec<String> = still.iter().take(5).map(|i| i.label.clone()).collect();
            return Err(AppError::Msg(format!(
                "有 {} 个文件下载失败：{}{}。请检查网络后重试。",
                still.len(),
                names.join("、"),
                if still.len() > 5 { " 等" } else { "" },
            )));
        }
    }

    // 5) 解压 natives
    for ex in &extractions {
        if cancel.load(Ordering::SeqCst) != 0 {
            return Err(AppError::Canceled);
        }
        extract_natives(&ex.zip, &ex.dest_dir, &ex.excludes, &cancel).await?;
        completed.fetch_add(1, Ordering::SeqCst);
        if let Some(n) = ex.zip.file_name() {
            report_progress(app, total, bytes_total, &completed, &bytes_done, &n.to_string_lossy());
        }
    }

    // 6) 旧版本资源复制（virtual / map_to_resources）
    for (from, to) in &copies {
        if cancel.load(Ordering::SeqCst) != 0 {
            return Err(AppError::Canceled);
        }
        if let Some(parent) = to.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::copy(from, to).await?;
        completed.fetch_add(1, Ordering::SeqCst);
        if let Some(n) = to.file_name() {
            report_progress(app, total, bytes_total, &completed, &bytes_done, &n.to_string_lossy());
        }
    }

    report_progress(app, total, bytes_total, &completed, &bytes_done, "完成");
    Ok(())
}
