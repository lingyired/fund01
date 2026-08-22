//! 检查更新 —— 设置界面打开时拉取远端静态 JSON（https://lingai.net/fund01/version.json）
//! 与当前版本比较；仅提示（下载新版本 / 跳转项目主页），不支持热更新。
//! 服务端零逻辑：静态 JSON 即可，格式见 docs/检查更新-服务端接入.md。

use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::http;
use crate::state::{AppState, UpdateCheckCache};

/// 远端版本清单（静态 JSON，见 docs/检查更新-服务端接入.md）
const UPDATE_URL: &str = "https://lingai.net/fund01/version.json";
/// 版本清单缺 homepage 字段时的兜底（项目主页）
const DEFAULT_HOMEPAGE: &str = "https://lingai.net/fund01";
/// 检查结果内存缓存：1h 内重复打开设置窗口不再请求网络（低消耗）
const CACHE_TTL: Duration = Duration::from_secs(3600);

/// 检查结果（camelCase 序列化对齐前端 CheckUpdateResult）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckUpdateResult {
    pub latest_version: String,
    pub homepage: String,
    /// 下载地址（可选；缺省时前端只显示「前往项目主页」按钮）
    pub download_url: Option<String>,
}

/// 解析 x.y.z 三段数字版本号；任一段非数字 → None（视为非法）
fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// latest 是否比 current 新；latest 解析失败 → 保守判「无更新」
fn version_is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// 解析远端 JSON；无更新时返回 None（也写入缓存，避免 1h 内重复请求）
fn parse_check_result(v: &serde_json::Value) -> Option<CheckUpdateResult> {
    let latest = v
        .get("latestVersion")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let homepage = v
        .get("homepage")
        .and_then(|x| x.as_str())
        .unwrap_or(DEFAULT_HOMEPAGE)
        .to_string();
    let current = env!("CARGO_PKG_VERSION");
    if version_is_newer(&latest, current) {
        Some(CheckUpdateResult {
            latest_version: latest,
            homepage,
            download_url: v
                .get("downloadUrl")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
        })
    } else {
        None
    }
}

/// 检查是否有新版本：缓存命中直接返回；否则请求远端 JSON。
/// 请求带 `v=当前版本号` 查询参数（服务端可据此统计客户端版本分布 / 兼容判断）。
/// `force = true`（「关于」页手动点击）时跳过 1h 内存缓存，真正请求远端一次。
/// Ok(None) = 已是最新（前端静默）；Err = 网络/解析失败（前端静默）。
pub async fn check_update(state: &AppState, force: bool) -> Result<Option<CheckUpdateResult>, String> {
    // 内存缓存：1h TTL，避免频繁开关设置窗口反复请求（手动检查 force 跳过）
    if !force {
        let cache = state.update_cache.read().unwrap();
        if let Some(c) = cache.as_ref() {
            let age = c.checked_at.elapsed().unwrap_or(CACHE_TTL);
            if age < CACHE_TTL {
                return Ok(c.result.clone());
            }
        }
    }
    let v = http::http_get_json(
        UPDATE_URL,
        &http::params(&[("v", env!("CARGO_PKG_VERSION"))]),
        http::DESKTOP_UA,
        None,
        Duration::from_secs(10),
    )
    .await?;
    let result = parse_check_result(&v);
    *state.update_cache.write().unwrap() = Some(UpdateCheckCache {
        checked_at: SystemTime::now(),
        result: result.clone(),
    });
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_ok() {
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("1"), Some((1, 0, 0)));
    }

    #[test]
    fn parse_version_invalid() {
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("a.b.c"), None);
        assert_eq!(parse_version("1.2.x"), None);
        assert_eq!(parse_version("1.2.3.4"), Some((1, 2, 3))); // 多余段忽略
    }

    #[test]
    fn newer_compare() {
        assert!(version_is_newer("1.2.0", "1.1.4"));
        assert!(version_is_newer("1.1.5", "1.1.4"));
        assert!(version_is_newer("2.0.0", "1.9.9"));
        assert!(!version_is_newer("1.1.4", "1.1.4"));
        assert!(!version_is_newer("1.1.3", "1.1.4"));
        assert!(!version_is_newer("bad", "1.1.4")); // 远端非法 → 保守无更新
    }
}
