//! 事件名常量：与 Electron 版 webContents.send / ipcRenderer.on 的字符串一一对应。
//! 前端适配层按这些名字 listen，保持通道零漂移。
#![allow(dead_code)] // 各阶段落地后逐个启用

pub const EV_DEVICE_CODE: &str = "auth:devicecode";
pub const EV_JAVA_PROGRESS: &str = "java:progress";
pub const EV_DOWNLOAD_PROGRESS: &str = "download:progress";
pub const EV_MODLOADER_PROGRESS: &str = "modloader:progress";
pub const EV_TRANSLATE_PROGRESS: &str = "lab:translate:progress";
pub const EV_MIGRATE_PROGRESS: &str = "migrate:progress";
pub const EV_DOWNLOADS_CHANGED: &str = "downloads:changed";
pub const EV_GAME_STARTED: &str = "game:started";
pub const EV_GAME_EXIT: &str = "game:exit";
pub const EV_GAME_LAN_PORT: &str = "game:lanPort";
pub const EV_SCAFFOLD_STATE: &str = "scaffold:state";
pub const EV_EASYTIER_STATE: &str = "easytier:state";
pub const EV_UPDATE_PROGRESS: &str = "update:progress";
pub const EV_LOG: &str = "log";
