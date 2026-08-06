//! 黄金 AU9999 —— 对应 `packages/services/src/gold.ts` 迁移。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::Value;

use crate::circuit::{is_tripped, record_failure, record_success, CircuitOptions};
use crate::http::{self, DESKTOP_UA};
use crate::model::{GoldPayload, GoldTrendPoint};

const PUSH_HOSTS: &[&str] = &[
    "https://push2delay.eastmoney.com",
    "https://push2.eastmoney.com",
    "https://82.push2.eastmoney.com",
];

const TREND_HOSTS: &[&str] = &[
    "https://push2his.eastmoney.com",
    "https://push2delay.eastmoney.com",
    "https://push2.eastmoney.com",
];

const TREND_CIRCUIT_KEY: &str = "gold-trend";
const TREND_CIRCUIT_OPTS: CircuitOptions = CircuitOptions {
    max_failures: 3,
    cooldown: Duration::from_secs(5 * 60),
    label: "gold-trend",
};

struct GoldQuote {
    code: String,
    name: String,
    price: Option<f64>,
    prev_close: Option<f64>,
    change: Option<f64>,
    percent: Option<f64>,
    time: String,
}

fn parse_sina_gold(text: &str) -> Option<GoldQuote> {
    let re = Regex::new(r#"hq_str_gds_AU9999="([^"]*)""#).unwrap();
    let m = re.captures(text)?;
    let parts: Vec<&str> = m.get(1)?.as_str().split(',').collect();
    if parts.len() < 9 {
        return None;
    }
    let parse = |i: usize| parts.get(i).and_then(|s| s.parse::<f64>().ok());
    let price = parse(0);
    let time = parts.get(6).copied().unwrap_or("").to_string();
    let prev_close = parse(7);
    let date = parts.get(12).copied().unwrap_or("").to_string();
    let name = parts.get(13).copied().unwrap_or("AU9999").to_string();
    let percent = match (price, prev_close) {
        (Some(p), Some(pc)) if pc != 0.0 => Some((p - pc) / pc * 100.0),
        _ => None,
    };
    let change = match (price, prev_close) {
        (Some(p), Some(pc)) => Some(p - pc),
        _ => None,
    };
    Some(GoldQuote {
        code: "AU9999".to_string(),
        name: if name.contains('金') { "AU9999 沪金99".to_string() } else { "AU9999".to_string() },
        price: price.filter(|p| p.is_finite()),
        prev_close: prev_close.filter(|p| p.is_finite()),
        change: change.map(round4).filter(|c| c.is_finite()),
        percent: percent.map(round4).filter(|p| p.is_finite()),
        time: if date.is_empty() { time.clone() } else { format!("{date} {time}") },
    })
}

async fn fetch_sina_quote() -> Result<GoldQuote, String> {
    let buf = http::http_get_bytes(
        "https://hq.sinajs.cn/list=gds_AU9999",
        &HashMap::new(),
        DESKTOP_UA,
        Some("https://finance.sina.com.cn/"),
        Duration::from_secs(10),
    )
    .await?;
    let text = http::gbk_decode(&buf);
    parse_sina_gold(&text).ok_or_else(|| "解析 AU9999 行情失败".to_string())
}

async fn fetch_eastmoney_quote() -> Result<GoldQuote, String> {
    let query = http::params(&[
        ("secid", "118.AU9999"),
        ("fltt", "2"),
        ("fields", "f43,f44,f45,f46,f57,f58,f60,f169,f170,f171"),
    ]);
    let mut last_err: Option<String> = None;
    for host in PUSH_HOSTS {
        let url = format!("{host}/api/qt/stock/get");
        match http::http_get_json(
            &url,
            &query,
            DESKTOP_UA,
            Some("https://quote.eastmoney.com/"),
            Duration::from_secs(10),
        )
        .await
        {
            Ok(data) => {
                let d = data.get("data").cloned().unwrap_or(Value::Null);
                if d.get("f43").is_none() || d.get("f43").and_then(|v| v.as_f64()).is_none() {
                    continue;
                }
                let price = d.get("f43").and_then(|v| v.as_f64());
                let prev_close = d.get("f60").and_then(|v| v.as_f64());
                let change = match (price, prev_close) {
                    (Some(p), Some(pc)) => Some(p - pc),
                    _ => d.get("f169").and_then(|v| v.as_f64()),
                };
                let percent = match (price, prev_close) {
                    (Some(p), Some(pc)) if pc != 0.0 => Some((p - pc) / pc * 100.0),
                    _ => d.get("f170").and_then(|v| v.as_f64()),
                };
                let name = d.get("f58").and_then(|v| v.as_str()).unwrap_or("");
                return Ok(GoldQuote {
                    code: "AU9999".to_string(),
                    name: if name.is_empty() {
                        "AU9999 沪金99".to_string()
                    } else {
                        format!("AU9999 {name}")
                    },
                    price: price.filter(|p| p.is_finite()),
                    prev_close: prev_close.filter(|p| p.is_finite()),
                    change: change.map(round4).filter(|c| c.is_finite()),
                    percent: percent.map(round4).filter(|p| p.is_finite()),
                    time: String::new(),
                });
            }
            Err(e) => {
                last_err = Some(e.clone());
                eprintln!("[fund01] fetchEastmoneyQuote host={host} 失败: {e}");
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "东财 AU9999 行情失败".to_string()))
}

async fn fetch_quote() -> Result<GoldQuote, String> {
    match fetch_eastmoney_quote().await {
        Ok(q) => Ok(q),
        Err(e) => {
            eprintln!("[fund01] 东财黄金失败，切新浪: {e}");
            fetch_sina_quote().await
        }
    }
}

/// 走势（trends2 → jijinhao 兜底 + 熔断）
async fn fetch_trend(prev_close_hint: Option<f64>) -> Vec<GoldTrendPoint> {
    if is_tripped(TREND_CIRCUIT_KEY) {
        return vec![];
    }
    let mut points: Vec<GoldTrendPoint> = Vec::new();
    for host in TREND_HOSTS {
        let query = http::params(&[
            ("fields1", "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13"),
            ("fields2", "f51,f52,f53,f54,f55,f56,f57,f58"),
            ("ndays", "1"),
            ("iscr", "0"),
            ("secid", "118.AU9999"),
        ]);
        let url = format!("{host}/api/qt/stock/trends2/get");
        match http::http_get_json(
            &url,
            &query,
            DESKTOP_UA,
            Some("https://quote.eastmoney.com/"),
            Duration::from_secs(10),
        )
        .await
        {
            Ok(data) => {
                let trends = data.pointer("/data/trends").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                if trends.is_empty() {
                    continue;
                }
                let pre_close = data
                    .pointer("/data/preClosePrice")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<f64>().ok())
                    .or(prev_close_hint)
                    .unwrap_or(0.0);
                for line in &trends {
                    let Some(line) = line.as_str() else { continue };
                    let cols: Vec<&str> = line.split(',').collect();
                    if cols.len() < 3 {
                        continue;
                    }
                    let price = cols[2].parse::<f64>().ok();
                    let time = cols[0].split(' ').nth(1).unwrap_or(cols[0]).to_string();
                    let percent = price
                        .filter(|p| p.is_finite())
                        .zip(pre_close.is_finite().then_some(pre_close).filter(|p| *p != 0.0))
                        .map(|(p, pc)| round4((p - pc) / pc * 100.0));
                    if let Some(p) = price {
                        points.push(GoldTrendPoint { time, price: p, percent });
                    }
                }
                if !points.is_empty() {
                    break;
                }
            }
            Err(e) => eprintln!("[fund01] fetchTrend(eastmoney) host={host} 失败: {e}"),
        }
    }

    // jijinhao 兜底
    if points.is_empty() {
        let query = http::params(&[("code", "JO_71"), ("isCalc", "true")]);
        match http::http_get_text(
            "https://api.jijinhao.com/sQuoteCenter/todayMin.htm",
            &query,
            DESKTOP_UA,
            Some("https://quote.cngold.org/"),
            Duration::from_secs(10),
        )
        .await
        {
            Ok(text) => {
                let json_str = text.trim_start_matches("var hq_str_ml = ");
                if let Ok(json) = serde_json::from_str::<Value>(json_str) {
                    let base = prev_close_hint.filter(|p| *p > 0.0);
                    let items: Vec<GoldTrendPoint> = json
                        .get("data")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|x| {
                            let price_raw = x.get("price").and_then(|v| v.as_str()).unwrap_or("");
                            let price = price_raw.parse::<f64>().ok();
                            if price.is_none() || price == Some(-1.0) {
                                return None;
                            }
                            let price = Some(round2(price.unwrap()));
                            let time = x
                                .get("time")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                                .unwrap_or_default();
                            let percent = base.map(|b| round4((price.unwrap() - b) / b * 100.0));
                            Some(GoldTrendPoint { time, price: price.unwrap(), percent })
                        })
                        .collect();
                    if !items.is_empty() {
                        if items[0].percent.is_none() {
                            let first = items[0].price;
                            return finish_trend(items.iter().map(|p| GoldTrendPoint {
                                time: p.time.clone(),
                                price: p.price,
                                percent: if first != 0.0 { Some(round4((p.price - first) / first * 100.0)) } else { None },
                            }).collect());
                        }
                        return finish_trend(items);
                    }
                }
            }
            Err(e) => eprintln!("[fund01] fetchTrend(jijinhao) 失败: {e}"),
        }
    }

    finish_trend(points)
}

fn finish_trend(points: Vec<GoldTrendPoint>) -> Vec<GoldTrendPoint> {
    if points.is_empty() {
        record_failure(TREND_CIRCUIT_KEY, &TREND_CIRCUIT_OPTS);
    } else {
        record_success(TREND_CIRCUIT_KEY);
    }
    points
}

/// 黄金实时行情（对应 getGoldRealtime）
pub async fn get_gold_realtime(holding: f64, avg_price: f64) -> Result<GoldPayload, String> {
    let mut quote = fetch_quote().await?;
    let trend = fetch_trend(quote.prev_close).await;

    if (quote.percent.is_none() || quote.change.is_none()) && !trend.is_empty() {
        let last = trend.last().unwrap();
        if quote.price.is_none() {
            quote.price = Some(last.price);
        }
        if quote.percent.is_none() {
            quote.percent = last.percent;
        }
        if quote.change.is_none() && quote.price.is_some() && quote.prev_close.is_some() {
            quote.change = Some(round4(quote.price.unwrap() - quote.prev_close.unwrap()));
        }
    }

    let hold = holding;
    let avg = avg_price;

    let mut pnl: Option<f64> = None;
    if hold > 0.0 && quote.price.is_some() && quote.prev_close.is_some() {
        let delta = quote.price.unwrap() - quote.prev_close.unwrap();
        quote.change = Some(round4(delta));
        pnl = Some(round2(hold * delta));
    }

    let mut cost_pnl: Option<f64> = None;
    let mut cost_pnl_percent: Option<f64> = None;
    if hold > 0.0 && avg > 0.0 && quote.price.is_some() {
        let p = quote.price.unwrap();
        cost_pnl = Some(round2((p - avg) * hold));
        cost_pnl_percent = Some(round2((p - avg) / avg * 100.0));
    }

    Ok(GoldPayload {
        code: quote.code,
        name: quote.name,
        price: quote.price,
        prev_close: quote.prev_close,
        percent: quote.percent,
        change: quote.change,
        time: quote.time,
        holding: hold,
        avg_price: avg,
        pnl,
        pnl_percent: quote.percent.map(round2),
        cost_pnl,
        cost_pnl_percent,
        show: None,
        trend,
    })
}

fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

// ------------------------- 黄金涨跌幅缓存（基金估值兜底） -------------------------

static GOLD_PCT_CACHE: OnceLock<Mutex<Option<(f64, Instant)>>> = OnceLock::new();
const GOLD_PCT_TTL: Duration = Duration::from_secs(60);

/// AU9999 今日涨跌幅（%），带 60s 缓存。
/// 供黄金主题基金（黄金/上海金 ETF 联接等）在无盘中估值、无重仓股可自算时
/// 用黄金现货涨跌幅近似基金今日估值（联接基金跟踪上海金，与 AU9999 走势一致）。
/// 失败返回 None 且不缓存（下次再试）。
pub async fn get_gold_percent_cached() -> Option<f64> {
    {
        let cache = GOLD_PCT_CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap();
        if let Some((pct, exp)) = cache.as_ref() {
            if Instant::now() < *exp {
                return Some(*pct);
            }
        }
    }
    let pct = match fetch_quote().await {
        Ok(q) => q.percent,
        Err(e) => {
            eprintln!("[fund01] get_gold_percent 获取 AU9999 行情失败: {e}");
            None
        }
    };
    if let Some(p) = pct.filter(|p| p.is_finite()) {
        *GOLD_PCT_CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap() =
            Some((p, Instant::now() + GOLD_PCT_TTL));
        Some(p)
    } else {
        None
    }
}

fn round4(n: f64) -> f64 {
    (n * 10000.0).round() / 10000.0
}
