//! 检查更新 / 应用内更新 —— 基于官方 `tauri-plugin-updater`
//!
//! 流程：读远端 `latest.json` 清单（多 endpoint 按序尝试，见 tauri.conf.json plugins.updater）
//! → 官方插件验签（ed25519，强制不可关闭）→ 下载 → 安装 → 重启。
//!
//! 与旧版差异（旧版仅拉自定义 `version.json`，提示「打开浏览器下载」）：
//! - 清单格式改为 Tauri 标准 `latest.json`（`platforms` 按 `OS-ARCH` 分发）
//! - 下载前必过签名校验，安装包被篡改直接拒绝
//! - 新增应用内安装（`install_update`），同时保留手动下载降级路径
//!
//! 两条硬性约定（改动时勿删）：
//! 1. **timeout 必须显式设置** —— 插件 `UpdaterBuilder::default()` 的 timeout 为 None，
//!    被墙时若 TCP 呈「连上但不响应」黑洞态，请求无限期挂起导致 UI 卡在「检查中」。
//! 2. **手动降级路径不可省** —— updater 在 macOS 非公证包 / 非 admin 安装 /
//!    Windows 杀软拦截等场景会安装失败，`download_url` 必须继续透给前端当兜底按钮。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::state::{AppState, UpdateCheckCache};

/// 版本清单缺下载地址时的兜底（项目主页 / GitHub Release 页）
const DEFAULT_HOMEPAGE: &str = "https://lingai.net/fund01";
/// 检查结果内存缓存：1h 内重复打开设置窗口不再请求网络（低消耗）
const CACHE_TTL: Duration = Duration::from_secs(3600);
/// 单次请求超时（对齐旧版 http_get_json 的 10 秒口径）。理由见模块头部约定 1。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// 下载进度事件名（前端 listen 订阅）
pub const PROGRESS_EVENT: &str = "fund01://update-progress";

/// 下载累计字节。插件的 on_chunk 回调只给**增量**，需外部累加；
/// 用全局原子量而非局部变量是因为两个回调闭包要共享同一计数器，
/// 且 download_and_install 结束（闭包 drop）后计数即失效，无需重置。
static DOWNLOADED: AtomicU64 = AtomicU64::new(0);

/// 检查结果（camelCase 序列化对齐前端 CheckUpdateResult）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckUpdateResult {
    /// 远端最新版本号（x.y.z）
    pub latest_version: String,
    /// 项目主页（手动降级路径）
    pub homepage: String,
    /// 安装包直链。自动安装失败时前端用它兜底「手动下载」——
    /// 语义已从旧版的「浏览器下载地址」变为「安装包 URL」。
    pub download_url: Option<String>,
    /// 更新说明（清单 notes 字段；无则 None）
    pub notes: Option<String>,
}

/// 下载进度事件载荷
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// 已下载字节
    pub downloaded: u64,
    /// 总字节（服务端未给 Content-Length 时为 None）
    pub total: Option<u64>,
}

/// 检查更新：构建 updater → 拉清单 → 比版本 → 返回元信息（不下载）。
/// - 打开设置界面自动检查（`force = false`）→ 走 1h 内存缓存，命中不请求网络；
/// - 「关于」页手动点击（`force = true`）→ 绕过缓存真正请求一次。
/// Ok(None) = 已是最新；Err = 网络/解析/验签失败（前端静默）。
pub async fn check_update(
    app: &AppHandle,
    state: &AppState,
    force: bool,
) -> Result<Option<CheckUpdateResult>, String> {
    if !force {
        let cache = state.update_cache.read().unwrap();
        if let Some(c) = cache.as_ref() {
            let age = c.checked_at.elapsed().unwrap_or(CACHE_TTL);
            if age < CACHE_TTL {
                return Ok(c.result.clone());
            }
        }
    }

    let update = app
        .updater_builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    let result = update.map(|u| CheckUpdateResult {
        latest_version: u.version,
        homepage: DEFAULT_HOMEPAGE.to_string(),
        download_url: Some(u.download_url.to_string()),
        notes: u.body,
    });

    *state.update_cache.write().unwrap() = Some(UpdateCheckCache {
        checked_at: SystemTime::now(),
        result: result.clone(),
    });
    Ok(result)
}

/// 下载 + 安装 + 重启。
///
/// 平台差异（官方文档明确说明）：
/// - Windows：安装前**自动退出应用**（安装器限制），`on_before_exit` 是唯一的退出前清理钩子；
/// - macOS：不自动退出，安装完成后 `app.restart()` 生效。
///
/// 进度经 `PROGRESS_EVENT` 回传前端。Err 字符串直接透给前端展示 —— 理由见模块头部约定 2。
pub async fn install_update(app: &AppHandle) -> Result<(), String> {
    let update = app
        .updater_builder()
        .timeout(REQUEST_TIMEOUT)
        .on_before_exit(|| {
            crate::err_log!("app is about to exit on Windows for update install");
        })
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "无可安装的新版本".to_string())?;

    DOWNLOADED.store(0, Ordering::Relaxed);
    let app_progress = app.clone();
    let app_finish = app.clone();

    update
        .download_and_install(
            move |chunk_length, content_length| {
                //插件的 on_chunk 回调给的是 usize 增量，转 u64 累加
                let chunk = chunk_length as u64;
                let downloaded = DOWNLOADED.fetch_add(chunk, Ordering::Relaxed) + chunk;
                let _ = app_progress.emit(
                    PROGRESS_EVENT,
                    UpdateProgress {
                        downloaded,
                        total: content_length,
                    },
                );
            },
            move || {
                let _ = app_finish.emit(
                    PROGRESS_EVENT,
                    UpdateProgress {
                        downloaded: DOWNLOADED.load(Ordering::Relaxed),
                        total: None,
                    },
                );
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    // macOS：安装包已就位，重启生效。
    // Windows 上此时进程已被安装器替换退出，走到这里属异常路径。
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_is_ten_seconds() {
        // 防回归：timeout 被误删会导致被墙时 UI 无限卡住（见模块头部约定 1）
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(10));
    }

    #[test]
    fn default_homepage_is_project_site() {
        assert_eq!(DEFAULT_HOMEPAGE, "https://lingai.net/fund01");
    }
}