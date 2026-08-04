//! 应用全局状态。

use std::sync::RwLock;
use tauri::async_runtime::JoinHandle;

use crate::model::{AppConfig, QuoteUpdate};

pub struct AppState {
    /// 最近一次完整刷新结果（前端 fetch_* 命令读这里）
    pub quote: RwLock<Option<QuoteUpdate>>,
    /// 归一化后的当前配置（内存权威副本，save_config 时更新）
    pub config: RwLock<AppConfig>,
    /// popup 延迟销毁计时器句柄（hide 后启动，show 时取消）
    pub popup_destroy_timer: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        Self {
            quote: RwLock::new(None),
            config: RwLock::new(config),
            popup_destroy_timer: std::sync::Mutex::new(None),
        }
    }
}
