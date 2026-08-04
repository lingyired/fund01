//! 紧凑数字格式化 —— 对应 `packages/core/src/format.ts` 1:1 迁移（menubar/角标共用）。

pub const DEFAULT_SHORT_LEN: usize = 4;

/// 金额类数值简化（k/w/kw，取绝对值不带符号）
pub fn format_short_amount(value: f64, max_len: usize) -> String {
    let abs = if value.is_finite() { value.abs() } else { 0.0 };
    let (mut n, unit) = if abs >= 1e7 {
        (abs / 1e7, "kw")
    } else if abs >= 1e4 {
        (abs / 1e4, "w")
    } else if abs >= 1e3 {
        (abs / 1e3, "k")
    } else {
        (abs, "")
    };
    let is_int = (n - n.round()).abs() < 1e-9;
    let decimals: &[usize] = if is_int { &[0] } else { &[1, 0] };
    for &d in decimals {
        let s = format!("{n:.d$}");
        if s.len() + unit.len() <= max_len {
            return s + unit;
        }
    }
    n = n.round();
    format!("{n:.0}{unit}")
}

/// 百分比简化（去符号去 %，逐级降精度）
pub fn format_short_percent(value: f64, max_len: usize) -> String {
    let abs = if value.is_finite() { value.abs() } else { 0.0 };
    for d in [2usize, 1, 0] {
        let s = format!("{abs:.d$}");
        if s.len() <= max_len {
            return s;
        }
    }
    format!("{}", abs.round())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amount_units() {
        assert_eq!(format_short_amount(1234.0, 4), "1.2k");
        assert_eq!(format_short_amount(12000.0, 4), "1.2w");
        assert_eq!(format_short_amount(15000000.0, 4), "2kw");
        assert_eq!(format_short_amount(856.0, 4), "856");
    }

    #[test]
    fn percent_precision() {
        assert_eq!(format_short_percent(0.83, 4), "0.83");
        assert_eq!(format_short_percent(12.34, 4), "12.3");
        assert_eq!(format_short_percent(-1.234, 4), "1.23");
    }
}
