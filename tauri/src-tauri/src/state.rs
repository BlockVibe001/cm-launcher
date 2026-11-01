//! 全局应用状态：下载取消标志 + 游戏运行标志 + 运行中实例集合。
//! 配置走 config 模块全局缓存，不在这里。

use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};

pub struct AppState {
    /// 下载取消：game:cancel 置 1，prepare 各处检查；启动前复位为 0
    pub download_cancel: Arc<AtomicUsize>,
    /// 是否有游戏在运行（总开关，多开时也为 true；game:running 读它）
    pub game_running: AtomicBool,
    /// 正在运行的实例 id 集合（支持多开：只拒绝同一个实例重复启动）
    pub running_instances: Mutex<Vec<String>>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            download_cancel: Arc::new(AtomicUsize::new(0)),
            game_running: AtomicBool::new(false),
            running_instances: Mutex::new(Vec::new()),
        }
    }
}
