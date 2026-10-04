//! 多人 / 联机功能：服务器 Ping、联机助手（IP/UPnP）、陶瓦、EasyTier。

pub mod easytier;
pub mod lan;
pub mod serverping;
pub mod terracotta;

use std::sync::atomic::AtomicU64;
use std::sync::Mutex;
use tokio::sync::Mutex as AsyncMutex;

/// 联机模块共享状态，随 App 托管。
pub struct MpState {
    /// 陶瓦 HTTP 端口（0=未起）
    pub tc_port: Mutex<u16>,
    /// 陶瓦轮询代次（leave/新请求递增以中断旧轮询）
    pub tc_epoch: AtomicU64,
    /// EasyTier 运行时
    pub et: AsyncMutex<easytier::EtRuntime>,
}

impl MpState {
    pub fn new() -> Self {
        MpState {
            tc_port: Mutex::new(0),
            tc_epoch: AtomicU64::new(0),
            et: AsyncMutex::new(easytier::EtRuntime::new()),
        }
    }
}
