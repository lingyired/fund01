//! 指数 / 大盘 —— 对应 `packages/services/src/market.ts` 迁移。

use std::collections::HashMap;
use std::time::Duration;

use serde_json::Value;

use crate::http::{self, DESKTOP_UA};
use crate::model::{IndexHistoryPayload, IndexHistoryPoint, IndexItem};

/// 东财行情 host 兜底链（push2delay 延迟行情最稳，放第一；push2 主域名对无 cookie 请求常风控秒断）。
/// getIndices 与 fundmnfinfo::fetch_stock_pct_changes 共用，保证行情类请求有三级 host 保险。
pub(crate) const PUSH_HOSTS: &[&str] = &[
    "https://push2delay.eastmoney.com",
    "https://push2.eastmoney.com",
    "https://82.push2.eastmoney.com",
];

const KLINE_HOSTS: &[&str] = &[
    "https://push2his.eastmoney.com",
    "https://push2delay.eastmoney.com",
    "https://push2.eastmoney.com",
];

struct IndexMeta {
    secid: &'static str,
    code: &'static str,
    name: &'static str,
    tx: Option<&'static str>,
    sina: Option<&'static str>,
    sina_us: Option<&'static str>,
    /// 历史 K 线走东财 kline（如国内金 118.AU9999）
    em_kline: bool,
    /// 新浪外盘 symbol：实时走 hq.sinajs.cn、历史走 GlobalFuturesService（如伦敦金 XAU）
    sina_fx: Option<&'static str>,
}

const INDEX_LIST: &[IndexMeta] = &[
    IndexMeta { secid: "1.000001", code: "000001", name: "上证指数", tx: Some("sh000001"), sina: None, sina_us: None, em_kline: false, sina_fx: None },
    IndexMeta { secid: "0.399001", code: "399001", name: "深证成指", tx: Some("sz399001"), sina: None, sina_us: None, em_kline: false, sina_fx: None },
    IndexMeta { secid: "0.399006", code: "399006", name: "创业板指", tx: Some("sz399006"), sina: None, sina_us: None, em_kline: false, sina_fx: None },
    IndexMeta { secid: "0.899050", code: "899050", name: "北证50", tx: None, sina: Some("bj899050"), sina_us: None, em_kline: false, sina_fx: None },
    IndexMeta { secid: "1.000688", code: "000688", name: "科创50", tx: Some("sh000688"), sina: None, sina_us: None, em_kline: false, sina_fx: None },
    IndexMeta { secid: "1.000016", code: "000016", name: "上证50", tx: Some("sh000016"), sina: None, sina_us: None, em_kline: false, sina_fx: None },
    IndexMeta { secid: "1.000300", code: "000300", name: "沪深300", tx: Some("sh000300"), sina: None, sina_us: None, em_kline: false, sina_fx: None },
    IndexMeta { secid: "1.000905", code: "000905", name: "中证500", tx: Some("sh000905"), sina: None, sina_us: None, em_kline: false, sina_fx: None },
    IndexMeta { secid: "100.NDX", code: "NDX", name: "纳斯达克100", tx: Some("us.NDX"), sina: None, sina_us: Some(".NDX"), em_kline: false, sina_fx: None },
    IndexMeta { secid: "100.SPX", code: "SPX", name: "标普500", tx: Some("us.INX"), sina: None, sina_us: Some(".INX"), em_kline: false, sina_fx: None },
    // 黄金看板：国内金（上金所现货，元/克）实时+历史都走东财；国际金实时走东财 COMEX 主力（GC00Y，美元/盎司，
    // 不依赖 Referer——新浪 hq.sinajs.cn 强制校验 Referer，chrome SW fetch 无法携带自定义 Referer 头会 Forbidden），
    // 历史走新浪外盘日K（GlobalFuturesService 不依赖 Referer），实时与历史同为国际金价、趋势一致
    IndexMeta { secid: "118.AU9999", code: "AU9999", name: "黄金9999", tx: None, sina: None, sina_us: None, em_kline: true, sina_fx: None },
    IndexMeta { secid: "101.GC00Y", code: "XAU", name: "COMEX 黄金", tx: None, sina: None, sina_us: None, em_kline: false, sina_fx: Some("XAU") },
];

fn find_index_meta(code: &str) -> Option<&'static IndexMeta> {
    let key = code.trim();
    INDEX_LIST
        .iter()
        .find(|i| i.code == key || i.secid.ends_with(&format!(".{key}")))
}

/// 该指数 code 是否美股指数（NDX/SPX）
pub fn is_us_index_code(code: &str) -> bool {
    INDEX_LIST.iter().any(|i| i.sina_us.is_some() && i.code == code)
}

/// 把接口异常归类为简短错误码（http.rs 的 send 错误格式）
fn error_code_of(msg: &str) -> &'static str {
    if msg.starts_with("HTTP ") {
        "HTTP"
    } else if msg.contains("timed out") || msg.contains("timeout") || msg.contains("Timeout") {
        "TIMEOUT"
    } else if msg.contains("网络错误") || msg.contains("connect") || msg.contains("Connection") {
        "NET"
    } else {
        "PARSE"
    }
}

/// 仅 A 股指数（上证/深证/北证/科创等 + 黄金，排除美股 NDX/SPX）
pub async fn get_a_share_indices() -> Vec<IndexItem> {
    let list: Vec<&IndexMeta> = INDEX_LIST.iter().filter(|i| i.sina_us.is_none()).collect();
    fetch_indices(&list).await
}

/// 仅美股指数（NDX / SPX）
pub async fn get_us_indices() -> Vec<IndexItem> {
    let list: Vec<&IndexMeta> = INDEX_LIST.iter().filter(|i| i.sina_us.is_some()).collect();
    fetch_indices(&list).await
}

/// 全量指数（A 股 + 美股 + 黄金，一次批量请求）：
/// 供 fetch_indices「读时填充」——指数快照缺失（如非盘中启动、刷新循环尚未产出）
/// 时实时拉一次，保证 popup 初始即有默认 5 个指数的行情，不依赖刷新循环的时段窗口。
pub async fn get_all_indices() -> Vec<IndexItem> {
    let list: Vec<&IndexMeta> = INDEX_LIST.iter().collect();
    fetch_indices(&list).await
}

/// 拉取指数实时行情（条目级容错：接口整体失败/条目缺失不抛错，对应条目带 error 码，
/// 保证看板卡片始终能显示，数值处与底部展示错误状态）
async fn fetch_indices(list: &[&IndexMeta]) -> Vec<IndexItem> {
    let secids: Vec<String> = list.iter().map(|i| i.secid.to_string()).collect();
    let query = http::params(&[
        ("fltt", "2"),
        ("invt", "2"),
        ("fields", "f2,f3,f4,f12,f14"),
        ("secids", &secids.join(",")),
    ]);
    let data = match http::eastmoney_get("/api/qt/ulist.np/get", &query, PUSH_HOSTS).await {
        Ok(d) => d,
        Err(e) => {
            crate::err_log!("getIndices 失败: {e}");
            let code = error_code_of(&e).to_string();
            return list
                .iter()
                .map(|i| IndexItem {
                    code: i.code.to_string(),
                    name: i.name.to_string(),
                    percent: None,
                    price: None,
                    change: None,
                    error: Some(code.clone()),
                })
                .collect();
        }
    };
    let diff = data.pointer("/data/diff").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let by_code: HashMap<String, &Value> = diff
        .iter()
        .filter_map(|d| {
            d.get("f12")
                .and_then(|v| v.as_str())
                .map(|c| (c.to_string(), d))
        })
        .collect();
    list.iter()
        .map(|item| {
            // COMEX 黄金（XAU）以 GC00Y 代理，secid 匹配到行后沿用 INDEX_LIST 名称
            let row = by_code.get(item.code).copied().or_else(|| {
                by_code.get(item.secid.split('.').nth(1).unwrap_or("")).copied()
            });
            match row {
                Some(r) => {
                    let num = |k: &str| r.get(k).and_then(|v| v.as_f64());
                    IndexItem {
                        code: item.code.to_string(),
                        name: item.name.to_string(),
                        percent: num("f3"),
                        price: num("f2"),
                        change: num("f4"),
                        error: None,
                    }
                }
                None => IndexItem {
                    code: item.code.to_string(),
                    name: item.name.to_string(),
                    percent: None,
                    price: None,
                    change: None,
                    error: Some("NODATA".to_string()),
                },
            }
        })
        .collect()
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

/// 东财日K（klt=101，fqt=1 不复权）：国内金 118.AU9999 用
async fn fetch_eastmoney_daily(secid: &str, limit: u32) -> Result<Vec<(String, Option<f64>)>, String> {
    let query = http::params(&[
        ("secid", secid),
        ("klt", "101"),
        ("fqt", "1"),
        ("end", "20500101"),
        ("lmt", &limit.to_string()),
        ("fields1", "f1,f2,f3,f4,f5,f6"),
        ("fields2", "f51,f52,f53,f54,f55,f56,f57,f58"),
    ]);
    let mut last_err: Option<String> = None;
    for host in KLINE_HOSTS {
        match http::http_get_json(
            &format!("{host}/api/qt/stock/kline/get"),
            &query,
            DESKTOP_UA,
            Some("https://quote.eastmoney.com/"),
            Duration::from_secs(12),
        )
        .await
        {
            Ok(data) => {
                let klines = data.pointer("/data/klines").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                let points: Vec<(String, Option<f64>)> = klines
                    .iter()
                    .filter_map(|k| {
                        let s = k.as_str()?;
                        let mut it = s.split(',');
                        let date = it.next()?.to_string();
                        let _ = it.next(); // open
                        let close = it.next().and_then(|c| c.parse::<f64>().ok());
                        if date.is_empty() || close.is_none() {
                            None
                        } else {
                            Some((date, close))
                        }
                    })
                    .collect();
                if !points.is_empty() {
                    return Ok(points);
                }
            }
            Err(e) => {
                last_err = Some(format!("{host}: {e}"));
                crate::err_log!("fetchEastmoneyDaily 失败 {last_err:?}");
            }
        }
    }
    Err(last_err.unwrap_or_else(|| format!("东财 {secid} K线失败")))
}

/// 新浪外盘日K（GlobalFuturesService，JSONP）：伦敦金 XAU 用，返回升序取末 limit 条
async fn fetch_sina_fx_daily(symbol: &str, limit: u32) -> Result<Vec<(String, Option<f64>)>, String> {
    let text = http::http_get_text(
        "https://stock.finance.sina.com.cn/futures/api/jsonp.php/var%20gc=/GlobalFuturesService.getGlobalFuturesDailyKLine",
        &http::params(&[("symbol", symbol)]),
        DESKTOP_UA,
        Some("https://finance.sina.com.cn/"),
        Duration::from_secs(15),
    )
    .await?;
    let start = text.find('[').ok_or_else(|| "新浪外盘 K 线响应异常".to_string())?;
    let end = text.rfind(']').ok_or_else(|| "新浪外盘 K 线响应异常".to_string())?;
    let v: Value = serde_json::from_str(&text[start..=end]).map_err(|e| format!("新浪外盘 K 线解析失败: {e}"))?;
    let arr = v.as_array().cloned().unwrap_or_default();
    let mut points: Vec<(String, Option<f64>)> = arr
        .iter()
        .filter_map(|r| {
            let date = r.get("date").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let close = r.get("close").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
            if date.is_empty() || close.is_none() {
                None
            } else {
                Some((date, close))
            }
        })
        .collect();
    let n = points.len();
    if n > limit as usize {
        points.drain(0..(n - limit as usize));
    }
    Ok(points)
}

/// 指数历史 K 线（对应 getIndexHistory，腾讯→新浪CN→新浪US→东财/新浪外盘 兜底）
pub async fn get_index_history(code: &str, range: &str) -> Result<IndexHistoryPayload, String> {
    let meta = find_index_meta(code).ok_or_else(|| format!("未知指数 {code}"))?;
    let key = if RANGE_CALENDAR_DAYS.iter().any(|(k, _)| *k == range) { range } else { "1m" };
    let limit = RANGE_FETCH_LIMIT.iter().find(|(k, _)| *k == key).map(|(_, l)| *l).unwrap_or(60);

    let mut points: Vec<(String, Option<f64>)> = Vec::new();
    if let Some(tx) = meta.tx {
        match fetch_tencent_daily(tx, limit).await {
            Ok(p) => points = p,
            Err(e) => crate::err_log!("fetchTencentDaily 失败 tx={tx}: {e}"),
        }
    }
    if points.len() < 10 {
        if let Some(sina) = meta.sina {
            match fetch_sina_cn_daily(sina, limit).await {
                Ok(p) if p.len() > points.len() => points = p,
                Ok(_) => {}
                Err(e) => crate::err_log!("fetchSinaCnDaily 失败 sina={sina}: {e}"),
            }
        }
    }
    if points.len() < 10 || key == "3y" {
        if let Some(sina_us) = meta.sina_us {
            match fetch_sina_us_daily(sina_us, limit).await {
                Ok(p) if p.len() > points.len() => points = p,
                Ok(_) => {}
                Err(e) => crate::err_log!("fetchSinaUsDaily 失败 sinaUs={sina_us}: {e}"),
            }
        }
    }
    // 黄金看板：国内金（AU9999）走东财日K，国际金（伦敦金）走新浪外盘日K
    if points.len() < 10 && meta.em_kline {
        match fetch_eastmoney_daily(meta.secid, limit).await {
            Ok(p) => points = p,
            Err(e) => crate::err_log!("fetchEastmoneyDaily 失败 secid={}: {e}", meta.secid),
        }
    }
    if points.len() < 10 {
        if let Some(fx) = meta.sina_fx {
            match fetch_sina_fx_daily(fx, limit).await {
                Ok(p) if p.len() > points.len() => points = p,
                Ok(_) => {}
                Err(e) => crate::err_log!("fetchSinaFxDaily 失败 symbol={fx}: {e}"),
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
