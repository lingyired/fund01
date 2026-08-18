// fund01 Tauri 桌面版（macOS menubar）—— 应用装配入口

mod badge;
mod calc;
mod calendar;
mod commands;
mod dbglog;
mod error;
mod format;
mod fundname;
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        // 开机自启动（macOS LaunchAgent 登录项；与 Clash Verge Rev 同款 tauri-plugin-autostart）。
        // 注意：LaunchAgent 只写 ~/Library/LaunchAgents/*.plist，不立即 launchctl load ——
        // 勾选后需重启登录，launchd 才加载并登记到系统设置「登录项」列表（clash 亦如此）。
        // 第二个参数（--autostart）写入 plist ProgramArguments：登录项拉起时进程带该参数，
        // setup 据此静默常驻（不弹设置窗口），手动打开则无此参数。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        // 原生保存/打开对话框（导出配置选位置保存 → 前端 save() + export_config_file 落盘）
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_multiline_menubar::init())
        .manage(AppState::new(portfolio::default_config()))
        .invoke_handler(tauri::generate_handler![
            commands::trigger_refresh,
            commands::fetch_holdings,
            commands::fetch_indices,
            commands::fetch_last_update,
            commands::get_refresh_schedule,
            commands::fetch_fund_history,
            commands::fetch_index_history,
            commands::fetch_fund_intraday,
            commands::resolve_fund,
            commands::get_config,
            commands::save_config,
            commands::open_settings_window,
            commands::open_popup_tab_window,
            commands::get_version,
            commands::open_external,
            commands::export_config_file,
            commands::dbg_log,
        ])
        .setup(|app| {
            // macOS: 不出现在 Dock（menubar 常驻应用）
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // macOS: 拦截 Dock 右键「退出」/ Cmd+Q → 只关主界面窗口（设置/popup-tab），menubar 保持常驻
            #[cfg(target_os = "macos")]
            window::install_terminate_hook(app.handle());

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
            let mut config = state.config.read().unwrap().clone();
            // 上次退出时 menubar 全空（用户移除了全部实例，关掉最后一个窗口退出）→
            // 用户主动重新打开 app = 想用，自动恢复默认菜单栏（清空隐藏列表，rebuild 全量复活）。
            if menubar::menubar_all_hidden(&config) {
                eprintln!("[fund01] 启动检测 menubar 全空 → 恢复默认菜单栏");
                config.settings.menubar_hidden_groups = Some(vec![]);
                *state.config.write().unwrap() = config.clone();
                crate::commands::persist_config(&handle, &config);
            }
            let quote = state.quote.read().unwrap().clone();
            menubar::rebuild_menubar(&handle, &config, quote.as_ref());

            // 静默启动判断（决定是否打开设置界面）：
            // - 登录项拉起（带 --autostart）→ 静默（开机自启动场景，不弹设置窗口）
            // - 用户勾选「静默启动」（clash-verge-rev enable_silent_start 同款）→ 任何方式启动都静默
            // - 其余（手动打开）→ 打开设置界面（menubar 常驻，打开 app 即见主界面窗口）
            let is_autostart_launch = std::env::args().any(|a| a == "--autostart");
            let is_silent_start = config.settings.silent_start.unwrap_or(false);
            if is_autostart_launch || is_silent_start {
                eprintln!(
                    "[fund01] 静默启动（autostart={is_autostart_launch}, silent_start={is_silent_start}）→ 仅常驻 menubar，不打开设置界面"
                );
            } else {
                window::open_settings_window(&handle, None, None);
            }

            // 启动两个定时刷新循环（日盘 A 股 / 夜盘 美股）+ 立即刷新一次
            refresh::start_refresh_loops(handle.clone());
            // fire-and-forget：启动期的首次刷新不阻塞 setup，也不参与前端刷新图标
            tauri::async_runtime::spawn(async move {
                refresh::trigger_refresh(handle, true).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building fund01 tauri application");

    // 拦截「最后一个窗口销毁 → 隐式退出」：进程保持常驻，menubar 实例不随浮窗销毁。
    // 显式退出（右键菜单「退出 fund01」→ 插件 quit 延迟 app.exit(0)）code.is_some() → 放行。
    app.run(|app, event| {
        match event {
            // macOS：进程常驻时用户再次点击 Dock / 启动台 / Finder 双击 app，
            // 系统把「重新打开」发给现有进程（不走 setup）→ 打开当前进程的设置界面。
            tauri::RunEvent::Reopen { .. } => {
                eprintln!("[fund01] 重新打开 app → 打开设置界面");
                window::open_settings_window(app, None, None);
            }
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                crate::err_log!("[退出] ExitRequested code={code:?}");
                if code.is_none() {
                    eprintln!("[fund01] 窗口全关，保持常驻（menubar 存活）");
                    api.prevent_exit();
                }
            }
            tauri::RunEvent::Exit => {
                crate::err_log!("[退出] RunEvent::Exit — 即将真正退出进程");
            }
            _ => {}
        }
    });
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
