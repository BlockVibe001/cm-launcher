//! 下载任务队列（对齐 Electron 版 src/main/system/downloads.js）。
//! 状态由 main.rs `.manage(downloads::DownloadsState::new())` 注册，命令经 app.state 访问；
//! 每次任务变化 emit `downloads:changed`（events::EV_DOWNLOADS_CHANGED，载荷 = 完整列表）。
//! 持久化：user_data_dir()/downloads.json（只存已收尾任务，最近 MAX_HISTORY=120 条）。
//! 队列语义：MAX_CONCURRENT=3 并发、排队等待、取消/重试/删除/清空、.part 临时文件收尾改名。
//!
//! 本文件由 OrganizeAgent 以 todo!() 骨架交付：把 todo!() 替换为真实实现即可，
//! 不得修改 #[tauri::command(rename = "...")] 通道名与函数签名、pub 结构体字段。

use crate::error::{AppError, CmdResult};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const MAX_CONCURRENT: usize = 3;
pub const MAX_HISTORY: usize = 120;

/// 全局下载队列状态（main.rs .manage 注册）
pub struct DownloadsState {
    /// 全部任务（含内部下划线字段，list/落盘前需清洗）。字段对齐 Electron：
    /// id/name/kind/url/dest/status/percent/received/total/speed/error/addedAt/finishedAt/startedAt
    pub tasks: Mutex<Vec<Value>>,
    /// id -> 取消标志（downloads:cancel 置 true，下载任务与 pump 检查）
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadsState {
    pub fn new() -> Self {
        DownloadsState {
            tasks: Mutex::new(Vec::new()),
            cancels: Mutex::new(HashMap::new()),
        }
    }
}

static SEQ: AtomicU64 = AtomicU64::new(0);
static LOADED: AtomicBool = AtomicBool::new(false);

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 清洗一条任务：去掉下划线开头内部字段
fn clean(t: &Value) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(m) = t.as_object() {
        for (k, v) in m {
            if k.starts_with('_') {
                continue;
            }
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// 完整列表快照（按 addedAt 倒序，清洗后）
pub fn snapshot(state: &DownloadsState) -> Vec<Value> {
    ensure_loaded(state);
    let g = state.tasks.lock().unwrap();
    let mut v: Vec<Value> = g.iter().map(clean).collect();
    v.sort_by(|a, b| {
        b.get("addedAt")
            .and_then(Value::as_i64)
            .cmp(&a.get("addedAt").and_then(Value::as_i64))
    });
    v
}

/// emit downloads:changed（载荷为完整列表）
pub fn emit_changed(app: &AppHandle) {
    let state = app.state::<DownloadsState>();
    let list = snapshot(&state);
    let _ = app.emit(crate::events::EV_DOWNLOADS_CHANGED, Value::Array(list));
}

/// 从磁盘加载历史任务（未收尾的标记 failed「应用已退出」）；延迟到首次使用时调用
pub fn ensure_loaded(state: &DownloadsState) {
    if LOADED.swap(true, Ordering::SeqCst) {
        return;
    }
    let path = crate::config::user_data_dir().join("downloads.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(arr) = serde_json::from_str::<Vec<Value>>(&text) {
            let mut g = state.tasks.lock().unwrap();
            for mut t in arr {
                if t.get("finishedAt").and_then(Value::as_i64).unwrap_or(0) == 0 {
                    t["status"] = json!("failed");
                    t["error"] = json!("应用已退出");
                    t["finishedAt"] = json!(now_ms());
                }
                g.push(t);
            }
        }
    }
}

/// 持久化已收尾任务
fn persist(state: &DownloadsState) {
    let done: Vec<Value> = {
        let g = state.tasks.lock().unwrap();
        g.iter()
            .filter(|t| t.get("finishedAt").and_then(Value::as_i64).unwrap_or(0) != 0)
            .map(clean)
            .collect()
    };
    // 取最近 MAX_HISTORY 条（done 按插入时间旧→新）
    let trimmed: Vec<Value> = done
        .into_iter()
        .rev()
        .take(MAX_HISTORY)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let path = crate::config::user_data_dir().join("downloads.json");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(&trimmed) {
        let _ = std::fs::write(path, s);
    }
}

/// 下载默认目录（user_data_dir()/downloads，自动创建）
pub fn default_dir() -> PathBuf {
    let dir = crate::config::user_data_dir().join("downloads");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 最小 percent-decode（对齐 decodeURIComponent 对路径末段的解码）
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16);
            let lo = (b[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 由 URL 猜测文件名（对齐 guessName）
fn guess_name(url: &str) -> String {
    let path: &str = url.split('?').next().unwrap_or("");
    let last = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let decoded = percent_decode(last);
    if decoded.is_empty() {
        "未命名文件".to_string()
    } else {
        decoded
    }
}

fn is_cancelled(state: &DownloadsState, id: &str) -> bool {
    state
        .cancels
        .lock()
        .unwrap()
        .get(id)
        .map(|a| a.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// 局部修改一条任务字段
fn patch_task(state: &DownloadsState, id: &str, patch: &Value) {
    let mut g = state.tasks.lock().unwrap();
    if let Some(t) = g.iter_mut().find(|t| t.get("id").and_then(Value::as_str) == Some(id)) {
        if let (Some(to), Some(po)) = (t.as_object_mut(), patch.as_object()) {
            for (k, v) in po {
                to.insert(k.clone(), v.clone());
            }
        }
    }
}

/// 调度队列：在并发上限内把 queued 任务领成 running 并 spawn 下载
fn pump(state: &DownloadsState, app: &AppHandle) {
    loop {
        let claim: Option<(String, Value)> = {
            let mut g = state.tasks.lock().unwrap();
            let running = g
                .iter()
                .filter(|t| t.get("status").and_then(Value::as_str) == Some("running"))
                .count();
            if running >= MAX_CONCURRENT {
                break;
            }
            let mut claim: Option<(String, Value)> = None;
            for t in g.iter_mut() {
                if t.get("status").and_then(Value::as_str) == Some("queued") {
                    let id = t.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    let opts = t.get("_opts").cloned().unwrap_or(Value::Null);
                    t["status"] = json!("running");
                    t["startedAt"] = json!(now_ms());
                    claim = Some((id, opts));
                    break;
                }
            }
            claim
        };
        match claim {
            Some((id, opts)) => {
                let app_c = app.clone();
                tauri::async_runtime::spawn(async move {
                    let st = app_c.state::<DownloadsState>();
                    let _ = run_download(&st, &app_c, &id, &opts).await;
                    pump(&st, &app_c);
                });
            }
            None => break,
        }
    }
}

/// 新建任务并入队（Electron enqueue 语义）；返回任务 id
pub fn enqueue(state: &DownloadsState, app: &AppHandle, opts: &Value) -> CmdResult<String> {
    ensure_loaded(state);
    let url = opts.get("url").and_then(Value::as_str).unwrap_or("").to_string();
    if url.is_empty() {
        return Err(AppError::Msg("下载地址为空".into()));
    }
    let name = opts
        .get("name")
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| guess_name(&url));
    let kind = opts.get("kind").and_then(Value::as_str).unwrap_or("file").to_string();
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let id = format!("dl-{}-{}", now_ms(), seq);
    let task = json!({
        "id": id,
        "name": name,
        "kind": kind,
        "url": url,
        "dest": opts.get("dest").cloned().unwrap_or(json!("")),
        "status": "queued",
        "percent": 0,
        "received": 0,
        "total": opts.get("size").cloned().unwrap_or(json!(0)),
        "speed": 0,
        "error": "",
        "addedAt": now_ms(),
        "finishedAt": 0,
        "startedAt": 0,
        "_opts": opts,
    });
    state.tasks.lock().unwrap().push(task);
    state
        .cancels
        .lock()
        .unwrap()
        .insert(id.clone(), Arc::new(AtomicBool::new(false)));
    emit_changed(app);
    pump(state, app);
    Ok(id)
}

/// 真正执行下载：流式写 .part，进度 ≥300ms 更新一次并 emit，完成后改名
async fn run_download(state: &DownloadsState, app: &AppHandle, id: &str, opts: &Value) -> CmdResult<()> {
    let url = opts.get("url").and_then(Value::as_str).unwrap_or("").to_string();
    if url.is_empty() {
        patch_task(state, id, &json!({"status":"failed","error":"下载地址为空","finishedAt":now_ms(),"speed":0}));
        emit_changed(app);
        persist(state);
        return Err(AppError::Msg("下载地址为空".into()));
    }
    let name = opts.get("name").and_then(Value::as_str).unwrap_or("未命名文件").to_string();
    let total0 = opts.get("size").and_then(Value::as_u64).unwrap_or(0);
    let dest = opts
        .get("dest")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| default_dir().join(&name).to_string_lossy().to_string());
    let dest_pb = PathBuf::from(&dest);
    if let Some(parent) = dest_pb.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let tmp = format!("{dest}.part");

    let mut req = crate::net::HTTP.get(&url);
    if let Some(headers) = opts.get("headers").and_then(Value::as_object) {
        for (k, v) in headers {
            if let Some(val) = v.as_str() {
                req = req.header(k, val);
            }
        }
    }

    patch_task(state, id, &json!({"status":"running","startedAt":now_ms()}));
    emit_changed(app);

    let result = async {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let resp = req
            .send()
            .await
            .map_err(|e| AppError::Msg(e.to_string()))?;
        if !resp.status().is_success() {
            return Err::<u64, AppError>(AppError::Msg(format!(
                "下载失败（HTTP {}）",
                resp.status().as_u16()
            )));
        }
        let total = resp.content_length().unwrap_or(total0);
        patch_task(state, id, &json!({"total": total}));
        let mut file = tokio::fs::File::create(&tmp).await?;
        let mut stream = resp.bytes_stream();
        let mut received: u64 = 0;
        let mut last_emit = Instant::now() - Duration::from_millis(500);
        let mut last_bytes: u64 = 0;
        let mut last_time = Instant::now();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Msg(e.to_string()))?;
            if is_cancelled(state, id) {
                return Err(AppError::Canceled);
            }
            file.write_all(&chunk).await?;
            received += chunk.len() as u64;
            let now = Instant::now();
            if now.duration_since(last_emit) >= Duration::from_millis(300) {
                let dt = now.duration_since(last_time).as_secs_f64();
                let speed = if dt > 0.0 {
                    (received - last_bytes) as f64 / dt
                } else {
                    0.0
                };
                let percent = if total > 0 {
                    ((received as f64 / total as f64) * 100.0).round().min(99.0) as u64
                } else {
                    0
                };
                patch_task(
                    state,
                    id,
                    &json!({"received": received, "speed": speed, "percent": percent}),
                );
                emit_changed(app);
                last_emit = now;
                last_bytes = received;
                last_time = now;
            }
        }
        file.flush().await?;
        drop(file);
        Ok::<u64, AppError>(received)
    }
    .await;

    match result {
        Ok(received) => {
            if is_cancelled(state, id) {
                let _ = tokio::fs::remove_file(&tmp).await;
                patch_task(state, id, &json!({"status":"cancelled","error":"","finishedAt":now_ms(),"speed":0}));
            } else {
                tokio::fs::rename(&tmp, &dest_pb).await?;
                patch_task(state, id, &json!({
                    "status":"done","percent":100,"received":received,"total":received,
                    "dest":dest,"finishedAt":now_ms(),"speed":0
                }));
            }
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            if is_cancelled(state, id) || matches!(e, AppError::Canceled) {
                patch_task(state, id, &json!({"status":"cancelled","error":"","finishedAt":now_ms(),"speed":0}));
            } else {
                patch_task(state, id, &json!({"status":"failed","error":e.to_string(),"finishedAt":now_ms(),"speed":0}));
            }
        }
    }
    emit_changed(app);
    persist(state);
    Ok(())
}

/// channel: downloads:list
#[tauri::command(rename = "downloads:list")]
pub fn downloads_list(app: tauri::AppHandle) -> Value {
    let state = app.state::<DownloadsState>();
    Value::Array(snapshot(&state))
}

/// channel: downloads:add —— 入参 opts: Value { url, name?, kind?, dest?, headers?, size? }
/// 返回任务 id（String）
#[tauri::command(rename = "downloads:add")]
pub fn downloads_add(app: tauri::AppHandle, opts: Value) -> CmdResult<String> {
    let state = app.state::<DownloadsState>();
    enqueue(&state, &app, &opts)
}

/// channel: downloads:cancel —— 返回 true；任务不存在抛错
#[tauri::command(rename = "downloads:cancel")]
pub fn downloads_cancel(app: tauri::AppHandle, id: String) -> CmdResult<bool> {
    let state = app.state::<DownloadsState>();
    ensure_loaded(&state);
    {
        let g = state.tasks.lock().unwrap();
        if !g.iter().any(|t| t.get("id").and_then(Value::as_str) == Some(id.as_str())) {
            return Err(AppError::Msg("任务不存在".into()));
        }
    }
    if let Some(a) = state.cancels.lock().unwrap().get(&id) {
        a.store(true, Ordering::SeqCst);
    }
    let mut just_queued = false;
    {
        let mut g = state.tasks.lock().unwrap();
        if let Some(t) = g.iter_mut().find(|t| t.get("id").and_then(Value::as_str) == Some(id.as_str())) {
            if t.get("status").and_then(Value::as_str) == Some("queued") {
                t["status"] = json!("cancelled");
                t["finishedAt"] = json!(now_ms());
                just_queued = true;
            }
        }
    }
    if just_queued {
        emit_changed(&app);
        persist(&state);
    }
    Ok(true)
}

/// channel: downloads:retry —— 返回 true
#[tauri::command(rename = "downloads:retry")]
pub fn downloads_retry(app: tauri::AppHandle, id: String) -> CmdResult<bool> {
    let state = app.state::<DownloadsState>();
    ensure_loaded(&state);
    {
        let g = state.tasks.lock().unwrap();
        if !g.iter().any(|t| t.get("id").and_then(Value::as_str) == Some(id.as_str())) {
            return Err(AppError::Msg("任务不存在".into()));
        }
    }
    if let Some(a) = state.cancels.lock().unwrap().get(&id) {
        a.store(false, Ordering::SeqCst);
    }
    {
        let mut g = state.tasks.lock().unwrap();
        if let Some(t) = g.iter_mut().find(|t| t.get("id").and_then(Value::as_str) == Some(id.as_str())) {
            // 历史加载回来的任务没有 _opts，从已持久化字段重建
            if t.get("_opts").is_none() {
                t["_opts"] = json!({
                    "url": t.get("url").cloned().unwrap_or(json!("")),
                    "dest": t.get("dest").cloned().unwrap_or(json!("")),
                    "name": t.get("name").cloned().unwrap_or(json!("")),
                    "size": t.get("total").cloned().unwrap_or(json!(0)),
                });
            }
            t["status"] = json!("queued");
            t["error"] = json!("");
            t["percent"] = json!(0);
            t["received"] = json!(0);
            t["speed"] = json!(0);
            t["finishedAt"] = json!(0);
            t["startedAt"] = json!(0);
            t["addedAt"] = json!(now_ms());
        }
    }
    emit_changed(&app);
    pump(&state, &app);
    Ok(true)
}

/// channel: downloads:remove —— 删除任务（含取消进行中）；不存在返回 false
#[tauri::command(rename = "downloads:remove")]
pub fn downloads_remove(app: tauri::AppHandle, id: String) -> CmdResult<bool> {
    let state = app.state::<DownloadsState>();
    ensure_loaded(&state);
    let existed = state
        .tasks
        .lock()
        .unwrap()
        .iter()
        .any(|t| t.get("id").and_then(Value::as_str) == Some(id.as_str()));
    if !existed {
        return Ok(false);
    }
    if let Some(a) = state.cancels.lock().unwrap().get(&id) {
        a.store(true, Ordering::SeqCst);
    }
    state.tasks.lock().unwrap().retain(|t| t.get("id").and_then(Value::as_str) != Some(id.as_str()));
    state.cancels.lock().unwrap().remove(&id);
    emit_changed(&app);
    persist(&state);
    Ok(true)
}

/// channel: downloads:clear —— 清空已收尾任务，返回 true
#[tauri::command(rename = "downloads:clear")]
pub fn downloads_clear(app: tauri::AppHandle) -> CmdResult<bool> {
    let state = app.state::<DownloadsState>();
    ensure_loaded(&state);
    state.tasks.lock().unwrap().retain(|t| {
        t.get("finishedAt").and_then(Value::as_i64).unwrap_or(0) == 0
    });
    emit_changed(&app);
    persist(&state);
    Ok(true)
}

/// channel: downloads:openDir —— 返回下载目录路径
#[tauri::command(rename = "downloads:openDir")]
pub fn downloads_open_dir() -> String {
    default_dir().to_string_lossy().to_string()
}
