//! 持仓/自选合并计算 —— 对应 `packages/core/src/holdingsCalc.ts` 1:1 迁移。

use crate::calendar::{normalize_net_value_date, should_show_confirmed_updated_badge};
use crate::model::{FundQuote, FundQuoteRow, FundRecord, HoldingsPayload, HoldingsSummary};

pub struct PersistPatch {
    pub code: String,
    pub sectors: Option<Vec<String>>,
}

fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

/// 收益取分：与支付宝一致，舍去厘（向 0 截断），不用四舍五入
pub fn trunc_pnl2(n: f64) -> f64 {
    if !n.is_finite() {
        return 0.0;
    }
    if n >= 0.0 {
        (n * 100.0).floor() / 100.0
    } else {
        (n * 100.0).ceil() / 100.0
    }
}

/// 从估值分时末点取净值（比涨幅更精确）
fn latest_estimate_nav(q: &FundQuote) -> Option<f64> {
    if let Some(n) = q.estimate_net_value.filter(|n| *n > 0.0) {
        return Some(n);
    }
    for t in q.trend.iter().rev() {
        if let Some(nv) = t.net_value.filter(|n| *n > 0.0) {
            return Some(nv);
        }
    }
    None
}

/// 解析昨净值 / 今净值（金钱一律用净值差；涨幅只用于展示）
pub fn resolve_nav_pair(q: &FundQuote) -> (Option<f64>, Option<f64>) {
    let confirmed_nav = q.net_value.filter(|n| *n > 0.0);
    let prev = q.prev_net_value.filter(|n| *n > 0.0);
    let estimate_nav = latest_estimate_nav(q);

    if q.percent_source.as_deref() == Some("confirmed") && confirmed_nav.is_some() && prev.is_some() {
        (prev, confirmed_nav)
    } else if estimate_nav.is_some() {
        (prev.or(confirmed_nav), estimate_nav)
    } else if confirmed_nav.is_some() && prev.is_some() {
        (prev, confirmed_nav)
    } else {
        (None, None)
    }
}

/// 持仓合并计算（对应 calcHoldings）
pub fn calc_holdings(
    local_funds: &[FundRecord],
    quotes: &[FundQuote],
) -> (HoldingsPayload, Vec<PersistPatch>) {
    let quote_map: std::collections::HashMap<&str, &FundQuote> =
        quotes.iter().map(|q| (q.code.as_str(), q)).collect();

    let mut rows: Vec<FundQuoteRow> = Vec::with_capacity(local_funds.len());
    let mut persist_patches: Vec<PersistPatch> = Vec::new();
    let mut total_amount = 0.0f64;
    let mut total_pnl = 0.0f64;
    let mut total_cost = 0.0f64;
    let mut total_cum_pnl = 0.0f64;
    let mut has_any_cost = false;

    let now = chrono::Local::now();

    for raw in local_funds {
        let q = quote_map.get(raw.code.as_str()).copied().unwrap_or(&EMPTY_QUOTE);
        let percent = q.percent.or(q.estimate_growth).or(q.day_growth);
        let (prev_nav, curr_nav) = resolve_nav_pair(q);

        let nav_day = normalize_net_value_date(&q.net_value_date, &now);
        let shares = if !raw.allocations.is_empty() {
            raw.allocations.values().sum()
        } else {
            raw.shares.unwrap_or(0.0)
        };

        // 成本：总成本 = Σ(单价[g] × 份额[g])；无 costs 则为 0
        let mut total_cost_row = 0.0f64;
        if let Some(costs) = &raw.costs {
            for (g, price) in costs {
                let sh = raw.allocations.get(g).copied().unwrap_or(0.0);
                if *price > 0.0 && sh > 0.0 {
                    total_cost_row += price * sh;
                }
            }
        }
        total_cost_row = round2(total_cost_row);
        let has_cost = total_cost_row > 0.0;

        let using_estimate = q.percent_source.as_deref() == Some("estimate")
            || (q.percent_source.as_deref() != Some("confirmed") && latest_estimate_nav(q).is_some());

        let mut pnl = 0.0f64;
        if shares > 0.0 && prev_nav.is_some() && curr_nav.is_some() {
            pnl = trunc_pnl2(shares * (curr_nav.unwrap() - prev_nav.unwrap()));
        }

        let mut display_amount = 0.0f64;
        if shares > 0.0 {
            if using_estimate && prev_nav.is_some() {
                display_amount = round2(shares * prev_nav.unwrap());
            } else if curr_nav.is_some() {
                display_amount = round2(shares * curr_nav.unwrap());
            } else if prev_nav.is_some() {
                display_amount = round2(shares * prev_nav.unwrap());
            }
        }
        let live_amount = if shares > 0.0 && curr_nav.is_some() {
            round2(shares * curr_nav.unwrap())
        } else {
            display_amount
        };

        total_amount += display_amount;
        total_pnl += pnl;
        if has_cost {
            has_any_cost = true;
            total_cost += total_cost_row;
            total_cum_pnl += round2(live_amount - total_cost_row);
        }

        let sectors = if !raw.sectors.is_empty() {
            raw.sectors.clone()
        } else if !q.sectors.is_empty() {
            q.sectors.clone()
        } else {
            vec![]
        };

        let mut patch = PersistPatch { code: raw.code.clone(), sectors: None };
        if raw.sectors.is_empty() && !sectors.is_empty() {
            patch.sectors = Some(sectors.clone());
            persist_patches.push(patch);
        }

        let confirmed_updated = should_show_confirmed_updated_badge(
            q.percent_source.as_deref(),
            Some(if nav_day.is_empty() { q.net_value_date.as_str() } else { nav_day.as_str() }),
            &now,
        );

        // 合并展示字段到 FundRecord（serde flatten，避免 JSON 字段冲突）
        let mut row_fund = raw.clone();
        if !q.name.is_empty() {
            row_fund.name = q.name.clone();
        }
        if !q.fund_key.is_empty() {
            row_fund.fund_key = Some(q.fund_key.clone());
        }
        row_fund.sectors = sectors.clone();
        row_fund.shares = Some(shares);

        rows.push(FundQuoteRow {
            fund: row_fund,
            percent,
            percent_source: q.percent_source.clone(),
            estimate_growth: q.estimate_growth,
            day_growth: q.day_growth,
            net_value_date: Some(if nav_day.is_empty() { q.net_value_date.clone() } else { nav_day }),
            net_value: q.net_value,
            estimate_net_value: latest_estimate_nav(q),
            prev_net_value: prev_nav,
            time: q.time.clone(),
            trend: q.trend.clone(),
            amount: round2(display_amount),
            live_amount: Some(round2(live_amount)),
            pnl: Some(pnl),
            confirmed_updated: Some(confirmed_updated),
            total_cost: Some(round2(total_cost_row)),
            total_cum_pnl: if has_cost { Some(round2(live_amount - total_cost_row)) } else { None },
            total_cum_pnl_percent: if has_cost && total_cost_row > 0.0 {
                Some(round2(((live_amount - total_cost_row) / total_cost_row) * 100.0))
            } else {
                None
            },
            weight: None,
        });
    }

    // weight
    for row in &mut rows {
        row.weight = if total_amount > 0.0 {
            Some(round2((row.amount / total_amount) * 100.0))
        } else {
            Some(0.0)
        };
    }

    // bodTotal：开盘前基数 = 份额 × 昨净值
    let mut bod_total = 0.0f64;
    for row in &rows {
        let sh = row.fund.shares.unwrap_or(0.0);
        if sh > 0.0 && row.prev_net_value.is_some_and(|p| p > 0.0) {
            bod_total += round2(sh * row.prev_net_value.unwrap());
        } else {
            bod_total += (row.amount) - (row.pnl.unwrap_or(0.0));
        }
    }
    bod_total = round2(bod_total);

    rows.sort_by(|a, b| b.amount.partial_cmp(&a.amount).unwrap_or(std::cmp::Ordering::Equal));

    let summary = HoldingsSummary {
        total_amount: round2(total_amount),
        bod_total: Some(bod_total),
        total_pnl: round2(total_pnl),
        total_pnl_percent: if bod_total > 0.0 { round2((total_pnl / bod_total) * 100.0) } else { 0.0 },
        total_cost: if has_any_cost { Some(round2(total_cost)) } else { Some(0.0) },
        total_cum_pnl: if has_any_cost { Some(round2(total_cum_pnl)) } else { None },
        total_cum_pnl_percent: if has_any_cost && total_cost > 0.0 {
            Some(round2((total_cum_pnl / total_cost) * 100.0))
        } else {
            None
        },
    };

    (HoldingsPayload { summary, list: rows }, persist_patches)
}

/// 自选合并（对应 mergeWatchlist）
pub fn merge_watchlist(
    local_funds: &[FundRecord],
    quotes: &[FundQuote],
) -> (Vec<FundQuoteRow>, Vec<PersistPatch>) {
    let quote_map: std::collections::HashMap<&str, &FundQuote> =
        quotes.iter().map(|q| (q.code.as_str(), q)).collect();
    let mut persist_patches = Vec::new();
    let list = local_funds
        .iter()
        .map(|f| {
            let q = quote_map.get(f.code.as_str()).copied().unwrap_or(&EMPTY_QUOTE);
            let sectors = if !f.sectors.is_empty() {
                f.sectors.clone()
            } else if !q.sectors.is_empty() {
                q.sectors.clone()
            } else {
                vec![]
            };
            if f.sectors.is_empty() && !sectors.is_empty() {
                persist_patches.push(PersistPatch { code: f.code.clone(), sectors: Some(sectors.clone()) });
            }
            let mut row_fund = f.clone();
            if !q.name.is_empty() {
                row_fund.name = q.name.clone();
            }
            if !q.fund_key.is_empty() {
                row_fund.fund_key = Some(q.fund_key.clone());
            }
            row_fund.sectors = sectors;
            FundQuoteRow {
                fund: row_fund,
                percent: q.percent.or(q.estimate_growth).or(q.day_growth),
                estimate_growth: q.estimate_growth,
                day_growth: q.day_growth,
                time: q.time.clone(),
                trend: q.trend.clone(),
                ..Default::default()
            }
        })
        .collect();
    (list, persist_patches)
}

static EMPTY_QUOTE: FundQuote = FundQuote {
    code: String::new(),
    name: String::new(),
    fund_key: String::new(),
    day_growth: None,
    estimate_growth: None,
    percent: None,
    percent_source: None,
    net_value: None,
    estimate_net_value: None,
    prev_net_value: None,
    net_value_date: String::new(),
    time: None,
    trend: Vec::new(),
    sectors: Vec::new(),
    error: None,
    use_calc: None,
};
