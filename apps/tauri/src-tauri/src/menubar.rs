//! menubar 多实例编排：总览恒在 + 每个持仓分组一个实例 + 未分组兜底。
//! 实例 id：menubar-overview / menubar-group-{分组名 hex 编码} / menubar-ungrouped。
//! 实例总数不限制，用户可在设置页隐藏单个分组来控制数量；macOS 原生「按住 ⌘ 拖出」可移除
//! 单个实例（插件 v1.6.0+ 启用 RemovalAllowed 并 emit remove 事件），本会话内保持消失不复活。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use tauri::AppHandle;
use tauri::Listener;
use tauri::Manager;
use tauri_plugin_multiline_menubar::{ColorStyle, MenuItemDescriptor, MultilineMenubarExt};

use crate::model::{AppConfig, FundQuoteRow, QuoteUpdate};
use crate::window::{open_settings_window, show_popup};

pub const INSTANCE_OVERVIEW: &str = "menubar-overview";

const COLOR_RISE_DEFAULT: &str = "#FF4F44"; // 涨/红（默认，可配置 menubarRiseColor）
const COLOR_FALL_DEFAULT: &str = "#34C759"; // 跌/绿（默认，可配置 menubarFallColor）
const COLOR_FLAT: &str = "#8e8e93"; // 平/灰（固定）
const COLOR_TOP_DEFAULT: &str = "#ffffff"; // 上行固定色默认（可配置 menubarTopColor）

static INSTANCE_TRACKED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// 实例 id → click 事件 EventId；实例销毁时 app.unlisten(id) 移除监听，避免闭包永久持有 AppHandle
static CLICK_LISTENERS: OnceLock<Mutex<HashMap<String, tauri::EventId>>> = OnceLock::new();
/// 用户通过 macOS 原生「⌘-拖出」移除过的实例 id（会话级，重启恢复）：
/// desired_instances 生成时跳过，使该实例保持消失且不被刷新/重建复活。
static REMOVED_BY_USER: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// 实例 id → remove 事件 EventId（插件 v1.6.0 用户拖出时 emit multiline-menubar://{id}//remove）
static REMOVE_LISTENERS: OnceLock<Mutex<HashMap<String, tauri::EventId>>> = OnceLock::new();

fn tracked() -> &'static Mutex<HashSet<String>> {
    INSTANCE_TRACKED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn listeners() -> &'static Mutex<HashMap<String, tauri::EventId>> {
    CLICK_LISTENERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn removed_by_user() -> &'static Mutex<HashSet<String>> {
    REMOVED_BY_USER.get_or_init(|| Mutex::new(HashSet::new()))
}

fn remove_listeners() -> &'static Mutex<HashMap<String, tauri::EventId>> {
    REMOVE_LISTENERS.get_or_init(|| Mutex::new(HashMap::new()))
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

/// 分组名 → menubar 实例 id 后缀：按字节 hex 编码（每字节两位小写 hex）。
/// 实例 id 只依赖分组名（与 holding_groups 下标无关）→ 分组排序变化不重建实例，
/// macOS 原生「按住 ⌘ 拖拽」调整的菜单栏顺序得以保留。
/// ⚠️ 不能用 percent-encoding：tauri 事件名（`multiline-menubar://{id}//click`）只允许
/// 字母数字 + `-`/`/`/`:`/`_`，`%` 非法（IllegalEventName panic）；hex 字符全部合法且无歧义。
fn encode_group_id(name: &str) -> String {
    let mut out = String::with_capacity(name.len() * 2);
    for b in name.as_bytes() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn decode_group_id(enc: &str) -> String {
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

    // 总览恒在；每个分组一个实例（隐藏的分组跳过）。
    // ⚠️ 不再跳过 REMOVED_BY_USER：macOS 的系统记忆会把「创建后被压制的实例」误判成用户移除
    // 并 emit remove 事件，若据此跳过，被压制的分组实例将永远不再重建（菜单栏只剩总览）。
    // 改为由 update_menubar 的全实例可见性自愈兜底：拖出/被压制后下次刷新重新创建 +
    // set_visible(true) 恢复——保证「设置里显示的分组一定出现在菜单栏」。
    // 实例 id 基于分组名（稳定）：持仓分组拖拽排序只改 holding_groups 顺序、不改 id，
    // sync_instances 按 id 集合增删不会重建已有实例 → 菜单栏位置（含 mac 原生拖拽结果）不受影响。
    for g in &groups {
        if hidden.iter().any(|h| h == g) {
            continue;
        }
        let id = format!("menubar-group-{}", encode_group_id(g));
        out.push((
            id,
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
    out
}

/// 点击实例 id → popup 分组 tab id（与前端 GroupTabs 的 tab id 对齐）：
/// 总览 → 'all'；未分组 → '__ungrouped__'；menubar-group-{enc} → 解码出的分组名。
fn popup_tab_for(id: &str) -> Option<String> {
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
            // 实例 id 自带分组名（percent-encode），点击映射直接解码即可
            let tab = popup_tab_for(&instance_id);
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
    let mut created: Vec<String> = Vec::new();
    // 1. 创建缺失实例 + 监听点击/移除
    for (id, _, _, _) in desired {
        let mb = app.multiline_menubar();
        if !tracked().lock().unwrap().contains(id) {
            let _ = mb.create(id.clone());
            tracked().lock().unwrap().insert(id.clone());
            created.push(id.clone());
        }
        ensure_click_listener(app, id);
        ensure_remove_listener(app, id);
    }

    // 2. 销毁多余实例（同步移除 click/remove 监听，释放闭包持有的 AppHandle）
    let mut removed: Vec<String> = Vec::new();
    let mut tracked_set = tracked().lock().unwrap();
    let desired_ids: HashSet<&String> = desired.iter().map(|(id, _, _, _)| id).collect();
    let stale: Vec<String> = tracked_set.iter().filter(|id| !desired_ids.contains(id)).cloned().collect();
    for id in stale {
        let _ = app.multiline_menubar().remove(id.clone());
        tracked_set.remove(&id);
        if let Some(event_id) = listeners().lock().unwrap().remove(&id) {
            app.unlisten(event_id);
        }
        if let Some(event_id) = remove_listeners().lock().unwrap().remove(&id) {
            app.unlisten(event_id);
        }
        // 实例被销毁（分组删除/隐藏）时清掉「用户移除」标记，避免下次重建时被误跳过
        removed_by_user().lock().unwrap().remove(&id);
        removed.push(id.clone());
    }
    if !created.is_empty() || !removed.is_empty() {
        eprintln!(
            "[fund01] sync_instances created=[{}] removed=[{}]",
            created.join(","),
            removed.join(",")
        );
    }
}

/// 注册实例的 remove 事件监听（插件 v1.6.0：用户 ⌘-拖出实例时 emit
/// `multiline-menubar://{id}//remove`）。收到后把该 id 记入 REMOVED_BY_USER——
/// desired_instances 生成时跳过它，使实例在本会话内保持消失、不被刷新/重建复活。
fn ensure_remove_listener(app: &AppHandle, id: &str) {
    let mut map = remove_listeners().lock().unwrap();
    if map.contains_key(id) {
        return;
    }
    let event_name = format!("multiline-menubar://{id}//remove");
    let app_listener = app.clone();
    let instance_id = id.to_string();
    let event_id = app_listener.listen(event_name, move |_event| {
        let mut set = removed_by_user().lock().unwrap();
        set.insert(instance_id.clone());
        // 诊断日志：谁被用户 ⌘-拖出、当前移除集合内容
        eprintln!("[fund01] menubar remove 事件：id={instance_id}，REMOVED_BY_USER={set:?}");
    });
    map.insert(id.to_string(), event_id);
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

    // 3. 更新文字与颜色（内部会再次收敛实例集合 + 应用样式，幂等；
    //    开头自带总览可见性温和兜底：不可见则 set_visible(true)，不销毁重建）
    update_menubar(app, quote);

    // 4. 启动总览恢复任务（会话级一次，rebuild 多次触发时幂等跳过）：
    //    macOS 系统记忆可能在实例创建后才把 visible 置 NO，需延迟重试；
    //    逐步升级：set_visible(true) → 销毁重建 → 终极手段 killall SystemUIServer 重建菜单栏，
    //    实现「总览无论如何都重新显示」。
    spawn_overview_recovery(app);
}

/// 实例当前是否可见（对不存在/未跟踪的实例一律视为不可见）
fn instance_is_visible(app: &AppHandle, id: &str) -> bool {
    app.multiline_menubar()
        .is_visible(id.to_string())
        .unwrap_or(false)
}

/// 总览实例可见性（供启动恢复任务使用）
fn overview_is_visible(app: &AppHandle) -> bool {
    instance_is_visible(app, INSTANCE_OVERVIEW)
}

/// 销毁实例并清掉跟踪/点击/移除监听/用户移除标记（销毁后需重新 create）
fn destroy_instance(app: &AppHandle, id: &str) {
    let mb = app.multiline_menubar();
    let _ = mb.remove(id.to_string());
    tracked().lock().unwrap().remove(id);
    if let Some(eid) = listeners().lock().unwrap().remove(id) {
        app.unlisten(eid);
    }
    if let Some(eid) = remove_listeners().lock().unwrap().remove(id) {
        app.unlisten(eid);
    }
    removed_by_user().lock().unwrap().remove(id);
}

/// 兜底：确保实例显示（总览/分组/未分组通用）。
///
/// 场景：macOS 在用户拖出第三方 status item（含旧版本无 RemovalAllowed 时的异常拖出）后会持久
/// 记忆，重启后创建的同款实例默认不可见；系统设置（控制中心→菜单栏）也可能把 app 或单一项取消
/// 勾选。社区验证的恢复手段（macOS 13+）：显式 `visible = true` 可覆盖系统记忆；仍无效则销毁
/// 重建全新 `NSStatusItem`。实测 set_visible 在「系统持续压制」时可能无效，需要延迟重试 /
/// killall SystemUIServer（见 spawn_overview_recovery）。
///
/// - `force=true`（自愈/启动路径）：无条件 `set_visible(true)` 再校验，无效则销毁重建；
/// - `force=false`（周期路径）：仅不可见时 `set_visible(true)`，**不销毁重建**（避免 60s
///   抖动；真正的恢复交给自愈路径或用户系统设置）。
/// 返回 true 表示执行过销毁重建（调用方需重新收敛实例集合并重刷文字/样式）。
fn ensure_instance_visible(app: &AppHandle, id: &str, force: bool) -> bool {
    let mb = app.multiline_menubar();
    let was_visible = mb.is_visible(id.to_string()).unwrap_or(false);
    if was_visible && !force {
        return false;
    }
    if !was_visible {
        eprintln!("[fund01] 实例 {id} 当前不可见（macOS 记忆/系统设置），尝试 set_visible(true) 恢复");
    }
    // 1) 温和尝试：显式 visible = true（系统记忆下 app 可覆盖）
    let _ = mb.set_visible(id.to_string(), true);
    if mb.is_visible(id.to_string()).unwrap_or(false) {
        if !was_visible {
            eprintln!("[fund01] 实例 {id} set_visible(true) 成功，已恢复显示");
        }
        return false;
    }
    if !force {
        // 周期路径：不销毁重建（避免 60s 抖动），等待自愈路径或用户操作系统设置
        eprintln!("[fund01] 实例 {id} set_visible(true) 无效（周期路径，跳过销毁重建）");
        return false;
    }
    // 2) force 路径：销毁 + 立即重建（create 自带 visible=YES）再校验
    eprintln!("[fund01] 实例 {id} set_visible(true) 无效，销毁重建全新 NSStatusItem");
    destroy_instance(app, id);
    let _ = mb.create(id.to_string());
    tracked().lock().unwrap().insert(id.to_string());
    let _ = mb.set_visible(id.to_string(), true);
    if mb.is_visible(id.to_string()).unwrap_or(false) {
        eprintln!("[fund01] 实例 {id} 重建后可见");
        return true;
    }
    eprintln!("[fund01] 实例 {id} 重建后仍不可见（系统持续压制，等待重试/终极手段）");
    true
}

/// 总览可见性兜底（供启动恢复任务使用；周期路径由 update_menubar 的全实例自愈覆盖）
fn ensure_overview_visible(app: &AppHandle, force: bool) -> bool {
    ensure_instance_visible(app, INSTANCE_OVERVIEW, force)
}

/// 会话级：总览启动恢复是否已执行完（避免每次 rebuild/配置变更都重复跑恢复任务）
static OVERVIEW_RECOVERY_DONE: AtomicBool = AtomicBool::new(false);

/// 启动总览恢复任务：macOS 系统记忆可能在实例创建后才把 visible 置 NO，且 set_visible / 销毁
/// 重建单次尝试可能被系统持续压制——延迟反复尝试，最后用 `killall SystemUIServer`（社区验证可
/// 重建菜单栏、恢复第三方图标）兜底，实现「总览无论如何都重新显示」。
fn spawn_overview_recovery(app: &AppHandle) {
    if OVERVIEW_RECOVERY_DONE.load(Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // 多次延迟重试（约 6 次 × 700ms）：覆盖「创建后才被系统隐藏」的时序
        for attempt in 0..6 {
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            let state = app.state::<crate::state::AppState>();
            let quote = state.quote.read().unwrap().clone();
            if !overview_is_visible(&app) {
                let recreated = ensure_overview_visible(&app, true);
                if recreated {
                    // 销毁重建过 → 重刷文字/样式（sync 不再重复创建）
                    update_menubar(&app, quote.as_ref());
                }
            }
            if overview_is_visible(&app) {
                eprintln!("[fund01] 启动总览恢复成功（第 {} 次尝试）", attempt + 1);
                break;
            }
        }
        // 仍不可见 → 终极手段：重启 SystemUIServer（自动拉起），重建菜单栏
        if !overview_is_visible(&app) {
            eprintln!("[fund01] 总览仍不可见，执行 killall SystemUIServer 重建菜单栏");
            let _ = std::process::Command::new("killall").arg("SystemUIServer").spawn();
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
            let state = app.state::<crate::state::AppState>();
            let quote = state.quote.read().unwrap().clone();
            if !overview_is_visible(&app) {
                let recreated = ensure_overview_visible(&app, true);
                if recreated {
                    update_menubar(&app, quote.as_ref());
                }
            }
            if overview_is_visible(&app) {
                eprintln!("[fund01] SystemUIServer 重建后总览已恢复");
            } else {
                eprintln!("[fund01] 总览仍不可见：请在 系统设置→控制中心→菜单栏 确认 fund01-tauri 已勾选显示");
            }
        }
        OVERVIEW_RECOVERY_DONE.store(true, Ordering::Relaxed);
    });
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
    // 全实例可见性自愈：macOS 系统记忆/设置可能压制任意实例（总览/分组/未分组）的 visible——
    // 不可见 → set_visible(true) → 仍无效 → 销毁重建。保证「设置里显示的分组一定出现在菜单栏」，
    // 不再只救总览（分组被压制后菜单栏只剩总览的问题）。每次刷新（约 60s）+ 每次 rebuild 都跑。
    let mut recreated = false;
    for (id, _, _, _) in &desired {
        if !instance_is_visible(app, id) {
            if ensure_instance_visible(app, id, true) {
                recreated = true;
            }
        }
    }
    if recreated {
        // 重建过的实例补注册 click/remove 监听（destroy 时已移除；sync_instances 幂等）
        sync_instances(app, &desired);
    }
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
                .map(decode_group_id)
                .filter(|n| !n.is_empty())
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
        open_settings_window(app, None, None);
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

    #[test]
    fn group_id_roundtrip_and_event_safe() {
        for name in ["人工智能", "测试-分组", "A B_C.D", "a/b:中", "x%y", "纯ASCII"] {
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
