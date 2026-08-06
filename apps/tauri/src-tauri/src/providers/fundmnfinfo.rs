//! FundMNFInfo 数据源（东方财富批量接口）—— 对应 fund.ts L824-1206 迁移。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::http::{self, DESKTOP_UA, MOBILE_UA};
use crate::model::{FundQuote, TrendPoint};
use crate::providers::{
    pad6, run_quotes_concurrent, eastmoney_fund_get, FundQuoteInput, QuoteProvider,
};

const MNFINFO_DEVICEID: &str = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

/// 批量拉取 FundMNFInfo（最多 200 个/次），返回 code → 原始 item
///
/// ⚠️ UA 必须是 MOBILE_UA：东财对 FundMNFInfo 接口拒绝桌面 UA 的脚本请求
/// （HTTP 200 + Success:false + ErrCode=61136403「网络繁忙」），手机 UA 放行。
/// 已用 curl 实测：同一 IP 下 DESKTOP_UA → 61136403，MOBILE_UA → Success:true。
/// 副作用：移动 UA 不返回 GSZ/GSZZL（盘中估算），空窗期/盘中靠自算估值兜底。
async fn fetch_fund_mnfinfo(codes: &[String]) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    for chunk in codes.chunks(200) {
        #[cfg(debug_assertions)]
        eprintln!("[fund01] FundMNFInfo 请求 chunk={} codes={}", chunk.len(), chunk.join(","));
        let query = http::params(&[
            ("pageIndex", "1"),
            ("pageSize", "200"),
            ("plat", "Android"),
            ("appType", "ttjj"),
            ("product", "EFund"),
            ("Version", "1"),
            ("deviceid", MNFINFO_DEVICEID),
            ("Fcodes", &chunk.join(",")),
        ]);
        let mut data: Option<Value> = None;
        for attempt in 0..2 {
            match http::http_get_json(
                "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo",
                &query,
                MOBILE_UA,
                Some("https://fund.eastmoney.com/"),
                Duration::from_secs(12),
            )
            .await
            {
                Ok(v) => {
                    // HTTP 200 ≠ 成功：东财业务层失败（Success=false）会静默返回空 Datas，
                    // 之前不检查导致"无数据且无日志"，这里必须显式打出来
                    let success = v.get("Success").and_then(|x| x.as_bool()).unwrap_or(false);
                    if !success {
                        let err_code = v.get("ErrCode").map(|x| x.to_string()).unwrap_or_default();
                        let err_msg = v.get("ErrMsg").and_then(|x| x.as_str()).unwrap_or("?");
                        eprintln!("[fund01] FundMNFInfo 业务失败 attempt={attempt} ErrCode={err_code} ErrMsg={err_msg}");
                    }
                    data = Some(v);
                    break;
                }
                Err(e) => {
                    if attempt == 1 {
                        eprintln!("[fund01] FundMNFInfo 批量拉取失败: {e}");
                    }
                    tokio::time::sleep(Duration::from_millis(400)).await;
                }
            }
        }
        if let Some(data) = data {
            if let Some(list) = data.get("Datas").and_then(|v| v.as_array()) {
                #[cfg(debug_assertions)]
                let mut hit = 0;
                for item in list {
                    let code = pad6(item.get("FCODE").and_then(|v| v.as_str()).unwrap_or(""));
                    if code.len() == 6 && code.chars().all(|c| c.is_ascii_digit()) {
                        out.insert(code, item.clone());
                        #[cfg(debug_assertions)]
                        {
                            hit += 1;
                        }
                    }
                }
                #[cfg(debug_assertions)]
                eprintln!("[fund01] FundMNFInfo 响应 Datas={} 有效命中={hit}", list.len());
            } else {
                eprintln!(
                    "[fund01] FundMNFInfo 响应无 Datas 字段（Success={}，原始前 120 字: {}）",
                    data.get("Success").map(|x| x.to_string()).unwrap_or_default(),
                    data.to_string().chars().take(120).collect::<String>()
                );
            }
        } else {
            eprintln!("[fund01] FundMNFInfo chunk 全部尝试失败（网络层）");
        }
    }
    #[cfg(debug_assertions)]
    eprintln!("[fund01] FundMNFInfo 总命中 {} / 请求 {}（唯一 code）", out.len(), codes.len());
    out
}

/// 解析单条 FundMNFInfo item（三态口径，对应 parseFundMNFInfoItem）
fn parse_fund_mnfinfo_item(item: &Value) -> ParsedMnf {
    let nav = item.get("NAV").and_then(|v| v.as_str()).unwrap_or("").parse::<f64>().ok();
    let nav_chg_rt = item.get("NAVCHGRT").and_then(|v| v.as_str()).unwrap_or("").parse::<f64>().ok();
    let gsz = item.get("GSZ").and_then(|v| v.as_str()).unwrap_or("").parse::<f64>().ok();
    let gszzl = item.get("GSZZL").and_then(|v| v.as_str()).unwrap_or("").parse::<f64>().ok();
    let pdate = item.get("PDATE").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let gztime = item.get("GZTIME").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let nav_valid = nav.is_some_and(|n| n > 0.0);
    let nav_chg_rt_valid = nav_chg_rt.is_some();
    let gsz_valid = gsz.is_some_and(|g| g > 0.0);

    let gztime_day = if gztime.len() >= 10 { gztime[..10].to_string() } else { String::new() };
    let has_replace = pdate != "--" && !pdate.is_empty() && !gztime_day.is_empty() && pdate == gztime_day;
    let estimate_stale = !gztime_day.is_empty() && !pdate.is_empty() && pdate != "--" && gztime_day < pdate;

    let now = chrono::Local::now();
    let mut parsed = ParsedMnf {
        name: item.get("SHORTNAME").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        confirmed: false,
        day_growth: None,
        estimate_growth: None,
        net_value: None,
        estimate_net_value: None,
        prev_net_value: None,
        net_value_date: String::new(),
        time: None,
        use_calc_needed: false,
    };

    if has_replace {
        // 当日净值已披露：今日 = NAV，昨日 = NAV / (1 + NAVCHGRT%)，涨幅 = NAVCHGRT
        parsed.confirmed = true;
        parsed.net_value = if nav_valid { nav } else { None };
        if nav_valid && nav_chg_rt_valid {
            parsed.prev_net_value = Some(round4(nav.unwrap() / (1.0 + nav_chg_rt.unwrap() / 100.0)));
        }
        parsed.day_growth = nav_chg_rt;
    } else if gsz_valid && !estimate_stale {
        // 盘中估算期：NAV = 昨日确认净值（基准），GSZ = 今日估算净值
        parsed.net_value = if nav_valid { nav } else { None };
        parsed.prev_net_value = parsed.net_value;
        parsed.estimate_net_value = gsz;
        parsed.estimate_growth = gszzl;
    } else {
        // 空窗期/估值过期：仅记录 netValue，标记 useCalcNeeded
        parsed.use_calc_needed = true;
        parsed.net_value = if nav_valid { nav } else { None };
    }

    parsed.net_value_date = if pdate.is_empty() || pdate == "--" {
        String::new()
    } else {
        crate::calendar::normalize_net_value_date(&pdate, &now)
    };
    parsed.time = if gztime.len() >= 16 {
        Some(gztime[11..16].to_string())
    } else {
        None
    };
    parsed
}

struct ParsedMnf {
    name: String,
    confirmed: bool,
    day_growth: Option<f64>,
    estimate_growth: Option<f64>,
    net_value: Option<f64>,
    estimate_net_value: Option<f64>,
    prev_net_value: Option<f64>,
    net_value_date: String,
    time: Option<String>,
    use_calc_needed: bool,
}

// ------------------------- 自算估值 (useCalc fallback) -------------------------

static HOLDINGS_CACHE: OnceLock<Mutex<HashMap<String, (Vec<Value>, Instant)>>> = OnceLock::new();
static CALC_GSZZL_CACHE: OnceLock<Mutex<HashMap<String, (f64, Instant)>>> = OnceLock::new();

const HOLDINGS_TTL: Duration = Duration::from_secs(60 * 60);
const CALC_GSZZL_TTL: Duration = Duration::from_secs(5 * 60);

async fn fetch_fund_top_holdings(code: &str) -> Vec<Value> {
    {
        let cache = HOLDINGS_CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
        if let Some((stocks, exp)) = cache.get(code) {
            if Instant::now() < *exp {
                return stocks.clone();
            }
        }
    }
    let data = match eastmoney_fund_get(
        "FundMNInverstPosition",
        &HashMap::from([("FCODE".to_string(), pad6(code))]),
    )
    .await
    {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let mut stocks = data.get("fundStocks").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    // 联接基金无直接持仓：取 ETFCODE 再查对应 ETF 的重仓股
    if stocks.is_empty() {
        if let Some(etf) = data.get("ETFCODE").and_then(|v| v.as_str()) {
            if let Ok(etf_data) = eastmoney_fund_get(
                "FundMNInverstPosition",
                &HashMap::from([("FCODE".to_string(), pad6(etf))]),
            )
            .await
            {
                stocks = etf_data.get("fundStocks").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            }
        }
    }
    let mut cache = HOLDINGS_CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
    cache.insert(code.to_string(), (stocks.clone(), Instant::now() + HOLDINGS_TTL));
    stocks
}

async fn fetch_stock_pct_changes(secids: &[String]) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    if secids.is_empty() {
        return out;
    }
    let query = http::params(&[
        ("fields", "f1,f2,f3,f4,f12,f13,f14,f292"),
        ("fltt", "2"),
        ("secids", &secids.join(",")),
    ]);
    let data = match http::http_get_json(
        "https://push2.eastmoney.com/api/qt/ulist.np/get",
        &query,
        DESKTOP_UA,
        Some("https://quote.eastmoney.com/"),
        Duration::from_secs(12),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[fund01] fetchStockPctChanges 失败: {e}");
            return out;
        }
    };
    if let Some(diff) = data.get("data").and_then(|d| d.get("diff")).and_then(|d| d.as_array()) {
        for row in diff {
            let f3 = row.get("f3").and_then(|v| v.as_f64()).or_else(|| {
                row.get("f3").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok())
            });
            let Some(pct) = f3.filter(|p| p.is_finite()) else { continue };
            let f12 = row.get("f12").and_then(|v| v.as_str()).unwrap_or("");
            let f13 = row.get("f13").and_then(|v| v.as_str()).unwrap_or("");
            if !f12.is_empty() {
                if !f13.is_empty() {
                    out.insert(format!("{f13}.{f12}"), pct);
                }
                out.insert(f12.to_string(), pct);
            }
        }
    }
    out
}

/// Σ(股票涨跌幅 × 该股占比 / 总占比)，对应 calcFundEstimateChange
fn calc_fund_estimate_change(stocks: &[Value], quote_by_secid: &HashMap<String, f64>) -> Option<f64> {
    let mut total_weight = 0.0f64;
    for s in stocks {
        let w = s.get("JZBL").and_then(|v| v.as_str()).unwrap_or("").parse::<f64>().ok();
        if w.is_some_and(|w| w > 0.0) {
            total_weight += w.unwrap();
        }
    }
    if total_weight <= 0.0 {
        return None;
    }
    let mut weighted = 0.0f64;
    let mut matched = 0u32;
    for s in stocks {
        let w = s.get("JZBL").and_then(|v| v.as_str()).unwrap_or("").parse::<f64>().ok();
        if !w.is_some_and(|w| w > 0.0) {
            continue;
        }
        let w = w.unwrap();
        let gpdm = s.get("GPDM").and_then(|v| v.as_str()).unwrap_or("");
        let newtexch = s.get("NEWTEXCH").and_then(|v| v.as_str()).unwrap_or("");
        let secid = if !newtexch.is_empty() && !gpdm.is_empty() {
            format!("{newtexch}.{gpdm}")
        } else {
            String::new()
        };
        let pct = if !secid.is_empty() {
            quote_by_secid.get(&secid).copied()
        } else {
            None
        };
        let pct = pct.or_else(|| {
            if gpdm.is_empty() {
                None
            } else {
                quote_by_secid.get(gpdm).copied()
            }
        });
        if let Some(pct) = pct.filter(|p| p.is_finite()) {
            weighted += (w / total_weight) * pct;
            matched += 1;
        }
    }
    if matched == 0 {
        return None;
    }
    Some(round2(weighted))
}

/// 自算估值主入口（对应 getCalcGszzl，缓存 5 分钟）
pub async fn get_calc_gszzl(code: &str) -> Option<f64> {
    let padded = pad6(code);
    {
        let cache = CALC_GSZZL_CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
        if let Some((v, exp)) = cache.get(&padded) {
            if Instant::now() < *exp {
                return Some(*v);
            }
        }
    }
    let stocks = fetch_fund_top_holdings(&padded).await;
    if stocks.is_empty() {
        return None;
    }
    let secids: Vec<String> = stocks
        .iter()
        .filter_map(|s| {
            let gpdm = s.get("GPDM").and_then(|v| v.as_str()).unwrap_or("");
            let newtexch = s.get("NEWTEXCH").and_then(|v| v.as_str()).unwrap_or("");
            if gpdm.is_empty() || newtexch.is_empty() {
                None
            } else {
                Some(format!("{newtexch}.{gpdm}"))
            }
        })
        .collect();
    if secids.is_empty() {
        return None;
    }
    let quote_map = fetch_stock_pct_changes(&secids).await;
    let value = calc_fund_estimate_change(&stocks, &quote_map);
    if let Some(v) = value {
        let mut cache = CALC_GSZZL_CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
        cache.insert(padded, (v, Instant::now() + CALC_GSZZL_TTL));
    }
    value
}

// ------------------------- Provider -------------------------

pub struct FundMNFInfoQuoteProvider;

impl QuoteProvider for FundMNFInfoQuoteProvider {
    async fn fetch_quotes(&self, funds: &[FundQuoteInput]) -> Vec<FundQuote> {
        if funds.is_empty() {
            return vec![];
        }
        let codes: Vec<String> = funds.iter().map(|f| pad6(&f.code)).collect();
        let info_map = fetch_fund_mnfinfo(&codes).await;
        run_quotes_concurrent(
            funds,
            {
                let info_map = info_map;
                move |f| {
                    let info_map = info_map.clone();
                    Box::pin(async move { fetch_one(&f, &info_map).await })
                }
            },
            4,
        )
        .await
    }
}

async fn fetch_one(fund: &FundQuoteInput, info_map: &HashMap<String, Value>) -> FundQuote {
    let code = pad6(&fund.code);
    let info = info_map.get(&code);

    let mut name = fund.name.clone().unwrap_or_default();
    let mut confirmed = false;
    let mut day_growth: Option<f64> = None;
    let mut estimate_growth: Option<f64> = None;
    let mut net_value: Option<f64> = None;
    let mut estimate_net_value: Option<f64> = None;
    let mut prev_net_value: Option<f64> = None;
    let mut net_value_date = String::new();
    let mut mnf_time: Option<String> = None;
    let mut use_calc_needed = false;
    // 板块（提前定义：黄金主题兜底需要它；后续板块推断在原位继续用同一变量）
    let mut sectors = fund.sectors.clone();

    if let Some(item) = info {
        let p = parse_fund_mnfinfo_item(item);
        if name.is_empty() {
            name = p.name;
        }
        confirmed = p.confirmed;
        day_growth = p.day_growth;
        estimate_growth = p.estimate_growth;
        net_value = p.net_value;
        estimate_net_value = p.estimate_net_value;
        prev_net_value = p.prev_net_value;
        net_value_date = p.net_value_date;
        mnf_time = p.time;
        use_calc_needed = p.use_calc_needed;
        eprintln!(
            "[fund01] FundMNFInfo 行情 code={code} name={name} confirmed={confirmed} day_growth={day_growth:?} est_growth={estimate_growth:?} est_net={estimate_net_value:?} net_value={net_value:?} prev_net={prev_net_value:?} date={net_value_date} time={mnf_time:?} use_calc_needed={use_calc_needed}"
        );
    } else {
        eprintln!(
            "[fund01] FundMNFInfo 无该基金行情 code={code} name={name} —— 批量接口未返回该 code（可能请求被业务拒绝或 code 不合法）"
        );
    }

    // FundMNFInfo 已批量提供行情，分时走势留空由前端懒加载
    let trend: Vec<TrendPoint> = vec![];

    // 展示口径直接按 API 确认标志（不走 resolveDisplayPercent）
    let mut percent: Option<f64> = None;
    let mut percent_source: Option<String> = None;
    if confirmed {
        if let Some(dg) = day_growth {
            percent = Some(dg);
            percent_source = Some("confirmed".to_string());
        }
    } else if let Some(eg) = estimate_growth {
        percent = Some(eg);
        percent_source = Some("estimate".to_string());
    }

    // 自算估值 fallback（空窗期/估值过期）
    let mut use_calc = false;
    if use_calc_needed && estimate_growth.is_none() && net_value.is_some_and(|n| n > 0.0) {
        if let Some(calc_gszzl) = get_calc_gszzl(&code).await {
            if calc_gszzl.is_finite() {
                let calc_gsz = round4(net_value.unwrap() * (1.0 + calc_gszzl / 100.0));
                estimate_growth = Some(calc_gszzl);
                estimate_net_value = Some(calc_gsz);
                percent = Some(calc_gszzl);
                percent_source = Some("estimate".to_string());
                use_calc = true;
                #[cfg(debug_assertions)]
                eprintln!("[fund01] FundMNFInfo 自算估值成功 code={code} calc_gszzl={calc_gszzl} calc_gsz={calc_gsz}");
            } else {
                eprintln!("[fund01] FundMNFInfo 自算估值非有限值 code={code} calc_gszzl={calc_gszzl}");
            }
        } else if is_gold_themed(&name, &sectors) {
            // 黄金主题基金兜底：黄金/上海金 ETF 联接无重仓股（FundMNInverstPosition
            // 返回 fundStocks 空且 ETFCODE=None），自算估值必然失败；
            // 用 AU9999 现货涨跌幅近似今日估值（联接基金跟踪上海金，走势一致）。
            if let Some(pct) = crate::gold::get_gold_percent_cached().await {
                if pct.is_finite() && pct.abs() < 30.0 {
                    let calc_gsz = round4(net_value.unwrap() * (1.0 + pct / 100.0));
                    estimate_growth = Some(pct);
                    estimate_net_value = Some(calc_gsz);
                    percent = Some(pct);
                    percent_source = Some("estimate".to_string());
                    use_calc = true;
                    eprintln!("[fund01] FundMNFInfo 黄金现货兜底估值成功 code={code} pct={pct} calc_gsz={calc_gsz}");
                } else {
                    eprintln!("[fund01] FundMNFInfo 黄金兜底估值异常值 code={code} pct={pct}");
                }
            } else {
                eprintln!("[fund01] FundMNFInfo 黄金兜底估值失败 code={code}（AU9999 行情不可用）");
            }
        } else {
            eprintln!("[fund01] FundMNFInfo 自算估值失败 code={code}（无重仓股/无股票行情/请求失败）");
        }
    }

    // 板块推断
    if crate::theme::sectors_need_refresh(&sectors, &name) {
        let next = crate::theme::fetch_fund_sectors_queued(&code, &name).await;
        if !next.is_empty() {
            sectors = next;
        }
    }

    FundQuote {
        code,
        name: if name.is_empty() { fund.code.clone() } else { name },
        fund_key: String::new(),
        day_growth,
        estimate_growth,
        percent,
        percent_source,
        net_value,
        estimate_net_value,
        prev_net_value,
        net_value_date,
        time: mnf_time,
        trend,
        sectors,
        use_calc: Some(use_calc),
        ..Default::default()
    }
}

// 供 fund123 provider 复用（getFundQuote 需要板块推断）
pub async fn refresh_sectors_if_needed(code: &str, name: &str, sectors: &[String]) -> Vec<String> {
    let mut out = sectors.to_vec();
    if crate::theme::sectors_need_refresh(&out, name) {
        let next = crate::theme::fetch_fund_sectors_queued(code, name).await;
        if !next.is_empty() {
            out = next;
        }
    }
    out
}

/// 黄金主题基金：名称含黄金/上海金/金ETF/贵金属，或板块含黄金/上海金。
/// 用于无盘中估值且无重仓股可自算时，用 AU9999 现货涨跌幅兜底估值。
fn is_gold_themed(name: &str, sectors: &[String]) -> bool {
    const KW: [&str; 4] = ["黄金", "上海金", "金ETF", "贵金属"];
    KW.iter().any(|k| name.contains(k) || sectors.iter().any(|s| s.contains(k)))
}

pub(crate) fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

pub(crate) fn round4(n: f64) -> f64 {
    (n * 10000.0).round() / 10000.0
}
