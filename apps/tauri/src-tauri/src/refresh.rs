//! 定时刷新循环 + 全量拉取/合并计算。
//! 两个独立 tokio 循环：日盘循环（基金 + A 股指数/大盘 + 黄金日盘）、
//! 夜盘循环（美股指数 + 黄金夜盘）。两窗口不重叠，任意时刻至多一个循环走盘中档；
//! 数据源按配置按需拉取（无美股指数/无黄金持仓则不拉）。trigger_refresh 走全量。

use std::collections::HashSet;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::calc::{calc_holdings, merge_watchlist, PersistPatch};
use crate::calendar;
use crate::menubar;
use crate::model::{AppConfig, FundQuoteRow, FundRecord, GoldPayload, HoldingsPayload, IndexItem, MarketOverview, QuoteUpdate};
use crate::portfolio::DEFAULT_REFRESH_INTERVAL;
use crate::providers::{get_quote_provider, FundQuoteInput, QuoteSource};
use crate::state::AppState;

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

/// 是否配置了黄金（显示开关开启且持仓 > 0）
fn has_gold(config: &AppConfig) -> bool {
    config.settings.show_gold && config.gold.holding > 0.0
}

/// 日盘循环：基金（持仓+自选）+ A 股指数/大盘 + 黄金日盘；盘中 09:00-15:30 用盘中档
pub fn start_day_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let secs =
                loop_interval(&app, calendar::is_day_market_active(&chrono::Local::now()));
            tokio::time::sleep(Duration::from_secs(secs.max(5))).await;
            // 定时器触发日志：便于观察各循环定时情况（trigger_refresh 手动刷新不走这里；release 打包移除）
            #[cfg(debug_assertions)]
            eprintln!(
                "[fund01] ----------------------定时器日盘 {}-----------------------",
                chrono::Local::now().format("%H：%M")
            );
            refresh_day(&app, false).await;
        }
    });
}

/// 夜盘循环：美股指数 + 黄金夜盘；盘中 20:00-次日 04:00 用盘中档，
/// 无美股指数且无黄金持仓时退化为低频空转（不拉数据）
pub fn start_night_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let secs = {
                let config = app.state::<AppState>().config.read().unwrap().clone();
                let ri = config
                    .settings
                    .refresh_interval
                    .clone()
                    .unwrap_or(DEFAULT_REFRESH_INTERVAL);
                let active = calendar::is_night_market_active(&chrono::Local::now());
                let needed = has_us_indices(&config) || has_gold(&config);
                if active && needed { ri.trading } else { ri.non_trading }
            };
            tokio::time::sleep(Duration::from_secs(secs.max(5))).await;
            #[cfg(debug_assertions)]
            eprintln!(
                "[fund01] ----------------------定时器夜盘 {}-----------------------",
                chrono::Local::now().format("%H：%M")
            );
            refresh_night(&app, false).await;
        }
    });
}

/// 立即触发一次全量刷新（trigger_refresh 命令）
pub fn trigger_refresh(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        refresh_all(&app, true).await;
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
        if let Some(f) = config.watchlist.get_mut(&patch.code) {
            if f.sectors != sectors {
                f.sectors = sectors;
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
#[allow(clippy::too_many_arguments)]
async fn broadcast(
    app: &AppHandle,
    holdings: Option<HoldingsPayload>,
    watchlist: Option<Vec<FundQuoteRow>>,
    indices: Option<Vec<IndexItem>>,
    market: Option<MarketOverview>,
    gold: Option<GoldPayload>,
    patches: Vec<PersistPatch>,
) {
    let state = app.state::<AppState>();
    let prev = state.quote.read().unwrap().clone();
    let update = QuoteUpdate {
        holdings: holdings.or_else(|| prev.as_ref().and_then(|p| p.holdings.clone())),
        watchlist: watchlist.or_else(|| prev.as_ref().and_then(|p| p.watchlist.clone())),
        indices: indices.or_else(|| prev.as_ref().and_then(|p| p.indices.clone())),
        market: market.or_else(|| prev.as_ref().and_then(|p| p.market.clone())),
        gold: gold.or_else(|| prev.as_ref().and_then(|p| p.gold.clone())),
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

/// 日盘数据：基金（持仓+自选）+ A 股指数/大盘 + 黄金日盘
async fn refresh_day(app: &AppHandle, force: bool) {
    let state = app.state::<AppState>();
    let config = state.config.read().unwrap().clone();
    let now = chrono::Local::now();
    let gold_cfg = has_gold(&config);

    let mut holdings_payload: Option<HoldingsPayload> = None;
    let mut watchlist: Option<Vec<FundQuoteRow>> = None;
    let mut indices: Option<Vec<IndexItem>> = None;
    let mut market: Option<MarketOverview> = None;
    let mut gold: Option<GoldPayload> = None;
    let mut patches: Vec<PersistPatch> = Vec::new();

    let source = QuoteSource::from_str(config.settings.quote_source.as_deref().unwrap_or("fundmnfinfo"));

    // ---------------- 基金（持仓 + 自选批量拉取） ----------------
    if force || calendar::should_refresh_fund(&now) {
        let holdings_funds: Vec<FundRecord> = config.holdings.values().cloned().collect();
        let watch_funds: Vec<FundRecord> = config.watchlist.values().cloned().collect();
        let mut inputs: Vec<FundQuoteInput> = Vec::with_capacity(holdings_funds.len() + watch_funds.len());
        for f in &holdings_funds {
            inputs.push(to_input(f));
        }
        for f in &watch_funds {
            inputs.push(to_input(f));
        }
        if !inputs.is_empty() {
            let provider = get_quote_provider(source);
            let quotes = provider.fetch_quotes(&inputs).await;
            #[cfg(debug_assertions)]
            {
                let with_percent = quotes.iter().filter(|q| q.percent.is_some()).count();
                let with_nav = quotes.iter().filter(|q| q.net_value.is_some()).count();
                eprintln!(
                    "[fund01] refresh 基金 source={} inputs={} quotes={} with_percent={} with_nav={}",
                    config.settings.quote_source.as_deref().unwrap_or("fundmnfinfo"),
                    inputs.len(),
                    quotes.len(),
                    with_percent,
                    with_nav
                );
            }
            let hold_codes: HashSet<&str> = holdings_funds.iter().map(|f| f.code.as_str()).collect();
            let mut h_quotes = Vec::new();
            let mut w_quotes = Vec::new();
            for q in quotes {
                if hold_codes.contains(q.code.as_str()) {
                    h_quotes.push(q);
                } else {
                    w_quotes.push(q);
                }
            }
            if !holdings_funds.is_empty() {
                let (payload, p) = calc_holdings(&holdings_funds, &h_quotes);
                holdings_payload = Some(payload);
                patches.extend(p);
            }
            if !watch_funds.is_empty() {
                let (list, p) = merge_watchlist(&watch_funds, &w_quotes);
                watchlist = Some(list);
                patches.extend(p);
            }
        } else if force {
            // 持仓/自选全空（重置 / 清空后 force 刷新）：显式广播空快照，
            // 否则 broadcast 会回退旧 state.quote，popup / menubar 浮窗仍显示旧持仓。
            holdings_payload = Some(HoldingsPayload::default());
            watchlist = Some(Vec::new());
        }
    }

    // ---------------- A 股指数 / 大盘 ----------------
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
        if force || calendar::is_a_share_trading_time(&now) {
            let m = crate::market::get_market_overview().await;
            market = Some(m);
        }
    }

    // ---------------- 黄金日盘 ----------------
    if force || (gold_cfg && calendar::is_gold_day_session(&now)) {
        match crate::gold::get_gold_realtime(config.gold.holding, config.gold.avg_price).await {
            Ok(g) => gold = Some(g),
            Err(e) => eprintln!("[fund01] getGoldRealtime(日盘) 失败: {e}"),
        }
    }

    broadcast(app, holdings_payload, watchlist, indices, market, gold, patches).await;
}

/// 夜盘数据：美股指数 + 黄金夜盘（任一数据源不在窗口或未配置时不拉、不广播）
async fn refresh_night(app: &AppHandle, force: bool) {
    let state = app.state::<AppState>();
    let config = state.config.read().unwrap().clone();
    let now = chrono::Local::now();
    let us_cfg = has_us_indices(&config);
    let gold_cfg = has_gold(&config);

    let mut indices: Option<Vec<IndexItem>> = None;
    let mut gold: Option<GoldPayload> = None;

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

    // ---------------- 黄金夜盘 ----------------
    if gold_cfg && (force || calendar::is_gold_night_session(&now)) {
        match crate::gold::get_gold_realtime(config.gold.holding, config.gold.avg_price).await {
            Ok(g) => gold = Some(g),
            Err(e) => eprintln!("[fund01] getGoldRealtime(夜盘) 失败: {e}"),
        }
    }

    if indices.is_none() && gold.is_none() {
        return; // 空转醒来：无数据变化，不发心跳广播
    }
    broadcast(app, None, None, indices, None, gold, Vec::new()).await;
}
