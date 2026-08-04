//! 熔断器 —— 对应 `packages/services/src/circuit.ts`。
//! 常驻进程内存态即可（无需跨重启持久化，chrome 版是为了 MV3 SW 休眠恢复）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

struct CircuitState {
    failures: u32,
    tripped_until: Option<Instant>,
}

pub struct CircuitOptions {
    pub max_failures: u32,
    pub cooldown: Duration,
    pub label: &'static str,
}

static CIRCUITS: OnceLock<Mutex<HashMap<&'static str, CircuitState>>> = OnceLock::new();

fn circuits() -> &'static Mutex<HashMap<&'static str, CircuitState>> {
    CIRCUITS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 是否已熔断（冷却期内应跳过请求）
pub fn is_tripped(key: &'static str) -> bool {
    let map = circuits().lock().unwrap();
    match map.get(key) {
        Some(s) => s.tripped_until.is_some_and(|t| Instant::now() < t),
        None => false,
    }
}

/// 记录成功：清零（回到 closed）
pub fn record_success(key: &'static str) {
    circuits().lock().unwrap().remove(key);
}

/// 记录失败：累计计数；达到阈值或冷却后重试仍失败时熔断
pub fn record_failure(key: &'static str, opts: &CircuitOptions) {
    let mut map = circuits().lock().unwrap();
    let now = Instant::now();
    let entry = map.entry(key).or_insert(CircuitState {
        failures: 0,
        tripped_until: None,
    });
    entry.failures += 1;
    if let Some(until) = entry.tripped_until {
        if now >= until {
            // half-open 重试失败：立即重新冷却
            entry.tripped_until = Some(now + opts.cooldown);
            eprintln!(
                "[fund01] 熔断 {}：冷却后重试仍失败，重新冷却 {}s",
                opts.label,
                opts.cooldown.as_secs()
            );
        }
    } else if entry.failures >= opts.max_failures {
        entry.tripped_until = Some(now + opts.cooldown);
        eprintln!(
            "[fund01] 熔断 {}：连续失败 {} 次，冷却 {}s",
            opts.label,
            entry.failures,
            opts.cooldown.as_secs()
        );
    }
}
