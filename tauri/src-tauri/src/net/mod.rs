//! 网络层：共享 HTTP 客户端、镜像改写、下载器。

pub mod downloader;
pub mod mirror;

use std::sync::LazyLock;

pub static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent("CM-Launcher/1.0")
        .build()
        .expect("build http client")
});
