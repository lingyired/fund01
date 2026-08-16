//! menubar 多实例编排：总览恒在 + 每个持仓分组一个实例 + 未分组兜底。
//! 实例 id：menubar-overview / menubar-group-{分组名 hex 编码} / menubar-ungrouped。
//!
//! # 实例生命周期模型（务必遵守，勿回退）
//!
//! 对齐插件 demo（`examples/demo/src/main.js`）与 `docs/INTEGRATION-NOTES.md` 的「合并模型」：
//! **实例的存在与显隐是两件事**。
//!
//! - **create 一次，终生不销毁**：分组只要还在 `holdingGroups` 里，对应实例就一直存在。
//! - **显隐一律走 `set_visible`**：设置页开关分组、⌘-拖出，都只翻 `visible`，实例与它在菜单栏
//!   里的 slot 保持不变，重新显示即原位复活。
//! - **只有实例「真的不该存在」时才 `remove`**：分组被删除/重命名、未分组持仓清空。
//!
//! ⚠️ 绝对不要把 `remove` 当日常显隐开关用。插件原生层注释（`multiline_menubar.mm:723-730`）
//! 写明：macOS 13+ 之所以用 `statusItem.visible` 而不是 `removeStatusItem`，正因为后者
//! **loses position**；插件也从不设 `autosaveName`，位置全靠系统运行时簿记，销毁即丢。
//! 历史事故：曾用 remove 做显隐 + 在主线程 create 后立刻同步查 `is_visible` 误判不可见 →
//! 销毁重建 churn → 分组实例被 macOS 定位到 y=-22 屏幕外（详见 docs/ 诊断记录）。
//!
//! ⚠️ 插件原生层 `create`/`set_visible`/`set_*` 都是 `dispatch_async(main)`（异步入队），
//! 而 `is_visible`/`rect` 是 `run_on_main_sync`（在主线程调用时 inline 立即执行）。
//! **禁止在同一主线程 turn 内 create 完就同步查 `is_visible`**——必然读到实例还不存在。
//! 本模块因此完全不做可见性回读，只做幂等的 `set_visible` 声明式下发。

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

const COLOR_RISE_DEFAULT: &str = "#FF4F44"; // 涨/红（默认，可配置 menubarRiseColor）
const COLOR_FALL_DEFAULT: &str = "#34C759"; // 跌/绿（默认，可配置 menubarFallColor）
const COLOR_FLAT_DEFAULT: &str = "#8e8e93"; // 平/灰（默认，可配置 menubarFlatColor）
const COLOR_TOP_DEFAULT: &str = "#ffffff"; // 上行固定色默认（可配置 menubarTopColor）

/// 已 create 过的实例 id（会话级）。等价 demo 的 `createdPersistent` Set：
/// create 去重守卫，保证同一 id 在一次运行内只 create 一次。
static INSTANCE_TRACKED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// 实例 id → click 事件 EventId；实例销毁时 app.unlisten(id) 移除监听，避免闭包永久持有 AppHandle
static CLICK_LISTENERS: OnceLock<Mutex<HashMap<String, tauri::EventId>>> = OnceLock::new();
/// 实例 id → remove 事件 EventId（插件 v1.6.0 用户拖出时 emit multiline-menubar://{id}//remove）
static REMOVE_LISTENERS: OnceLock<Mutex<HashMap<String, tauri::EventId>>> = OnceLock::new();

fn tracked() -> &'static Mutex<HashSet<String>> {
    INSTANCE_TRACKED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn listeners() -> &'static Mutex<HashMap<String, tauri::EventId>> {
    CLICK_LISTENERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remove_listeners() -> &'static Mutex<HashMap<String, tauri::EventId>> {
    REMOVE_LISTENERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn color_for(pct: f64, rise: &str, fall: &str, flat: &str) -> String {
    if pct > 0.0 {
        rise.to_string()
    } else if pct < 0.0 {
        fall.to_string()
    } else {
        flat.to_string()
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

/// menubar 是否全空（所有菜单栏实例都被隐藏，用户把每个状态项都移出了菜单栏）。
///
/// 判定（只依赖 config，与行情无关）：
/// 1. 总览（`__overview__`）被隐藏——设置页无法关闭总览，只有 macOS ⌘-拖出会写入该标记；
/// 2. 每个持仓分组都在 `menubar_hidden_groups`；
/// 3. 存在未分组持仓时，未分组实例（`""`）也在隐藏列表。
///
/// ⚠️ 判定口径与前端 `isMenubarEmpty`（packages/ui/src/lib/fundOps.ts）保持一致（两端 1:1 铁律）。
/// 调用场景：⌘-拖出最后一个实例后自动弹 popup-tab；窗口 Destroyed 后全空即退出；启动时全空恢复默认。
pub fn menubar_all_hidden(config: &AppConfig) -> bool {
    let groups = config.settings.holding_groups.clone().unwrap_or_default();
    let hidden = config.settings.menubar_hidden_groups.clone().unwrap_or_default();
    // 1. 总览必须被隐藏
    if !hidden.iter().any(|h| h == crate::portfolio::MENUBAR_OVERVIEW_KEY) {
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

/// 一个菜单栏实例的期望状态。
///
/// `visible` 与「实例是否在列表里」是**两个独立维度**：
/// - 在列表里 + `visible=true`  → 实例存在且显示在菜单栏
/// - 在列表里 + `visible=false` → 实例存在但隐藏（slot/位置保留，随时原位复活）
/// - 不在列表里                 → 实例不该存在，`sync_instances` 才会真正 `remove` 销毁
struct InstanceSpec {
    id: String,
    /// 顶行文字（总览 / 分组名 / 未分组）
    top: String,
    /// 涨跌百分比
    pct: f64,
    /// 收益额
    amount: f64,
    /// 是否显示在菜单栏（false = 隐藏但保留实例）
    visible: bool,
}

/// 计算期望实例列表。
///
/// 返回**全集**（含设置页里被隐藏的分组），隐藏只体现为 `visible=false`——这样实例永远不被
/// 销毁，开关分组不会丢失菜单栏位置。只有「分组被删除/重命名」「未分组持仓清空」才会让
/// 对应 id 从列表里消失，进而被 `sync_instances` 真正 remove。
///
/// 实例集合（分组归属/未分组判定）与份额一律以最新 config 为权威，行情仅取 quote。
fn desired_instances(config: &AppConfig, quote: Option<&QuoteUpdate>) -> Vec<InstanceSpec> {
    let groups = config.settings.holding_groups.clone().unwrap_or_default();
    let hidden = config.settings.menubar_hidden_groups.clone().unwrap_or_default();
    let rows = quote_rows(quote);

    let mut out: Vec<InstanceSpec> = Vec::new();
    let overview = quote.and_then(|q| q.holdings.as_ref()).map(|h| h.summary.clone());
    // 总览恒在（实例不销毁）；默认恒显示，但被用户 ⌘-拖出（写入 __overview__ 隐藏标记）后
    // visible=false——设置界面据此解锁总览为可重新开启，开启后恢复恒显。
    let overview_hidden = hidden
        .iter()
        .any(|h| h == crate::portfolio::MENUBAR_OVERVIEW_KEY);
    out.push(InstanceSpec {
        id: INSTANCE_OVERVIEW.to_string(),
        top: "总览".to_string(),
        pct: overview.as_ref().map(|s| s.total_pnl_percent).unwrap_or(0.0),
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

/// 应用布局模式、上下行字号、字体族、加粗与对齐（对所有 desired 实例统一设置，含已存在实例）。
/// rebuild（布局/字号/隐藏变更）与 update（刷新兜底）路径都会调用，幂等。
/// 每种布局的字号独立存储：布局 0（下大上小）用 top/bottom（7-10 / 10-14），
/// 布局 2（等大）用 equal（8-11，上限受插件原生 clamp 限制）并两行对称。
/// 字体/加粗/对齐与布局无关，上下行独立（默认上下行系统字体：上行不加粗 / 下行加粗；
/// 对齐默认左对齐 0，0=左 1=中 2=右，非法值插件原生按左处理）。
fn apply_menubar_style(app: &AppHandle, config: &AppConfig, desired: &[InstanceSpec]) {
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
    // 对齐：仅 0|1|2 合法（0=左 1=中 2=右），非法回落 0
    let align_of = |v: Option<u8>| match v {
        Some(1) => 1,
        Some(2) => 2,
        _ => 0,
    };
    let top_align = align_of(config.settings.menubar_top_align);
    let bottom_align = align_of(config.settings.menubar_bottom_align);
    // 隐藏的实例也一并设置：再次显示时样式已经是最新的，无需额外同步
    for spec in desired {
        apply_menubar_style_one(
            app,
            spec,
            layout,
            top,
            bottom,
            &top_font,
            &bottom_font,
            top_bold,
            bottom_bold,
            top_align,
            bottom_align,
        );
    }
}

/// 对单个实例下发布局/字号/字体族/加粗/对齐。ready 事件 handler 也调用本函数，
/// 让 plugin 用已挂载的真实 view 重测文字高度（修复 release 下 view 首帧未就绪时被
/// setFontSizes 算成偏矮 view height 的稳态裁切）。
fn apply_menubar_style_one(
    app: &AppHandle,
    spec: &InstanceSpec,
    layout: i32,
    top_size: f64,
    bottom_size: f64,
    top_font: &Option<String>,
    bottom_font: &Option<String>,
    top_bold: bool,
    bottom_bold: bool,
    top_align: i32,
    bottom_align: i32,
) {
    let mb = app.multiline_menubar();
    let _ = mb.set_layout(spec.id.clone(), layout);
    let _ = mb.set_font_sizes(spec.id.clone(), top_size, bottom_size);
    let _ = mb.set_font_family(spec.id.clone(), top_font.clone(), bottom_font.clone());
    let _ = mb.set_bold(spec.id.clone(), top_bold, bottom_bold);
    let _ = mb.set_alignment(spec.id.clone(), top_align, bottom_align);
}

/// 收敛实例集合：创建缺失实例（+点击监听）、销毁多余实例（+移除监听）。
/// 实例 id → 人类可读标签（总览 / 未分组 / 分组名），用于日志排查
fn instance_label(id: &str) -> String {
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

/// 收敛实例集合与显隐状态。幂等，rebuild 与 update 共用。
///
/// 三步，顺序不可调换（`set_visible(false)` 对不存在的实例是 no-op，必须先 create）：
/// 1. **create 缺失实例**（tracked 去重，等价 demo 的 `createdPersistent`）+ 注册监听；
/// 2. **对每个实例声明式下发 `set_visible`**——这是显隐的唯一通道，不销毁、不重建，
///    因此菜单栏 slot 与位置始终保留，隐藏后再显示是原位复活；
/// 3. **只销毁「不该存在」的实例**：分组被删除/重命名、未分组持仓清空。
///    注意这里的 stale 判定基于 id 集合，而隐藏的分组仍在 desired 里，**不会**被销毁。
///
/// ⚠️ 全程不回读 `is_visible`/`rect`：原生 setter 是 `dispatch_async`，主线程上同步回读必然
/// 读到旧状态（见模块头注释）。`set_visible` 每轮重复下发本身就是幂等自愈——若 macOS 压制了
/// 某个实例，下一次刷新会再下发一次 `visible=YES`，且不会付出销毁重建的代价。
fn sync_instances(app: &AppHandle, desired: &[InstanceSpec]) {
    let mb = app.multiline_menubar();

    // 1. 创建缺失实例 + 监听点击/移除
    for spec in desired {
        let is_new = tracked().lock().unwrap().insert(spec.id.clone());
        if is_new {
            let _ = mb.create(spec.id.clone());
            // 实例创建即挂标准右键菜单（版本/打开设置/退出）——覆盖 update_menubar 路径新建的实例，
            // 保证任何实例都可不依赖「总览」在场右键退出 app（总览可被 ⌘-拖出）。
            set_standard_menu(app, &spec.id);
            eprintln!(
                "[fund01] create 实例 {}（{}）",
                spec.id,
                instance_label(&spec.id)
            );
        }
        ensure_click_listener(app, &spec.id);
        ensure_remove_listener(app, &spec.id);
    }

    // 2. 显隐：唯一通道，幂等下发（create 已入队在前，同一 main queue FIFO，顺序安全）
    for spec in desired {
        let _ = mb.set_visible(spec.id.clone(), spec.visible);
    }

    // 3. 销毁「不该存在」的实例（同步移除 click/remove 监听，释放闭包持有的 AppHandle）。
    //    ⚠️ 只有分组被删除/重命名、未分组消失才会走到这里；设置页隐藏分组**不会**。
    let mut tracked_set = tracked().lock().unwrap();
    let desired_ids: HashSet<&String> = desired.iter().map(|s| &s.id).collect();
    let stale: Vec<String> = tracked_set
        .iter()
        .filter(|id| !desired_ids.contains(id))
        .cloned()
        .collect();
    for id in stale {
        let _ = mb.remove(id.clone());
        tracked_set.remove(&id);
        if let Some(event_id) = listeners().lock().unwrap().remove(&id) {
            app.unlisten(event_id);
        }
        if let Some(event_id) = remove_listeners().lock().unwrap().remove(&id) {
            app.unlisten(event_id);
        }
        eprintln!(
            "[fund01] remove 实例 {id}（{}，分组已删除）",
            instance_label(&id)
        );
    }
}

/// 注册实例的 remove 事件监听（插件 v1.6.0：用户 ⌘-拖出实例时 emit
/// `multiline-menubar://{id}//remove`）。
///
/// 语义对齐 demo：**⌘-拖出 == 在设置页取消勾选**，只把对应分组写进 `menubarHiddenGroups`，
/// 实例本身**保留不销毁**（原生层拖出后 `statusItem` 仍是活对象，`removedByUser=YES`；
/// 之后 `set_visible(true)` 即可原位复活）。设置页开关随 config-change 置灰。
fn ensure_remove_listener(app: &AppHandle, id: &str) {
    let mut map = remove_listeners().lock().unwrap();
    if map.contains_key(id) {
        return;
    }
    let event_name = format!("multiline-menubar://{id}//remove");
    let app_listener = app.clone();
    let instance_id = id.to_string();
    let event_id = app_listener
        .clone()
        .listen(event_name, move |_event| {
        eprintln!("[fund01] menubar remove 事件：id={instance_id}（⌘-拖出，视作取消勾选）");
        // ⌘-拖出 = 用户不想在菜单栏显示该实例 → 同步隐藏到设置（menubarHiddenGroups），
        // 设置页对应分组的「显示」开关随之置灰。实例保留，重新勾选即原位复活。
        // 总览默认恒显不可隐藏，但 macOS 允许 ⌘-拖出 → 写入 __overview__ 标记，设置页解锁为可重新开启；
        // 未分组 id 对应隐藏列表中的 ''。
        let group = if instance_id == "menubar-ungrouped" {
            Some(String::new())
        } else if instance_id == INSTANCE_OVERVIEW {
            Some(crate::portfolio::MENUBAR_OVERVIEW_KEY.to_string())
        } else {
            instance_id
                .strip_prefix("menubar-group-")
                .map(decode_group_id)
                .filter(|n| !n.is_empty())
        };
        if let Some(g) = group {
            let state = app_listener.state::<crate::state::AppState>();
            let mut cfg = state.config.write().unwrap();
            let hidden = cfg.settings.menubar_hidden_groups.get_or_insert_with(Vec::new);
            if !hidden.iter().any(|h| h == &g) {
                hidden.push(g.clone());
            }
            let snapshot = cfg.clone();
            drop(cfg);
            let quote = state.quote.read().unwrap().clone();
            // 持久化 + 广播 config-change（设置页订阅后实时更新开关）+ 收敛
            //（该分组在 desired 里变成 visible=false → set_visible(false)，实例保留）
            crate::commands::persist_config(&app_listener, &snapshot);
            rebuild_menubar(&app_listener, &snapshot, quote.as_ref());
            eprintln!("[fund01] ⌘-拖出 → 分组「{g}」已隐藏（menubarHiddenGroups 已同步）");
            // 最后一个实例也被拖出（menubar 全空）且当前无任何窗口（全静默）→ 自动打开
            // popup-tab 独立页，让用户看到 banner（「恢复菜单栏」/ 关窗即退出）。
            // 有窗口（设置页开着）时不弹——banner 已在窗口内，等用户关掉最后一个窗口即退出。
            if menubar_all_hidden(&snapshot) && !crate::window::has_main_window(&app_listener) {
                eprintln!("[fund01] menubar 全空且无窗口 → 自动打开 popup-tab");
                crate::window::open_popup_tab_window(&app_listener);
            }
        }
    });
    map.insert(id.to_string(), event_id);
}

/// 应用启动 / 配置变更：收敛实例集合与显隐（+ 右键菜单 + 文字/样式）
pub fn rebuild_menubar(app: &AppHandle, config: &AppConfig, quote: Option<&QuoteUpdate>) {
    // 1. 收敛实例集合与显隐（创建缺失 + set_visible + 销毁已删除分组）
    let desired = desired_instances(config, quote);
    sync_instances(app, &desired);

    // 2. 设置右键菜单（打开设置 + 退出）——**每个实例一份**，不只总览。
    //    插件 set_menu 是按实例的 API（payload 带 id），原生层对任意实例 NSStatusItem 挂 NSMenu，
    //    右键即弹出；菜单事件经 muda 全局 handler → Tauri on_menu_event（lib.rs 注册一次，与实例无关），
    //    "quit" 由插件在 Rust 侧直接 app.exit(0)。总览被 ⌘-拖出（隐藏）后，任一其他实例仍可右键退出 app。
    //    ⚠️ 总览本身不可销毁（create 后终生保留，拖出只翻 visible），退出入口不依赖总览在场。
    for spec in &desired {
        set_standard_menu(app, &spec.id);
    }

    // 3. 更新文字与颜色（内部会再次收敛实例集合与显隐 + 应用样式，幂等）
    update_menubar(app, quote);
}

/// 标准右键菜单（每个实例一份）：打开设置 + 退出。
/// 幂等；由 sync_instances 创建实例时挂载 + rebuild_menubar 对全集重挂，
/// 两条路径共用，保证任何创建途径的实例都带右键菜单。
/// ⚠️ 不放版本号行：① 版本在设置窗口/浮窗头部都有显示（v{version}），菜单里重复且无用；
/// ② disabled 置灰首行在部分 macOS 版本下会渲染成带展开箭头的怪异样子（用户反馈 2026-08-16）。
fn set_standard_menu(app: &AppHandle, id: &str) {
    let _ = app.multiline_menubar().set_menu(
        id.to_string(),
        vec![
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
}

/// 每次刷新后：更新全部实例的文字与颜色，并收敛实例集合（不依赖过期快照）。
/// 修改持仓/分组后即使尚未触发 rebuild，刷新也会让实例集合与最新配置对齐。
pub fn update_menubar(app: &AppHandle, quote: Option<&QuoteUpdate>) {
    let config = app.state::<crate::state::AppState>().config.read().unwrap().clone();
    // 数值显示方式：false=收益率百分比，true=收益额（简写）
    let show_amount = config.settings.menubar_show_amount.unwrap_or(false);
    // 颜色：上行固定色（默认白色）；下行按涨跌（涨色/跌色/平色均可配置）
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
    let flat_color = config
        .settings
        .menubar_flat_color
        .clone()
        .unwrap_or_else(|| COLOR_FLAT_DEFAULT.to_string());
    let desired = desired_instances(&config, quote);
    // 刷新后分组/持仓可能已变化：先收敛实例集合，再声明式下发显隐，最后应用布局字号/字体/加粗与文字。
    // 显隐的唯一通道是 sync_instances 内的 set_visible（对齐插件 demo 的合并模型），不回读 is_visible、
    // 不销毁重建——原生 setter 异步入队、getter 同步执行，回读会在 create 后的同一个 runloop turn 内
    // 误判「不可见」进而触发 churn，正是重启后分组实例被定位到屏幕外的根因。
    sync_instances(app, &desired);
    // ⚠️ 顺序约定：**先 set_text 再 apply_menubar_style**。
    // 插件文档明确：只有 setBold/setFontFamily/setAlignment/setMonospaced/setFontSizes 会在
    // **每次调用时** re-measure（按当前文本重新量宽度/布局）；**setText 不触发 re-measure**。
    // 先 set_text 填真实文本、再调 re-measure 的样式 setter，保证测量基于最新文本。
    // （2026-08-13 排查结论：菜单栏下行被裁的根因在插件 drawRect 的高度计算
    // `bottomH = bottomFontSize + 1` 未按字体真实 ascender/descender 留白，见插件仓库 issue；
    // 本顺序约定不解决该问题，仅作为合理的调用顺序保留。）
    for spec in &desired {
        let _ = app
            .multiline_menubar()
            .set_text(spec.id.clone(), spec.top.clone(), bottom_text_of(spec, show_amount));
    }
    apply_menubar_style(app, &config, &desired);
    for spec in &desired {
        apply_colors_tooltip_one(
            &config,
            spec,
            show_amount,
            &top_color,
            &rise_color,
            &fall_color,
            &flat_color,
            app,
        );
    }
}

/// 计算实例下行文本（收益率百分比或收益额，与颜色判定共用同一数值）。
fn bottom_text_of(spec: &InstanceSpec, show_amount: bool) -> String {
    if show_amount {
        format_amount(spec.amount)
    } else {
        format_pct(spec.pct)
    }
}

/// 对单个实例下发颜色与 tooltip（不影响 view 高度测量，可与文本分离）。
fn apply_colors_tooltip_one(
    config: &AppConfig,
    spec: &InstanceSpec,
    show_amount: bool,
    top_color_default: &str,
    rise: &str,
    fall: &str,
    flat: &str,
    app: &AppHandle,
) {
    let mb = app.multiline_menubar();
    let bottom = bottom_text_of(spec, show_amount);
    let color = if show_amount {
        color_for(spec.amount, rise, fall, flat)
    } else {
        color_for(spec.pct, rise, fall, flat)
    };
    // 上行颜色：实例对应分组自定义色（menubarGroupColors）→ 未配置回落全局 topColor。
    // 总览 key=__overview__（可自定义，同分组语义）；未分组 key=''
    let group_key = if spec.id == INSTANCE_OVERVIEW {
        Some(crate::portfolio::MENUBAR_OVERVIEW_KEY.to_string())
    } else if spec.id == "menubar-ungrouped" {
        Some(String::new())
    } else {
        spec.id
            .strip_prefix("menubar-group-")
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
        .unwrap_or_else(|| top_color_default.to_string());
    let _ = mb.set_colors(
        spec.id.clone(),
        ColorStyle::Solid {
            value: instance_top_color,
        },
        ColorStyle::Solid { value: color },
    );
    let _ = mb.set_tooltip(spec.id.clone(), format!("{} {bottom}", spec.top));
}

/// 菜单事件分发（open-settings / quit 等）。
/// lib.rs 注册的 `on_menu_event` 是 Tauri 全局菜单事件：所有实例的右键菜单项都汇聚到这里，
/// 与来源实例无关（item_id 相同则行为一致），因此每个实例的「打开设置…」/「退出 fund01」行为完全等价。
pub fn on_menu_event(app: &AppHandle, item_id: &str) {
    if item_id == "open-settings" {
        open_settings_window(app, None, None);
    }
    // "quit" 由插件在 Rust 侧直接 app.exit(0)，不经过这里
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
