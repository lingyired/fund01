//! menubar 多实例编排：总览恒在 + 每个持仓分组一个实例 + 未分组兜底。
//! 实例 id：menubar-overview / menubar-group-{idx} / menubar-ungrouped；上限 6 个。

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use tauri::AppHandle;
use tauri::Listener;
use tauri::Manager;
use tauri_plugin_multiline_menubar::{ColorStyle, MenuItemDescriptor, MultilineMenubarExt};

use crate::model::{AppConfig, FundQuoteRow, QuoteUpdate};
use crate::window::{open_settings_window, show_popup};

pub const INSTANCE_OVERVIEW: &str = "menubar-overview";
const MAX_INSTANCES: usize = 6;

const COLOR_RISE_DEFAULT: &str = "#FF4F44"; // 涨/红（默认，可配置 menubarRiseColor）
const COLOR_FALL_DEFAULT: &str = "#34C759"; // 跌/绿（默认，可配置 menubarFallColor）
const COLOR_FLAT: &str = "#8e8e93"; // 平/灰（固定）
const COLOR_TOP_DEFAULT: &str = "#ffffff"; // 上行固定色默认（可配置 menubarTopColor）

static INSTANCE_TRACKED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// 实例 id → click 事件 EventId；实例销毁时 app.unlisten(id) 移除监听，避免闭包永久持有 AppHandle
static CLICK_LISTENERS: OnceLock<Mutex<HashMap<String, tauri::EventId>>> = OnceLock::new();

fn tracked() -> &'static Mutex<HashSet<String>> {
    INSTANCE_TRACKED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn listeners() -> &'static Mutex<HashMap<String, tauri::EventId>> {
    CLICK_LISTENERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn color_for(pct: f64, rise: &str, fall: &str) -> String {
    if pct > 0.0 {
        rise.to_string()
    } else if pct < 0.0 {
        fall.to_string()
    } else {
        COLOR_FLAT.to_string()
    }
}

fn format_pct(pct: f64) -> String {
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
fn format_amount(v: f64) -> String {
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
        let Some(row) = rows.get(fund.code.as_str()).copied() else { continue };
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
        let Some(row) = rows.get(fund.code.as_str()).copied() else { continue };
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

/// 计算期望实例列表：(id, 顶行文字, 涨跌%, 收益额)
/// 实例集合（分组归属/未分组判定）与份额一律以最新 config 为权威，行情仅取 quote。
fn desired_instances(
    config: &AppConfig,
    quote: Option<&QuoteUpdate>,
) -> Vec<(String, String, f64, f64)> {
    let groups = config.settings.holding_groups.clone().unwrap_or_default();
    let hidden = config.settings.menubar_hidden_groups.clone().unwrap_or_default();
    let rows = quote_rows(quote);

    let mut out: Vec<(String, String, f64, f64)> = Vec::new();
    let overview = quote.and_then(|q| q.holdings.as_ref()).map(|h| h.summary.clone());
    let overview_pct = overview.as_ref().map(|s| s.total_pnl_percent).unwrap_or(0.0);
    let overview_amount = overview.as_ref().map(|s| s.total_pnl).unwrap_or(0.0);
    out.push((
        INSTANCE_OVERVIEW.to_string(),
        "总览".to_string(),
        overview_pct,
        overview_amount,
    ));

    // 总览恒在；每个分组一个实例（隐藏的分组跳过，idx 保持原始序号 → id 稳定）
    for (idx, g) in groups.iter().enumerate() {
        if hidden.iter().any(|h| h == g) {
            continue;
        }
        out.push((
            format!("menubar-group-{idx}"),
            g.clone(),
            group_percent(config, &rows, g),
            group_pnl(config, &rows, g),
        ));
    }
    if has_ungrouped(config, &groups) && !hidden.iter().any(|h| h.is_empty()) {
        out.push((
            "menubar-ungrouped".to_string(),
            "未分组".to_string(),
            group_percent(config, &rows, ""),
            group_pnl(config, &rows, ""),
        ));
    }
    out.truncate(MAX_INSTANCES);
    out
}

/// 点击实例 id → popup 分组 tab id（与前端 GroupTabs 的 tab id 对齐）：
/// 总览 → 'all'；未分组 → '__ungrouped__'；menubar-group-{idx} → holding_groups[idx]（分组名）。
fn popup_tab_for(config: &AppConfig, id: &str) -> Option<String> {
    if id == INSTANCE_OVERVIEW {
        return Some("all".to_string());
    }
    if id == "menubar-ungrouped" {
        return Some("__ungrouped__".to_string());
    }
    id.strip_prefix("menubar-group-")
        .and_then(|s| s.parse::<usize>().ok())
        .and_then(|i| {
            config
                .settings
                .holding_groups
                .as_ref()
                .and_then(|g| g.get(i).cloned())
        })
}

/// 点击事件监听（每个实例一次，记录 EventId 供销毁时移除）：解析状态项 rect → 弹出浮窗，
/// 并把该实例对应的分组 tab id 一并传给浮窗（popup 直达该分组 tab）
fn ensure_click_listener(app: &AppHandle, id: &str) {
    let mut map = listeners().lock().unwrap();
    if map.contains_key(id) {
        return;
    }
    let event_name = format!("multiline-menubar://{id}//click");
    let app_listener = app.clone();
    let app_handler = app.clone();
    let instance_id = id.to_string();
    let event_id = app_listener.listen(event_name, move |event| {
        let payload: Value = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
        let rect = payload
            .get("rect")
            .map(|r| {
                (
                    r.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    r.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    r.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    r.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0),
                )
            })
            .filter(|(_, _, w, h)| *w > 0.0 && *h > 0.0);
        // 右键（菜单）由原生层处理；这里只处理左键
        if payload.get("button").and_then(|v| v.as_str()) == Some("left") {
            // 实例 id 与分组归属以最新 config 为权威（分组可能已重命名/删除）
            let state = app_handler.state::<crate::state::AppState>();
            let config = state.config.read().unwrap().clone();
            let tab = popup_tab_for(&config, &instance_id);
            drop(state);
            show_popup(&app_handler, rect, tab.as_deref());
        }
    });
    map.insert(id.to_string(), event_id);
}

/// 应用布局模式、上下行字号、字体族与加粗（对所有 desired 实例统一设置，含已存在实例）。
/// rebuild（布局/字号/隐藏变更）与 update（刷新兜底）路径都会调用，幂等。
/// 每种布局的字号独立存储：布局 0（下大上小）用 top/bottom（7-10 / 10-14），
/// 布局 2（等大）用 equal（8-11，上限受插件原生 clamp 限制）并两行对称。
/// 字体/加粗与布局无关，上下行独立（默认上行 Hiragino Sans GB 不加粗 / 下行 Menlo 加粗）。
fn apply_menubar_style(app: &AppHandle, config: &AppConfig, desired: &[(String, String, f64, f64)]) {
    let mb = app.multiline_menubar();
    let layout = i32::from(config.settings.menubar_layout.unwrap_or(0).min(2));
    let (top, bottom) = if layout == 2 {
        let eq = config
            .settings
            .menubar_equal_font_size
            .unwrap_or(9.0)
            .clamp(8.0, 11.0);
        (eq, eq)
    } else {
        let t = config
            .settings
            .menubar_top_font_size
            .unwrap_or(7.0)
            .clamp(7.0, 10.0);
        let b = config
            .settings
            .menubar_bottom_font_size
            .unwrap_or(11.0)
            .clamp(10.0, 14.0);
        (t, b)
    };
    // 字体族：空串/None → 系统字体（插件原生回退）
    let top_font = config
        .settings
        .menubar_top_font
        .clone()
        .filter(|s| !s.trim().is_empty());
    let bottom_font = config
        .settings
        .menubar_bottom_font
        .clone()
        .filter(|s| !s.trim().is_empty());
    let top_bold = config.settings.menubar_top_bold.unwrap_or(false);
    let bottom_bold = config.settings.menubar_bottom_bold.unwrap_or(true);
    for (id, _, _, _) in desired {
        let _ = mb.set_layout(id.clone(), layout);
        let _ = mb.set_font_sizes(id.clone(), top, bottom);
        let _ = mb.set_font_family(id.clone(), top_font.clone(), bottom_font.clone());
        let _ = mb.set_bold(id.clone(), top_bold, bottom_bold);
    }
}

/// 收敛实例集合：创建缺失实例（+点击监听）、销毁多余实例（+移除监听）。
/// 幂等，rebuild 与 update 共用——保证任何时刻菜单栏实例与「最新 config + 行情」对齐，
/// 避免分组/持仓变更后（尤其刷新完成后）多余实例残留、正确实例缺失。
fn sync_instances(app: &AppHandle, desired: &[(String, String, f64, f64)]) {
    // 1. 创建缺失实例 + 监听点击
    for (id, _, _, _) in desired {
        let mb = app.multiline_menubar();
        if !tracked().lock().unwrap().contains(id) {
            let _ = mb.create(id.clone());
            tracked().lock().unwrap().insert(id.clone());
        }
        ensure_click_listener(app, id);
    }

    // 2. 销毁多余实例（同步移除 click 监听，释放闭包持有的 AppHandle）
    let mut tracked_set = tracked().lock().unwrap();
    let desired_ids: HashSet<&String> = desired.iter().map(|(id, _, _, _)| id).collect();
    let stale: Vec<String> = tracked_set.iter().filter(|id| !desired_ids.contains(id)).cloned().collect();
    for id in stale {
        let _ = app.multiline_menubar().remove(id.clone());
        tracked_set.remove(&id);
        if let Some(event_id) = listeners().lock().unwrap().remove(&id) {
            app.unlisten(event_id);
        }
    }
}

/// 应用启动 / 配置变更：重建实例集合（实例增删 + 右键菜单 + 文字/样式）
pub fn rebuild_menubar(app: &AppHandle, config: &AppConfig, quote: Option<&QuoteUpdate>) {
    // 1. 收敛实例集合（创建缺失 + 销毁多余）
    sync_instances(app, &desired_instances(config, quote));

    // 2. 设置右键菜单（版本 + 打开设置 + 退出）
    let version = env!("CARGO_PKG_VERSION").to_string();
    let _ = app.multiline_menubar().set_menu(
        INSTANCE_OVERVIEW.to_string(),
        vec![
            MenuItemDescriptor::Item {
                id: "version".to_string(),
                text: format!("fund01 v{version}"),
                accelerator: None,
                disabled: Some(true),
            },
            MenuItemDescriptor::Separator,
            MenuItemDescriptor::Item {
                id: "open-settings".to_string(),
                text: "打开设置…".to_string(),
                accelerator: None,
                disabled: None,
            },
            MenuItemDescriptor::Separator,
            MenuItemDescriptor::Item {
                id: "quit".to_string(),
                text: "退出 fund01".to_string(),
                accelerator: None,
                disabled: None,
            },
        ],
    );

    // 3. 更新文字与颜色（内部会再次收敛实例集合 + 应用样式，幂等）
    update_menubar(app, quote);
}

/// 每次刷新后：更新全部实例的文字与颜色，并收敛实例集合（不依赖过期快照）。
/// 修改持仓/分组后即使尚未触发 rebuild，刷新也会让实例集合与最新配置对齐。
pub fn update_menubar(app: &AppHandle, quote: Option<&QuoteUpdate>) {
    let config = app.state::<crate::state::AppState>().config.read().unwrap().clone();
    // 数值显示方式：false=收益率百分比，true=收益额（简写）
    let show_amount = config.settings.menubar_show_amount.unwrap_or(false);
    // 颜色：上行固定色（默认白色）；下行按涨跌（涨色/跌色可配置，平盘灰固定）
    let top_color = config
        .settings
        .menubar_top_color
        .clone()
        .unwrap_or_else(|| COLOR_TOP_DEFAULT.to_string());
    let rise_color = config
        .settings
        .menubar_rise_color
        .clone()
        .unwrap_or_else(|| COLOR_RISE_DEFAULT.to_string());
    let fall_color = config
        .settings
        .menubar_fall_color
        .clone()
        .unwrap_or_else(|| COLOR_FALL_DEFAULT.to_string());
    let desired = desired_instances(&config, quote);
    // 刷新后分组/持仓可能已变化：先收敛实例集合 + 应用布局字号/字体/加粗，再更新文字
    sync_instances(app, &desired);
    apply_menubar_style(app, &config, &desired);
    let mb = app.multiline_menubar();
    for (id, top, pct, amount) in desired {
        let (bottom, color) = if show_amount {
            (format_amount(amount), color_for(amount, &rise_color, &fall_color))
        } else {
            (format_pct(pct), color_for(pct, &rise_color, &fall_color))
        };
        // 上行颜色：实例对应分组自定义色（menubarGroupColors）→ 未配置回落全局 topColor。
        // 总览 key=__overview__（可自定义，同分组语义）；未分组 key=''
        let group_key = if id == INSTANCE_OVERVIEW {
            Some(crate::portfolio::MENUBAR_OVERVIEW_KEY.to_string())
        } else if id == "menubar-ungrouped" {
            Some(String::new())
        } else {
            id.strip_prefix("menubar-group-")
                .and_then(|s| s.parse::<usize>().ok())
                .and_then(|i| {
                    config
                        .settings
                        .holding_groups
                        .as_ref()
                        .and_then(|g| g.get(i))
                })
                .map(|g| g.clone())
        };
        let instance_top_color = group_key
            .and_then(|k| {
                config
                    .settings
                    .menubar_group_colors
                    .as_ref()
                    .and_then(|m| m.get(&k))
            })
            .cloned()
            .unwrap_or_else(|| top_color.clone());
        let _ = mb.set_text(id.clone(), top.clone(), bottom.clone());
        let _ = mb.set_colors(
            id.clone(),
            ColorStyle::Solid { value: instance_top_color },
            ColorStyle::Solid { value: color },
        );
        let _ = mb.set_tooltip(id.clone(), format!("{top} {bottom}"));
    }
}

/// 菜单事件分发（open-settings / quit 等）
pub fn on_menu_event(app: &AppHandle, item_id: &str) {
    if item_id == "open-settings" {
        open_settings_window(app, None);
    }
    // "quit" 由插件在 Rust 侧直接 app.exit(0)
}

/// 供 refresh 后调用（避免与 config 锁死）
pub fn update_menubar_with(app: &AppHandle, quote: &Option<QuoteUpdate>) {
    update_menubar(app, quote.as_ref());
}

#[allow(dead_code)]
fn _unused(_: &Value) {}

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
}
