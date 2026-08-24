//! Tauri command 层 —— 对应前端 DataPort/ConfigPort/WindowPort。

use tauri::{AppHandle, Emitter, Manager, State};

use crate::model::*;
use crate::state::AppState;

/// 持久化配置：store 写入 + 广播 config-change
pub fn persist_config(app: &AppHandle, config: &AppConfig) {
    use tauri_plugin_store::StoreExt;
    if let Ok(store) = app.store("config.json") {
        if let Ok(v) = serde_json::to_value(config) {
            let _ = store.set("config", v);
        }
        let _ = store.save();
    }
    let _ = app.emit("config-change", config);
}

// ------------------------- DataPort -------------------------

#[tauri::command]
pub async fn trigger_refresh(app: AppHandle, reset_timer: bool) {
    // 手动刷新入口日志（请求发出前）：带秒时间戳，便于与 Chrome SW 端
    // 「----------------------刷新 hh:mm:ss----------------」日志对照两端点击时刻。
    eprintln!(
        "[fund01] ----------------------刷新 {}----------------",
        chrono::Local::now().format("%H：%M：%S")
    );
    // await 等待刷新真正完成：前端「刷新中」图标在数据回来前持续旋转，
    // 对齐 Chrome SW REFRESH 消息 await refreshAll 完成才 sendResponse 的行为。
    crate::refresh::trigger_refresh(app, reset_timer).await;
}

#[tauri::command]
pub fn fetch_holdings(state: State<AppState>) -> Option<HoldingsPayload> {
    state
        .quote
        .read()
        .unwrap()
        .as_ref()
        .and_then(|q| q.holdings.clone())
}

#[tauri::command]
pub async fn fetch_indices(app: AppHandle) -> Vec<IndexItem> {
    // 读时填充：先同步检查缓存快照（块内取 state，不跨 await 持引用）
    let cached = {
        let state = app.state::<AppState>();
        let quote = state.quote.read().unwrap();
        quote
            .as_ref()
            .and_then(|q| q.indices.clone())
            .unwrap_or_default()
    };
    if !cached.is_empty() {
        return cached;
    }
    // 指数快照缺失（如非盘中启动、刷新循环从未产出）→ 实时拉一次全量指数，
    // 保证 popup 初始即有默认 5 个指数的行情，不依赖刷新循环的时段窗口（指数面板独立于持仓）。
    let indices = crate::market::get_all_indices().await;
    {
        let state = app.state::<AppState>();
        let mut quote = state.quote.write().unwrap();
        let now = chrono::Local::now().timestamp_millis();
        if let Some(q) = quote.as_mut() {
            q.indices = Some(indices.clone());
            q.time = now;
        } else {
            *quote = Some(QuoteUpdate {
                holdings: None,
                indices: Some(indices.clone()),
                time: now,
            });
        }
    }
    // 广播：menubar / 其他窗口同步（当前 popup 已通过返回值拿到数据）
    {
        let state = app.state::<AppState>();
        let quote = state.quote.read().unwrap().clone();
        if let Some(q) = quote {
            let _ = app.emit("quote-update", &q);
        }
    }
    indices
}

/// 最近一次后台成功刷新的时间戳（ms）；尚未刷新过返回 0。
/// 供前端 popup 打开时直接显示更新时间（无需等待下一次事件推送）。
#[tauri::command]
pub fn fetch_last_update(state: State<AppState>) -> i64 {
    state
        .quote
        .read()
        .unwrap()
        .as_ref()
        .map(|q| q.time)
        .unwrap_or(0)
}

/// 当前自动刷新计划（周期与下次触发时间），供前端 popup 打开即拉进度环权威时刻，
/// 避免用交易时段间隔瞎猜导致进度环过早走满、卡在满格。
#[tauri::command]
pub fn get_refresh_schedule(app: AppHandle) -> crate::refresh::RefreshSchedule {
    crate::refresh::current_refresh_schedule(&app)
}

#[tauri::command]
pub async fn fetch_fund_history(
    state: State<'_, AppState>,
    code: String,
    range: Option<String>,
) -> Result<FundHistoryPayload, String> {
    let _ = state;
    crate::history::get_fund_history(&code, range.as_deref().unwrap_or("3m")).await
}

#[tauri::command]
pub async fn fetch_index_history(
    state: State<'_, AppState>,
    code: String,
    range: Option<String>,
) -> Result<IndexHistoryPayload, String> {
    let _ = state;
    crate::market::get_index_history(&code, range.as_deref().unwrap_or("1m")).await
}

#[tauri::command]
pub async fn fetch_fund_intraday(
    state: State<'_, AppState>,
    req: FundIntradayRequest,
) -> Result<FundIntradayPayload, String> {
    let _ = state;
    crate::providers::fund123::fetch_intraday_for_dialog(
        &req.code,
        req.fund_key.as_deref(),
        req.name.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn resolve_fund(
    state: State<'_, AppState>,
    req: ResolveFundRequest,
) -> Result<ResolveFundPayload, String> {
    let _ = state;
    crate::history::resolve_fund(&req).await
}

// ------------------------- ConfigPort -------------------------

#[tauri::command]
pub fn get_config(state: State<AppState>) -> AppConfig {
    state.config.read().unwrap().clone()
}

/// 判断配置变更是否「仅涉及菜单栏展示」（隐藏分组 / 布局 / 字号 / 数值显示）。
/// 此类变更不改变行情数据口径，保存后无需触发行情刷新。
/// 注意比较的是整个 AppConfig：持仓/分组等任何数据口径变更都会触发刷新，
/// 保证「修改持仓后 menubar（及 badge/列表）能随最新配置实时更新」。
fn is_menubar_only_settings_change(old: &AppConfig, new: &AppConfig) -> bool {
    let mut a = old.clone();
    let mut b = new.clone();
    a.settings.menubar_hidden_groups = None;
    a.settings.menubar_layout = None;
    a.settings.menubar_top_font_size = None;
    a.settings.menubar_bottom_font_size = None;
    a.settings.menubar_equal_font_size = None;
    a.settings.menubar_show_amount = None;
    a.settings.menubar_top_font = None;
    a.settings.menubar_bottom_font = None;
    a.settings.menubar_top_bold = None;
    a.settings.menubar_bottom_bold = None;
    a.settings.menubar_top_align = None;
    a.settings.menubar_bottom_align = None;
    a.settings.menubar_top_color = None;
    a.settings.menubar_group_colors = None;
    a.settings.menubar_rise_color = None;
    a.settings.menubar_fall_color = None;
    a.settings.menubar_flat_color = None;
    a.settings.privacy_mode = None;
    b.settings.menubar_hidden_groups = None;
    b.settings.menubar_layout = None;
    b.settings.menubar_top_font_size = None;
    b.settings.menubar_bottom_font_size = None;
    b.settings.menubar_equal_font_size = None;
    b.settings.menubar_show_amount = None;
    b.settings.menubar_top_font = None;
    b.settings.menubar_bottom_font = None;
    b.settings.menubar_top_bold = None;
    b.settings.menubar_bottom_bold = None;
    b.settings.menubar_top_align = None;
    b.settings.menubar_bottom_align = None;
    b.settings.menubar_top_color = None;
    b.settings.menubar_group_colors = None;
    b.settings.menubar_rise_color = None;
    b.settings.menubar_fall_color = None;
    b.settings.menubar_flat_color = None;
    b.settings.privacy_mode = None;
    a == b
}

#[tauri::command]
pub async fn save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: AppConfig,
) -> Result<AppConfig, String> {
    let old = state.config.read().unwrap().clone();
    let raw = serde_json::to_value(&config).map_err(|e| e.to_string())?;
    let normalized = crate::portfolio::normalize_config(&raw);
    *state.config.write().unwrap() = normalized.clone();
    persist_config(&app, &normalized);
    // 诊断日志：menubar 分组显示 / 分组顺序相关变更（排查「开关 A 却隐藏 B」与排序问题）
    let oh = old
        .settings
        .menubar_hidden_groups
        .clone()
        .unwrap_or_default();
    let nh = normalized
        .settings
        .menubar_hidden_groups
        .clone()
        .unwrap_or_default();
    if oh != nh {
        eprintln!("[fund01] save_config: menubarHiddenGroups {oh:?} -> {nh:?}");
    }
    let og = old.settings.holding_groups.clone().unwrap_or_default();
    let ng = normalized
        .settings
        .holding_groups
        .clone()
        .unwrap_or_default();
    if og != ng {
        eprintln!("[fund01] save_config: holdingGroups {og:?} -> {ng:?}");
    }
    // 数据源切换：清空内存中旧源的基金行情缓存，避免 popup / menubar 在刷新回来前
    // 暂显旧源（如东方财富）的当日涨幅百分比与数值，造成「百分比和数值不同」的现象。
    // 对齐 Chrome 端 oldSource !== newSource 时 remove(cache-holdings / cache-source) 的行为。
    let old_source = old.settings.quote_source.clone().unwrap_or_default();
    let new_source = normalized.settings.quote_source.clone().unwrap_or_default();
    if old_source != new_source {
        let had_holdings = state
            .quote
            .read()
            .unwrap()
            .as_ref()
            .map(|q| q.holdings.is_some())
            .unwrap_or(false);
        if had_holdings {
            eprintln!(
                "[fund01] save_config: quoteSource {old_source:?} -> {new_source:?}，清空旧源基金行情缓存"
            );
        }
        // 仅清 holdings（基金行情），保留 indices（指数独立、不受数据源切换影响）。
        // 后续 trigger_refresh 会用新源强制刷新，重新填充 holdings。
        if let Some(q) = state.quote.write().unwrap().as_mut() {
            q.holdings = None;
        }
        // 同步清空 last_quote_source（与清空 holdings 配套），使下次合并跳过旧源缓存，
        // 对齐 Chrome 端 oldSource !== newSource 时 remove(cache-holdings / cache-source) 的行为。
        *state.last_quote_source.write().unwrap() = None;
    }
    // 分组/持仓变化 → 重建 menubar 实例（含菜单栏样式应用）
    let quote = state.quote.read().unwrap().clone();
    crate::menubar::rebuild_menubar(&app, &normalized, quote.as_ref());
    // 仅当「影响行情数据的配置」变更时才立即刷新；
    // 纯菜单栏展示设置（隐藏分组/布局/字号）不触发网络请求
    if !is_menubar_only_settings_change(&old, &normalized) {
        // fire-and-forget：保存配置不等待刷新完成（save_config 是同步返回的）
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::refresh::trigger_refresh(app2, true).await;
        });
    }
    Ok(normalized)
}

/// 前端诊断日志转发：webview 的 console.log 默认不进终端，UI 交互链路（如开关点击）通过
/// EventPort.emitDebug → 本命令打到 stdout，便于与 Rust 侧 save_config/sync_instances 日志对齐排查。
#[tauri::command]
pub fn dbg_log(msg: String) {
    eprintln!("[fund01][web] {msg}");
}

// ------------------------- WindowPort -------------------------

#[tauri::command]
pub async fn open_settings_window(app: AppHandle, tab: Option<String>, anchor: Option<String>) {
    crate::window::open_settings_window(&app, tab.as_deref(), anchor.as_deref());
}

/// 打开 popup 独立页面窗口（对齐 Chrome popup.html?tab=1「标签页模式」）
#[tauri::command]
pub async fn open_popup_tab_window(app: AppHandle) {
    crate::window::open_popup_tab_window(&app);
}

#[tauri::command]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 检查是否有新版本（仅 Tauri 桌面版）。
/// - 打开设置界面自动检查（前端不传 force）→ 走 1h 内存缓存，命中不请求网络；
/// - 「关于」页「检查更新」按钮手动检查（force=true）→ 绕过缓存真正请求远端一次。
/// Ok(None) = 已是最新；Err = 网络/解析失败 —— 前端两种情况静默（手动检查时
/// 前端另行显示「当前已是最新版本」）。
#[tauri::command]
pub async fn check_update(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<Option<crate::update::CheckUpdateResult>, String> {
    crate::update::check_update(&state, force.unwrap_or(false)).await
}

/// 外部链接：用系统默认浏览器打开（macOS `open`；Windows 用 `cmd /c start`）。
/// 桌面端 webview 的 window.open 默认被 WKWebView 拦截，必须走系统命令。
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("拒绝打开非 http(s) 链接：{url}"));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开链接失败：{e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| format!("打开链接失败：{e}"))?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开链接失败：{e}"))?;
    }
    Ok(())
}

/// 导出配置：把 JSON 文本写到用户经保存对话框选定的路径（任意位置，无 scope 限制）。
/// 由前端 `save({defaultPath})` 先弹 NSSavePanel 拿到 path，再 invoke 本命令落盘。
/// 走 Rust std::fs 而非前端 fs 插件 —— 免去 fs:scope 授权，与 Clash Verge Rev 的
/// export_local_backup 同思路。
#[tauri::command]
pub fn export_config_file(path: String, content: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("保存路径为空".into());
    }
    std::fs::write(&path, content).map_err(|e| format!("写入失败：{e}"))
}
