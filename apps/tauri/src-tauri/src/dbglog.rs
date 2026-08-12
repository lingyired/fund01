//! 数据链路诊断日志：**始终打印到 stderr（控制台）**，与 Chrome 扩展的 console 日志
//! 对齐（`cargo tauri dev` 终端直接可见）；同时**写入日志文件**
//! （macOS `~/Library/Logs/fund01/data.log`，可用 `FUND01_LOG_DIR` 覆盖目录），
//! 保证 .app 双击运行时也能查看加载数据的日志。
//!
//! `dbg_log!`（数据日志）与 `err_log!`（错误日志）行为一致：stderr + 文件均无条件
//! 输出（每行带本地毫秒时间戳，可与 Chrome 侧 console 日志对照时序）。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static LOG_FILE: OnceLock<Mutex<File>> = OnceLock::new();

/// 日志文件路径：FUND01_LOG_DIR 覆盖目录；否则按平台取用户级日志目录，
/// 统一文件名 data.log。
fn log_path() -> PathBuf {
    if let Ok(dir) = std::env::var("FUND01_LOG_DIR") {
        return PathBuf::from(dir).join("data.log");
    }
    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join("Library/Logs/fund01"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/fund01"));
    #[cfg(target_os = "windows")]
    let base = std::env::var("LOCALAPPDATA")
        .map(|h| PathBuf::from(h).join("fund01"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/fund01"));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = std::env::var("XDG_STATE_HOME")
        .map(|h| PathBuf::from(h).join("fund01"))
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .map(|h| PathBuf::from(h).join(".local/state/fund01"))
                .unwrap_or_else(|_| PathBuf::from("/tmp/fund01"))
        });
    base.join("data.log")
}

fn log_file() -> &'static Mutex<File> {
    LOG_FILE.get_or_init(|| {
        let p = log_path();
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .unwrap_or_else(|e| {
                eprintln!("[fund01] 打开日志文件失败 {p:?}: {e}");
                File::open("/dev/null").expect("fallback to /dev/null")
            });
        Mutex::new(f)
    })
}

/// 统一写入：stderr（按 to_stderr）+ 文件（无条件）。多线程安全（Mutex 串行写）。
/// 两者行首都带本地毫秒时间戳，控制台与文件格式一致。
pub fn log_write(msg: &str, to_stderr: bool) {
    let ts = chrono::Local::now().format("%H:%M:%S%.3f");
    if to_stderr {
        eprintln!("[{ts}] [fund01] {msg}");
    }
    if let Ok(mut f) = log_file().lock() {
        let _ = writeln!(f, "[{ts}] [fund01] {msg}");
    }
}

/// 数据日志：**仅 debug 构建打印**（stderr + 文件）；release 构建完全关闭，
/// 只保留错误日志（`err_log!`）。release 下参数仍被 `format_args!` 求值丢弃，
/// 避免 unused 警告且无运行时开销。用法：`crate::dbg_log!("消息 {var}");`
#[macro_export]
macro_rules! dbg_log {
    ($($arg:tt)*) => {{
        let _ = format_args!($($arg)*);
        #[cfg(debug_assertions)]
        crate::dbglog::log_write(&format_args!($($arg)*).to_string(), true);
    }};
}

/// 错误日志：stderr + 文件均无条件输出（替代裸 eprintln!，使 .app 下也可查）。
/// 用法：`crate::err_log!("失败: {e}");`
#[macro_export]
macro_rules! err_log {
    ($($arg:tt)*) => {{
        let msg = format_args!($($arg)*).to_string();
        crate::dbglog::log_write(&msg, true);
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_write_appends_to_file() {
        let dir = std::env::temp_dir().join(format!("fund01-log-test-{}", std::process::id()));
        std::env::set_var("FUND01_LOG_DIR", &dir);
        let line = format!(
            "test line {}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        log_write(&line, false);
        let content = fs::read_to_string(log_path()).expect("日志文件应存在");
        assert!(content.contains(&line), "日志文件应包含写入行");
        let _ = fs::remove_dir_all(&dir);
    }
}
