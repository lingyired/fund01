//! menubar 多实例编排：总览恒在 + 每个持仓分组一个实例 + 未分组兜底。
//! 实例 id：menubar-overview / menubar-group-{idx} / menubar-ungrouped；上限 6 个。

use std::collections::HashSet;
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
static CLICK_LISTENED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn tracked() -> &'static Mutex<HashSet<String>> {
    INSTANCE_TRACKED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn listened() -> &'static Mutex<HashSet<String>> {
    CLICK_LISTENED.get_or_init(|| Mutex::new(HashSet::new()))
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

/// 分组涨跌（%）：Σ(组内份额分摊的 pnl) / Σ(组内份额 × 昨净值)
fn group_percent(rows: &[FundQuoteRow], group: &str) -> f64 {
    let mut pnl = 0.0f64;
    let mut bod = 0.0f64;
    for row in rows {
        let sh_g = row.fund.allocations.get(group).copied().unwrap_or(0.0);
        if sh_g <= 0.0 {
            continue;
        }
        let total_sh = row.fund.total_shares();
        if total_sh <= 0.0 {
            continue;
        }
        let frac = sh_g / total_sh;
        pnl += row.pnl.unwrap_or(0.0) * frac;
        bod += sh_g * row.prev_net_value.unwrap_or(0.0);
    }
    if bod > 0.0 {
        pnl / bod * 100.0
    } else {
        0.0
    }
}

/// 是否存在未分组持仓
fn has_ungrouped(rows: &[FundQuoteRow], groups: &[String]) -> bool {
    rows.iter().any(|row| {
        row.fund
            .allocations
            .iter()
            .any(|(g, sh)| (*sh > 0.0) && !groups.iter().any(|known| known == g))
    })
}

/// 计算期望实例列表：(id, 顶行文字, 涨跌%)
fn desired_instances(config: &AppConfig, quote: Option<&QuoteUpdate>) -> Vec<(String, String, f64)> {
    let groups = config.settings.holding_groups.clone().unwrap_or_default();
    let hidden = config.settings.menubar_hidden_groups.clone().unwrap_or_default();
    let rows: &[FundQuoteRow] = quote
        .and_then(|q| q.holdings.as_ref())
        .map(|h| h.list.as_slice())
        .unwrap_or(&[]);

    let mut out: Vec<(String, String, f64)> = Vec::new();
    let overview_pct = quote
        .and_then(|q| q.holdings.as_ref())
        .map(|h| h.summary.total_pnl_percent)
        .unwrap_or(0.0);
    out.push((INSTANCE_OVERVIEW.to_string(), "总览".to_string(), overview_pct));

    // 总览恒在；每个分组一个实例（隐藏的分组跳过，idx 保持原始序号 → id 稳定）
    for (idx, g) in groups.iter().enumerate() {
        if hidden.iter().any(|h| h == g) {
            continue;
        }
        out.push((format!("menubar-group-{idx}"), g.clone(), group_percent(rows, g)));
    }
    if has_ungrouped(rows, &groups) && !hidden.iter().any(|h| h.is_empty()) {
        out.push(("menubar-ungrouped".to_string(), "未分组".to_string(), group_percent(rows, "")));
    }
    out.truncate(MAX_INSTANCES);
    out
}

/// 点击事件监听（每个实例一次）：解析状态项 rect → 弹出浮窗
fn ensure_click_listener(app: &AppHandle, id: &str) {
    let mut listened = listened().lock().unwrap();
    if listened.contains(id) {
        return;
    }
    let event_name = format!("multiline-menubar://{id}//click");
    let app_listener = app.clone();
    let app_handler = app.clone();
    app_listener.listen(event_name, move |event| {
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
    listened.insert(id.to_string());
}

/// 应用布局模式与上下行字号（对所有 desired 实例统一设置，含已存在实例）。
/// 布局/字号变更只能靠 rebuild 路径应用（update_menubar 只碰文字/颜色）。
fn apply_menubar_style(app: &AppHandle, config: &AppConfig, desired: &[(String, String, f64)]) {
    let mb = app.multiline_menubar();
    let layout = i32::from(config.settings.menubar_layout.unwrap_or(0).min(2));
    // 位置语义字号；未设置时按布局默认（与插件原生默认一致 0:7/12 1:12/7 2:9/9）
    let top = config
        .settings
        .menubar_top_font_size
        .unwrap_or(if layout == 1 { 12.0 } else { 7.0 })
        .clamp(5.0, 16.0);
    let mut bottom = config
        .settings
        .menubar_bottom_font_size
        .unwrap_or(if layout == 1 { 7.0 } else { 12.0 })
        .clamp(5.0, 16.0);
    if layout == 2 {
        bottom = top; // 等大强制对称兜底（插件会再 clamp 5-11，对称保持）
    }
    for (id, _, _) in desired {
        let _ = mb.set_layout(id.clone(), layout);
        let _ = mb.set_font_sizes(id.clone(), top, bottom);
    }
}

/// 应用启动 / 配置变更：重建实例集合
pub fn rebuild_menubar(app: &AppHandle, config: &AppConfig, quote: Option<&QuoteUpdate>) {
    let desired = desired_instances(config, quote);

    // 1. 创建缺失实例 + 监听点击
    for (id, _, _) in &desired {
        let mb = app.multiline_menubar();
        if !tracked().lock().unwrap().contains(id) {
            let _ = mb.create(id.clone());
            tracked().lock().unwrap().insert(id.clone());
        }
        ensure_click_listener(app, id);
    }

    // 2. 销毁多余实例
    let mut tracked_set = tracked().lock().unwrap();
    let desired_ids: HashSet<&String> = desired.iter().map(|(id, _, _)| id).collect();
    let stale: Vec<String> = tracked_set.iter().filter(|id| !desired_ids.contains(id)).cloned().collect();
    for id in stale {
        let _ = app.multiline_menubar().remove(id.clone());
        tracked_set.remove(&id);
    }

    // 3. 应用布局模式与字号（对所有实例）
    apply_menubar_style(app, config, &desired);

    // 4. 设置右键菜单（版本 + 打开设置 + 退出）
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

    // 5. 更新文字与颜色
    update_menubar(app, quote);
}

/// 每次刷新后：更新全部实例的文字与颜色（不增删实例）
pub fn update_menubar(app: &AppHandle, quote: Option<&QuoteUpdate>) {
    let config = app.state::<crate::state::AppState>().config.read().unwrap().clone();
    let desired = desired_instances(&config, quote);
    let mb = app.multiline_menubar();
    for (id, top, pct) in desired {
        let bottom = format_pct(pct);
        let color = color_for(pct).to_string();
        let _ = mb.set_text(id.clone(), top.clone(), bottom.clone());
        let _ = mb.set_colors(id.clone(), ColorStyle::Default, ColorStyle::Solid { value: color });
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
