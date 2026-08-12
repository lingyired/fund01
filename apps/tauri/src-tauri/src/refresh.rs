//! 定时刷新循环 + 全量拉取/合并计算。
//! 两个独立 tokio 循环：日盘循环（基金持仓 + A 股指数）、夜盘循环（美股指数）。
//! 两窗口不重叠，任意时刻至多一个循环走盘中档；数据源按配置按需拉取
//! （无美股指数则不拉夜盘）。trigger_refresh 走全量。

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::calc::{calc_holdings, PersistPatch};
use crate::calendar;
use crate::menubar;
use crate::model::{AppConfig, FundRecord, HoldingsPayload, IndexItem, QuoteUpdate};
use crate::portfolio::DEFAULT_REFRESH_INTERVAL;
use crate::providers::{get_quote_provider, FundQuoteInput, QuoteSource};
use crate::state::AppState;

/// 推送给前端的自动刷新计划
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSchedule {
    interval_seconds: u64,
    next_refresh_at: i64,
}

/// 通知前端下一次自动刷新将在何时发生，用于刷新按钮的进度环
fn emit_refresh_schedule(app: &AppHandle, interval_seconds: u64) {
    let next_refresh_at = chrono::Local::now().timestamp_millis() + (interval_seconds as i64) * 1000;
    let _ = app.emit(
        "refresh-schedule",
        RefreshSchedule {
            interval_seconds,
            next_refresh_at,
        },
    );
}

/// 供 popup 打开即拉的权威刷新计划（与循环 emit 的口径一致：interval 取当前市场档位，
/// nextRefreshAt = 现在 + interval）。避免前端用 trading 间隔瞎猜导致进度环过早走满、卡在满格。
/// 前端挂载时调用，第一时间拿到真实周期，进度环从首帧就准确。
pub fn current_refresh_schedule(app: &AppHandle) -> RefreshSchedule {
    let interval = current_interval(app);
    let next_refresh_at = chrono::Local::now().timestamp_millis() + (interval as i64) * 1000;
    RefreshSchedule {
        interval_seconds: interval,
        next_refresh_at,
    }
}

/// 手动刷新时唤醒两个循环，重置其待定 sleep（使下次自动刷新从「现在」重新计时，
/// 与进度环周期对齐）。两个循环的 Notify 句柄在 start_*_loop 时初始化。
static DAY_NOTIFY: OnceLock<Arc<Notify>> = OnceLock::new();
static NIGHT_NOTIFY: OnceLock<Arc<Notify>> = OnceLock::new();

/// 根据当前市场状态与配置返回合适的刷新间隔（秒）
fn current_interval(app: &AppHandle) -> u64 {
    let config = app.state::<AppState>().config.read().unwrap().clone();
    let ri = config
        .settings
        .refresh_interval
        .clone()
        .unwrap_or(DEFAULT_REFRESH_INTERVAL);
    let now = chrono::Local::now();
    let day_active = calendar::is_day_market_active(&now);
    let night_active = calendar::is_night_market_active(&now) && has_us_indices(&config);
    if day_active || night_active {
        ri.trading
    } else {
        ri.non_trading
    }
}

/// 启动日盘 / 夜盘两个刷新循环（应用 setup 时调用）
pub fn start_refresh_loops(app: AppHandle) {
    start_day_loop(app.clone());
    start_night_loop(app);
}

/// 读配置刷新间隔，按「是否盘中」返回 sleep 秒数
fn loop_interval(app: &AppHandle, active: bool) -> u64 {
    let config = app.state::<AppState>().config.read().unwrap().clone();
    let ri = config
        .settings
        .refresh_interval
        .clone()
        .unwrap_or(DEFAULT_REFRESH_INTERVAL);
    if active { ri.trading } else { ri.non_trading }
}

/// 指数看板是否含美股指数（NDX/SPX）
fn has_us_indices(config: &AppConfig) -> bool {
    config
        .settings
        .selected_indices
        .as_ref()
        .map(|list| list.iter().any(|c| crate::market::is_us_index_code(c)))
        .unwrap_or(false)
}

/// 日盘循环：基金持仓 + A 股指数；盘中 09:00-15:30 用盘中档
pub fn start_day_loop(app: AppHandle) {
    let notify = DAY_NOTIFY.get_or_init(|| Arc::new(Notify::new())).clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let now = chrono::Local::now();
            let active = calendar::is_day_market_active(&now);
            let secs = loop_interval(&app, active);
            // 准点切换：距下一时段翻转点比当前档位周期更近时，先睡到翻转点，
            // 醒来（顶部重判）即切档，消除「非交易档最坏滞后一个周期」
            let sleep_secs = match calendar::seconds_until_next_switch(active, calendar::is_day_market_active, &now) {
                Some(s) if s < secs => s.max(5),
                _ => secs.max(5),
            };
            emit_refresh_schedule(&app, sleep_secs);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(sleep_secs)) => {
                    // 定时器触发日志：便于观察各循环定时情况（trigger_refresh 手动刷新不走这里；release 打包移除）
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[fund01] ----------------------定时器日盘 {}-----------------------",
                        chrono::Local::now().format("%H：%M")
                    );
                    refresh_day(&app, false).await;
                }
                _ = notify.notified() => {
                    // 被手动刷新唤醒：仅重置定时器（重新 emit 周期 + 重新 sleep），不重复拉数据
                    continue;
                }
            }
        }
    });
}

/// 夜盘循环：美股指数；盘中 20:00-次日 04:00 用盘中档，
/// 无美股指数时退化为低频空转（不拉数据）
pub fn start_night_loop(app: AppHandle) {
    let notify = NIGHT_NOTIFY.get_or_init(|| Arc::new(Notify::new())).clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let now = chrono::Local::now();
            let secs = {
                let config = app.state::<AppState>().config.read().unwrap().clone();
                let ri = config
                    .settings
                    .refresh_interval
                    .clone()
                    .unwrap_or(DEFAULT_REFRESH_INTERVAL);
                let active = calendar::is_night_market_active(&now);
                let needed = has_us_indices(&config);
                if active && needed { ri.trading } else { ri.non_trading }
            };
            // 准点切换：距下一时段翻转点更近时先睡到翻转点（与日盘循环一致）
            let sleep_secs = match calendar::seconds_until_next_switch(
                calendar::is_night_market_active(&now),
                calendar::is_night_market_active,
                &now,
            ) {
                Some(s) if s < secs => s.max(5),
                _ => secs.max(5),
            };
            emit_refresh_schedule(&app, sleep_secs);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(sleep_secs)) => {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[fund01] ----------------------定时器夜盘 {}-----------------------",
                        chrono::Local::now().format("%H：%M")
                    );
                    refresh_night(&app, false).await;
                }
                _ = notify.notified() => {
                    // 被手动刷新唤醒：仅重置定时器（重新 emit 周期 + 重新 sleep），不重复拉数据
                    continue;
                }
            }
        }
    });
}

/// 立即触发一次全量刷新（trigger_refresh 命令）
/// - reset_timer=true（手动点击刷新）：拉数据 + 重置进度环 + 唤醒两个循环，
///   使下次自动刷新从「现在」重新计时，与进度环对齐。
/// - reset_timer=false（打开 popup 拉数据）：仅拉数据，不动定时器与进度环，
///   避免打开浮窗就把环重置、与后台真实进度脱节。
pub fn trigger_refresh(app: AppHandle, reset_timer: bool) {
    tauri::async_runtime::spawn(async move {
        refresh_all(&app, true).await;
        if reset_timer {
            // 手动刷新立即重置进度环：前端按当前市场档位展示新的周期
            emit_refresh_schedule(&app, current_interval(&app));
            // 重置两个循环的定时器，使下次自动刷新从「现在」重新计时，与进度环对齐
            if let Some(n) = DAY_NOTIFY.get() {
                n.notify_one();
            }
            if let Some(n) = NIGHT_NOTIFY.get() {
                n.notify_one();
            }
        }
    });
}

fn to_input(f: &FundRecord) -> FundQuoteInput {
    FundQuoteInput {
        code: f.code.clone(),
        fund_key: f.fund_key.clone(),
        name: Some(f.name.clone()),
        sectors: f.sectors.clone(),
    }
}

/// 把板块推断结果回写配置：改内存 → 持久化 store → 广播 config-change
pub fn apply_patches(app: &AppHandle, patches: Vec<PersistPatch>) {
    if patches.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    let mut config = state.config.read().unwrap().clone();
    let mut changed = false;
    for patch in patches {
        let Some(sectors) = patch.sectors else { continue };
        if let Some(f) = config.holdings.get_mut(&patch.code) {
            if f.sectors != sectors {
                f.sectors = sectors.clone();
                changed = true;
            }
        }
    }
    if !changed {
        return;
    }
    *state.config.write().unwrap() = config.clone();
    crate::commands::persist_config(app, &config);
}

/// 指数按市场拆分：(A股部分, 美股部分)
fn split_indices(list: &[IndexItem]) -> (Vec<IndexItem>, Vec<IndexItem>) {
    let mut a = Vec::new();
    let mut us = Vec::new();
    for i in list {
        if crate::market::is_us_index_code(&i.code) {
            us.push(i.clone());
        } else {
            a.push(i.clone());
        }
    }
    (a, us)
}

/// 合并缓存 → 写 state.quote → 广播 quote-update → menubar
async fn broadcast(
    app: &AppHandle,
    holdings: Option<HoldingsPayload>,
    indices: Option<Vec<IndexItem>>,
    patches: Vec<PersistPatch>,
) {
    let state = app.state::<AppState>();
    let prev = state.quote.read().unwrap().clone();
    let update = QuoteUpdate {
        holdings: holdings.or_else(|| prev.as_ref().and_then(|p| p.holdings.clone())),
        indices: indices.or_else(|| prev.as_ref().and_then(|p| p.indices.clone())),
        time: chrono::Local::now().timestamp_millis(),
    };
    *state.quote.write().unwrap() = Some(update.clone());
    let _ = app.emit("quote-update", &update);

    // 板块回写（在 emit 之后，避免与 config 锁竞争）
    apply_patches(app, patches);

    // menubar 更新
    menubar::update_menubar_with(app, &Some(update));
}

/// 全量刷新（trigger_refresh 手动刷新 / 导入配置后）：日盘 → 夜盘
pub async fn refresh_all(app: &AppHandle, force: bool) {
    refresh_day(app, force).await;
    refresh_night(app, force).await;
}

/// 日盘数据：基金持仓 + A 股指数
async fn refresh_day(app: &AppHandle, force: bool) {
    let state = app.state::<AppState>();
    let config = state.config.read().unwrap().clone();
    let now = chrono::Local::now();

    let mut holdings_payload: Option<HoldingsPayload> = None;
    let mut indices: Option<Vec<IndexItem>> = None;
    let mut patches: Vec<PersistPatch> = Vec::new();

    let source = QuoteSource::from_str(config.settings.quote_source.as_deref().unwrap_or("fundmnfinfo"));

    // ---------------- 基金（仅持仓） ----------------
    if force || calendar::should_refresh_fund(&now) {
        let holdings_funds: Vec<FundRecord> = config.holdings.values().cloned().collect();
        if !holdings_funds.is_empty() {
            let mut inputs: Vec<FundQuoteInput> =
                Vec::with_capacity(holdings_funds.len());
            for f in &holdings_funds {
                inputs.push(to_input(f));
            }
            let provider = get_quote_provider(source);
            let quotes = provider.fetch_quotes(&inputs).await;
            {
                let with_percent = quotes.iter().filter(|q| q.percent.is_some()).count();
                let with_nav = quotes.iter().filter(|q| q.net_value.is_some()).count();
                crate::dbg_log!(
                    "refresh 基金 source={} inputs={} quotes={} with_percent={} with_nav={}",
                    config.settings.quote_source.as_deref().unwrap_or("fundmnfinfo"),
                    inputs.len(),
                    quotes.len(),
                    with_percent,
                    with_nav
                );
            }
            let (payload, p) = calc_holdings(&holdings_funds, &quotes);
            holdings_payload = Some(payload);
            patches.extend(p);
        } else if force {
            // 持仓全空（重置 / 清空后 force 刷新）：显式广播空快照，
            // 否则 broadcast 会回退旧 state.quote，popup / menubar 浮窗仍显示旧持仓。
            holdings_payload = Some(HoldingsPayload::default());
        }
    }

    // ---------------- A 股指数 ----------------
    if force || calendar::should_refresh_a_share_market(&now) {
        // 与缓存中的美股指数合并，避免覆盖另一市场
        let prev_us = state
            .quote
            .read()
            .unwrap()
            .as_ref()
            .and_then(|p| p.indices.as_ref())
            .map(|l| split_indices(l).1)
            .unwrap_or_default();
        let mut merged = crate::market::get_a_share_indices().await;
        merged.extend(prev_us);
        indices = Some(merged);
    }

    broadcast(app, holdings_payload, indices, patches).await;
}

/// 夜盘数据：美股指数（任一数据源不在窗口或未配置时不拉、不广播）
async fn refresh_night(app: &AppHandle, force: bool) {
    let state = app.state::<AppState>();
    let config = state.config.read().unwrap().clone();
    let now = chrono::Local::now();
    let us_cfg = has_us_indices(&config);

    let mut indices: Option<Vec<IndexItem>> = None;

    // ---------------- 美股指数 ----------------
    if us_cfg && (force || calendar::should_refresh_us_index(&now)) {
        // 与缓存中的 A 股指数合并，避免覆盖另一市场
        let prev_a = state
            .quote
            .read()
            .unwrap()
            .as_ref()
            .and_then(|p| p.indices.as_ref())
            .map(|l| split_indices(l).0)
            .unwrap_or_default();
        let mut merged = prev_a;
        merged.extend(crate::market::get_us_indices().await);
        indices = Some(merged);
    }

    if indices.is_none() {
        return; // 空转醒来：无数据变化，不发心跳广播
    }
    broadcast(app, None, indices, Vec::new()).await;
}
