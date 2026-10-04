//! 统一错误：序列化为纯字符串消息，前端适配层包成 Error 对象，
//! 与 Electron 时代 e.message 的取法保持一致。

use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("{0}")]
    Msg(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    /// 带 OAuth 错误码与 HTTP 状态（设备码轮询要按 code 分支）
    #[error("{message}")]
    Auth { code: String, status: u16, message: String },
    /// 用户主动取消下载（对应 JS CanceledError.code = 'CANCELED'）
    #[error("已取消下载")]
    Canceled,
}

impl AppError {
    #[allow(dead_code)]
    pub fn code(&self) -> &str {
        match self {
            AppError::Auth { code, .. } => code,
            AppError::Canceled => "CANCELED",
            _ => "",
        }
    }

    #[allow(dead_code)]
    pub fn status(&self) -> u16 {
        match self {
            AppError::Auth { status, .. } => *status,
            _ => 0,
        }
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Msg(s.to_string())
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Msg(s)
    }
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type CmdResult<T> = Result<T, AppError>;
