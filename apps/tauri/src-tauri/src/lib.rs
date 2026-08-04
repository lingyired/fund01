// fund01 Tauri 桌面版（macOS menubar）—— 应用装配入口

mod badge;
mod calc;
mod calendar;
mod circuit;
mod commands;
mod error;
mod format;
mod fundname;
mod gold;
mod history;
mod http;
mod market;
mod menubar;
mod model;
mod portfolio;
mod providers;
mod refresh;
mod state;
mod theme;
mod window;

use tauri::{AppHandle, Manager};
use tauri_plugin_multiline_menubar::MultilineMenubarExt;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_multiline_menubar::init())
        .manage(AppState::new(portfolio::default_config()))
        .invoke_handler(tauri::generate_handler![
            commands::trigger_refresh,
            commands::fetch_holdings,
            commands::fetch_watchlist,
            commands::fetch_indices,
            commands::fetch_market_overview,
            commands::fetch_gold,
            commands::fetch_fund_history,
            commands::fetch_index_history,
            commands::fetch_fund_intraday,
            commands::resolve_fund,
            commands::get_config,
            commands::save_config,
            commands::open_settings_window,
            commands::get_version,
        ])
        .setup(|app| {
            // macOS: 不出现在 Dock（menubar 常驻应用）
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // 加载持久化配置（无则用默认）
            load_config(app.handle())?;

            // 插件：禁用自动 popup（生命周期由 window.rs 自管）
            app.multiline_menubar().set_auto_popup(false)?;
            app.multiline_menubar().set_popup_window(window::POPUP_LABEL.to_string())?;

            // 菜单事件（右键菜单项）
            {
                let app = app.handle().clone();
                app.on_menu_event(|app, event| {
                    let item_id = event.id().0.as_str();
                    menubar::on_menu_event(app, item_id);
                });
            }

            // 重建 menubar 实例 + 监听点击
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            let config = state.config.read().unwrap().clone();
            let quote = state.quote.read().unwrap().clone();
            menubar::rebuild_menubar(&handle, &config, quote.as_ref());

            // 启动定时刷新循环 + 立即刷新一次
            refresh::start_refresh_loop(handle.clone());
            refresh::trigger_refresh(handle);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running fund01 tauri application");
}

/// 从 tauri-plugin-store 加载配置；存在则归一化并替换默认值
fn load_config(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json")?;
    let raw = store.get("config").unwrap_or(serde_json::Value::Null);
    let normalized = portfolio::normalize_config(&raw);
    let state = app.state::<AppState>();
    *state.config.write().unwrap() = normalized;
    Ok(())
}
