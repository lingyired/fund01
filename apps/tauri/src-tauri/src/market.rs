//! 指数 / 大盘 —— 对应 `packages/services/src/market.ts` 迁移。

use std::collections::HashMap;
use std::time::Duration;

use serde_json::Value;

use crate::http::{self, DESKTOP_UA};
use crate::model::{IndexHistoryPayload, IndexHistoryPoint, IndexItem, MarketOverview, SectorItem, UpDownStats};

const PUSH_HOSTS: &[&str] = &[
    "https://push2delay.eastmoney.com",
    "https://push2.eastmoney.com",
    "https://82.push2.eastmoney.com",
];

struct IndexMeta {
    secid: &'static str,
    code: &'static str,
    name: &'static str,
    tx: Option<&'static str>,
    sina: Option<&'static str>,
    sina_us: Option<&'static str>,
}

const INDEX_LIST: &[IndexMeta] = &[
    IndexMeta { secid: "1.000001", code: "000001", name: "上证指数", tx: Some("sh000001"), sina: None, sina_us: None },
    IndexMeta { secid: "0.399001", code: "399001", name: "深证成指", tx: Some("sz399001"), sina: None, sina_us: None },
    IndexMeta { secid: "0.399006", code: "399006", name: "创业板指", tx: Some("sz399006"), sina: None, sina_us: None },
    IndexMeta { secid: "0.899050", code: "899050", name: "北证50", tx: None, sina: Some("bj899050"), sina_us: None },
    IndexMeta { secid: "1.000688", code: "000688", name: "科创50", tx: Some("sh000688"), sina: None, sina_us: None },
    IndexMeta { secid: "1.000016", code: "000016", name: "上证50", tx: Some("sh000016"), sina: None, sina_us: None },
    IndexMeta { secid: "1.000300", code: "000300", name: "沪深300", tx: Some("sh000300"), sina: None, sina_us: None },
    IndexMeta { secid: "1.000905", code: "000905", name: "中证500", tx: Some("sh000905"), sina: None, sina_us: None },
    IndexMeta { secid: "100.NDX", code: "NDX", name: "纳斯达克100", tx: Some("us.NDX"), sina: None, sina_us: Some(".NDX") },
    IndexMeta { secid: "100.SPX", code: "SPX", name: "标普500", tx: Some("us.INX"), sina: None, sina_us: Some(".INX") },
];

fn find_index_meta(code: &str) -> Option<&'static IndexMeta> {
    let key = code.trim();
    INDEX_LIST
        .iter()
        .find(|i| i.code == key || i.secid.ends_with(&format!(".{key}")))
}

/// 指数实时行情（对应 getIndices）
pub async fn get_indices() -> Result<Vec<IndexItem>, String> {
    let secids: Vec<String> = INDEX_LIST.iter().map(|i| i.secid.to_string()).collect();
    let query = http::params(&[
        ("fltt", "2"),
        ("invt", "2"),
        ("fields", "f2,f3,f4,f12,f14"),
        ("secids", &secids.join(",")),
    ]);
    let data = http::eastmoney_get("/api/qt/ulist.np/get", &query, PUSH_HOSTS).await?;
    let diff = data.pointer("/data/diff").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let by_code: HashMap<String, &Value> = diff
        .iter()
        .filter_map(|d| {
            d.get("f12")
                .and_then(|v| v.as_str())
                .map(|c| (c.to_string(), d))
        })
        .collect();
    let mut out = Vec::with_capacity(INDEX_LIST.len());
    for item in INDEX_LIST {
        let row = by_code.get(item.code).copied().or_else(|| {
            by_code.get(item.secid.split('.').nth(1).unwrap_or("")).copied()
        });
        let num = |k: &str| -> Option<f64> {
            row.and_then(|r| r.get(k)).and_then(|v| v.as_f64())
        };
        out.push(IndexItem {
            code: item.code.to_string(),
            name: item.name.to_string(),
            percent: num("f3"),
            price: num("f2"),
            change: num("f4"),
        });
    }
    Ok(out)
}

/// 板块排行（对应 getSectorBoards）
async fn get_sector_boards(sort: &str, size: usize) -> Vec<SectorItem> {
    let query = http::params(&[
        ("pn", "1"),
        ("pz", "80"),
        ("po", if sort == "asc" { "0" } else { "1" }),
        ("np", "1"),
        ("fltt", "2"),
        ("invt", "2"),
        ("fid", "f3"),
        ("fs", "m:90+t:2"),
        ("fields", "f12,f14,f2,f3"),
    ]);
    let data = match http::eastmoney_get("/api/qt/clist/get", &query, PUSH_HOSTS).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[fund01] getSectorBoards 失败: {e}");
            return vec![];
        }
    };
    let mut list: Vec<SectorItem> = data
        .pointer("/data/diff")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|d| {
            let code = d.get("f12").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let name = d.get("f14").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let percent = d.get("f3").and_then(|v| v.as_f64());
            if code.is_empty() || percent.is_none() {
                None
            } else {
                Some(SectorItem { code, name, percent })
            }
        })
        .collect();
    list.sort_by(|a, b| {
        let cmp = a.percent.partial_cmp(&b.percent).unwrap_or(std::cmp::Ordering::Equal);
        if sort == "asc" {
            cmp
        } else {
            cmp.reverse()
        }
    });
    list.truncate(size);
    list
}

/// 涨跌家数（对应 getUpDownStats，emdatah5）
async fn get_up_down_stats() -> UpDownStats {
    let query = http::params(&[("type", "0")]);
    match http::http_get_json(
        "https://emdatah5.eastmoney.com/dc/NXFXB/GetUpDownData",
        &query,
        DESKTOP_UA,
        Some("https://emdatah5.eastmoney.com/"),
        Duration::from_secs(12),
    )
    .await
    {
        Ok(data) => {
            let row = data.as_array().and_then(|a| a.first()).cloned().unwrap_or(Value::Null);
            UpDownStats {
                up: row.get("up").and_then(|v| v.as_f64()).unwrap_or(0.0) as u32,
                down: row.get("down").and_then(|v| v.as_f64()).unwrap_or(0.0) as u32,
                flat: row.get("t").and_then(|v| v.as_f64()).unwrap_or(0.0) as u32,
                time: row.get("time").and_then(|v| v.as_str()).map(|s| s.to_string()),
            }
        }
        Err(e) => {
            eprintln!("[fund01] getUpDownStats 失败: {e}");
            UpDownStats::default()
        }
    }
}

/// 大盘总览（对应 getMarketOverview）
pub async fn get_market_overview() -> MarketOverview {
    let (up_down, top_gainers, top_losers) = futures::join!(
        get_up_down_stats(),
        get_sector_boards("desc", 10),
        get_sector_boards("asc", 10),
    );
    MarketOverview { up_down, top_gainers, top_losers }
}

// ----------------------------- 指数历史 K 线 -----------------------------

const RANGE_CALENDAR_DAYS: &[(&str, i64)] = &[("1m", 35), ("3m", 100), ("6m", 200), ("1y", 400), ("3y", 1200)];
const RANGE_FETCH_LIMIT: &[(&str, u32)] = &[("1m", 60), ("3m", 120), ("6m", 200), ("1y", 320), ("3y", 900)];

fn round4(n: f64) -> f64 {
    (n * 10000.0).round() / 10000.0
}

fn filter_by_range(points: &[(String, Option<f64>)], range: &str) -> Vec<(String, Option<f64>)> {
    let days = RANGE_CALENDAR_DAYS.iter().find(|(k, _)| *k == range).map(|(_, d)| *d).unwrap_or(35);
    let start = chrono::Local::now().date_naive() - chrono::Days::new(days as u64);
    let start_str = start.format("%Y-%m-%d").to_string();
    points.iter().filter(|(d, _)| d >= &start_str).cloned().collect()
}

fn with_period_percent(points: Vec<(String, Option<f64>)>) -> Vec<IndexHistoryPoint> {
    let base = points.first().and_then(|(_, c)| *c);
    points
        .into_iter()
        .map(|(date, close)| {
            let percent = base.filter(|b| b.is_finite() && *b != 0.0).map(|b| {
                round4((close.unwrap_or(0.0) - b) / b * 100.0)
            });
            IndexHistoryPoint { date, close: close.unwrap_or(0.0), percent }
        })
        .collect()
}

async fn fetch_tencent_daily(symbol: &str, limit: u32) -> Result<Vec<(String, Option<f64>)>, String> {
    let query = http::params(&[("param", &format!("{symbol},day,,,{limit},qfq"))]);
    let data = http::http_get_json(
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
        &query,
        DESKTOP_UA,
        Some("https://gu.qq.com/"),
        Duration::from_secs(15),
    )
    .await?;
    let key = data.get("data").and_then(|v| v.as_object()).and_then(|o| o.keys().next()).cloned().unwrap_or_default();
    let rows = data
        .pointer(&format!("/data/{key}/qfqday"))
        .and_then(|v| v.as_array())
        .or_else(|| data.pointer(&format!("/data/{key}/day")).and_then(|v| v.as_array()))
        .cloned()
        .unwrap_or_default();
    Ok(rows
        .iter()
        .filter_map(|r| {
            let date = r.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let close = r.get(2).and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
            if date.is_empty() || close.is_none() {
                None
            } else {
                Some((date, close))
            }
        })
        .collect())
}

async fn fetch_sina_cn_daily(symbol: &str, limit: u32) -> Result<Vec<(String, Option<f64>)>, String> {
    let query = http::params(&[("symbol", symbol), ("scale", "240"), ("ma", "no"), ("datalen", &limit.to_string())]);
    let data = http::http_get_json(
        "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData",
        &query,
        DESKTOP_UA,
        Some("https://finance.sina.com.cn/"),
        Duration::from_secs(15),
    )
    .await?;
    Ok(data
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| {
            let date = r.get("day").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let close = r.get("close").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
            if date.is_empty() || close.is_none() {
                None
            } else {
                Some((date, close))
            }
        })
        .collect())
}

async fn fetch_sina_us_daily(symbol: &str, limit: u32) -> Result<Vec<(String, Option<f64>)>, String> {
    let query = http::params(&[("symbol", symbol)]);
    let data = http::http_get_json(
        "https://stock.finance.sina.com.cn/usstock/api/json.php/US_MinKService.getDailyK",
        &query,
        DESKTOP_UA,
        Some("https://stock.finance.sina.com.cn/"),
        Duration::from_secs(20),
    )
    .await?;
    let mapped: Vec<(String, Option<f64>)> = data
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| {
            let date = r.get("d").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let close = r.get("c").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
            if date.is_empty() || close.is_none() {
                None
            } else {
                Some((date, close))
            }
        })
        .collect();
    Ok(mapped.into_iter().rev().take(limit as usize).collect())
}

/// 指数历史 K 线（对应 getIndexHistory，腾讯→新浪CN→新浪US 三级兜底）
pub async fn get_index_history(code: &str, range: &str) -> Result<IndexHistoryPayload, String> {
    let meta = find_index_meta(code).ok_or_else(|| format!("未知指数 {code}"))?;
    let key = if RANGE_CALENDAR_DAYS.iter().any(|(k, _)| *k == range) { range } else { "1m" };
    let limit = RANGE_FETCH_LIMIT.iter().find(|(k, _)| *k == key).map(|(_, l)| *l).unwrap_or(60);

    let mut points: Vec<(String, Option<f64>)> = Vec::new();
    if let Some(tx) = meta.tx {
        match fetch_tencent_daily(tx, limit).await {
            Ok(p) => points = p,
            Err(e) => eprintln!("[fund01] fetchTencentDaily 失败 tx={tx}: {e}"),
        }
    }
    if points.len() < 10 {
        if let Some(sina) = meta.sina {
            match fetch_sina_cn_daily(sina, limit).await {
                Ok(p) if p.len() > points.len() => points = p,
                Ok(_) => {}
                Err(e) => eprintln!("[fund01] fetchSinaCnDaily 失败 sina={sina}: {e}"),
            }
        }
    }
    if points.len() < 10 || key == "3y" {
        if let Some(sina_us) = meta.sina_us {
            match fetch_sina_us_daily(sina_us, limit).await {
                Ok(p) if p.len() > points.len() => points = p,
                Ok(_) => {}
                Err(e) => eprintln!("[fund01] fetchSinaUsDaily 失败 sinaUs={sina_us}: {e}"),
            }
        }
    }
    if points.is_empty() {
        return Err(format!("暂无 {} 历史行情", meta.name));
    }

    let filtered = with_period_percent(filter_by_range(&points, key));
    let first = filtered.first();
    let last = filtered.last();
    let period_percent = match (first, last) {
        (Some(f), Some(l)) if f.close.is_finite() && f.close != 0.0 => Some(round4((l.close - f.close) / f.close * 100.0)),
        _ => None,
    };

    Ok(IndexHistoryPayload {
        code: meta.code.to_string(),
        name: meta.name.to_string(),
        range: key.to_string(),
        period_percent,
        points: filtered,
    })
}
