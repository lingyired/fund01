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

const COLOR_RISE: &str = "#e5484d"; // 涨/红
const COLOR_FALL: &str = "#46a758"; // 跌/绿
const COLOR_FLAT: &str = "#8e8e93"; // 平/灰

static INSTANCE_TRACKED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// 实例 id → click 事件 EventId；实例销毁时 app.unlisten(id) 移除监听，避免闭包永久持有 AppHandle
static CLICK_LISTENERS: OnceLock<Mutex<HashMap<String, tauri::EventId>>> = OnceLock::new();

fn tracked() -> &'static Mutex<HashSet<String>> {
    INSTANCE_TRACKED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn listeners() -> &'static Mutex<HashMap<String, tauri::EventId>> {
    CLICK_LISTENERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn color_for(pct: f64) -> &'static str {
    if pct > 0.0 {
        COLOR_RISE
    } else if pct < 0.0 {
        COLOR_FALL
    } else {
        COLOR_FLAT
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

/// 金额简写（对应 TS `formatShortAmount`：k/w/kw，带符号，保留 1 位小数、放不下再去）。
/// 菜单栏行宽有限，收益额用简写 + 方向符号表达。
fn format_amount(v: f64) -> String {
    if !v.is_finite() {
        return "+0".to_string();
    }
    let sign = if v < 0.0 { "-" } else { "+" };
    let abs = v.abs();
    let (n, unit) = if abs >= 1e7 {
        (abs / 1e7, "kw")
    } else if abs >= 1e4 {
        (abs / 1e4, "w")
    } else if abs >= 1e3 {
        (abs / 1e3, "k")
    } else {
        (abs, "")
    };
    let is_int = (n - n.round()).abs() < 1e-9;
    let cands: &[usize] = if is_int { &[0] } else { &[1, 0] };
    for &d in cands {
        let s = format!("{:.*}{}", d, n, unit);
        if s.len() <= 4 {
            return format!("{sign}{s}");
        }
    }
    format!("{sign}{}{}", n.round(), unit)
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
fn group_percent(config: &AppConfig, rows: &QuoteRows<'_>, group: &str) -> f64 {
    let mut pnl = 0.0f64;
    let mut bod = 0.0f64;
    for fund in config.holdings.values() {
        let sh_g = fund.allocations.get(group).copied().unwrap_or(0.0);
        if sh_g <= 0.0 {
            continue;
        }
        let row = rows.get(fund.code.as_str()).copied();
        pnl += per_share_pnl(row) * sh_g;
        bod += sh_g * row.and_then(|r| r.prev_net_value).unwrap_or(0.0);
    }
    if bod > 0.0 {
        pnl / bod * 100.0
    } else {
        0.0
    }
}

/// 分组收益额：Σ(组内份额分摊的 pnl)（份额取最新 config，每份收益口径同上）
fn group_pnl(config: &AppConfig, rows: &QuoteRows<'_>, group: &str) -> f64 {
    let mut pnl = 0.0f64;
    for fund in config.holdings.values() {
        let sh_g = fund.allocations.get(group).copied().unwrap_or(0.0);
        if sh_g <= 0.0 {
            continue;
        }
        let row = rows.get(fund.code.as_str()).copied();
        pnl += per_share_pnl(row) * sh_g;
    }
    pnl
}

/// 每份收益 = 行内 pnl / 行内总份额（pnl 是「刷新时份额」的整基金收益，
/// 除以旧份额得到每份 Δ净值，再乘以最新份额即可贴合最新持仓）。
fn per_share_pnl(row: Option<&FundQuoteRow>) -> f64 {
    match row {
        Some(r) => {
            let total = r.fund.total_shares();
            if total > 0.0 {
                r.pnl.unwrap_or(0.0) / total
            } else {
                0.0
            }
        }
        None => 0.0,
    }
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

/// 点击事件监听（每个实例一次，记录 EventId 供销毁时移除）：解析状态项 rect → 弹出浮窗
fn ensure_click_listener(app: &AppHandle, id: &str) {
    let mut map = listeners().lock().unwrap();
    if map.contains_key(id) {
        return;
    }
    let event_name = format!("multiline-menubar://{id}//click");
    let app_listener = app.clone();
    let app_handler = app.clone();
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
            show_popup(&app_handler, rect);
        }
    });
    map.insert(id.to_string(), event_id);
}

/// 应用布局模式与上下行字号（对所有 desired 实例统一设置，含已存在实例）。
/// rebuild（布局/字号/隐藏变更）与 update（刷新兜底）路径都会调用，幂等。
/// 每种布局的字号独立存储：布局 0（下大上小）用 top/bottom（7-10 / 10-14），
/// 布局 2（等大）用 equal（8-11，上限受插件原生 clamp 限制）并两行对称。
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
            .unwrap_or(12.0)
            .clamp(10.0, 14.0);
        (t, b)
    };
    for (id, _, _, _) in desired {
        let _ = mb.set_layout(id.clone(), layout);
        let _ = mb.set_font_sizes(id.clone(), top, bottom);
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
    let desired = desired_instances(&config, quote);
    // 刷新后分组/持仓可能已变化：先收敛实例集合 + 应用布局字号，再更新文字
    sync_instances(app, &desired);
    apply_menubar_style(app, &config, &desired);
    let mb = app.multiline_menubar();
    for (id, top, pct, amount) in desired {
        let (bottom, color) = if show_amount {
            (format_amount(amount), color_for(amount))
        } else {
            (format_pct(pct), color_for(pct))
        };
        let _ = mb.set_text(id.clone(), top.clone(), bottom.clone());
        let _ = mb.set_colors(id.clone(), ColorStyle::Default, ColorStyle::Solid { value: color.to_string() });
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
