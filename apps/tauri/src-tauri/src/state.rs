//! 应用全局状态。

use std::sync::RwLock;
use std::time::SystemTime;
use tauri::async_runtime::JoinHandle;

use crate::model::{AppConfig, QuoteUpdate};
use crate::update::CheckUpdateResult;

/// 检查更新结果缓存（内存态，重启即失效；TTL 由 update.rs CACHE_TTL 控制）
pub struct UpdateCheckCache {
    pub checked_at: SystemTime,
    /// None = 已是最新（同样缓存，避免 1h 内重复请求）
    pub result: Option<CheckUpdateResult>,
}

pub struct AppState {
    /// 最近一次完整刷新结果（前端 fetch_* 命令读这里）
    pub quote: RwLock<Option<QuoteUpdate>>,
    /// 归一化后的当前配置（内存权威副本，save_config 时更新）
    pub config: RwLock<AppConfig>,
    /// 最近一次基金刷新使用的数据源（"fundmnfinfo" / "fund123"）。
    /// 供 refresh_day 的 merge_stale_estimate 做同源判断：切源后旧缓存是旧源口径，
    /// 混入会让 percent 与净值差来自不同源（与 Chrome SW 的 cache-source 对齐）。
    pub last_quote_source: RwLock<Option<String>>,
    /// popup 延迟销毁计时器句柄（hide 后启动，show 时取消）
    pub popup_destroy_timer: std::sync::Mutex<Option<JoinHandle<()>>>,
    /// 检查更新结果缓存（设置界面打开时读，1h TTL 防重复请求）
    pub update_cache: RwLock<Option<UpdateCheckCache>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        Self {
            quote: RwLock::new(None),
            config: RwLock::new(config),
            last_quote_source: RwLock::new(None),
            popup_destroy_timer: std::sync::Mutex::new(None),
            update_cache: RwLock::new(None),
        }
    }
}
