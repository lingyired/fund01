//! 定时刷新循环 + 全量拉取/合并计算。
//! 常驻进程 tokio 循环（区别于 MV3 SW 的 alarm 唤醒）；按交易日历分档间隔。

use std::collections::HashSet;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::calc::{calc_holdings, merge_watchlist, PersistPatch};
use crate::calendar;
use crate::menubar;
use crate::model::{FundQuoteRow, FundRecord, GoldPayload, HoldingsPayload, IndexItem, MarketOverview, QuoteUpdate};
use crate::portfolio::DEFAULT_REFRESH_INTERVAL;
use crate::providers::{get_quote_provider, FundQuoteInput, QuoteSource};
use crate::state::AppState;

/// 启动刷新循环（应用 setup 时调用）
pub fn start_refresh_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let secs = {
                let config = app.state::<AppState>().config.read().unwrap().clone();
                let ri = config
                    .settings
                    .refresh_interval
                    .clone()
                    .unwrap_or(DEFAULT_REFRESH_INTERVAL);
                let active = calendar::is_any_market_active(&chrono::Local::now());
                if active { ri.trading } else { ri.non_trading }
            };
            tokio::time::sleep(Duration::from_secs(secs.max(5))).await;
            refresh_all(&app, false).await;
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

/// 全量刷新：按时段拉取 → 合并计算 → 缓存 → 事件 → menubar
pub async fn refresh_all(app: &AppHandle, force: bool) {
    let state = app.state::<AppState>();
    let config = state.config.read().unwrap().clone();
    let now = chrono::Local::now();

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
        }
    }

    // ---------------- 指数 / 大盘 ----------------
    if force || calendar::should_refresh_a_share_market(&now) {
        match crate::market::get_indices().await {
            Ok(v) => indices = Some(v),
            Err(e) => eprintln!("[fund01] getIndices 失败: {e}"),
        }
        if force || calendar::is_a_share_trading_time(&now) {
            let m = crate::market::get_market_overview().await;
            market = Some(m);
        }
    }

    // ---------------- 黄金 ----------------
    if force || calendar::should_refresh_gold(&now) {
        match crate::gold::get_gold_realtime(config.gold.holding, config.gold.avg_price).await {
            Ok(g) => gold = Some(g),
            Err(e) => eprintln!("[fund01] getGoldRealtime 失败: {e}"),
        }
    }

    // ---------------- 汇总缓存 + 事件 ----------------
    let prev = state.quote.read().unwrap().clone();
    let update = QuoteUpdate {
        holdings: holdings_payload.or_else(|| prev.as_ref().and_then(|p| p.holdings.clone())),
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
