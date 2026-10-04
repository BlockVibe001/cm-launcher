//! 全局应用状态：下载取消标志 + 游戏运行标志。
//! 配置走 config 模块全局缓存，不在这里。

use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Arc;

pub struct AppState {
    /// 下载取消：game:cancel 置 1，prepare 各处检查；启动前复位为 0
    pub download_cancel: Arc<AtomicUsize>,
    /// 游戏是否运行中（game:running 读它）
    pub game_running: AtomicBool,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            download_cancel: Arc::new(AtomicUsize::new(0)),
            game_running: AtomicBool::new(false),
        }
    }
}
