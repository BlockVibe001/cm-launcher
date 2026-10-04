//! 运行日志：与 Electron 版 logger.js 对齐。
//! 内存 2000 条环形缓冲 + userData/logs/launcher-YYYY-MM-DD.log 落盘 + emit('log')。

use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::sync::{OnceLock, RwLock};
use tauri::{AppHandle, Emitter};

const MAX_BUFFER: usize = 2000;

#[derive(Clone, Serialize)]
pub struct LogEntry {
    pub level: String,
    pub message: String,
    pub time: String,
}

struct LoggerState {
    buffer: VecDeque<LogEntry>,
    file: Option<File>,
}

static STATE: OnceLock<RwLock<LoggerState>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app_handle(app: AppHandle) {
    let _ = APP.set(app);
}

fn state() -> &'static RwLock<LoggerState> {
    STATE.get_or_init(|| {
        let dir = crate::config::user_data_dir().join("logs");
        let _ = fs::create_dir_all(&dir);
        let name = format!("launcher-{}.log", chrono::Utc::now().format("%Y-%m-%d"));
        let file = OpenOptions::new().create(true).append(true).open(dir.join(name)).ok();
        RwLock::new(LoggerState {
            buffer: VecDeque::new(),
            file,
        })
    })
}

fn push(level: &str, message: &str) {
    let entry = LogEntry {
        level: level.to_string(),
        message: message.to_string(),
        time: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    {
        let mut g = state().write().unwrap();
        if let Some(f) = g.file.as_mut() {
            let _ = writeln!(f, "[{}] [{}] {}", entry.time, entry.level, entry.message);
        }
        g.buffer.push_back(entry.clone());
        while g.buffer.len() > MAX_BUFFER {
            g.buffer.pop_front();
        }
    }
    if let Some(app) = APP.get() {
        let _ = app.emit(crate::events::EV_LOG, entry);
    }
}

pub fn info(m: impl AsRef<str>) {
    push("info", m.as_ref());
}
#[allow(dead_code)]
pub fn warn(m: impl AsRef<str>) {
    push("warn", m.as_ref());
}
#[allow(dead_code)]
pub fn error(m: impl AsRef<str>) {
    push("error", m.as_ref());
}
pub fn history() -> Vec<LogEntry> {
    state().read().unwrap().buffer.iter().cloned().collect()
}
