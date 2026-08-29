//! menubar 多实例编排（macOS）：总览恒在 + 每个持仓分组一个实例 + 未分组兜底。
//! 实例 id：menubar-overview / menubar-group-{分组名 hex 编码} / menubar-ungrouped。
//!
//! 纯逻辑（实例期望集合、涨跌口径、id 编解码等）已下沉到 `menubar_common.rs`
//! 与 Windows 的 taskband.rs 共享；本模块只保留 macOS 插件（multiline-menubar）编排层。
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

use crate::menubar_common::{
    bottom_text_of, color_for, desired_instances, instance_label, menubar_all_hidden,
    popup_tab_for, InstanceSpec, COLOR_FALL_DEFAULT, COLOR_FLAT_DEFAULT, COLOR_RISE_DEFAULT,
    COLOR_TOP_DEFAULT, INSTANCE_OVERVIEW,
};
use crate::model::QuoteUpdate;
use crate::window::{open_settings_window, show_popup};

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
fn apply_menubar_style(
    app: &AppHandle,
    config: &crate::model::AppConfig,
    desired: &[InstanceSpec],
) {
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
        let mb = app.multiline_menubar();
        let _ = mb.set_layout(spec.id.clone(), layout);
        let _ = mb.set_font_sizes(spec.id.clone(), top, bottom);
        let _ = mb.set_font_family(spec.id.clone(), top_font.clone(), bottom_font.clone());
        let _ = mb.set_bold(spec.id.clone(), top_bold, bottom_bold);
        let _ = mb.set_alignment(spec.id.clone(), top_align, bottom_align);
    }
}

/// 收敛实例集合：创建缺失实例（+点击监听）、销毁多余实例（+移除监听）。
/// （实例 id → 人类可读标签见 menubar_common::instance_label）
///
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
    let event_id = app_listener.clone().listen(event_name, move |_event| {
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
                .map(crate::menubar_common::decode_group_id)
                .filter(|n| !n.is_empty())
        };
        if let Some(g) = group {
            let state = app_listener.state::<crate::state::AppState>();
            let mut cfg = state.config.write().unwrap();
            let hidden = cfg
                .settings
                .menubar_hidden_groups
                .get_or_insert_with(Vec::new);
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
pub fn rebuild_menubar(
    app: &AppHandle,
    config: &crate::model::AppConfig,
    quote: Option<&QuoteUpdate>,
) {
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
///
/// ⚠️ 退出项使用插件保留 id `quit`：插件 v1.6.1 起对该 id **延迟 ~200ms 异步** `app.exit(0)`
/// （native 侧补发 rightMouseUp 让 button 外层 trackMouse 收尾），不再挂起。
/// 宿主无需、也不要在自己的 on_menu_event 里再处理该 id（见 on_menu_event 注释）。
/// （v1.6.0 的同步退出缺陷 + fund01 的 quit-fund01/process::exit workaround 已于 1.0.47 撤下，
/// 回退指南见 docs/插件v1.6.1-右键退出workaround回退指南.md。）
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
        let _ = app.multiline_menubar().set_text(
            spec.id.clone(),
            spec.top.clone(),
            bottom_text_of(spec, show_amount),
        );
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

/// 对单个实例下发颜色与 tooltip（不影响 view 高度测量，可与文本分离）。
fn apply_colors_tooltip_one(
    config: &crate::model::AppConfig,
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
            .map(crate::menubar_common::decode_group_id)
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

/// 菜单事件分发（open-settings 等）。
/// lib.rs 注册的 `on_menu_event` 是 Tauri 全局菜单事件：所有实例的右键菜单项都汇聚到这里，
/// 与来源实例无关（item_id 相同则行为一致），因此每个实例的「打开设置…」行为完全等价。
///
/// `quit` 由插件处理（QUIT_ITEM_IDS，v1.6.1 起延迟 ~200ms 异步 app.exit），宿主不监听；
/// **勿在此处加 quit/quit2 分支**，否则会与插件异步退出竞争（如直接 process::exit 会抢先
/// 杀进程，跳过 tauri 正常退出清理）。标准 id 就该交给插件。
/// （v1.6.0 同步退出缺陷 + fund01 的 quit-fund01/process::exit workaround 已于 1.0.47 撤下，
/// 回退指南见 docs/插件v1.6.1-右键退出workaround回退指南.md。）
pub fn on_menu_event(app: &AppHandle, item_id: &str) {
    if item_id == "open-settings" {
        open_settings_window(app, None, None);
    }
}

/// 供 refresh 后调用（避免与 config 锁死）
pub fn update_menubar_with(app: &AppHandle, quote: &Option<QuoteUpdate>) {
    update_menubar(app, quote.as_ref());
}

#[allow(dead_code)]
fn _unused(_: &Value) {}
