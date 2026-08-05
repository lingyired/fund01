//! HTTP 封装 —— 对应 `packages/services/src/http.ts`。
//! 全局 reqwest Client（桌面 UA + cookie_store + 15s 超时）；
//! 提供 json/text/bytes 三种响应、host fallback、指数退避重试、GBK 解码。

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, REFERER, USER_AGENT};
use serde_json::Value;

pub const DESKTOP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
pub const MOBILE_UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(DESKTOP_UA)
            // fund123 CSRF 依赖 GET /fund 下发的会话 cookie
            .cookie_store(true)
            // 限制重定向次数，防止上游接口异常时被带到任意域
            .redirect(reqwest::redirect::Policy::limited(3))
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client 构建失败")
    })
}

/// 快速构造 query 参数
pub fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn headers(ua: &str, referer: Option<&str>) -> HeaderMap {
    let mut h = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(ua) {
        h.insert(USER_AGENT, v);
    }
    if let Some(r) = referer {
        if let Ok(v) = HeaderValue::from_str(r) {
            h.insert(REFERER, v);
        }
    }
    h
}

/// 发起请求，!ok 时带状态码与路径的报错
async fn send(
    url: &str,
    headers: &HeaderMap,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    let res = client()
        .get(url)
        .headers(headers.clone())
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("网络错误({url}): {e}"))?;
    if !res.status().is_success() {
        let code = res.status();
        let body = res.text().await.unwrap_or_default();
        let preview: String = body.chars().take(300).collect();
        return Err(format!("HTTP {code} {url} body={preview}"));
    }
    Ok(res)
}

pub async fn http_get_json(
    url: &str,
    query: &HashMap<String, String>,
    ua: &str,
    referer: Option<&str>,
    timeout: Duration,
) -> Result<Value, String> {
    let mut final_url = url.to_string();
    if !query.is_empty() {
        let qs = query
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");
        final_url.push('?');
        final_url.push_str(&qs);
    }
    let res = send(&final_url, &headers(ua, referer), timeout).await?;
    res.json::<Value>().await.map_err(|e| format!("JSON 解析失败({url}): {e}"))
}

pub async fn http_get_text(
    url: &str,
    query: &HashMap<String, String>,
    ua: &str,
    referer: Option<&str>,
    timeout: Duration,
) -> Result<String, String> {
    let mut final_url = url.to_string();
    if !query.is_empty() {
        let qs = query
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");
        final_url.push('?');
        final_url.push_str(&qs);
    }
    let res = send(&final_url, &headers(ua, referer), timeout).await?;
    res.text().await.map_err(|e| format!("读取响应失败({url}): {e}"))
}

pub async fn http_get_bytes(
    url: &str,
    query: &HashMap<String, String>,
    ua: &str,
    referer: Option<&str>,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut final_url = url.to_string();
    if !query.is_empty() {
        let qs = query
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");
        final_url.push('?');
        final_url.push_str(&qs);
    }
    let res = send(&final_url, &headers(ua, referer), timeout).await?;
    res.bytes().await.map(|b| b.to_vec()).map_err(|e| format!("读取响应失败({url}): {e}"))
}

pub async fn http_post_json(
    url: &str,
    body: &Value,
    extra_headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<Value, String> {
    let mut h = HeaderMap::new();
    h.insert(USER_AGENT, HeaderValue::from_static(DESKTOP_UA));
    h.insert(reqwest::header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    for (k, v) in extra_headers {
        let hv = HeaderValue::from_str(v).map_err(|_| "非法 header".to_string())?;
        let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| "非法 header 名".to_string())?;
        h.insert(name, hv);
    }
    let res = client()
        .post(url)
        .headers(h)
        .json(body)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("网络错误({url}): {e}"))?;
    if !res.status().is_success() {
        let code = res.status();
        let body = res.text().await.unwrap_or_default();
        let preview: String = body.chars().take(300).collect();
        return Err(format!("HTTP {code} {url} body={preview}"));
    }
    res.json::<Value>().await.map_err(|e| format!("JSON 解析失败({url}): {e}"))
}

/// 东财 host fallback：依次尝试 hosts，全部失败抛错
pub async fn eastmoney_get(
    path: &str,
    query: &HashMap<String, String>,
    hosts: &[&str],
) -> Result<Value, String> {
    let mut last_err: Option<String> = None;
    for host in hosts {
        let url = format!("{host}{path}");
        match http_get_json(&url, query, DESKTOP_UA, Some("https://quote.eastmoney.com/"), Duration::from_secs(12)).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                eprintln!("[fund01] eastmoney_get 失败 host={host} path={path} err={e}");
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "eastmoney request failed".to_string()))
}

/// 指数退避重试（对应 eastmoneyFundGet 3 次 400ms*attempt）
pub async fn retry_3(
    f: impl Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>,
    label: &str,
) -> Result<Value, String> {
    let mut last_err: Option<String> = None;
    for i in 0..3 {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                eprintln!("[fund01] {label} attempt={}/3 失败: {e}", i + 1);
                last_err = Some(e);
            }
        }
        tokio::time::sleep(Duration::from_millis(400 * (i as u64 + 1))).await;
    }
    Err(last_err.unwrap_or_else(|| format!("{label} 获取失败")))
}

/// GBK 解码（新浪黄金行情）
pub fn gbk_decode(bytes: &[u8]) -> String {
    let (cow, _, _) = encoding_rs::GBK.decode(bytes);
    cow.into_owned()
}
