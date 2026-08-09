//! 历史净值 / 解析基金 —— 对应 fund.ts 的 fetchFundNavHistory / getFundHistory / resolveFund 迁移。

use std::collections::HashMap;

use serde_json::Value;

use crate::calendar::confirmed_session_active_now;
use crate::fundname::{is_loose_same_fund_name, is_same_fund_name, pick_fund_by_name, loose_fund_name};
use crate::model::{FundHistoryPayload, FundHistoryPoint, NameMismatch, ResolveFundPayload, CodeCorrected};
use crate::providers::fund123::{search_fund, search_funds_by_keyword};
use crate::providers::{eastmoney_fund_get, pad6};

pub struct HistRow {
    pub date: String,
    pub net_value: Option<f64>,
    pub day_growth: Option<f64>,
}

fn round4(n: f64) -> f64 {
    (n * 10000.0).round() / 10000.0
}

fn map_his_net_rows(list: &Value) -> Vec<HistRow> {
    let Some(rows) = list.as_array() else { return vec![] };
    rows.iter()
        .filter_map(|r| {
            let net_value = r.get("DWJZ").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
            let day_growth = r.get("JZZZL").and_then(|v| v.as_str()).and_then(|s| {
                let s = s.replace('%', "");
                if s.is_empty() || s == "--" {
                    None
                } else {
                    s.parse::<f64>().ok().filter(|n| n.is_finite())
                }
            });
            let date = r.get("FSRQ").and_then(|v| v.as_str()).map(|s| {
                crate::calendar::normalize_net_value_date(s, &chrono::Local::now())
            }).unwrap_or_default();
            if net_value.is_some_and(|n| n.is_finite()) && !date.is_empty() {
                Some(HistRow { date, net_value, day_growth })
            } else {
                None
            }
        })
        .collect()
}

/// 分页拉历史净值（对应 fetchFundNavHistory）
pub async fn fetch_fund_nav_history(code: &str, page_size: u32, page_index: u32) -> Result<Vec<HistRow>, String> {
    let data = eastmoney_fund_get(
        "FundMNHisNetList",
        &HashMap::from([
            ("FCODE".to_string(), pad6(code)),
            ("pageIndex".to_string(), page_index.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ]),
    )
    .await?;
    Ok(map_his_net_rows(&data))
}

/// 分页拉取（对应 fetchFundNavHistoryPaged）
async fn fetch_fund_nav_history_paged(
    code: &str,
    page_size: u32,
    max_pages: u32,
    min_count: usize,
) -> Vec<HistRow> {
    let mut all: Vec<HistRow> = Vec::new();
    for page_index in 1..=max_pages {
        let rows = fetch_fund_nav_history(code, page_size, page_index).await.unwrap_or_default();
        if rows.is_empty() {
            break;
        }
        let before = all.len();
        all.extend(rows);
        if all.len() - before < page_size as usize {
            break;
        }
        if min_count > 0 && all.len() >= min_count {
            break;
        }
    }
    all
}

fn filter_fund_nav_by_range(rows_asc: Vec<HistRow>, range: &str) -> Vec<HistRow> {
    let days: Option<i64> = match range {
        "3m" => Some(100),
        "1y" => Some(400),
        "3y" => Some(1200),
        "since" => None,
        _ => Some(100),
    };
    let Some(days) = days else { return rows_asc };
    let start = chrono::Local::now().date_naive() - chrono::Days::new(days as u64);
    let start_str = start.format("%Y-%m-%d").to_string();
    rows_asc.into_iter().filter(|p| p.date >= start_str).collect()
}

/// 降采样：点数超过 max 时按比例均匀抽取（保留首尾），控制序列化体积与前端渲染量。
/// 对应 TS 侧 downsamplePoints；since 成立以来一次最多拉 2 万点，需收敛到 1200 点。
fn downsample<T: Clone>(points: &[T], max: usize) -> Vec<T> {
    if points.len() <= max {
        return points.to_vec();
    }
    let step = (points.len() - 1) as f64 / (max - 1) as f64;
    (0..max).map(|i| points[(i as f64 * step).round() as usize].clone()).collect()
}

/// 基金历史净值（对应 getFundHistory）
pub async fn get_fund_history(code: &str, range: &str) -> Result<FundHistoryPayload, String> {
    let padded = pad6(code);
    let key = match range {
        "since" | "3y" | "1y" | "3m" => range,
        _ => "3m",
    };
    let desc = match key {
        // min_count 提前退出：成立以来的净值大多 2000-5000 行，4-10 页即可拿全量，
        // 老基金才需要继续翻页，避免所有基金都串行拉满 40 页
        "since" => fetch_fund_nav_history_paged(&padded, 500, 40, 2000).await,
        "3y" => fetch_fund_nav_history_paged(&padded, 500, 3, 900).await,
        "1y" => fetch_fund_nav_history(&padded, 320, 1).await.unwrap_or_default(),
        _ => fetch_fund_nav_history(&padded, 120, 1).await.unwrap_or_default(),
    };
    if desc.is_empty() {
        return Err(format!("暂无基金 {padded} 历史净值"));
    }
    let mut asc = desc;
    asc.reverse();
    let asc = filter_fund_nav_by_range(asc, key);
    if asc.is_empty() {
        return Err("暂无该周期净值数据".to_string());
    }
    let base = asc[0].net_value;
    let points: Vec<FundHistoryPoint> = downsample(
        &asc
            .iter()
            .map(|p| FundHistoryPoint {
                date: p.date.clone(),
                net_value: p.net_value.unwrap_or(0.0),
                percent: base.filter(|b| b.is_finite()).map(|b| round4((p.net_value.unwrap_or(0.0) - b) / b * 100.0)),
            })
            .collect::<Vec<_>>(),
        1200,
    );
    let period_percent = points.last().and_then(|l| l.percent);
    Ok(FundHistoryPayload {
        code: padded,
        range: key.to_string(),
        period_percent,
        points,
    })
}

// ----------------------------- resolveFund -----------------------------

/// 代码 ↔ 名称交叉验证（对应 verifyCodeByName，宁缺毋滥）
async fn verify_code_by_name(
    code: &str,
    official_names: &[String],
    input_name: Option<&str>,
) -> Result<VerifyResult, String> {
    let input = input_name.unwrap_or("").trim().to_string();
    if input.is_empty() {
        return Ok(VerifyResult { code: code.to_string(), name_mismatch: None, code_corrected: None });
    }
    let match_any = official_names.iter().any(|n| {
        !n.is_empty() && (is_same_fund_name(Some(&input), Some(n)) || is_loose_same_fund_name(Some(&input), Some(n)))
    });
    if match_any {
        return Ok(VerifyResult { code: code.to_string(), name_mismatch: None, code_corrected: None });
    }

    // 用关键词搜索并校验
    async fn search_and_verify(
        keyword: &str,
        code: &str,
        input: &str,
        official_names: &[String],
    ) -> Option<VerifyStep> {
        if keyword.is_empty() {
            return None;
        }
        let candidates = search_funds_by_keyword(keyword).await;
        if candidates.iter().any(|(c, _)| c == code) {
            return Some(VerifyStep::Ok);
        }
        if let Some(((hit_code, hit_name), matched_by)) = pick_fund_by_name(&candidates, Some(input)) {
            if hit_code != code {
                return Some(VerifyStep::Corrected(CodeCorrected {
                    from: code.to_string(),
                    to: hit_code,
                    from_name: official_names.iter().find(|n| !n.is_empty()).cloned().unwrap_or_default(),
                    to_name: hit_name,
                    matched_by: matched_by.to_string(),
                }));
            }
        }
        None
    }

    // 1) 原始名
    if let Some(step) = search_and_verify(&input, code, &input, official_names).await {
        return Ok(match step {
            VerifyStep::Ok => VerifyResult { code: code.to_string(), name_mismatch: None, code_corrected: None },
            VerifyStep::Corrected(c) => VerifyResult { code: c.to.clone(), name_mismatch: None, code_corrected: Some(c) },
        });
    }
    // 2) 宽松名兜底
    let loose = loose_fund_name(Some(&input));
    if loose.chars().count() >= 4 {
        if let Some(step) = search_and_verify(&loose, code, &input, official_names).await {
            return Ok(match step {
                VerifyStep::Ok => VerifyResult { code: code.to_string(), name_mismatch: None, code_corrected: None },
                VerifyStep::Corrected(c) => VerifyResult { code: c.to.clone(), name_mismatch: None, code_corrected: Some(c) },
            });
        }
    }

    let officials = official_names.iter().filter(|n| !n.is_empty()).cloned().collect();
    Ok(VerifyResult {
        code: code.to_string(),
        name_mismatch: Some(NameMismatch { input, officials }),
        code_corrected: None,
    })
}

enum VerifyStep {
    Ok,
    Corrected(CodeCorrected),
}

struct VerifyResult {
    code: String,
    name_mismatch: Option<NameMismatch>,
    code_corrected: Option<CodeCorrected>,
}

/// 解析基金（对应 resolveFund）
pub async fn resolve_fund(payload: &crate::model::ResolveFundRequest) -> Result<ResolveFundPayload, String> {
    let mut code = payload.code.trim().to_string();
    let mut meta: Option<SearchMeta> = None;
    match search_fund(&code).await {
        Ok(s) => {
            meta = Some(SearchMeta {
                code: s.code.clone(),
                name: s.name,
                fund_key: s.fund_key,
            });
        }
        Err(e) => {
            eprintln!("[fund01] resolveFund searchFund 失败: {e}");
            if payload.name.is_none() {
                return Err(e);
            }
        }
    }

    let mut name_mismatch: Option<NameMismatch> = None;
    let mut code_corrected: Option<CodeCorrected> = None;

    // 收集多平台权威名
    async fn collect_official_names(meta_name: Option<&str>, c: &str) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        if let Some(n) = meta_name.filter(|n| !n.is_empty()) {
            names.push(n.to_string());
        }
        let padded = pad6(c);
        if let Ok(data) = eastmoney_fund_get(
            "FundMNFInfo",
            &HashMap::from([("Fcodes".to_string(), padded.clone())]),
        )
        .await
        {
            if let Some(list) = data.as_array() {
                if let Some(item) = list.first() {
                    if let Some(sn) = item.get("SHORTNAME").and_then(|v| v.as_str()) {
                        names.push(sn.to_string());
                    }
                }
            }
        }
        names
    }

    let meta_code = meta.as_ref().map(|m| m.code.clone()).unwrap_or_else(|| code.clone());
    if payload.name.is_some() {
        let official_names = collect_official_names(meta.as_ref().map(|m| m.name.as_str()), &meta_code).await;
        let verified = verify_code_by_name(&meta_code, &official_names, payload.name.as_deref()).await?;
        name_mismatch = verified.name_mismatch;
        code_corrected = verified.code_corrected;
        if verified.code != meta_code {
            code = verified.code.clone();
            match search_fund(&code).await {
                Ok(s) => {
                    meta = Some(SearchMeta {
                        code: s.code,
                        name: s.name,
                        fund_key: s.fund_key,
                    });
                }
                Err(e) => eprintln!("[fund01] resolveFund 纠正代码后重查失败: {e}"),
            }
        }
    }
    let official_name = meta.as_ref().map(|m| m.name.clone()).unwrap_or_default();

    let mut sectors: Vec<String> = payload.sectors.clone().unwrap_or_default();
    if sectors.is_empty() {
        sectors = crate::theme::fetch_fund_sectors_queued(&meta_code, &official_name).await;
    }

    let mut net_value: Option<f64> = None;
    let mut prev_net_value: Option<f64> = None;
    let mut prev_net_value_date = String::new();
    let mut net_value_date = String::new();
    if payload.fund_type.as_deref().unwrap_or("watch") == "hold" {
        let hist_code = meta.as_ref().map(|m| m.code.clone()).unwrap_or_else(|| code.clone());
        if let Ok(hist) = fetch_fund_nav_history(&hist_code, 5, 1).await {
            if !hist.is_empty() {
                net_value = hist[0].net_value;
                net_value_date = hist[0].date.clone();
                if let Some(h1) = hist.get(1) {
                    prev_net_value = h1.net_value;
                    prev_net_value_date = h1.date.clone();
                }
            }
        }
    }

    let confirmed_session = if net_value_date.is_empty() {
        None
    } else {
        // 与抓取侧 has_replace 同语义：境内标准窗口；QDII 走 delayed 分支
        // （锚点 = 披露日 = PDATE 下一交易日，保留到披露日的下一交易日开盘前）
        let delayed = crate::providers::fundmnfinfo::is_qdii_name(&official_name);
        confirmed_session_active_now(&net_value_date, delayed).then_some(true)
    };

    Ok(ResolveFundPayload {
        code: meta.as_ref().map(|m| m.code.clone()).unwrap_or_else(|| code.clone()),
        name: if !official_name.is_empty() { official_name.clone() } else { payload.name.clone().unwrap_or_else(|| code.clone()) },
        fund_key: meta.as_ref().map(|m| m.fund_key.clone()).unwrap_or_default(),
        sectors,
        net_value,
        prev_net_value,
        prev_net_value_date: if prev_net_value_date.is_empty() { None } else { Some(prev_net_value_date) },
        net_value_date: if net_value_date.is_empty() { None } else { Some(net_value_date) },
        confirmed_session,
        official_name: if official_name.is_empty() { None } else { Some(official_name) },
        name_mismatch,
        code_corrected,
    })
}

struct SearchMeta {
    code: String,
    name: String,
    fund_key: String,
}
