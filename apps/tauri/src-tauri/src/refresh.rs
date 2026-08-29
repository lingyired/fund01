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
use crate::model::{
    AppConfig, FundQuote, FundQuoteRow, FundRecord, HoldingsPayload, IndexItem, QuoteUpdate,
};
use crate::portfolio::DEFAULT_REFRESH_INTERVAL;
use crate::providers::{get_quote_provider, FundQuoteInput, QuoteSource};
use crate::state::AppState;
use crate::status_bar;

/// 推送给前端的自动刷新计划
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSchedule {
    interval_seconds: u64,
    next_refresh_at: i64,
}

/// 通知前端下一次自动刷新将在何时发生，用于刷新按钮的进度环
fn emit_refresh_schedule(app: &AppHandle, interval_seconds: u64) {
    let next_refresh_at =
        chrono::Local::now().timestamp_millis() + (interval_seconds as i64) * 1000;
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
    if active {
        ri.trading
    } else {
        ri.non_trading
    }
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
            let sleep_secs = match calendar::seconds_until_next_switch(
                active,
                calendar::is_day_market_active,
                &now,
            ) {
                Some(s) if s < secs => s.max(5),
                _ => secs.max(5),
            };
            emit_refresh_schedule(&app, current_interval(&app));
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
                if active && needed {
                    ri.trading
                } else {
                    ri.non_trading
                }
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
            emit_refresh_schedule(&app, current_interval(&app));
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
///
/// async 版本：命令层 await 本函数，前端「刷新中」图标在数据真正回来前保持旋转
/// （对齐 Chrome SW 的 REFRESH 消息 await refreshAll 完成才 sendResponse）。
/// 非命令调用方（导入配置 / 切源后的 fire-and-forget）用 async_runtime::spawn 包装。
pub async fn trigger_refresh(app: AppHandle, reset_timer: bool) {
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
        let Some(sectors) = patch.sectors else {
            continue;
        };
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

/// 合并缓存 → 写 state.quote → 广播 quote-update → 状态栏实例（menubar/taskband）
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

    // 状态栏实例更新（macOS menubar / Windows taskband）
    status_bar::update_with(app, &Some(update));
}

/// 全量刷新（trigger_refresh 手动刷新 / 导入配置后）：日盘 → 夜盘
pub async fn refresh_all(app: &AppHandle, force: bool) {
    refresh_day(app, force).await;
    refresh_night(app, force).await;
}

/// 对应 Chrome SW `mergeStaleEstimate`：本轮实时自算未拿到估算值时，从上一轮缓存
/// （state.quote.holdings.list，即上一轮 `HoldingsPayload.list`）合并旧估算字段兜底，
/// 使空窗期 / 自算偶发失败的基金在 UI 仍能显示最近一次有效估算，从而与 Chrome 端
/// 当日收益 1:1 对齐，杜绝「同一持仓同一时刻两端当日收益不同」的信任问题。
///
/// 合并字段（仅当新值缺失且旧值存在时覆盖）：
///   estimate_net_value / estimate_growth / percent / percent_source / time / prev_net_value
/// 不覆盖 net_value / day_growth / net_value_date（新数据更准）。
///
/// 跳过条件（与 SW 逐条对齐）：
///   - q.is_qdii：QDII 盘中无估算为常态（provider 跳过自算估值），合并会把昨日 confirmed
///     涨幅 + prevNetValue 带回盘中冒充「今日」收益。直接跳过，保持 percent/prevNetValue
///     为空，严格走披露日窗口（盘中显示「-」）。
///   - 本轮已有新估算（estimate_net_value 或 estimate_growth 非 null）：不覆盖实时估值，
///     也不覆盖 20:00 后的官方确认数据。
///   - 旧值 percent_source == 'confirmed'：仅允许 estimate 旧值保留（黄金 ETF 联接等无 GSZ
///     基金同样受益），避免历史确认涨幅冒充今日盘中收益。
/// 同源判断由调用方负责（last_quote_source 比较），本函数不处理。
fn merge_stale_estimate(quotes: &mut [FundQuote], cached_list: &[FundQuoteRow]) {
    if cached_list.is_empty() {
        return;
    }
    let cache_map: std::collections::HashMap<&str, &FundQuoteRow> = cached_list
        .iter()
        .map(|r| (r.fund.code.as_str(), r))
        .collect();
    for q in quotes.iter_mut() {
        if q.is_qdii.unwrap_or(false) {
            continue;
        }
        let has_new_estimate = q.estimate_net_value.is_some() || q.estimate_growth.is_some();
        if has_new_estimate {
            continue;
        }
        let old = match cache_map.get(q.code.as_str()) {
            Some(o) => *o,
            None => continue,
        };
        if q.estimate_net_value.is_none() && old.estimate_net_value.is_some() {
            q.estimate_net_value = old.estimate_net_value;
        }
        if q.estimate_growth.is_none() && old.estimate_growth.is_some() {
            q.estimate_growth = old.estimate_growth;
        }
        if q.percent.is_none()
            && old.percent.is_some()
            && old.percent_source.as_deref() != Some("confirmed")
        {
            q.percent = old.percent;
            q.percent_source = old
                .percent_source
                .clone()
                .or_else(|| Some("estimate".to_string()));
        }
        if q.time.is_none() && old.time.is_some() {
            q.time = old.time.clone();
        }
        if q.prev_net_value.is_none() && old.prev_net_value.is_some() {
            q.prev_net_value = old.prev_net_value;
        }
    }
}

/// 日盘数据：基金持仓 + A 股指数
async fn refresh_day(app: &AppHandle, force: bool) {
    let state = app.state::<AppState>();
    let config = state.config.read().unwrap().clone();
    let now = chrono::Local::now();

    let mut holdings_payload: Option<HoldingsPayload> = None;
    let mut indices: Option<Vec<IndexItem>> = None;
    let mut patches: Vec<PersistPatch> = Vec::new();

    let source_str = config
        .settings
        .quote_source
        .as_deref()
        .unwrap_or("fundmnfinfo")
        .to_string();
    let source = QuoteSource::from_str(&source_str);

    // ---------------- 基金（仅持仓） ----------------
    if force || calendar::should_refresh_fund(&now) {
        // 手动刷新（force）时清空自算估值缓存，强制本轮实时拉取行情，
        // 使「点击刷新 = 点击时刻的最新估算值」（与 Chrome SW force=true 时
        // clearFundEstimateCaches() 对齐）。否则手动刷新会命中 5min CALC_GSZZL_CACHE，
        // 返回上次自动刷新的旧估算值，两端缓存填充时刻不同步 → 分叉。
        if force {
            crate::providers::fundmnfinfo::clear_calc_caches();
        }
        let holdings_funds: Vec<FundRecord> = config.holdings.values().cloned().collect();
        if !holdings_funds.is_empty() {
            let mut inputs: Vec<FundQuoteInput> = Vec::with_capacity(holdings_funds.len());
            for f in &holdings_funds {
                inputs.push(to_input(f));
            }
            let provider = get_quote_provider(source);
            let mut quotes = provider.fetch_quotes(&inputs).await;
            {
                let with_percent = quotes.iter().filter(|q| q.percent.is_some()).count();
                let with_nav = quotes.iter().filter(|q| q.net_value.is_some()).count();
                crate::dbg_log!(
                    "refresh 基金 source={} inputs={} quotes={} with_percent={} with_nav={}",
                    config
                        .settings
                        .quote_source
                        .as_deref()
                        .unwrap_or("fundmnfinfo"),
                    inputs.len(),
                    quotes.len(),
                    with_percent,
                    with_nav
                );
            }
            // 与 Chrome SW mergeStaleEstimate 1:1 对齐：本轮实时自算失败时，从上一轮缓存
            // 合并旧估算值兜底，避免 Tauri 端 pnl 被永久置 0 而 Chrome 端有值 → 两端当日
            // 收益分叉。切源后旧缓存是旧源口径，必须同源才合并（与 SW cache-source 对齐）。
            {
                let prev = state.quote.read().unwrap();
                let prev_source = state.last_quote_source.read().unwrap().clone();
                let same_source = prev_source.as_deref() == Some(source_str.as_str());
                if let Some(prev_holdings) = prev.as_ref().and_then(|p| p.holdings.as_ref()) {
                    if same_source && !prev_holdings.list.is_empty() {
                        crate::dbg_log!(
                            "refresh mergeStaleEstimate source={} cached={}",
                            source_str,
                            prev_holdings.list.len()
                        );
                        merge_stale_estimate(&mut quotes, &prev_holdings.list);
                    } else if !same_source {
                        crate::dbg_log!(
                            "refresh 缓存数据源 {:?} ≠ 当前 {}，跳过估算合并",
                            prev_source,
                            source_str
                        );
                    }
                }
            }
            let excluded_groups = config
                .settings
                .overview_excluded_groups
                .clone()
                .unwrap_or_default();
            let (payload, p) = calc_holdings(&holdings_funds, &quotes, &excluded_groups);
            holdings_payload = Some(payload);
            patches.extend(p);
        } else if force {
            // 持仓全空（重置 / 清空后 force 刷新）：显式广播空快照，
            // 否则 broadcast 会回退旧 state.quote，popup / menubar 浮窗仍显示旧持仓。
            holdings_payload = Some(HoldingsPayload::default());
        }
        // 记录本轮基金刷新使用的数据源（供下次合并做同源判断；切源即失效，下次跳过合并）
        *state.last_quote_source.write().unwrap() = Some(source_str.clone());
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
