//! 行情 provider 抽象 —— 对应 `packages/services/src/fund.ts` 的 FundQuoteProvider。
//! fundmnfinfo（东方财富批量）、fund123（蚂蚁基金 CSRF）、xiaobei（小倍养基）三个实现。

pub mod fund123;
pub mod fundmnfinfo;
pub mod xiaobei;

use std::collections::HashMap;
use std::time::Duration;

use serde_json::Value;

use crate::http::{self, MOBILE_UA};
use crate::model::FundQuote;

/// provider 输入（对应 FundQuoteInput）
#[derive(Debug, Clone, Default)]
pub struct FundQuoteInput {
    pub code: String,
    pub fund_key: Option<String>,
    pub name: Option<String>,
    pub sectors: Vec<String>,
}

/// 行情源标识
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteSource {
    Fund123,
    FundMnfinfo,
    Xiaobei,
}

impl QuoteSource {
    pub fn from_str(s: &str) -> QuoteSource {
        match s {
            "fund123" => QuoteSource::Fund123,
            "xiaobei" => QuoteSource::Xiaobei,
            _ => QuoteSource::FundMnfinfo,
        }
    }
}

pub trait QuoteProvider {
    async fn fetch_quotes(&self, funds: &[FundQuoteInput]) -> Vec<FundQuote>;
}

/// 具体 provider 分发（avoid dyn；async fn in trait 不 dyn-compatible）
pub enum AnyProvider {
    Fund123(fund123::Fund123QuoteProvider),
    Mnf(fundmnfinfo::FundMNFInfoQuoteProvider),
    Xiaobei(xiaobei::XiaobeiQuoteProvider),
}

impl AnyProvider {
    pub async fn fetch_quotes(&self, funds: &[FundQuoteInput]) -> Vec<FundQuote> {
        match self {
            AnyProvider::Fund123(p) => p.fetch_quotes(funds).await,
            AnyProvider::Mnf(p) => p.fetch_quotes(funds).await,
            AnyProvider::Xiaobei(p) => p.fetch_quotes(funds).await,
        }
    }
}

pub fn get_quote_provider(source: QuoteSource) -> AnyProvider {
    match source {
        QuoteSource::Fund123 => AnyProvider::Fund123(fund123::Fund123QuoteProvider),
        QuoteSource::FundMnfinfo => AnyProvider::Mnf(fundmnfinfo::FundMNFInfoQuoteProvider),
        QuoteSource::Xiaobei => AnyProvider::Xiaobei(xiaobei::XiaobeiQuoteProvider),
    }
}

/// 补零到 6 位基金代码
pub fn pad6(code: &str) -> String {
    let c = code.trim();
    if c.len() >= 6 {
        c.to_string()
    } else {
        format!("{:0>6}", c)
    }
}

/// 通用并发执行器：把 per-fund 任务按 concurrency 并发，保持输入顺序
pub async fn run_quotes_concurrent(
    funds: &[FundQuoteInput],
    worker: impl Fn(FundQuoteInput) -> std::pin::Pin<Box<dyn std::future::Future<Output = FundQuote> + Send>>,
    concurrency: usize,
) -> Vec<FundQuote> {
    let mut results = Vec::with_capacity(funds.len());
    let cc = concurrency.max(1);
    for chunk in funds.chunks(cc) {
        let futs: Vec<_> = chunk.iter().map(|f| worker(f.clone())).collect();
        let settled = futures::future::join_all(futs).await;
        results.extend(settled);
    }
    results
}

/// 东财 fundmobapi 公共请求（对应 eastmoneyFundGet）：
/// MOBILE_UA + 固定参数 + 3 次指数退避重试，返回 Datas 数组
pub async fn eastmoney_fund_get(path: &str, extra: &HashMap<String, String>) -> Result<Value, String> {
    let mut p = http::params(&[
        ("deviceid", "Wap"),
        ("plat", "Wap"),
        ("product", "EFund"),
        ("version", "2.0.0"),
        ("appType", "ttjj"),
    ]);
    for (k, v) in extra {
        p.insert(k.clone(), v.clone());
    }
    let url = format!("https://fundmobapi.eastmoney.com/FundMNewApi/{path}");
    let result = http::retry_3(
        {
            let url = url.clone();
            let p = p.clone();
            move || {
                let url = url.clone();
                let p = p.clone();
                Box::pin(async move {
                    let data = http::http_get_json(
                        &url,
                        &p,
                        MOBILE_UA,
                        Some("https://fund.eastmoney.com/"),
                        Duration::from_secs(12),
                    )
                    .await?;
                    if data.get("Success").and_then(|v| v.as_bool()).unwrap_or(false) {
                        Ok(data.get("Datas").cloned().unwrap_or(Value::Array(vec![])))
                    } else {
                        Err(data
                            .get("ErrMsg")
                            .and_then(|v| v.as_str())
                            .unwrap_or("接口暂不可用")
                            .to_string())
                    }
                })
            }
        },
        &format!("fundmobapi {path}"),
    )
    .await?;
    Ok(result)
}
