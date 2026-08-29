//! 平台分派薄层 —— 状态栏/任务栏实例编排的统一入口。
//!
//! macOS → menubar.rs（multiline-menubar 插件）；Windows → taskband.rs（multiline-taskband 插件）；
//! 其他平台（Linux 等，当前未适配）为 no-op。调用方（lib.rs / commands.rs / refresh.rs）
//! 一律经由本模块，避免在各处散布 `#[cfg]` 分支。
//!
//! `all_hidden` 是纯配置判定（menubar_common::menubar_all_hidden），两平台语义一致，
//! 直接透传（Windows 无 ⌘-拖出通道，「总览被隐藏」不可达，判定恒 false，无害）。

use tauri::AppHandle;

use crate::model::{AppConfig, QuoteUpdate};

/// 应用启动 / 配置变更：收敛实例集合与显隐（+ 右键菜单 + 样式/文字）
pub fn rebuild(app: &AppHandle, config: &AppConfig, quote: Option<&QuoteUpdate>) {
    #[cfg(target_os = "macos")]
    crate::menubar::rebuild_menubar(app, config, quote);
    #[cfg(target_os = "windows")]
    crate::taskband::rebuild_taskbar(app, config, quote);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, config, quote);
    }
}

/// 行情刷新后更新文字与颜色（不重建实例集合之外的东西，幂等）
pub fn update_with(app: &AppHandle, quote: &Option<QuoteUpdate>) {
    #[cfg(target_os = "macos")]
    crate::menubar::update_menubar_with(app, quote);
    #[cfg(target_os = "windows")]
    crate::taskband::update_taskbar_with(app, quote);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, quote);
    }
}

/// 全局菜单事件分发（实例右键菜单 / 托盘菜单；macOS 的 quit 由插件自行处理）
pub fn on_menu_event(app: &AppHandle, item_id: &str) {
    #[cfg(target_os = "macos")]
    crate::menubar::on_menu_event(app, item_id);
    #[cfg(target_os = "windows")]
    crate::taskband::on_menu_event(app, item_id);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, item_id);
    }
}

/// menubar/taskbar 是否全空（所有实例都被隐藏；判定口径与前端 isMenubarEmpty 1:1）
pub fn all_hidden(config: &AppConfig) -> bool {
    crate::menubar_common::menubar_all_hidden(config)
}
