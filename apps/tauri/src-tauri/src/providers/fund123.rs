//! fund123 数据源（蚂蚁基金，CSRF + cookie）—— 对应 fund.ts L12-71/L476-730 迁移。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{json, Value};

use crate::http::{self, DESKTOP_UA};
use crate::model::{FundQuote, TrendPoint};
use crate::providers::{pad6, FundQuoteInput, QuoteProvider};

// ----------------------------- CSRF -----------------------------

static CSRF_CACHE: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();
/// 全局互斥：串行化所有 fund123 请求（CSRF 刷新 + POST），避免并发爆发触发
/// fund123 的频率风控（queryFundEstimateIntraday 等接口高频并发会 403）。
static FUND123_IO_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
const CSRF_TTL: Duration = Duration::from_secs(10 * 60);

async fn fund123_io() -> tokio::sync::MutexGuard<'static, ()> {
    FUND123_IO_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await
}

async fn ensure_csrf(force: bool) -> Result<String, String> {
    // 调用方（fund123_post::run）已持有 FUND123_IO_LOCK，这里不再加锁
    if !force {
        let cache = CSRF_CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap();
        if let Some((token, exp)) = cache.as_ref() {
            if Instant::now() < *exp {
                return Ok(token.clone());
            }
        }
    }
    let html = http::http_get_text(
        "https://www.fund123.cn/fund",
        &HashMap::new(),
        DESKTOP_UA,
        Some("https://www.fund123.cn/"),
        Duration::from_secs(15),
    )
    .await?;
    let re = Regex::new(r#""csrf":"([^"]+)""#).unwrap();
    let token = re
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| "获取 fund123 CSRF 失败".to_string())?;
    *CSRF_CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap() =
        Some((token.clone(), Instant::now() + CSRF_TTL));
    Ok(token)
}

async fn fund123_post(path: &str, body: &Value) -> Result<Value, String> {
    async fn run(path: &str, body: &Value, force: bool) -> Result<Value, String> {
        // 全局互斥：串行化所有 fund123 请求（CSRF 刷新 + POST），
        // 避免并发爆发触发 fund123 频率风控（queryFundEstimateIntraday 高频并发 403）
        let _guard = fund123_io().await;
        let csrf = ensure_csrf(force).await?;
        let url = format!("https://www.fund123.cn{path}?_csrf={csrf}");
        http::http_post_json(
            &url,
            body,
            &[
                ("Origin", "https://www.fund123.cn"),
                ("Referer", "https://www.fund123.cn/fund"),
                ("X-API-Key", "foobar"),
            ],
            Duration::from_secs(15),
        )
        .await
    }
    match run(path, body, false).await {
        Ok(v) => Ok(v),
        Err(e) if e.contains("403") || e.contains("401") => {
            eprintln!("[fund01] fund123_post {path} 首次失败 ({e})，刷新 CSRF 重试");
            // 风控 403：退避 1s 再强制刷新重试（避免立即再触发）
            tokio::time::sleep(Duration::from_millis(1000)).await;
            match run(path, body, true).await {
                Ok(v) => Ok(v),
                Err(e2) => {
                    eprintln!("[fund01] fund123_post {path} 重试仍失败: {e2}");
                    Err(e2)
                }
            }
        }
        Err(e) => Err(e),
    }
}

fn parse_pct(v: Option<&Value>) -> Option<f64> {
    let s = v.and_then(|v| v.as_str()).unwrap_or("");
    if s.is_empty() || s == "--" {
        return None;
    }
    let n = s.replace('%', "").parse::<f64>().ok();
    n.filter(|n| n.is_finite())
}

// ----------------------------- 搜索 / 资料 -----------------------------

pub struct SearchFundResult {
    pub code: String,
    pub name: String,
    pub fund_key: String,
    pub net_value: Option<f64>,
    pub day_growth: Option<f64>,
}

pub async fn search_fund(code: &str) -> Result<SearchFundResult, String> {
    let padded = pad6(code);
    let data = fund123_post("/api/fund/searchFund", &json!({"fundCode": padded})).await?;
    if !data.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
        let msg = data
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("未找到基金")
            .to_string();
        return Err(format!("{msg} ({padded})"));
    }
    let info = data.get("fundInfo").cloned().unwrap_or(Value::Null);
    Ok(SearchFundResult {
        code: info.get("fundCode").and_then(|v| v.as_str()).unwrap_or(&padded).to_string(),
        name: info.get("fundName").and_then(|v| v.as_str()).unwrap_or(&padded).to_string(),
        fund_key: info.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        net_value: info.get("netValue").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()).filter(|n| n.is_finite()),
        day_growth: parse_pct(info.get("dayOfGrowth")),
    })
}

/// 按关键词搜索基金（模糊匹配，调用方必须用名称精确过滤）
pub async fn search_funds_by_keyword(keyword: &str) -> Vec<(String, String)> {
    let key = keyword.trim();
    if key.is_empty() {
        return vec![];
    }
    let query = http::params(&[("m", "1"), ("key", key)]);
    match http::http_get_json(
        "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx",
        &query,
        DESKTOP_UA,
        Some("https://fund.eastmoney.com/"),
        Duration::from_secs(12),
    )
    .await
    {
        Ok(data) => {
            let rows = data.get("Datas").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            rows.iter()
                .filter_map(|r| {
                    let code = r.get("CODE").and_then(|v| v.as_str()).unwrap_or("");
                    let name = r.get("NAME").and_then(|v| v.as_str()).unwrap_or("");
                    if code.len() == 6 && code.chars().all(|c| c.is_ascii_digit()) && !name.is_empty() {
                        Some((code.to_string(), name.to_string()))
                    } else {
                        None
                    }
                })
                .collect()
        }
        Err(e) => {
            eprintln!("[fund01] searchFundsByKeyword 失败: {e}");
            vec![]
        }
    }
}

pub struct MatiariaResult {
    pub name: String,
    pub day_growth: Option<f64>,
    pub net_value: Option<f64>,
    pub net_value_date: String,
}

pub async fn get_fund_matiaria(code: &str) -> Result<MatiariaResult, String> {
    let padded = pad6(code);
    let html = http::http_get_text(
        &format!("https://www.fund123.cn/matiaria?fundCode={padded}"),
        &HashMap::new(),
        DESKTOP_UA,
        Some("https://www.fund123.cn/"),
        Duration::from_secs(15),
    )
    .await?;
    let grab = |pattern: &str| -> Option<String> {
        Regex::new(pattern)
            .ok()?
            .captures(&html)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
    };
    let day_growth = grab(r#"dayOfGrowth":"([^"]+)"#).as_deref().and_then(|s| {
        if s.is_empty() || s == "--" {
            None
        } else {
            s.parse::<f64>().ok().filter(|n| n.is_finite())
        }
    });
    let net_value = grab(r#"netValue":"([^"]+)"#).and_then(|s| s.parse::<f64>().ok()).filter(|n| n.is_finite());
    let raw_date = grab(r#"netValueDate":"([^"]+)"#).unwrap_or_default();
    let net_value_date = crate::calendar::normalize_net_value_date(&raw_date, &chrono::Local::now());
    let name = grab(r#"fundName":"([^"]+)"#).unwrap_or_default();
    Ok(MatiariaResult { name, day_growth, net_value, net_value_date })
}

/// 盘中分时走势（fund123 POST）
pub async fn get_fund_estimate_intraday(fund_key: &str) -> Result<(Vec<TrendPoint>, Option<TrendPoint>), String> {
    if fund_key.is_empty() {
        return Ok((vec![], None));
    }
    let today = chrono::Local::now();
    let tomorrow = today + Duration::from_secs(86400);
    let body = json!({
        "startTime": today.format("%Y-%m-%d").to_string(),
        "endTime": tomorrow.format("%Y-%m-%d").to_string(),
        "limit": 240,
        "productId": fund_key,
        "format": true,
        "source": "WEALTHBFFWEB",
    });
    let data = fund123_post("/api/fund/queryFundEstimateIntraday", &body).await?;
    let list = data.get("list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut points = Vec::with_capacity(list.len());
    for p in list {
        let time_raw = p.get("time").and_then(|v| v.as_str()).unwrap_or("");
        let growth = p
            .get("forecastGrowth")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .map(|g| g * 100.0);
        let net_value = p
            .get("forecastNetValue")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite());
        if let Some(g) = growth.filter(|g| g.is_finite()) {
            points.push(TrendPoint {
                time: parse_time_hm(time_raw),
                growth: Some(g),
                net_value,
            });
        }
    }
    let latest = points.last().cloned();
    Ok((points, latest))
}

/// ISO "2024-01-01T10:30:00" → "10:30"
fn parse_time_hm(t: &str) -> String {
    if t.len() >= 16 && t.as_bytes()[10] == b'T' {
        return t[11..16].to_string();
    }
    let digits: String = t.chars().filter(|c| c.is_ascii_digit() || *c == ':').collect();
    digits.chars().take(5).collect()
}

// ----------------------------- getFundQuote（fund123 单只） -----------------------------

/// fund123 数据源的单只行情（对应 getFundQuote）
pub async fn get_fund_quote(fund: &FundQuoteInput) -> FundQuote {
    let code = pad6(&fund.code);
    let mut fund_key = fund.fund_key.clone().unwrap_or_default();
    let mut name = fund.name.clone().unwrap_or_default();
    let mut day_growth: Option<f64> = None;
    let mut net_value: Option<f64> = None;
    let mut net_value_date = String::new();

    // 1. searchFund 补齐 key/name（失败忽略）
    if fund_key.is_empty() || name.is_empty() {
        if let Ok(searched) = search_fund(&code).await {
            if fund_key.is_empty() {
                fund_key = searched.fund_key;
            }
            if name.is_empty() {
                name = searched.name;
            }
            if day_growth.is_none() {
                day_growth = searched.day_growth;
            }
            if net_value.is_none() {
                net_value = searched.net_value;
            }
        }
    }

    // 2. matiaria（失败保留先前值）
    if let Ok(m) = get_fund_matiaria(&code).await {
        if name.is_empty() {
            name = m.name;
        }
        if m.day_growth.is_some() {
            day_growth = m.day_growth;
        }
        if m.net_value.is_some() {
            net_value = m.net_value;
        }
        if !m.net_value_date.is_empty() {
            net_value_date = m.net_value_date;
        }
    }

    // 3. 盘中估算（fund123 分时走势）
    let mut estimate_growth: Option<f64> = None;
    let mut estimate_net_value: Option<f64> = None;
    let mut trend: Vec<TrendPoint> = vec![];
    if let Ok((pts, latest)) = get_fund_estimate_intraday(&fund_key).await {
        estimate_growth = latest.as_ref().and_then(|l| l.growth);
        estimate_net_value = latest.as_ref().and_then(|l| l.net_value);
        trend = pts;
    }

    // 4. 历史净值（5 条）对齐口径
    let mut hist: Vec<crate::history::HistRow> = vec![];
    let mut hist_idx: i64 = -1;
    if let Ok(rows) = crate::history::fetch_fund_nav_history(&code, 5, 1).await {
        hist = rows;
        if !hist.is_empty() {
            let now = chrono::Local::now();
            let nav_day = crate::calendar::normalize_net_value_date(&net_value_date, &now);
            hist_idx = if nav_day.is_empty() {
                0
            } else {
                hist.iter()
                    .position(|h| h.date == nav_day)
                    .map(|i| i as i64)
                    .unwrap_or(0)
            };
            if let Some(match_row) = hist.get(hist_idx as usize) {
                if match_row.net_value.is_some() {
                    net_value = match_row.net_value;
                }
                if match_row.day_growth.is_some() {
                    day_growth = match_row.day_growth;
                }
                if !match_row.date.is_empty() {
                    net_value_date = match_row.date.clone();
                }
            }
        }
    }

    // 5. 展示口径（resolveDisplayPercent）
    let now = chrono::Local::now();
    let nav_day = crate::calendar::normalize_net_value_date(&net_value_date, &now);
    let in_confirm = day_growth.is_some()
        && !nav_day.is_empty()
        && crate::calendar::is_confirmed_session_active(&nav_day, &now);
    let (percent, percent_source) = if in_confirm {
        (day_growth, Some("confirmed".to_string()))
    } else if let Some(eg) = estimate_growth {
        (Some(eg), Some("estimate".to_string()))
    } else if let Some(dg) = day_growth {
        (Some(dg), None)
    } else {
        (None, None)
    };
    let has_estimate = estimate_net_value.is_some() || estimate_growth.is_some();
    let prev_net_value = if percent_source.as_deref() == Some("confirmed") {
        hist.get((hist_idx + 1) as usize).and_then(|h| h.net_value)
    } else if has_estimate {
        net_value
    } else if let Some(h) = hist.get((hist_idx + 1) as usize) {
        h.net_value
    } else {
        net_value
    };

    // 6. 板块刷新
    let sectors = crate::providers::fundmnfinfo::refresh_sectors_if_needed(&code, &name, &fund.sectors).await;

    FundQuote {
        code: code.clone(),
        name: if name.is_empty() { code.clone() } else { name },
        fund_key,
        day_growth,
        estimate_growth,
        percent,
        percent_source,
        net_value,
        estimate_net_value,
        prev_net_value,
        net_value_date,
        time: trend.last().map(|t| t.time.clone()),
        trend,
        sectors,
        ..Default::default()
    }
}

// ----------------------------- Provider -----------------------------

/// 懒加载盘中分时走势（对应 fetchFundIntradayForDialog）
pub async fn fetch_intraday_for_dialog(
    code: &str,
    fund_key: Option<&str>,
    name: Option<&str>,
) -> Result<crate::model::FundIntradayPayload, String> {
    let padded = pad6(code);
    let mut key = fund_key.unwrap_or("").to_string();
    let mut resolved_name = name.unwrap_or("").to_string();
    if key.is_empty() {
        if let Ok(searched) = search_fund(&padded).await {
            key = searched.fund_key;
            if resolved_name.is_empty() {
                resolved_name = searched.name;
            }
        }
    }
    let (points, latest) = get_fund_estimate_intraday(&key).await?;
    Ok(crate::model::FundIntradayPayload {
        points,
        latest,
        fund_key: key,
        name: resolved_name,
    })
}

pub struct Fund123QuoteProvider;

impl QuoteProvider for Fund123QuoteProvider {
    async fn fetch_quotes(&self, funds: &[FundQuoteInput]) -> Vec<FundQuote> {
        // fund123 接口对并发爆发有限流（403），全程串行（fund123_post 内部还有全局互斥）
        crate::providers::run_quotes_concurrent(
            funds,
            |f| Box::pin(async move { get_fund_quote(&f).await }),
            1,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ⚠️ 以下测试依赖网络（访问 fund123.cn），默认 #[ignore] 跳过；
    // 手动运行：cargo test --lib fund123::tests -- --ignored --nocapture

    #[tokio::test]
    #[ignore]
    async fn probe_fund123_post() {
        // 复现 app 运行时路径：ensure_csrf(共享缓存) + fund123_post
        let r = fund123_post("/api/fund/searchFund", &json!({"fundCode": "161725"})).await;
        println!("[app-probe] fund123_post result: {:?}", r);
        assert!(r.is_ok(), "fund123_post 应成功: {:?}", r.err());
    }

    #[tokio::test]
    #[ignore]
    async fn probe_ensure_csrf() {
        let token = ensure_csrf(false).await;
        println!("[app-probe] ensure_csrf: {:?}", token);
        assert!(token.is_ok());
    }

    #[tokio::test]
    #[ignore]
    async fn probe_concurrent_post_serialized() {
        // 验证全局互斥 + 串行化后，10 只基金并发 fund123_post 不再触发风控 403
        let mut handles = Vec::new();
        for code in ["161725", "110022", "001594", "003095", "005827", "012414", "011102", "001714", "004231", "005968"] {
            handles.push(tokio::spawn(async move {
                fund123_post("/api/fund/searchFund", &json!({"fundCode": code})).await
            }));
        }
        let mut ok = 0;
        for h in handles {
            match h.await.unwrap() {
                Ok(_) => ok += 1,
                Err(e) => println!("[serialized] 失败: {e}"),
            }
        }
        println!("[serialized] 成功: {ok}/10");
        assert!(ok == 10, "串行化后应全部成功，实际 {ok}/10");
    }
}
