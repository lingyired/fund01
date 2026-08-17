//! FundMNFInfo 数据源（东方财富批量接口）—— 对应 fund.ts L824-1206 迁移。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::http::{self, MOBILE_UA};
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
        crate::dbg_log!("FundMNFInfo 请求 chunk={} codes={}", chunk.len(), chunk.join(","));
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
                        crate::err_log!("FundMNFInfo 业务失败 attempt={attempt} ErrCode={err_code} ErrMsg={err_msg}");
                    }
                    data = Some(v);
                    break;
                }
                Err(e) => {
                    if attempt == 1 {
                        crate::err_log!("FundMNFInfo 批量拉取失败: {e}");
                    }
                    tokio::time::sleep(Duration::from_millis(400)).await;
                }
            }
        }
        if let Some(data) = data {
            if let Some(list) = data.get("Datas").and_then(|v| v.as_array()) {
                let mut hit = 0;
                for item in list {
                    let code = pad6(item.get("FCODE").and_then(|v| v.as_str()).unwrap_or(""));
                    if code.len() == 6 && code.chars().all(|c| c.is_ascii_digit()) {
                        out.insert(code, item.clone());
                        hit += 1;
                    }
                }
                crate::dbg_log!("FundMNFInfo 响应 Datas={} 有效命中={hit}", list.len());
            } else {
                crate::err_log!(
                    "FundMNFInfo 响应无 Datas 字段（Success={}，原始前 120 字: {}）",
                    data.get("Success").map(|x| x.to_string()).unwrap_or_default(),
                    data.to_string().chars().take(120).collect::<String>()
                );
            }
        } else {
            crate::err_log!("FundMNFInfo chunk 全部尝试失败（网络层）");
        }
    }
    crate::dbg_log!("FundMNFInfo 总命中 {} / 请求 {}（唯一 code）", out.len(), codes.len());
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
    let now = chrono::Local::now();
    // has_replace：当日净值已披露（估值时间 == 净值日期）。
    // ⚠️ GZTIME 已对全部场外基金停返（实测恒 null，2026-08-07）→ 原判定恒 false，
    // confirmed 分支成为死代码（境内基金盘后不显官方净值、QDII 彻底裸奔）。
    // 替代判定：GZTIME 缺失时改用「确认会话」——
    //   - 境内（delayed=false）：PDATE 下一交易日开盘前（PDATE=今天 即当日已披露）
    //   - QDII（delayed=true，披露日窗口）：披露日 = PDATE 下一交易日 ≥ 今天 才算「今日已更新」
    //     （QDII T+1：今天披露昨天净值 → PDATE=今天-1 → 显示；PDATE=前天 = 昨天披露的 → 保持 `-`）
    let nav_qdii = crate::calendar::is_delayed_nav_fund(
        item.get("SHORTNAME").and_then(|v| v.as_str()).unwrap_or(""),
    );
    let has_replace = if !gztime_day.is_empty() {
        pdate != "--" && !pdate.is_empty() && pdate == gztime_day
    } else {
        let nav_day = crate::calendar::normalize_net_value_date(&pdate, &now);
        !nav_day.is_empty() && crate::calendar::is_confirmed_session_active(&nav_day, &now, nav_qdii)
    };
    crate::dbg_log!(
        "parse item code={} name={} pdate={} gztime_day={} qdii={} has_replace={}",
        item.get("FCODE").and_then(|v| v.as_str()).unwrap_or(""),
        item.get("SHORTNAME").and_then(|v| v.as_str()).unwrap_or(""),
        pdate,
        gztime_day,
        nav_qdii,
        has_replace
    );
    let estimate_stale = !gztime_day.is_empty() && !pdate.is_empty() && pdate != "--" && gztime_day < pdate;

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

/// 手动刷新（force）时清空自算估值缓存，强制下一次自算实时拉取行情，
/// 保证「点击刷新 = 点击时刻的最新估算值」。
/// 与 Chrome 端 clearFundEstimateCaches()（清 CALC_GSZZL_CACHE + STOCK_PCT_CACHE）对齐：
/// - Rust 端 fetch_stock_pct_changes 无缓存，故只需清 CALC_GSZZL_CACHE；
/// - HOLDINGS_CACHE（重仓股，1h TTL）保留：重仓股为慢变量，清空只会徒增请求。
pub fn clear_calc_caches() {
    if let Some(cache) = CALC_GSZZL_CACHE.get() {
        cache.lock().unwrap().clear();
    }
}

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
    // host 兜底链与 market::PUSH_HOSTS 一致（push2delay 优先，对应 JS fetchStockPctChanges 1:1）：
    // 东财 push2 主域名对无 cookie 的程序化请求常风控秒断（Empty reply，2026-08-17 实测），
    // push2delay（延迟行情）风控最松放第一。全部失败返回空 map，由 get_calc_gszzl 兜底
    // （merge_stale_estimate 恢复缓存估算，界面不感知）。
    let query = http::params(&[
        ("fields", "f2,f3,f4,f12,f13,f14"),
        ("fltt", "2"),
        ("secids", &secids.join(",")),
    ]);
    let data = match http::eastmoney_get("/api/qt/ulist.np/get", &query, crate::market::PUSH_HOSTS).await {
        Ok(v) => v,
        Err(e) => {
            crate::err_log!("fetchStockPctChanges 失败: {e}");
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

/// 历史净值对齐（P0-2）：取 FundMNHisNetList 对齐 netValue / dayGrowth / netValueDate，
/// 并按需填真实前一日净值 —— **禁止用 NAVCHGRT 两位涨幅反推**（有 4 元级系统误差，
/// 实测 040046 反推 8.303409 vs 真实 8.3030，持 10000 份收益额偏差 +4.09 元）。
/// `with_prev=true` 仅用于「确认会话（盘后）」场景；盘中/空窗不填 prev，
/// 避免 resolve_nav_pair 的兜底分支用滞后净值算出盘中收益。
/// 性能：本函数仅在自算估值失败（QDII / 黄金等无重仓股）或 QDII 盘后确认时调用，
/// 是少数基金按需单只拉取，不复用 FundMNFInfo 批量优势。
async fn fill_hist_aligned(
    code: &str,
    net_value: &mut Option<f64>,
    day_growth: &mut Option<f64>,
    prev_net_value: &mut Option<f64>,
    net_value_date: &mut String,
    with_prev: bool,
) {
    let Ok(hist) = crate::history::fetch_fund_nav_history(code, 5, 1).await else { return };
    if hist.is_empty() {
        return;
    }
    let now = chrono::Local::now();
    let nav_day = crate::calendar::normalize_net_value_date(net_value_date, &now);
    let idx = if nav_day.is_empty() {
        0
    } else {
        hist.iter().position(|h| h.date == nav_day).unwrap_or(0)
    };
    if let Some(r) = hist.get(idx) {
        if r.net_value.is_some() {
            *net_value = r.net_value;
        }
        if r.day_growth.is_some() {
            *day_growth = r.day_growth;
        }
        if !r.date.is_empty() {
            *net_value_date = r.date.clone();
        }
        if with_prev {
            if let Some(r1) = hist.get(idx + 1) {
                *prev_net_value = r1.net_value;
            }
        }
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
    let mut percent: Option<f64> = None;
    let mut percent_source: Option<String> = None;

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
        crate::dbg_log!(
            "FundMNFInfo 行情 code={code} name={name} confirmed={confirmed} day_growth={day_growth:?} est_growth={estimate_growth:?} est_net={estimate_net_value:?} net_value={net_value:?} prev_net={prev_net_value:?} date={net_value_date} {} time={mnf_time:?} use_calc_needed={use_calc_needed}",
            chrono::Local::now().format("%H:%M")
        );
    } else {
        crate::dbg_log!(
            "FundMNFInfo 无该基金行情 code={code} name={name} —— 批量接口未返回该 code（可能请求被业务拒绝或 code 不合法）"
        );
    }

    // FundMNFInfo 已批量提供行情，分时走势留空由前端懒加载
    let trend: Vec<TrendPoint> = vec![];

    let now = chrono::Local::now();
    let qdii = is_qdii_name(&name);
    let a_share_trading = crate::calendar::is_a_share_trading_time(&now);

    // 自算估值 fallback（空窗期/估值过期）——先于 percent 判定，
    // 因为它可能产出 estimate（自算/fund123 兜底）或 confirmed（QDII/黄金盘后历史净值）口径
    let mut use_calc = false;
    if use_calc_needed && estimate_growth.is_none() && net_value.is_some_and(|n| n > 0.0) {
        if qdii {
            // QDII：**跳过自算估值** —— 其重仓为美股，自算口径是「上一美股交易日」涨跌，
            // 在 A 股交易日会被误当成「今日」收益（用户反对点：15:30-20:00 空窗期把美股
            // 08-06 涨跌当今日）。严格走披露日窗口：东财披露 PDATE 更新后才 confirmed 显示，
            // 否则保持 `-`（且 fund123 无 QDII 分时估值、matiaria 昨日涨幅冒充今日，均不可用）。
            crate::dbg_log!(
                "FundMNFInfo 自算失败 code={code} name={name} —— QDII 跳过自算估值，严格按披露日窗口（PDATE={net_value_date} 今日未更新则当日收益保持 -）"
            );
        } else if let Some(calc_gszzl) = get_calc_gszzl(&code).await {
            if calc_gszzl.is_finite() {
                let calc_gsz = round4(net_value.unwrap() * (1.0 + calc_gszzl / 100.0));
                estimate_growth = Some(calc_gszzl);
                estimate_net_value = Some(calc_gsz);
                percent = Some(calc_gszzl);
                percent_source = Some("estimate".to_string());
                use_calc = true;
                crate::dbg_log!("FundMNFInfo 自算估值成功 code={code} calc_gszzl={calc_gszzl} calc_gsz={calc_gsz}");
            } else {
                crate::dbg_log!("FundMNFInfo 自算估值非有限值 code={code} calc_gszzl={calc_gszzl}");
            }
        } else {
            // 自算失败（无重仓股可加权：黄金/商品等）→ fallback fund123 官方分时估值
            match fund123_estimate_fallback(&code, fund).await {
                Some((eg, en)) => {
                    estimate_growth = Some(eg);
                    estimate_net_value = Some(en);
                    percent = Some(eg);
                    percent_source = Some("estimate".to_string());
                    use_calc = true;
                    crate::dbg_log!("FundMNFInfo 自算失败→fund123 兜底成功 code={code} growth={eg} est_net={en}");
                }
                None => {
                    // 黄金等：fund123 兜底亦不可用 → 历史净值对齐（盘后 confirmed 时填真实 prev）
                    fill_hist_aligned(
                        &code,
                        &mut net_value,
                        &mut day_growth,
                        &mut prev_net_value,
                        &mut net_value_date,
                        confirmed,
                    )
                    .await;
                    crate::dbg_log!("FundMNFInfo 自算估值失败 code={code}（无重仓股/无股票行情/请求失败，fund123 兜底亦不可用，改走历史净值对齐）");
                }
            }
        }
    } else if confirmed && qdii && !a_share_trading {
        // QDII 真正「当日」更新后（PDATE=今天，盘后）：parse 反推的 prev 有 4 元级
        // 系统误差，用历史净值取真实前一日净值对齐（P0-2，禁止用涨幅反推）。
        fill_hist_aligned(
            &code,
            &mut net_value,
            &mut day_growth,
            &mut prev_net_value,
            &mut net_value_date,
            true,
        )
        .await;
    }

    // 展示口径：confirmed（今日已披露）当日涨幅 = NAVCHGRT；
    // 其他时候（盘中估算 / QDII 今日无新披露）保持 percent=null → UI 渲染「-」灰色
    if confirmed {
        if let Some(dg) = day_growth {
            percent = Some(dg);
            percent_source = Some("confirmed".to_string());
        }
    } else if let Some(eg) = estimate_growth {
        percent = Some(eg);
        percent_source = Some("estimate".to_string());
    }
    crate::dbg_log!(
        "FundMNFInfo 展示 code={code} name={name} confirmed={confirmed} day_growth={day_growth:?} estimate_growth={estimate_growth:?} percent={percent:?} src={percent_source:?} use_calc={use_calc} net={net_value:?} prev={prev_net_value:?} date={net_value_date} {}",
        chrono::Local::now().format("%H:%M")
    );

    // 板块推断
    let mut sectors = fund.sectors.clone();
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
        is_qdii: Some(qdii),
        ..Default::default()
    }
}

/// QDII 基金名判断：证监会规定 QDII 基金名称必须含 "QDII"（兼容半角/全角括号）。
/// 用于自算估值失败时跳过 fund123 fallback —— fund123 对 QDII 无分时估值
/// （实测 queryFundEstimateIntraday 0 点），且其资料接口会把 T+1 披露的
/// 昨日涨幅冒充今日涨幅，混入会误导；QDII 的可靠估值只来自 FundMNFInfo
/// 链路（盘中 GSZ 正确；空窗期如实无估值，等 T+1 净值确认）。
pub(crate) fn is_qdii_name(name: &str) -> bool {
    name.to_uppercase().contains("QDII")
}

/// fund123 分时估值兜底：自算估值失败（无股票重仓）时，用该基金在蚂蚁基金的
/// 官方分时估值（queryFundEstimateIntraday 末点）补估算净值与涨幅。
/// 返回 (估算涨幅%, 估算净值)；fund_key 缺失时用 searchFund 补查；失败返回 None。
/// ⚠️ 仅限非 QDII 基金调用（QDII 由调用方用 is_qdii_name 过滤）。
/// ⚠️ 单向兜底（防循环）：本函数内部只调 fund123（searchFund / queryFundEstimateIntraday），
/// 不得再回调 FundMNFInfo 或触发其他数据源 fallback；每个基金最多走一次兜底。
async fn fund123_estimate_fallback(
    code: &str,
    fund: &FundQuoteInput,
) -> Option<(f64, f64)> {
    use crate::providers::fund123;
    // 1. 确保 fund_key（config 已存则直接用，否则 searchFund 补查）
    let mut fund_key = fund.fund_key.clone().unwrap_or_default();
    if fund_key.is_empty() {
        match fund123::search_fund(code).await {
            Ok(s) => fund_key = s.fund_key,
            Err(_) => return None,
        }
    }
    if fund_key.is_empty() {
        return None;
    }
    // 2. 拉分时估值，取末点
    match fund123::get_fund_estimate_intraday(&fund_key).await {
        Ok((_, Some(latest))) => {
            let growth = latest.growth?;
            let est_net = latest.net_value?;
            if growth.is_finite() && est_net.is_finite() && est_net > 0.0 && growth.abs() < 30.0 {
                Some((growth, est_net))
            } else {
                None
            }
        }
        _ => None,
    }
}

// 供 fund123 provider 复用（getFundQuote 需要板块推断）
pub async fn refresh_sectors_if_needed(code: &str, name: &str, sectors: &[String]) -> Vec<String> {    let mut out = sectors.to_vec();
    if crate::theme::sectors_need_refresh(&out, name) {
        let next = crate::theme::fetch_fund_sectors_queued(code, name).await;
        if !next.is_empty() {
            out = next;
        }
    }
    out
}

pub(crate) fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

pub(crate) fn round4(n: f64) -> f64 {
    (n * 10000.0).round() / 10000.0
}
