//! 统一错误类型：所有数据层错误转为 String，供 tauri command 返回。
#![allow(dead_code)]

use std::fmt;

#[derive(Debug)]
pub struct AppError(pub String);

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for AppError {}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError(format!("网络错误: {e}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError(format!("JSON 解析错误: {e}"))
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError(s.to_string())
    }
}

impl AppError {
    pub fn msg(m: impl Into<String>) -> Self {
        AppError(m.into())
    }
}

/// command 统一返回类型
pub type AppResult<T> = Result<T, String>;
