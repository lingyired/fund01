//! 交易日历 —— 对应 `packages/core/src/tradingCalendar.ts` 1:1 迁移。
//! A 股简易交易日：仅跳周末（不含法定节假日，与 TS 版一致）。

use chrono::{DateTime, Datelike, Local, NaiveDate, Timelike, Weekday};

fn now_local() -> DateTime<Local> {
    Local::now()
}

pub fn today_date_str(d: &DateTime<Local>) -> String {
    format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day())
}

/// 统一成 YYYY-MM-DD（兼容 MM-DD）
pub fn normalize_net_value_date(raw: &str, now: &DateTime<Local>) -> String {
    let s = raw.trim();
    if s.len() >= 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' {
        return s[..10].to_string();
    }
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 2 {
        return String::new();
    }
    let month: u32 = match parts[0].parse() {
        Ok(m) if (1..=12).contains(&m) => m,
        _ => return String::new(),
    };
    let day: u32 = match parts[1].parse() {
        Ok(d) if (1..=31).contains(&d) => d,
        _ => return String::new(),
    };
    let mut year = now.year();
    let candidate = NaiveDate::from_ymd_opt(year, month, day);
    let today_only = NaiveDate::from_ymd_opt(now.year(), now.month(), now.day()).unwrap();
    if candidate.is_some_and(|c| c > today_only) {
        year -= 1;
    }
    format!("{year:04}-{month:02}-{day:02}")
}

fn parse_date_str(s: &str) -> Option<NaiveDate> {
    let parts: Vec<u32> = s.split('-').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 3 {
        return None;
    }
    NaiveDate::from_ymd_opt(parts[0] as i32, parts[1], parts[2])
}

/// 给定交易日之后的下一个交易日（周末顺延）
pub fn next_trading_day(date_str: &str, now: &DateTime<Local>) -> String {
    let normalized = {
        let n = normalize_net_value_date(date_str, now);
        if n.is_empty() {
            date_str.to_string()
        } else {
            n
        }
    };
    let Some(mut d) = parse_date_str(&normalized) else {
        return normalized;
    };
    loop {
        d = d.succ_opt().unwrap_or(d);
        let wd = d.weekday();
        if wd != Weekday::Sat && wd != Weekday::Sun {
            break;
        }
    }
    format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day())
}

/// 「下一交易日是否已开始」：日历到达该日，且本地时间 ≥ 09:15
pub fn is_trading_day_started(date_str: &str, now: &DateTime<Local>) -> bool {
    let day = {
        let n = normalize_net_value_date(date_str, now);
        if n.is_empty() {
            date_str.to_string()
        } else {
            n
        }
    };
    let today = today_date_str(now);
    if today > day {
        return true;
    }
    if today < day {
        return false;
    }
    let minutes = now.hour() * 60 + now.minute();
    minutes >= 9 * 60 + 15
}

/// 晚间已拉到官方确认涨跌：展示「已更新」；两类基金均保留到「锚点日的下一交易日」开盘后抹去：
/// - 普通基金：锚点 = 净值日（当天披露）→ 净值日下一交易日开盘后清除（周末照常显示）。
/// - QDII（T+1 披露，净值日=昨天）：锚点 = 披露日（净值日的下一交易日，即用户看到该净值
///   的日子），与普通基金的净值日同义 → 披露日的下一交易日开盘后清除（周末照常显示）。
/// 与 `is_confirmed_session_active` 的 delayed 分支保持一致。
pub fn should_show_confirmed_updated_badge(
    percent_source: Option<&str>,
    net_value_date: Option<&str>,
    now: &DateTime<Local>,
    is_qdii: bool,
) -> bool {
    if percent_source != Some("confirmed") {
        return false;
    }
    let nav_day = normalize_net_value_date(net_value_date.unwrap_or(""), now);
    if nav_day.is_empty() {
        return false;
    }
    let anchor = if is_qdii { next_trading_day(&nav_day, now) } else { nav_day };
    let next = next_trading_day(&anchor, now);
    !is_trading_day_started(&next, now)
}

fn hms_to_minutes(d: &DateTime<Local>) -> u32 {
    d.hour() * 60 + d.minute()
}

/// A 股交易日（周一到周五）盘中时段：09:15 - 15:30
pub fn is_a_share_trading_time(now: &DateTime<Local>) -> bool {
    let day = now.weekday();
    if day == Weekday::Sat || day == Weekday::Sun {
        return false;
    }
    let m = hms_to_minutes(now);
    m >= 9 * 60 + 15 && m <= 15 * 60 + 30
}

/// 基金是否需要刷新：A 股交易日 09:15-23:00（盘中估值 + 空窗自算 + 晚间确认）
pub fn should_refresh_fund(now: &DateTime<Local>) -> bool {
    let day = now.weekday();
    if day == Weekday::Sat || day == Weekday::Sun {
        return false;
    }
    let m = hms_to_minutes(now);
    m >= 9 * 60 + 15 && m <= 23 * 60
}

/// A 股指数 / 大盘：仅交易日 09:15-15:30
pub fn should_refresh_a_share_market(now: &DateTime<Local>) -> bool {
    is_a_share_trading_time(now)
}

/// 黄金 AU9999 日盘：周一至周五 09:00-15:30（归日盘循环）
pub fn is_gold_day_session(now: &DateTime<Local>) -> bool {
    let day = now.weekday();
    if day == Weekday::Sat || day == Weekday::Sun {
        return false;
    }
    let m = hms_to_minutes(now);
    m >= 9 * 60 && m <= 15 * 60 + 30
}

/// 黄金 AU9999 夜盘：周一 20:00 - 周六 03:00（归夜盘循环；周一凌晨 0-3 点按原语义保留）
pub fn is_gold_night_session(now: &DateTime<Local>) -> bool {
    let day = now.weekday();
    let m = hms_to_minutes(now);
    if day == Weekday::Sun {
        return false;
    }
    if day == Weekday::Sat {
        return m <= 3 * 60;
    }
    m >= 20 * 60 || m <= 3 * 60
}

/// 美股指数（NDX/SPX）：周一 21:30 - 周六 04:00（夏令时近似）
pub fn should_refresh_us_index(now: &DateTime<Local>) -> bool {
    let day = now.weekday();
    let m = hms_to_minutes(now);
    if day == Weekday::Sun {
        return false;
    }
    if day == Weekday::Sat {
        return m <= 4 * 60;
    }
    m >= 21 * 60 + 30 || m <= 4 * 60
}

/// 日盘市场活跃（决定日盘循环档位）：黄金日盘 09:00 或 A 股盘中 09:15 起，至 15:30
pub fn is_day_market_active(now: &DateTime<Local>) -> bool {
    is_gold_day_session(now) || is_a_share_trading_time(now)
}

/// 夜盘市场活跃（决定夜盘循环档位）：黄金夜盘 20:00 或 美股 21:30 起，至次日 04:00
pub fn is_night_market_active(now: &DateTime<Local>) -> bool {
    is_gold_night_session(now) || should_refresh_us_index(now)
}

/// 延迟披露基金（QDII/海外）：净值 T+1/T+2 披露。判定与 `fundmnfinfo::is_qdii_name`
/// 一致（证监会强制 QDII 基金名含 "QDII"；后续可扩展 FTYPE 双通道）。
/// 识别出的基金在 `is_confirmed_session_active` 中走 delayed 分支：锚点从「净值日」前移
/// 到「披露日」（净值日的下一交易日），披露日与普通基金净值日同义 —— 披露后一直保留
/// 到披露日的下一交易日开盘前（周末照常显示），开盘后恢复盘中口径。
pub fn is_delayed_nav_fund(name: &str) -> bool {
    crate::providers::fundmnfinfo::is_qdii_name(name)
}

/// 确认会话：锚点日的下一交易日尚未开盘（09:15 前）。非延迟披露基金（境内）用它：
/// PDATE=今天（当晚披露）→ 锚点=今天 → next=明天 > today → 已确认；PDATE=昨天（盘中）→
/// 锚点=昨天 → next=今天已开盘 → 未确认（走盘中估算）。
///
/// `delayed_disclosure=true`（QDII/海外，净值 T+1 披露）：锚点 = 披露日（PDATE 的下一
/// 交易日，T+1：今天披露昨天净值）——把披露日当作普通基金的「净值日」处理：披露后
/// 保留到披露日的下一交易日开盘前，周末照常显示「已更新」。如 08-06 净值 08-07 披露 →
/// 锚点 08-07 → 08-07 ~ 08-10 开盘前均确认（周末显示）；08-10 开盘后恢复盘中口径。
pub fn is_confirmed_session_active(
    nav_day_raw: &str,
    now: &DateTime<Local>,
    delayed_disclosure: bool,
) -> bool {
    let nav_day = normalize_net_value_date(nav_day_raw, now);
    if nav_day.is_empty() {
        return false;
    }
    let anchor = if delayed_disclosure { next_trading_day(&nav_day, now) } else { nav_day };
    let next = next_trading_day(&anchor, now);
    !is_trading_day_started(&next, now)
}

/// 便捷：默认取当前时间
pub fn confirmed_session_active_now(nav_day_raw: &str, delayed_disclosure: bool) -> bool {
    is_confirmed_session_active(nav_day_raw, &now_local(), delayed_disclosure)
}
