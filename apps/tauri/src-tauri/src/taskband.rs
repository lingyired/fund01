//! taskband 多实例编排（Windows 任务栏，multiline-taskband 插件）。
//! 实例 id 与 macOS menubar 完全一致：menubar-overview / menubar-group-{hex} / menubar-ungrouped，
//! 纯逻辑（期望实例集合、涨跌口径、id 编解码）复用 `menubar_common.rs`，本模块只做插件编排。
//!
//! # 与 macOS menubar.rs 的差异（务必了解，详见 docs/tauri-plugin-multiline-taskband-适配说明.md）
//!
//! - **多三个定位概念**：每实例 `set_side`（左/右缘，默认右）+ `set_order`（同侧排序，
//!   用 desired 顺序：总览 0 → 分组按 holdingGroups 序 → 未分组最后，总览最靠右/最靠左缘起点）
//!   + 全局 `set_edge_margins`（左右缘留白，物理像素，避开开始按钮/其他图标）。
//! - **少三个能力**：无 `set_layout`（固定上下两行，字号直接用布局 0 的上行/下行字段）、
//!   无 `set_tooltip`、无 ⌘-拖出的 `//remove` 事件（Windows 隐藏分组只能走设置页开关）。
//! - **`quit` 不是插件保留 id**：菜单事件经 muda → Tauri 全局 `on_menu_event`（插件内部 handler
//!   另发 `multiline-taskband://{id}//menu`，宿主不监听），`open-settings`/`quit` 都由本模块处理，
//!   `quit` 直接 `app.exit(0)`（Windows 无 macOS trackMouse 收尾问题，无需延迟退出）。
//!   插件要求菜单项 id 形如 `{instance_id}::{action_id}`（插件解析命名空间路由），
//!   因此本模块处理事件时兼容带/不带 `{instance}::` 前缀两种形态（前者=实例菜单，后者=托盘菜单）。
//!
//! # 实例生命周期模型（与 menubar.rs 同款铁律）
//!
//! - **create 一次，终生不销毁**；显隐一律 `set_visible`；仅分组删除/重命名才 `remove`。
//! - 插件原生层把 create/set_* 派发到独立 UI 线程（异步入队）——不回读 `is_visible`/`rect`，
//!   只做幂等声明式下发（与 macOS「dispatch_async 禁止同步回读」同一纪律）。

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;
use tauri::Listener;
use tauri::Manager;
use tauri_plugin_multiline_taskband::{ColorStyle, MenuItemDescriptor, MultilineTaskbandExt, Side};

use crate::menubar_common::{
    bottom_text_of, color_for, decode_group_id, desired_instances, instance_label, popup_tab_for,
    InstanceSpec, COLOR_FALL_DEFAULT, COLOR_FLAT_DEFAULT, COLOR_RISE_DEFAULT, COLOR_TOP_DEFAULT,
    INSTANCE_OVERVIEW,
};
use crate::model::{AppConfig, QuoteUpdate};
use crate::window::{open_settings_window, show_popup};

/// 已 create 过的实例 id（会话级）——create 去重守卫（同 menubar.rs）。
static INSTANCE_TRACKED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// 实例 id → click 事件 EventId；实例销毁时 app.unlisten(id) 移除监听，避免闭包永久持有 AppHandle
static CLICK_LISTENERS: OnceLock<Mutex<HashMap<String, tauri::EventId>>> = OnceLock::new();

fn tracked() -> &'static Mutex<HashSet<String>> {
    INSTANCE_TRACKED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn listeners() -> &'static Mutex<HashMap<String, tauri::EventId>> {
    CLICK_LISTENERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 插件装配（lib.rs setup 调用一次）：禁用插件自动 popup（生命周期由 window.rs 自管，
/// 对齐 macOS 架构：点击 → 自己 ensure/position/show + 失焦隐藏 + 闲置销毁），
/// 并声明浮窗 label（保留声明，即便 auto_popup=false 也不依赖插件 popup 能力）。
pub fn setup(app: &AppHandle) {
    let tb = app.multiline_taskband();
    if let Err(e) = tb.set_auto_popup(false) {
        eprintln!("[fund01] taskband set_auto_popup(false) 失败：{e}");
    }
    if let Err(e) = tb.set_popup_window(crate::window::POPUP_LABEL.to_string()) {
        eprintln!("[fund01] taskband set_popup_window 失败：{e}");
    }
}

/// 实例 id → 分组 key（menubarGroupSides/menubarGroupColors 同 key 约定）：
/// 总览 → '__overview__'；未分组 → ''；menubar-group-{hex} → 分组名。
fn group_key_of(id: &str) -> Option<String> {
    if id == INSTANCE_OVERVIEW {
        Some(crate::portfolio::MENUBAR_OVERVIEW_KEY.to_string())
    } else if id == "menubar-ungrouped" {
        Some(String::new())
    } else {
        id.strip_prefix("menubar-group-")
            .map(decode_group_id)
            .filter(|n| !n.is_empty())
    }
}

/// 实例停靠侧：menubarGroupSides[key] == "left" → 左缘；缺省/非法 → 右缘（插件默认一致）。
fn side_for(config: &AppConfig, id: &str) -> Side {
    let left = group_key_of(id)
        .and_then(|k| {
            config
                .settings
                .menubar_group_sides
                .as_ref()?
                .get(&k)
                .cloned()
        })
        .map(|s| s == "left")
        .unwrap_or(false);
    if left {
        Side::Left
    } else {
        Side::Right
    }
}

/// 点击事件监听（每个实例一次，记录 EventId 供销毁时移除）：
/// 解析任务栏项 rect（物理像素，屏幕坐标 top-left 原点）→ 左键弹出浮窗并直达对应分组。
/// 右键由插件原生层弹 set_menu 挂载的菜单（见 on_menu_event）。
fn ensure_click_listener(app: &AppHandle, id: &str) {
    let mut map = listeners().lock().unwrap();
    if map.contains_key(id) {
        return;
    }
    let event_name = format!("multiline-taskband://{id}//click");
    let app_listener = app.clone();
    let app_handler = app.clone();
    let instance_id = id.to_string();
    let event_id = app_listener.listen(event_name, move |event| {
        let payload: serde_json::Value =
            serde_json::from_str(event.payload()).unwrap_or(serde_json::Value::Null);
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
        if payload.get("button").and_then(|v| v.as_str()) == Some("left") {
            let tab = popup_tab_for(&instance_id);
            show_popup(&app_handler, rect, tab.as_deref());
        }
    });
    map.insert(id.to_string(), event_id);
}

/// 收敛实例集合与显隐/停靠侧/顺序。幂等，rebuild 与 update 共用。
///
/// 三步（顺序同 menubar.rs，不可调换）：
/// 1. **create 缺失实例**（带停靠侧）+ 注册点击监听 + 挂右键菜单；
/// 2. **对每个实例声明式下发 `set_visible` + `set_side` + `set_order`**（均幂等：
///    分组换边/排序变化无需重建实例，插件 set_side 原地搬迁并保留 order）；
/// 3. **只销毁「不该存在」的实例**（分组被删除/重命名、未分组持仓清空）。
fn sync_instances(app: &AppHandle, config: &AppConfig, desired: &[InstanceSpec]) {
    let tb = app.multiline_taskband();

    // 1. 创建缺失实例 + 监听点击
    for spec in desired {
        let is_new = tracked().lock().unwrap().insert(spec.id.clone());
        if is_new {
            let side = side_for(config, &spec.id);
            let _ = tb.create(spec.id.clone(), side);
            set_standard_menu(app, &spec.id);
            eprintln!(
                "[fund01] taskband create 实例 {}（{}，side={side:?}）",
                spec.id,
                instance_label(&spec.id)
            );
        }
        ensure_click_listener(app, &spec.id);
    }

    // 2. 显隐/停靠侧/顺序：幂等下发（desired 顺序即同侧排序，总览恒为 0 = 最靠右缘起点）
    for (order, spec) in desired.iter().enumerate() {
        let _ = tb.set_visible(spec.id.clone(), spec.visible);
        let _ = tb.set_side(spec.id.clone(), side_for(config, &spec.id));
        let _ = tb.set_order(spec.id.clone(), order as u64);
    }

    // 3. 销毁「不该存在」的实例（同步移除 click 监听，释放闭包持有的 AppHandle）
    let mut tracked_set = tracked().lock().unwrap();
    let desired_ids: HashSet<&String> = desired.iter().map(|s| &s.id).collect();
    let stale: Vec<String> = tracked_set
        .iter()
        .filter(|id| !desired_ids.contains(id))
        .cloned()
        .collect();
    for id in stale {
        let _ = tb.remove(id.clone());
        tracked_set.remove(&id);
        if let Some(event_id) = listeners().lock().unwrap().remove(&id) {
            app.unlisten(event_id);
        }
        eprintln!(
            "[fund01] taskband remove 实例 {id}（{}，分组已删除）",
            instance_label(&id)
        );
    }
}

/// 应用全局外边距（menubarEdgeMargins，物理像素）+ 每实例字号/字体/加粗/对齐。
/// rebuild（设置变更）与 update（刷新兜底）路径都会调用，幂等。
///
/// ⚠️ 插件无 set_layout：固定上下两行渲染，字号直接用布局 0「下大上小」的
/// 上行/下行字段（7-10 / 10-14），布局选择器与等大字号在 Windows 设置页不展示。
fn apply_taskband_style(app: &AppHandle, config: &AppConfig, desired: &[InstanceSpec]) {
    let tb = app.multiline_taskband();
    // 全局外边距（left/right 双侧一次下发；None=保持现值，这里两侧都显式下发）
    let margins = config.settings.menubar_edge_margins.unwrap_or_default();
    let _ = tb.set_edge_margins(Some(margins.left), Some(margins.right));

    let top = config
        .settings
        .menubar_top_font_size
        .unwrap_or(7.0)
        .clamp(7.0, 10.0);
    let bottom = config
        .settings
        .menubar_bottom_font_size
        .unwrap_or(11.0)
        .clamp(10.0, 14.0);
    // 字体族：空串/None → 系统字体（插件原生回退，与 macOS 语义一致）
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
        let _ = tb.set_font_sizes(spec.id.clone(), top, bottom);
        let _ = tb.set_font_family(spec.id.clone(), top_font.clone(), bottom_font.clone());
        let _ = tb.set_bold(spec.id.clone(), top_bold, bottom_bold);
        let _ = tb.set_alignment(spec.id.clone(), top_align, bottom_align);
    }
}

/// 标准右键菜单（每个实例一份）：打开设置 + 退出（与 macOS 相同的菜单结构）。
/// ⚠️ taskband 的 Item 字段是 `enabled`（menubar 是 `disabled`），语义相反勿混。
/// 退出项 id 仍用 "quit"：**插件不保留该 id**（与 menubar v1.6.1 不同），事件会以
/// `{instance}::quit` 形态到达全局 on_menu_event，由本模块负责 app.exit(0)（见模块头注释）。
fn set_standard_menu(app: &AppHandle, id: &str) {
    let _ = app.multiline_taskband().set_menu(
        id.to_string(),
        Some(vec![
            MenuItemDescriptor::Item {
                id: "open-settings".to_string(),
                text: "打开设置…".to_string(),
                accelerator: None,
                enabled: None,
            },
            MenuItemDescriptor::Separator,
            MenuItemDescriptor::Item {
                id: "quit".to_string(),
                text: "退出 fund01".to_string(),
                accelerator: None,
                enabled: None,
            },
        ]),
    );
}

/// 应用启动 / 配置变更：收敛实例集合与显隐（+ 右键菜单 + 边距 + 文字/样式）
pub fn rebuild_taskbar(app: &AppHandle, config: &AppConfig, quote: Option<&QuoteUpdate>) {
    // 1. 收敛实例集合与显隐/停靠侧/顺序（创建缺失 + set_visible/set_side/set_order + 销毁已删除分组）
    let desired = desired_instances(config, quote);
    sync_instances(app, config, &desired);

    // 2. 右键菜单全集重挂（幂等，覆盖任何创建途径的实例）
    for spec in &desired {
        set_standard_menu(app, &spec.id);
    }

    // 3. 更新文字与颜色（内部会再次收敛实例集合 + 应用样式，幂等）
    update_taskbar(app, quote);
}

/// 每次刷新后：更新全部实例的文字与颜色，并收敛实例集合（不依赖过期快照）。
/// 修改持仓/分组后即使尚未触发 rebuild，刷新也会让实例集合与最新配置对齐。
pub fn update_taskbar(app: &AppHandle, quote: Option<&QuoteUpdate>) {
    let config = app
        .state::<crate::state::AppState>()
        .config
        .read()
        .unwrap()
        .clone();
    // 数值显示方式：false=收益率百分比，true=收益额（简写）。
    // 隐私模式（privacy_mode）下强制百分比（不暴露绝对金额），忽略用户设置的收益额偏好。
    let show_amount = if config.settings.privacy_mode.unwrap_or(false) {
        false
    } else {
        config.settings.menubar_show_amount.unwrap_or(false)
    };
    // 颜色：上行固定色（默认白色，⚠️ Windows 浅色任务栏下对比度差，见 docs 已知限制）；
    // 下行按涨跌（涨色/跌色/平色均可配置）
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
    // 刷新后分组/持仓可能已变化：先收敛实例集合与显隐/侧/序，再下发文字与样式（幂等）
    sync_instances(app, &config, &desired);
    for spec in &desired {
        let _ = app.multiline_taskband().set_text(
            spec.id.clone(),
            spec.top.clone(),
            bottom_text_of(spec, show_amount),
        );
    }
    apply_taskband_style(app, &config, &desired);
    for spec in &desired {
        apply_colors_one(
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

/// 对单个实例下发颜色（⚠️ 插件无 set_tooltip，跳过 macOS 的 tooltip 步骤）。
fn apply_colors_one(
    config: &AppConfig,
    spec: &InstanceSpec,
    show_amount: bool,
    top_color_default: &str,
    rise: &str,
    fall: &str,
    flat: &str,
    app: &AppHandle,
) {
    let color = if show_amount {
        color_for(spec.amount, rise, fall, flat)
    } else {
        color_for(spec.pct, rise, fall, flat)
    };
    // 上行颜色：实例对应分组自定义色（menubarGroupColors）→ 未配置回落全局 topColor。
    // 总览 key=__overview__（可自定义，同分组语义）；未分组 key=''
    let instance_top_color = group_key_of(&spec.id)
        .and_then(|k| {
            config
                .settings
                .menubar_group_colors
                .as_ref()
                .and_then(|m| m.get(&k))
        })
        .cloned()
        .unwrap_or_else(|| top_color_default.to_string());
    let _ = app.multiline_taskband().set_colors(
        spec.id.clone(),
        ColorStyle::Solid {
            value: instance_top_color,
        },
        ColorStyle::Solid { value: color },
    );
}

/// 菜单事件分发（实例右键菜单 + 托盘菜单共用）。
/// lib.rs 注册的 `on_menu_event` 是 Tauri 全局菜单事件，两类来源都汇聚到这里：
/// - 实例右键菜单：插件把菜单项 id 建成 `{instance_id}::{action_id}`（解析命名空间发
///   `//menu` 事件用），因此这里收到的是带前缀的 id；
/// - 托盘菜单（tray.rs）：菜单项 id 就是裸的 action id。
/// 故先剥 `{instance}::` 前缀（实例 id 只含 hex/固定字符，`split_once("::")` 无歧义）再匹配。
pub fn on_menu_event(app: &AppHandle, item_id: &str) {
    let action = match item_id.split_once("::") {
        Some((_instance, action)) => action,
        None => item_id,
    };
    match action {
        "open-settings" => open_settings_window(app, None, None),
        // taskband 插件不保留 quit id（与 macOS menubar 插件 v1.6.1 不同）：
        // Windows 无 NSMenu trackMouse 收尾问题，直接同步退出即可。
        "quit" => {
            eprintln!("[fund01] 菜单「退出 fund01」→ app.exit(0)");
            app.exit(0);
        }
        _ => {}
    }
}

/// 供 refresh 后调用（避免与 config 锁死）
pub fn update_taskbar_with(app: &AppHandle, quote: &Option<QuoteUpdate>) {
    update_taskbar(app, quote.as_ref());
}
