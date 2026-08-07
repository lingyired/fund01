//! Tauri command 层 —— 对应前端 DataPort/ConfigPort/WindowPort。

use tauri::{AppHandle, Emitter, State};

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
pub async fn trigger_refresh(app: AppHandle) {
    crate::refresh::trigger_refresh(app);
}

#[tauri::command]
pub fn fetch_holdings(state: State<AppState>) -> Option<HoldingsPayload> {
    state.quote.read().unwrap().as_ref().and_then(|q| q.holdings.clone())
}

#[tauri::command]
pub fn fetch_watchlist(state: State<AppState>) -> Option<Vec<FundQuoteRow>> {
    state.quote.read().unwrap().as_ref().and_then(|q| q.watchlist.clone())
}

#[tauri::command]
pub fn fetch_indices(state: State<AppState>) -> Vec<IndexItem> {
    state.quote.read().unwrap().as_ref().and_then(|q| q.indices.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn fetch_market_overview(state: State<AppState>) -> Option<MarketOverview> {
    state.quote.read().unwrap().as_ref().and_then(|q| q.market.clone())
}

#[tauri::command]
pub fn fetch_gold(state: State<AppState>) -> Option<GoldPayload> {
    state.quote.read().unwrap().as_ref().and_then(|q| q.gold.clone())
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
/// 注意比较的是整个 AppConfig：持仓/自选/黄金/分组等任何数据口径变更都会触发刷新，
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
    a.settings.menubar_top_color = None;
    a.settings.menubar_group_colors = None;
    a.settings.menubar_rise_color = None;
    a.settings.menubar_fall_color = None;
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
    b.settings.menubar_top_color = None;
    b.settings.menubar_group_colors = None;
    b.settings.menubar_rise_color = None;
    b.settings.menubar_fall_color = None;
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
    // 分组/持仓变化 → 重建 menubar 实例（含菜单栏样式应用）
    let quote = state.quote.read().unwrap().clone();
    crate::menubar::rebuild_menubar(&app, &normalized, quote.as_ref());
    // 仅当「影响行情数据的配置」变更时才立即刷新；
    // 纯菜单栏展示设置（隐藏分组/布局/字号）不触发网络请求
    if !is_menubar_only_settings_change(&old, &normalized) {
        crate::refresh::trigger_refresh(app);
    }
    Ok(normalized)
}

// ------------------------- WindowPort -------------------------

#[tauri::command]
pub async fn open_settings_window(app: AppHandle, tab: Option<String>) {
    crate::window::open_settings_window(&app, tab.as_deref());
}

#[tauri::command]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
