//! 数据链路诊断日志门控：`FUND01_DEBUG=1` 时输出 `[fund01]` 前缀的数据日志。
//!
//! 数据日志（请求 chunk / 命中数 / 逐条行情 / 刷新汇总）每次刷新都会打，debug build 下会刷屏、
//! 干扰排查（如 menubar 分组显示问题）。默认静默；需要排查具体数据链路时设 `FUND01_DEBUG=1`
//! 再运行。错误日志（业务失败 / 网络失败）不走这里，始终输出。

use std::sync::OnceLock;

static ENABLED: OnceLock<bool> = OnceLock::new();

/// FUND01_DEBUG 是否开启（"1" / "true"，大小写不敏感）
pub fn debug_enabled() -> bool {
    *ENABLED.get_or_init(|| {
        std::env::var("FUND01_DEBUG").is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    })
}

/// 与 `eprintln!` 同签名，但受 FUND01_DEBUG 门控（默认静默）。
/// 用法：`crate::dbg_log!("消息 {var}");`
#[macro_export]
macro_rules! dbg_log {
    ($($arg:tt)*) => {{
        if crate::dbglog::debug_enabled() {
            eprintln!("[fund01] {}", format_args!($($arg)*));
        }
    }};
}
