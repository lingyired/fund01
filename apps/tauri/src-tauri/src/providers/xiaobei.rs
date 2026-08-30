//! 小倍养基数据源（api.xiaobeiyangji.com）—— 对应 fund.ts XiaobeiQuoteProvider。
//!
//! POST get-fund-detail-v310 → `data.dailyYield`（number 小数，盘中实时估值，如 0.0268 → 2.68%）。
//! ⚠️ 只取 dailyYield，不用 changeRate 兜底：changeRate 属热搜口径（开盘常为空），与 dailyYield
//! 不同源，混用会显示错误涨幅（wzk-fund 文档 §7.1 明确警告）。
//! 小倍只提供估值百分比 + nav，无估值净值/分时/历史净值 → 净值对与净值日期由东财
//! FundMNHisNetList 补齐（对齐 fund123.rs 的 hist 对齐逻辑）；取不到估值时 per-fund
//! 回落 FundMNFInfo（单向 DAG：xiaobei→fundmnfinfo→fund123，无环）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::http::{self, MOBILE_UA};
use crate::model::FundQuote;
use crate::providers::{fundmnfinfo, pad6, run_quotes_concurrent, FundQuoteInput, QuoteProvider};

// ----------------------------- 缓存 -----------------------------

const XIAOBEI_TTL: Duration = Duration::from_secs(60); // 盘中估值 60s 刷新（对齐 wzk）

static XIAOBEI_CACHE: OnceLock<Mutex<HashMap<String, (String, Option<f64>, Instant)>>> =
    OnceLock::new();

/// 拉取小倍基金详情：返回 (name, daily_yield 百分数)。60s 缓存；
/// 仅缓存有估值的响应（无估值不缓存，便于下次重试）。
async fn load_xiaobei_detail(code: &str) -> Option<(String, Option<f64>)> {
    let cache = || XIAOBEI_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let guard = cache().lock().unwrap();
        if let Some((name, dy, ts)) = guard.get(code) {
            if ts.elapsed() < XIAOBEI_TTL {
                return Some((name.clone(), *dy));
            }
        }
    }
    let body = json!({ "code": code, "version": "3.8.7.0", "clientType": "APP" });
    let res = http::http_post_json(
        "https://api.xiaobeiyangji.com/yangji-api/api/get-fund-detail-v310",
        &body,
        &[("User-Agent", MOBILE_UA)],
        Duration::from_secs(12),
    )
    .await
    .ok()?;
    let data = res.get("data")?;
    let name = data
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 0.0268 → 2.68（百分数，保留两位；wzk parseXiaobeiDailyYield 同构）
    let daily_yield = data
        .get("dailyYield")
        .and_then(|v| v.as_f64())
        .map(|raw| (raw * 10000.0).round() / 100.0);
    if daily_yield.is_some() {
        cache().lock().unwrap().insert(
            code.to_string(),
            (name.clone(), daily_yield, Instant::now()),
        );
    }
    Some((name, daily_yield))
}

/// 小倍失败/无估值时的空行情（percent 空 → fetch_quotes 层降级到 FundMNFInfo）
fn xiaobei_empty(code: &str, fund: &FundQuoteInput, err: &str) -> FundQuote {
    FundQuote {
        code: code.to_string(),
        name: fund.name.clone().unwrap_or_else(|| code.to_string()),
        error: Some(err.to_string()),
        ..Default::default()
    }
}

// ----------------------------- Provider -----------------------------

pub struct XiaobeiQuoteProvider;

impl QuoteProvider for XiaobeiQuoteProvider {
    async fn fetch_quotes(&self, funds: &[FundQuoteInput]) -> Vec<FundQuote> {
        if funds.is_empty() {
            return vec![];
        }
        let mut results =
            run_quotes_concurrent(funds, |f| Box::pin(async move { fetch_one(&f).await }), 10)
                .await;
        // 降级：小倍失败 / 无估值的基金 → FundMNFInfo（其内部含自算 / fund123 兜底链）
        let failed_idx: Vec<usize> = results
            .iter()
            .enumerate()
            .filter(|(_, q)| q.percent.is_none() && q.percent_source.is_none())
            .map(|(i, _)| i)
            .collect();
        if !failed_idx.is_empty() {
            let failed_funds: Vec<FundQuoteInput> =
                failed_idx.iter().map(|&i| funds[i].clone()).collect();
            let fallback = fundmnfinfo::FundMNFInfoQuoteProvider
                .fetch_quotes(&failed_funds)
                .await;
            for (j, &i) in failed_idx.iter().enumerate() {
                if let Some(q) = fallback.get(j) {
                    results[i] = q.clone();
                }
            }
        }
        results
    }
}

async fn fetch_one(fund: &FundQuoteInput) -> FundQuote {
    let code = pad6(&fund.code);
    let mut name = fund.name.clone().unwrap_or_default();
    let daily_yield = match load_xiaobei_detail(&code).await {
        Some((n, dy)) => {
            if name.is_empty() {
                name = n;
            }
            dy
        }
        None => return xiaobei_empty(&code, fund, "xiaobei: 请求失败"),
    };
    let Some(daily_yield) = daily_yield else {
        return xiaobei_empty(&code, fund, "xiaobei: 无盘中估值");
    };

    // 净值 / 净值日期 / dayGrowth：东财历史净值对齐（对齐 fund123.rs get_fund_quote）
    let mut net_value: Option<f64> = None;
    let mut day_growth: Option<f64> = None;
    let mut net_value_date = String::new();
    let mut hist_idx: i64 = -1;
    let mut hist: Vec<crate::history::HistRow> = vec![];
    if let Ok(rows) = crate::history::fetch_fund_nav_history(&code, 5, 1).await {
        hist = rows;
        if !hist.is_empty() {
            hist_idx = 0; // 小倍不给净值日期，取东财最新一条
            if let Some(m) = hist.get(0) {
                if m.net_value.is_some() {
                    net_value = m.net_value;
                }
                if m.day_growth.is_some() {
                    day_growth = m.day_growth;
                }
                if !m.date.is_empty() {
                    net_value_date = m.date.clone();
                }
            }
        }
    }

    // 展示口径（对齐 resolveDisplayPercent / fund123.rs）：确认窗口 → 东财已披露涨幅；
    // 否则 → 小倍盘中估值（QDII 与非 QDII 统一显示，不再「-」）
    let now = chrono::Local::now();
    let nav_day = crate::calendar::normalize_net_value_date(&net_value_date, &now);
    let qdii = fundmnfinfo::is_qdii_name(&name);
    let in_confirm = day_growth.is_some()
        && !nav_day.is_empty()
        && crate::calendar::is_confirmed_session_active(&nav_day, &now, qdii)
        && !(qdii && crate::calendar::is_a_share_trading_time(&now));
    let (percent, percent_source) = if in_confirm {
        (day_growth, Some("confirmed".to_string()))
    } else {
        (Some(daily_yield), Some("estimate".to_string()))
    };

    // 估算净值：最新确认净值 × (1 + 当日估值涨幅)，供 resolve_nav_pair 的 estimate
    // 分支产出 当日收益 = 份额 × 净值 × 涨幅（小倍无估值净值，近似同 fundmnfinfo 自算）
    let estimate_net_value = net_value
        .filter(|n| *n > 0.0)
        .map(|n| fundmnfinfo::round4(n * (1.0 + daily_yield / 100.0)));
    let has_estimate =
        estimate_net_value.is_some() || percent_source.as_deref() == Some("estimate");
    let prev_net_value = if percent_source.as_deref() == Some("confirmed") {
        hist.get((hist_idx + 1) as usize).and_then(|h| h.net_value)
    } else if has_estimate {
        net_value
    } else if let Some(h) = hist.get((hist_idx + 1) as usize) {
        h.net_value
    } else {
        net_value
    };

    // 板块推断（同 fundmnfinfo/fund123 源）
    let mut sectors = fund.sectors.clone();
    if crate::theme::sectors_need_refresh(&sectors, &name) {
        let next = crate::theme::fetch_fund_sectors_queued(&code, &name).await;
        if !next.is_empty() {
            sectors = next;
        }
    }

    FundQuote {
        code,
        name: if name.is_empty() {
            fund.code.clone()
        } else {
            name
        },
        fund_key: String::new(),
        day_growth,
        estimate_growth: Some(daily_yield),
        percent,
        percent_source,
        net_value,
        estimate_net_value,
        prev_net_value,
        net_value_date,
        time: None,
        trend: vec![],
        sectors,
        use_calc: Some(false),
        is_qdii: Some(qdii),
        ..Default::default()
    }
}
