//! 角标计算 —— 对应 `packages/core/src/badge.ts` 1:1 迁移。
//! 涨红跌绿（中国习惯）。（菜单栏着色目前走 menubar.rs 的 color_for，本模块供后续复用）
#![allow(dead_code)]

use crate::format::{format_short_amount, format_short_percent, DEFAULT_SHORT_LEN};

pub const MAX_BADGE_LEN: usize = DEFAULT_SHORT_LEN;

const BADGE_RISE: &str = "#dc2626";
const BADGE_FALL: &str = "#16a34a";

pub struct BadgeComputed {
    pub text: String,
    pub color: String,
}

/// mode: "percent" | "amount" | "hidden"
pub fn compute_badge(mode: &str, total_pnl_percent: f64, total_pnl: f64) -> BadgeComputed {
    if mode == "hidden" {
        return BadgeComputed {
            text: String::new(),
            color: BADGE_FALL.to_string(),
        };
    }
    if mode == "amount" {
        return BadgeComputed {
            text: format_short_amount(total_pnl, MAX_BADGE_LEN),
            color: if total_pnl >= 0.0 {
                BADGE_RISE.to_string()
            } else {
                BADGE_FALL.to_string()
            },
        };
    }
    // percent（默认）
    BadgeComputed {
        text: format_short_percent(total_pnl_percent, MAX_BADGE_LEN),
        color: if total_pnl_percent >= 0.0 {
            BADGE_RISE.to_string()
        } else {
            BADGE_FALL.to_string()
        },
    }
}
