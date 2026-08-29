//! menubar/taskband 共用纯逻辑（无插件依赖，macOS 与 Windows 共享）。
//!
//! 从 menubar.rs 抽出：实例期望集合计算、分组涨跌口径、文本/颜色格式化、实例 id 编解码。
//! 唯一消费者是 menubar.rs（macOS）与 taskband.rs（Windows）两套插件编排层。
//!
//! ⚠️ 口径铁律：`menubar_all_hidden` 与前端 `isMenubarEmpty`（packages/ui/src/lib/fundOps.ts）
//! 保持 1:1 一致；分组涨跌/收益额口径与 popup 分组聚合一致（份额取最新 config 为权威）。

use std::collections::HashMap;

use crate::model::{AppConfig, FundQuoteRow, QuoteUpdate};

pub const INSTANCE_OVERVIEW: &str = "menubar-overview";

pub const COLOR_RISE_DEFAULT: &str = "#FF4F44"; // 涨/红（默认，可配置 menubarRiseColor）
pub const COLOR_FALL_DEFAULT: &str = "#34C759"; // 跌/绿（默认，可配置 menubarFallColor）
pub const COLOR_FLAT_DEFAULT: &str = "#8e8e93"; // 平/灰（默认，可配置 menubarFlatColor）
pub const COLOR_TOP_DEFAULT: &str = "#ffffff"; // 上行固定色默认（可配置 menubarTopColor）

pub(crate) fn color_for(pct: f64, rise: &str, fall: &str, flat: &str) -> String {
    if pct > 0.0 {
        rise.to_string()
    } else if pct < 0.0 {
        fall.to_string()
    } else {
        flat.to_string()
    }
}

pub(crate) fn format_pct(pct: f64) -> String {
    if !pct.is_finite() {
        return "0.00%".to_string();
    }
    if pct.abs() >= 100.0 {
        format!("{:+.0}%", pct)
    } else {
        format!("{:+.2}%", pct)
    }
}

/// 收益额显示（菜单栏专用，不受长度限制；与 format.rs 的 badge 简写规则不同）。
/// - 绝对值 ≥ 10 万：w（万）缩写，最多 1 位小数（整数则不带小数）；
/// - 绝对值 < 10 万：完整整数显示，无缩写、无小数点。
/// 均带方向符号；符号由调用方颜色 + 前缀表达。
pub(crate) fn format_amount(v: f64) -> String {
    if !v.is_finite() {
        return "+0".to_string();
    }
    let sign = if v < 0.0 { "-" } else { "+" };
    let abs = v.abs();
    if abs >= 1e5 {
        let n = abs / 1e4;
        let is_int = (n - n.round()).abs() < 1e-9;
        let s = if is_int {
            format!("{n:.0}")
        } else {
            format!("{n:.1}")
        };
        format!("{sign}{s}w")
    } else {
        format!("{sign}{}", abs.round())
    }
}

/// 行情行索引：code → quote 行（分组归属与份额以最新 config 为准，此处只取行情数值）
type QuoteRows<'a> = HashMap<&'a str, &'a FundQuoteRow>;

fn quote_rows(quote: Option<&QuoteUpdate>) -> QuoteRows<'_> {
    quote
        .and_then(|q| q.holdings.as_ref())
        .map(|h| h.list.iter().map(|r| (r.fund.code.as_str(), r)).collect())
        .unwrap_or_default()
}

/// 分组涨跌（%）：Σ(组内份额分摊的 pnl) / Σ(组内份额 × 昨净值)
/// 份额取最新 config.holdings（权威），行情（pnl/昨净值）取 quote 快照，缺失按 0。
/// 不用 quote 行内的 allocations：那是「上次刷新时」的 config 快照，
/// 重命名/调整分组后两者会错位，导致实例集合误判、数值显示旧份额。
/// 收益用「每份收益 × 最新份额」分摊：修改持仓后即使行情未刷新，数值也立即贴合新份额。
/// 当日收益为空的成员（QDII 盘中 pnl=None）分子分母同步排除，避免 0 占位稀释（§六）。
fn group_percent(config: &AppConfig, rows: &QuoteRows<'_>, group: &str) -> f64 {
    let mut pnl = 0.0f64;
    let mut bod = 0.0f64;
    for fund in config.holdings.values() {
        let sh_g = fund.allocations.get(group).copied().unwrap_or(0.0);
        if sh_g <= 0.0 {
            continue;
        }
        let Some(row) = rows.get(fund.code.as_str()).copied() else {
            continue;
        };
        let Some(row_pnl) = row.pnl else { continue };
        let total = row.fund.total_shares();
        if total <= 0.0 {
            continue;
        }
        pnl += (row_pnl / total) * sh_g;
        bod += sh_g * row.prev_net_value.unwrap_or(0.0);
    }
    if bod > 0.0 {
        pnl / bod * 100.0
    } else {
        0.0
    }
}

/// 分组收益额：Σ(组内份额分摊的 pnl)（份额取最新 config，每份收益口径同上）
/// 当日收益为空的成员（QDII 盘中 pnl=None）不参与求和（§六，与 UI 分组口径一致）。
fn group_pnl(config: &AppConfig, rows: &QuoteRows<'_>, group: &str) -> f64 {
    let mut pnl = 0.0f64;
    for fund in config.holdings.values() {
        let sh_g = fund.allocations.get(group).copied().unwrap_or(0.0);
        if sh_g <= 0.0 {
            continue;
        }
        let Some(row) = rows.get(fund.code.as_str()).copied() else {
            continue;
        };
        let Some(row_pnl) = row.pnl else { continue };
        let total = row.fund.total_shares();
        if total > 0.0 {
            pnl += (row_pnl / total) * sh_g;
        }
    }
    pnl
}

/// 是否存在未分组持仓：以最新 config 的份额为权威（同 group_percent 的理由，
/// 避免重命名/调整分组后依赖过期行情快照误判出多余的 ungrouped 实例）。
fn has_ungrouped(config: &AppConfig, groups: &[String]) -> bool {
    config.holdings.values().any(|fund| {
        fund.allocations
            .iter()
            .any(|(g, sh)| (*sh > 0.0) && !groups.iter().any(|known| known == g))
    })
}

/// menubar/taskbar 是否全空（所有实例都被隐藏，用户把每个分组都移出了显示）。
///
/// 判定（只依赖 config，与行情无关）：
/// 1. 总览（`__overview__`）被隐藏——设置页无法关闭总览，只有 macOS ⌘-拖出会写入该标记
///    （Windows 无拖出通道，本判定恒 false，启动恢复逻辑在 Windows 上自然不触发）；
/// 2. 每个持仓分组都在 `menubar_hidden_groups`；
/// 3. 存在未分组持仓时，未分组实例（`""`）也在隐藏列表。
///
/// ⚠️ 判定口径与前端 `isMenubarEmpty`（packages/ui/src/lib/fundOps.ts）保持一致（两端 1:1 铁律）。
/// 调用场景：⌘-拖出最后一个实例后自动弹 popup-tab；窗口 Destroyed 后全空即退出；启动时全空恢复默认。
pub fn menubar_all_hidden(config: &AppConfig) -> bool {
    let groups = config.settings.holding_groups.clone().unwrap_or_default();
    let hidden = config
        .settings
        .menubar_hidden_groups
        .clone()
        .unwrap_or_default();
    // 1. 总览必须被隐藏
    if !hidden
        .iter()
        .any(|h| h == crate::portfolio::MENUBAR_OVERVIEW_KEY)
    {
        return false;
    }
    // 2. 每个持仓分组必须被隐藏
    for g in &groups {
        if !hidden.iter().any(|h| h == g) {
            return false;
        }
    }
    // 3. 存在未分组持仓时，未分组实例（''）必须也在隐藏列表
    if has_ungrouped(config, &groups) && !hidden.iter().any(|h| h.is_empty()) {
        return false;
    }
    true
}

/// 分组名 → 实例 id 后缀：按字节 hex 编码（每字节两位小写 hex）。
/// 实例 id 只依赖分组名（与 holding_groups 下标无关）→ 分组排序变化不重建实例，
/// macOS 原生「按住 ⌘ 拖拽」调整的菜单栏顺序得以保留。
/// ⚠️ 不能用 percent-encoding：tauri 事件名（`multiline-menubar://{id}//click`）只允许
/// 字母数字 + `-`/`/`/`:`/`_`，`%` 非法（IllegalEventName panic）；hex 字符全部合法且无歧义。
pub(crate) fn encode_group_id(name: &str) -> String {
    let mut out = String::with_capacity(name.len() * 2);
    for b in name.as_bytes() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

pub(crate) fn decode_group_id(enc: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(enc.len() / 2);
    let mut chars = enc.bytes();
    while let (Some(h), Some(l)) = (chars.next(), chars.next()) {
        if let (Some(h), Some(l)) = (hex_val(h), hex_val(l)) {
            out.push(h * 16 + l);
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'A'..=b'F' => Some(c - b'A' + 10),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

/// 一个菜单栏/任务栏实例的期望状态。
///
/// `visible` 与「实例是否在列表里」是**两个独立维度**：
/// - 在列表里 + `visible=true`  → 实例存在且显示
/// - 在列表里 + `visible=false` → 实例存在但隐藏（slot/位置保留，随时原位复活）
/// - 不在列表里                 → 实例不该存在，`sync_instances` 才会真正 `remove` 销毁
pub struct InstanceSpec {
    pub id: String,
    /// 顶行文字（总览 / 分组名 / 未分组）
    pub top: String,
    /// 涨跌百分比
    pub pct: f64,
    /// 收益额
    pub amount: f64,
    /// 是否显示（false = 隐藏但保留实例）
    pub visible: bool,
}

/// 计算期望实例列表。
///
/// 返回**全集**（含设置页里被隐藏的分组），隐藏只体现为 `visible=false`——这样实例永远不被
/// 销毁，开关分组不会丢失位置。只有「分组被删除/重命名」「未分组持仓清空」才会让
/// 对应 id 从列表里消失，进而被 `sync_instances` 真正 remove。
///
/// 实例集合（分组归属/未分组判定）与份额一律以最新 config 为权威，行情仅取 quote。
/// 顺序（同时是 Windows 任务栏 set_order 的依据）：总览 → 各分组（holdingGroups 顺序）→ 未分组。
pub fn desired_instances(config: &AppConfig, quote: Option<&QuoteUpdate>) -> Vec<InstanceSpec> {
    let groups = config.settings.holding_groups.clone().unwrap_or_default();
    let hidden = config
        .settings
        .menubar_hidden_groups
        .clone()
        .unwrap_or_default();
    let rows = quote_rows(quote);

    let mut out: Vec<InstanceSpec> = Vec::new();
    let overview = quote
        .and_then(|q| q.holdings.as_ref())
        .map(|h| h.summary.clone());
    // 总览恒在（实例不销毁）；默认恒显示，但被用户 ⌘-拖出（写入 __overview__ 隐藏标记）后
    // visible=false——设置界面据此解锁总览为可重新开启，开启后恢复恒显。
    let overview_hidden = hidden
        .iter()
        .any(|h| h == crate::portfolio::MENUBAR_OVERVIEW_KEY);
    out.push(InstanceSpec {
        id: INSTANCE_OVERVIEW.to_string(),
        top: "总览".to_string(),
        pct: overview
            .as_ref()
            .map(|s| s.total_pnl_percent)
            .unwrap_or(0.0),
        amount: overview.as_ref().map(|s| s.total_pnl).unwrap_or(0.0),
        visible: !overview_hidden,
    });

    // 每个分组一个实例：隐藏的分组**照样进列表**，只是 visible=false。
    // 实例 id 基于分组名（稳定）：持仓分组拖拽排序只改 holding_groups 顺序、不改 id，
    // 实例既不重建也不销毁 → 菜单栏位置（含 mac 原生 ⌘-拖拽结果）完整保留。
    for g in &groups {
        out.push(InstanceSpec {
            id: format!("menubar-group-{}", encode_group_id(g)),
            top: g.clone(),
            pct: group_percent(config, &rows, g),
            amount: group_pnl(config, &rows, g),
            visible: !hidden.iter().any(|h| h == g),
        });
    }
    // 未分组实例只在「确实存在未分组持仓」时才存在；隐藏同样只翻 visible
    if has_ungrouped(config, &groups) {
        out.push(InstanceSpec {
            id: "menubar-ungrouped".to_string(),
            top: "未分组".to_string(),
            pct: group_percent(config, &rows, ""),
            amount: group_pnl(config, &rows, ""),
            visible: !hidden.iter().any(|h| h.is_empty()),
        });
    }
    out
}

/// 点击实例 id → popup 分组 tab id（与前端 GroupTabs 的 tab id 对齐）：
/// 总览 → 'all'；未分组 → '__ungrouped__'；menubar-group-{enc} → 解码出的分组名。
pub(crate) fn popup_tab_for(id: &str) -> Option<String> {
    if id == INSTANCE_OVERVIEW {
        return Some("all".to_string());
    }
    if id == "menubar-ungrouped" {
        return Some("__ungrouped__".to_string());
    }
    id.strip_prefix("menubar-group-")
        .map(decode_group_id)
        .filter(|name| !name.is_empty())
}

/// 实例 id → 人类可读标签（总览 / 未分组 / 分组名），用于日志排查
pub(crate) fn instance_label(id: &str) -> String {
    if id == INSTANCE_OVERVIEW {
        "总览".to_string()
    } else if id == "menubar-ungrouped" {
        "未分组".to_string()
    } else {
        id.strip_prefix("menubar-group-")
            .map(decode_group_id)
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| id.to_string())
    }
}

/// 计算实例下行文本（收益率百分比或收益额，与颜色判定共用同一数值）。
pub(crate) fn bottom_text_of(spec: &InstanceSpec, show_amount: bool) -> String {
    if show_amount {
        format_amount(spec.amount)
    } else {
        format_pct(spec.pct)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amount_below_100k_full_integer() {
        assert_eq!(format_amount(0.0), "+0");
        assert_eq!(format_amount(856.0), "+856");
        assert_eq!(format_amount(9999.0), "+9999");
        assert_eq!(format_amount(12345.0), "+12345");
        assert_eq!(format_amount(99999.4), "+99999");
        assert_eq!(format_amount(-12345.0), "-12345");
        // 四舍五入到整数，无小数点
        assert_eq!(format_amount(99999.6), "+100000");
    }

    #[test]
    fn amount_from_100k_uses_w() {
        assert_eq!(format_amount(100000.0), "+10w");
        assert_eq!(format_amount(100000.4), "+10.0w");
        assert_eq!(format_amount(123456.0), "+12.3w");
        assert_eq!(format_amount(1000000.0), "+100w");
        // 超过千万不再用 kw，统一 w
        assert_eq!(format_amount(12345678.0), "+1234.6w");
        assert_eq!(format_amount(-123456.0), "-12.3w");
        // 整数缩放后无小数
        assert_eq!(format_amount(150000.0), "+15w");
    }

    #[test]
    fn amount_non_finite() {
        assert_eq!(format_amount(f64::NAN), "+0");
        assert_eq!(format_amount(f64::INFINITY), "+0");
    }

    #[test]
    fn pct_unchanged() {
        assert_eq!(format_pct(12.345), "+12.35%");
        assert_eq!(format_pct(-0.5), "-0.50%");
        assert_eq!(format_pct(123.4), "+123%");
    }

    #[test]
    fn group_id_roundtrip_and_event_safe() {
        for name in [
            "人工智能",
            "测试-分组",
            "A B_C.D",
            "a/b:中",
            "x%y",
            "纯ASCII",
        ] {
            let enc = encode_group_id(name);
            // 事件名合法字符（tauri 校验：字母数字 + - / : _，`%` 非法）→ id 后缀必须只含字母数字
            assert!(
                enc.chars().all(|c| c.is_ascii_alphanumeric()),
                "enc 含非法事件名字符: {enc}",
            );
            assert_eq!(decode_group_id(&enc), name, "roundtrip 失败: {name}");
        }
    }
}
