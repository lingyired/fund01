//! 浮窗（menubar popup）生命周期 + 设置窗口 + popup 独立页面（popup-tab）。
//!
//! 生命周期：点击 menubar → show；失焦 → hide + 延迟 N 分钟销毁（默认 5min，
//! 期间再点击直接 show 状态保留；已销毁则重建）。窗口 680×600 与 Chrome popup 同尺寸。
//!
//! popup-tab = 「在新窗口打开」独立页面（对齐 Chrome popup.html?tab=1 标签页模式）：
//! 持久化窗口，手动关闭才销毁；重开聚焦复用，不随 menubar 浮窗隐藏/销毁。

use std::time::Duration;

use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

#[cfg(not(target_os = "macos"))]
use tauri::{PhysicalPosition, Position};

#[cfg(target_os = "macos")]
use std::ptr::NonNull;
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "macos")]
use objc2::msg_send;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyObject, Sel};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplicationTerminateReply, NSEvent, NSEventMask, NSStatusBar};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSPoint, NSRect};

use crate::state::AppState;

pub const POPUP_LABEL: &str = "menubar";
pub const SETTINGS_LABEL: &str = "settings";
/// popup 独立页面窗口（「在新窗口打开」，对齐 Chrome popup.html?tab=1 标签页模式）
pub const POPUP_TAB_LABEL: &str = "popup-tab";
/// 浮窗隐藏后延迟销毁时长（秒），TODO: 接入设置项
pub const POPUP_DESTROY_DELAY_SECS: u64 = 5 * 60;

/// 确保浮窗存在（不存在则创建，URL 带 ?tab= 直达分组；tab=None 不拼参数），
/// 返回 (窗口, 是否已存在)。已存在的窗口 webview 已加载 → 调用方用事件导航；
/// 新建窗口 → 前端启动时读 ?tab= 作为初始选中（避免 emit 早于监听注册丢失）。
fn ensure_popup_window(app: &AppHandle, tab: Option<&str>) -> (Option<WebviewWindow>, bool) {
    if let Some(win) = app.get_webview_window(POPUP_LABEL) {
        return (Some(win), true);
    }
    let url = match tab {
        Some(t) => format!("index.html?tab={t}"),
        None => "index.html".to_string(),
    };
    let win = WebviewWindowBuilder::new(app, POPUP_LABEL, WebviewUrl::App(url.into()))
        .title("fund01")
        .decorations(false)
        .skip_taskbar(true)
        .resizable(false)
        .always_on_top(true)
        .visible(false)
        .inner_size(680.0, 600.0)
        .build()
        .ok();
    if let Some(w) = &win {
        attach_popup_handlers(app, w);
        #[cfg(target_os = "macos")]
        set_popup_native_flags(w);
    }
    (win, false)
}

/// 失焦 → hide + 启动延迟销毁计时器。
///
/// ⚠️ 这只是三层兜底之一（覆盖「同 app 内点击另一个窗口 → key 转移」）。
/// macOS 上点击桌面/其他 app/菜单栏空白时，floating level（always_on_top）窗口 + Accessory
/// app 的 `windowDidResignKey` 经常**不触发**（见 set_popup_native_flags / install_global_click_monitor），
/// 只靠这里会漏 → popup 赖着不消失。三层各自独立兜底，缺一不可。
fn attach_popup_handlers(app: &AppHandle, win: &WebviewWindow) {
    let app = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            crate::dbglog::log_write("[popup失焦] Focused(false)（同 app key 转移）→ hide", false);
            if let Some(w) = app.get_webview_window(POPUP_LABEL) {
                if w.is_visible().unwrap_or(false) {
                    let _ = w.hide();
                }
            }
            let state = app.state::<AppState>();
            schedule_destroy(app.clone(), &state);
        }
    });
}

/// macOS：popup 窗口的原生兜底设置（每次创建窗口时调用，幂等）。
///
/// `hidesOnDeactivate = true`：app 失活（点击其他 app / 桌面 / Cmd+Tab 切换走）时
/// popup 自动从屏幕移除。这是 AppKit 为「失活即隐藏」设计的原生属性（NSPanel 默认开启），
/// 不依赖 windowDidResignKey，因此不受 floating level / Accessory 策略影响。
#[cfg(target_os = "macos")]
fn set_popup_native_flags(win: &WebviewWindow) {
    let win2 = win.clone();
    let _ = win.run_on_main_thread(move || unsafe {
        if let Ok(ptr) = win2.ns_window() {
            let ns_win: *mut AnyObject = ptr.cast();
            let _: () = msg_send![ns_win, setHidesOnDeactivate: true];
        }
    });
}

/// 全局鼠标点击 monitor 的安装守卫（进程级只装一次；popup 销毁重建后 monitor 仍在，
/// 回调里按 label 每次现查窗口，窗口不存在时自然跳过）。
#[cfg(target_os = "macos")]
static GLOBAL_CLICK_MONITOR: OnceLock<()> = OnceLock::new();

/// 安装全局 mouseDown monitor：点击坐标不在 popup frame 内 → 隐藏 popup。
///
/// 为什么需要：macOS 上 floating level 窗口（always_on_top）+ Accessory app 的
/// `windowDidResignKey` 在点击桌面/其他 app/菜单栏空白时**不触发**，`Focused(false)` 兜不住。
/// `addGlobalMonitorForEventsMatchingMask:` 只接收**其他 app** 的事件：
/// - popup 内部点击（本 app）→ monitor 不接收，交互不受影响；
/// - 点击设置窗口（本 app）→ monitor 不接收，但 key 转移触发 Focused(false)（上面兜底）；
/// - 点击桌面 / 其他 app / 菜单栏空白 → monitor 收到 → 坐标不在 popup frame 内 → hide。
/// 坐标系：`[NSWindow frame]` 与 `NSEvent.mouseLocation` 同为 AppKit 全局 points（主屏左下原点、y 向上），
/// 直接比较即可，与多屏排列无关。社区实测（Accessory menubar app 场景）此方案最可靠。
#[cfg(target_os = "macos")]
fn install_global_click_monitor(app: &AppHandle) {
    GLOBAL_CLICK_MONITOR.get_or_init(|| {
        let app = app.clone();
        // global monitor 的 handler 在主线程事件分发中同步调用 → 可直接访问 AppKit；
        // tauri 的 hide() 内部仍会 dispatch 到主线程消息队列，安全。
        let block: block2::RcBlock<dyn Fn(NonNull<NSEvent>)> = block2::RcBlock::new(
            move |_event: NonNull<NSEvent>| {
                if let Some(win) = app.get_webview_window(POPUP_LABEL) {
                    if !win.is_visible().unwrap_or(false) {
                        return;
                    }
                    unsafe {
                        if let Ok(ptr) = win.ns_window() {
                            let ns_win: *mut AnyObject = ptr.cast();
                            let frame: NSRect = msg_send![ns_win, frame];
                            let mouse = NSEvent::mouseLocation();
                            let inside = mouse.x >= frame.origin.x
                                && mouse.x < frame.origin.x + frame.size.width
                                && mouse.y >= frame.origin.y
                                && mouse.y < frame.origin.y + frame.size.height;
                            if !inside {
                                crate::dbglog::log_write(
                                    &format!(
                                        "[popup失焦] 全局点击外部 mouse=({:.1},{:.1}) frame=({:.1},{:.1},{:.1},{:.1}) → hide",
                                        mouse.x,
                                        mouse.y,
                                        frame.origin.x,
                                        frame.origin.y,
                                        frame.size.width,
                                        frame.size.height
                                    ),
                                    false,
                                );
                                let _ = win.hide();
                            }
                        }
                    }
                }
            },
        );
        // 左键 + 右键点击外部都收起；popup 内部点击是本 app 事件，monitor 收不到，不受影响
        NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown,
            &block,
        );
        eprintln!("[fund01] 已安装全局点击 monitor（popup 点击外部自动隐藏）");
    });
}

pub fn cancel_destroy(state: &State<AppState>) {
    let mut guard = state.popup_destroy_timer.lock().unwrap();
    if let Some(handle) = guard.take() {
        handle.abort();
    }
}

pub fn schedule_destroy(app: AppHandle, state: &State<AppState>) {
    cancel_destroy(state);
    let delay = Duration::from_secs(POPUP_DESTROY_DELAY_SECS);
    let handle = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if let Some(win) = app.get_webview_window(POPUP_LABEL) {
            eprintln!("[fund01] 浮窗闲置超时销毁");
            let _ = win.destroy();
        }
    });
    *state.popup_destroy_timer.lock().unwrap() = Some(handle);
}

/// 由鼠标位置（AppKit 全局 points，y 向上）算出 popup 左上角（AppKit points）。
///
/// 参考 macOS 右键菜单（NSMenu）的定位方式：系统右键菜单直接用鼠标点击的屏幕坐标
/// （NSEvent.mouseLocation）弹出，多屏任意排列都天然正确（用户实测右键菜单所有屏都准）。
/// 这里同样用鼠标坐标，但比右键菜单更精确：
/// - y = 鼠标所在屏的**顶边** − 菜单栏厚度(thickness) − 1pt → popup 顶边精确贴在菜单栏底边下方 1pt，
///   与鼠标点在状态项的具体位置无关（右键菜单是左上角=鼠标点，会有缝隙/偏移）。
/// - x = 鼠标 x 居中 − 窗口半宽，clamp 到鼠标所在屏幕区间。
/// screens_ak = (左x, 底y, 顶y, 宽)：各屏的 AppKit 全局 points 区间（y 向上，底y < 顶y）。
fn popup_from_mouse(
    mouse: (f64, f64),
    thickness: f64,
    win_w: f64,
    screens_ak: &[(f64, f64, f64, f64)],
) -> (f64, f64) {
    let mut x = mouse.0 - win_w / 2.0;
    let mut y = 0.0;
    if let Some(&(sx, _yb, yt, sw)) = screens_ak.iter().find(|&&(sx, yb, yt, sw)| {
        mouse.0 >= sx && mouse.0 < sx + sw && mouse.1 >= yb && mouse.1 <= yt
    }) {
        x = x.clamp(sx, (sx + sw - win_w).max(sx));
        y = yt - thickness - 1.0;
    }
    (x, y)
}

/// 把窗口定位到状态项正下方（macOS）。
///
/// **定位方式参考右键菜单（NSMenu）**：系统右键菜单用鼠标点击的屏幕坐标
/// （`NSEvent.mouseLocation`，AppKit 全局 points、主屏左下原点、y 向上）弹出，
/// 多屏任意排列都天然正确。这里同样用鼠标坐标 + 菜单栏厚度定位，**完全绕开插件
/// click rect 的单位歧义**（此前反复出错的根源）。rect 仅用于日志对比验证单位。
#[cfg(target_os = "macos")]
fn position_below(app: &AppHandle, win: &WebviewWindow, rect: (f64, f64, f64, f64)) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let outer = win.outer_size().unwrap_or_default();
    let win_w = outer.width as f64 / scale; // 窗口逻辑宽（pt）
    let main_h = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as f64 / m.scale_factor())
        .unwrap_or(0.0); // 主屏逻辑高（pt）
                         // 各屏 → AppKit 全局 points 区间 (左x, 底y, 顶y, 宽)：
                         // tauri Monitor::position() = CGDisplayBounds×scale（top-left 原点、y 向下，副屏在上方 y 负），
                         // size() = 物理×scale；÷scale 还原 points 后翻转 y 为屏底向上（底y = main_h - (sy+sh)，顶y = main_h - sy）。
    let screens_ak: Vec<(f64, f64, f64, f64)> = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let s = m.scale_factor();
            let pos = m.position();
            let size = m.size();
            let sx = pos.x as f64 / s;
            let sy = pos.y as f64 / s; // top-left 逻辑 y（y 向下）
            let sw = size.width as f64 / s;
            let sh = size.height as f64 / s;
            (sx, main_h - (sy + sh), main_h - sy, sw)
        })
        .collect();
    let win2 = win.clone();
    let _ = win.run_on_main_thread(move || {
        let mouse = NSEvent::mouseLocation();
        let thickness = NSStatusBar::systemStatusBar().thickness();
        let (x, y) = popup_from_mouse((mouse.x, mouse.y), thickness, win_w, &screens_ak);
        crate::dbglog::log_write(
            &format!(
                "[popup定位] mouse=({:.1},{:.1}) thickness={thickness:.1} rect={rect:?} → AppKit top-left=({x:.1},{y:.1}) screens_ak={screens_ak:?}",
                mouse.x, mouse.y
            ),
            false,
        );
        unsafe {
            if let Ok(ptr) = win2.ns_window() {
                let ns_win: *mut AnyObject = ptr.cast();
                let point = NSPoint::new(x, y);
                let _: () = msg_send![ns_win, setFrameTopLeftPoint: point];
            }
        }
    });
}

/// Windows（及非 macOS 平台）：把浮窗定位到任务栏项/托盘图标旁。
///
/// rect 为 taskband click 事件 / 托盘事件给出的**物理像素**矩形（屏幕坐标、top-left 原点）：
/// - 水平任务栏（绝大多数场景）→ 浮窗贴分组正上方（间隙 1 逻辑 px）、水平居中于分组；
///   上方空间不足（顶部任务栏/上屏边缘）→ 翻到分组下方；
/// - 竖直任务栏（rect 高>宽）→ 左缘任务栏弹分组右侧、右缘任务栏弹分组左侧，垂直居中；
/// - x/y clamp 到分组所在显示器（遍历 monitors 找包含 rect 中心者，找不到回退主屏；
///   均不可得时不 clamp）。
/// 多屏拼接 / 任务栏自动隐藏等场景待 Windows 真机验证（mac 侧无法覆盖）。
#[cfg(not(target_os = "macos"))]
fn position_below(app: &AppHandle, win: &WebviewWindow, rect: (f64, f64, f64, f64)) {
    let scale = win.scale_factor().unwrap_or(1.0);
    // 窗口尺寸（物理 px）：无边框窗口 outer=inner（680×600）；刚 build 未完成布局时
    // outer_size 可能为 0 → 回退逻辑尺寸×scale 估算
    let outer = win.outer_size().unwrap_or_default();
    let (mut w, mut h) = (outer.width as f64, outer.height as f64);
    if w <= 0.0 || h <= 0.0 {
        w = 680.0 * scale;
        h = 600.0 * scale;
    }
    let gap = scale; // 与分组的间隙：1 逻辑 px（物理 px 计）
    let (cx, cy) = (rect.0 + rect.2 / 2.0, rect.1 + rect.3 / 2.0);
    // 分组所在显示器（物理坐标区间）
    let monitor = app
        .available_monitors()
        .ok()
        .unwrap_or_default()
        .into_iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            cx >= p.x as f64
                && cx < (p.x + s.width as i32) as f64
                && cy >= p.y as f64
                && cy < (p.y + s.height as i32) as f64
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let (mx, my, mw, mh) = monitor
        .map(|m| {
            let p = m.position();
            let s = m.size();
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64)
        })
        .unwrap_or((0.0, 0.0, f64::MAX, f64::MAX));
    let (mut x, mut y);
    if rect.3 > rect.2 {
        // 竖直任务栏：按屏中线判断分组在左缘还是右缘任务栏
        if cx < mx + mw / 2.0 {
            x = rect.0 + rect.2 + gap;
        } else {
            x = rect.0 - w - gap;
        }
        y = cy - h / 2.0;
    } else {
        // 水平任务栏：贴分组正上方
        x = cx - w / 2.0;
        y = rect.1 - h - gap;
        if y < my {
            y = rect.1 + rect.3 + gap; // 顶部任务栏 → 翻到分组下方
        }
    }
    x = x.clamp(mx, (mx + mw - w).max(mx));
    y = y.clamp(my, (my + mh - h).max(my));
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(
        x.round() as i32,
        y.round() as i32,
    )));
}

/// 显示浮窗（点击 menubar 实例时调用；rect 为该实例屏幕位置）。
/// tab = 该实例对应的 popup 分组 tab id（'all' / 分组名 / '__ungrouped__'）：
/// 窗口已存在（webview 已加载）→ emit 事件直达；新建 → 前端读 ?tab= 初始化。
pub fn show_popup(app: &AppHandle, rect: Option<(f64, f64, f64, f64)>, tab: Option<&str>) {
    #[cfg(target_os = "macos")]
    install_global_click_monitor(app);
    let state = app.state::<AppState>();
    cancel_destroy(&state);
    let (win, existed) = ensure_popup_window(app, tab);
    if let Some(win) = win {
        if let Some(r) = rect {
            position_below(app, &win, r);
        }
        let _ = win.show();
        let _ = win.set_focus();
        if existed {
            if let Some(t) = tab {
                // 事件名与 TauriEventPort.onPopupOpenGroup 对应；payload = 分组 tab id
                let _ = win.emit("popup-open-group", t);
            }
        }
    }
}

/// macOS：是否存在「主界面形态」窗口（设置窗口 / popup-tab 独立页面）。
/// Dock 可见性跟随主界面形态窗口：任一存在 → Dock 可见；全部销毁 → 恢复 Accessory。
/// 也供 menubar.rs 判断「全静默」状态（无窗口时 ⌘-拖出最后一个实例 → 自动弹 popup-tab）。
pub fn has_main_window(app: &AppHandle) -> bool {
    app.get_webview_window(SETTINGS_LABEL).is_some()
        || app.get_webview_window(POPUP_TAB_LABEL).is_some()
}

/// 打开 popup 独立页面窗口（对齐 Chrome popup.html?tab=1「标签页模式」）：
/// - 已存在 → show + focus（持久化窗口，不随 menubar 浮窗隐藏/销毁）；
/// - 不存在 → 创建独立窗口加载 index.html?tab=1（前端读 ?tab=1 进入 tab 模式铺满视口）。
/// URL 参数与 Chrome 完全一致：App.tsx 的 requestedTab / FundDetailDialog / viewport 判断自动对齐。
pub fn open_popup_tab_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(POPUP_TAB_LABEL) {
        // macOS: 主界面形态窗口，确保 Dock 显示应用图标
        #[cfg(target_os = "macos")]
        let _ = app.set_dock_visibility(true);
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let url = "index.html?tab=1";
    if let Ok(win) = WebviewWindowBuilder::new(app, POPUP_TAB_LABEL, WebviewUrl::App(url.into()))
        .title("fund01")
        .inner_size(1000.0, 760.0)
        .min_inner_size(680.0, 600.0)
        .build()
    {
        // macOS: 打开时切到 Regular（Dock 出现应用图标）；全部主界面窗口销毁后恢复 Accessory
        #[cfg(target_os = "macos")]
        {
            let _ = app.set_dock_visibility(true);
            let app2 = app.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::Destroyed = event {
                    if !has_main_window(&app2) {
                        let _ = app2.set_dock_visibility(false);
                        // menubar 全空且最后一个主界面窗口已关 → 用户眼里 app 已无任何可见存在，
                        // 干净退出（不保留后台进程）。只有 ⌘-拖出/设置页关闭全部实例才会走到这里。
                        let empty = {
                            let state = app2.state::<crate::state::AppState>();
                            let cfg = state.config.read().unwrap().clone();
                            crate::status_bar::all_hidden(&cfg)
                        };
                        if empty {
                            eprintln!("[fund01] menubar 全空且无窗口 → 退出 app");
                            app2.exit(0);
                        }
                    }
                }
            });
        }
        let _ = win.show();
    }
}

/// 打开设置窗口（复用 options.html?tab= 约定）
/// tab = 设置页一级 tab（'holdings' / 'data' / ...）；anchor = 「持仓」tab 内区块锚点 id
/// （仅 tab='holdings' 时有意义），拼入 URL hash 供前端滚动定位。
/// 注意：窗口已存在时仅聚焦（不重新导航），anchor 不生效——与 Chrome 端每次新开标签页不同。
pub fn open_settings_window(app: &AppHandle, tab: Option<&str>, anchor: Option<&str>) {
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        // macOS: 设置窗口 = 主界面形态，确保 Dock 显示应用图标
        //（应用启动时 Accessory 常驻，若用户关窗后恢复过则需再次切回）
        #[cfg(target_os = "macos")]
        let _ = app.set_dock_visibility(true);
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let url = match tab {
        Some(t) if t == "holdings" || t == "data" => {
            let hash = anchor
                .filter(|_| t == "holdings")
                .map(|a| format!("#{a}"))
                .unwrap_or_default();
            format!("options.html?tab={t}{hash}")
        }
        _ => "options.html".to_string(),
    };
    if let Ok(win) = WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App(url.into()))
        .title("fund01 设置")
        .inner_size(1200.0, 800.0)
        .build()
    {
        // macOS: 打开设置窗口时切到 Regular（Dock 出现应用图标）；
        // 全部主界面窗口（设置 / popup-tab）销毁后恢复 Accessory（menubar 常驻、不占 Dock）
        #[cfg(target_os = "macos")]
        {
            let _ = app.set_dock_visibility(true);
            let app2 = app.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::Destroyed = event {
                    if !has_main_window(&app2) {
                        let _ = app2.set_dock_visibility(false);
                        // menubar 全空且最后一个主界面窗口已关 → 干净退出（与 popup-tab 分支同规则）
                        let empty = {
                            let state = app2.state::<crate::state::AppState>();
                            let cfg = state.config.read().unwrap().clone();
                            crate::status_bar::all_hidden(&cfg)
                        };
                        if empty {
                            eprintln!("[fund01] menubar 全空且无窗口 → 退出 app");
                            app2.exit(0);
                        }
                    }
                }
            });
        }
        let _ = win.show();
    }
}

/// macOS：拦截 Dock 右键「退出」/ Cmd+Q（`NSApp terminate:`），把「退出」改写成
/// 「只关闭主界面窗口（设置 / popup-tab），menubar 保持常驻」。
///
/// 为什么需要原生 hook：tauri 的 `RunEvent::ExitRequested` + `prevent_exit()` 只覆盖
/// 「最后一个窗口销毁」和 `app.exit(code)` 两条路径；macOS 系统级 `terminate:`（Dock
/// 右键退出、Cmd+Q）直接走 `NSApplication` 默认行为退出进程，tao 0.35 的 AppDelegate
/// 没有实现 `applicationShouldTerminate:`，tauri 拦不到。
///
/// 做法：给现有 AppDelegate 类动态挂 `applicationShouldTerminate:` ——
/// 有主界面窗口（设置 / popup-tab）→ 关闭它 + 恢复 Accessory + 返回 `TerminateCancel`（取消退出）；
/// 无窗口（纯 menubar 态）→ 返回 `TerminateNow` 放行真正退出。
#[cfg(target_os = "macos")]
static APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);

#[cfg(target_os = "macos")]
pub fn install_terminate_hook(app: &AppHandle) {
    use objc2::ffi::{class_addMethod, class_getInstanceMethod, object_getClass};
    use objc2::runtime::{AnyClass, Imp};
    use objc2::sel;
    use objc2_app_kit::NSApplication;

    *APP_HANDLE.lock().unwrap() = Some(app.clone());

    let nsapp = NSApplication::sharedApplication(objc2::MainThreadMarker::new().unwrap());
    let Some(delegate) = nsapp.delegate() else {
        eprintln!("[fund01] 未拿到 NSApp delegate，跳过退出拦截");
        return;
    };
    // ProtocolObject<dyn NSApplicationDelegate> 是 repr(C) 的 type-erased 对象，
    // 首字段即 AnyObject，可安全取回对象指针
    let obj: &AnyObject = unsafe { &*(&*delegate as *const _ as *const AnyObject) };
    let cls = unsafe { object_getClass(obj as *const AnyObject) } as *mut AnyClass;
    let should_terminate_sel: Sel = sel!(applicationShouldTerminate:);
    unsafe {
        // tao 已实现该方法则跳过（未来 tao/tauri 若原生支持退出拦截，走它们的路径）
        if class_getInstanceMethod(cls as *const AnyClass, should_terminate_sel).is_null() {
            // fn item 先转 fn pointer，再 transmute 成 Imp（objc2 内部 MethodImplementation::__imp 同款做法；
            // trait 对 Option<&AnyObject> 参数签名的 impl 缺失，故手动 transmute，两者语义等价）
            let impl_fn = application_should_terminate
                as unsafe extern "C-unwind" fn(
                    &AnyObject,
                    Sel,
                    Option<&AnyObject>,
                ) -> NSApplicationTerminateReply;
            let imp: Imp = std::mem::transmute(impl_fn);
            let ok = class_addMethod(cls, should_terminate_sel, imp, c"L@:@".as_ptr());
            if !ok.as_bool() {
                eprintln!("[fund01] class_addMethod(applicationShouldTerminate:) 失败");
            }
        }
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn application_should_terminate(
    _this: &AnyObject,
    _sel: Sel,
    _sender: Option<&AnyObject>,
) -> NSApplicationTerminateReply {
    let handle = APP_HANDLE.lock().unwrap().clone();
    let Some(app) = handle else {
        return NSApplicationTerminateReply::TerminateNow;
    };
    // 关闭所有主界面窗口（设置 / popup-tab 可能并存）
    let mut closed_any = false;
    for label in [SETTINGS_LABEL, POPUP_TAB_LABEL] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.close();
            closed_any = true;
        }
    }
    if !closed_any {
        // 无主界面窗口（纯 menubar 态）→ 放行真正退出
        return NSApplicationTerminateReply::TerminateNow;
    }
    eprintln!("[fund01] Dock/Cmd+Q 退出被拦截：仅关闭主界面窗口，menubar 保持常驻");
    let _ = app.set_dock_visibility(false);
    NSApplicationTerminateReply::TerminateCancel
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::popup_from_mouse;

    // 用户环境实测分辨率：主屏 1728×1117 物理 / scale=2 → 864×558.5 逻辑；
    // 副屏 2048×1152 物理（在主屏上方，CGDisplayBounds y=-576）→ 1024×576 逻辑。
    const THICKNESS: f64 = 28.0; // macOS 菜单栏厚度（pt，含刘海屏系统菜单栏）
    const WIN_W: f64 = 680.0; // popup 窗口逻辑宽（pt）

    /// 两屏：主屏 (0,0,864,558.5)；副屏在上方，AppKit 区间 y∈[558.5, 1134.5]
    fn screens_ak() -> Vec<(f64, f64, f64, f64)> {
        vec![(0.0, 0.0, 558.5, 864.0), (0.0, 558.5, 1134.5, 1024.0)]
    }

    #[test]
    fn primary_click_top_edge_1pt_below_menubar() {
        // 主屏状态项内点击（鼠标在状态项中间偏下）
        let (x, y) = popup_from_mouse((400.0, 544.5), THICKNESS, WIN_W, &screens_ak());
        // 顶边 = 屏顶 558.5 − 28 − 1 = 529.5（菜单栏底边下方 1pt）
        assert!((y - 529.5).abs() < 1e-6, "y={y}");
        // x 居中：400−340=60，主屏可容纳 [0,184]，不 clamp
        assert!((x - 60.0).abs() < 1e-6, "x={x}");
    }

    #[test]
    fn secondary_above_click_top_edge_1pt_below_its_menubar() {
        // 副屏（在主屏上方）状态项内点击，AppKit y≈1120
        let (x, y) = popup_from_mouse((400.0, 1120.0), THICKNESS, WIN_W, &screens_ak());
        // 顶边 = 副屏顶 1134.5 − 28 − 1 = 1105.5（副屏菜单栏底边下方 1pt）
        assert!((y - 1105.5).abs() < 1e-6, "y={y}");
        // x 居中：400−340=60，副屏 [0,344] 可容纳
        assert!((x - 60.0).abs() < 1e-6, "x={x}");
    }

    #[test]
    fn y_independent_of_click_position_within_status_item() {
        // 同一屏内，鼠标在状态项底部/中间/顶部 → y 恒为菜单栏底边下方 1pt
        for my in [558.5 - 2.0, 558.5 - 14.0, 558.5 - 27.0] {
            let (_x, y) = popup_from_mouse((400.0, my), THICKNESS, WIN_W, &screens_ak());
            assert!((y - 529.5).abs() < 1e-6, "my={my} y={y}");
        }
    }

    #[test]
    fn narrow_primary_clamps_x_both_edges() {
        // 鼠标在屏最右（x=860）→ x_left=520 超右缘 → clamp 到 864−680=184
        let (x, _) = popup_from_mouse((860.0, 544.5), THICKNESS, WIN_W, &screens_ak());
        assert!((x - 184.0).abs() < 1e-6, "x={x}");
        // 鼠标在屏最左（x=0）→ x_left=−340 超左缘 → clamp 到 0
        let (x, _) = popup_from_mouse((0.0, 544.5), THICKNESS, WIN_W, &screens_ak());
        assert!((x - 0.0).abs() < 1e-6, "x={x}");
    }

    #[test]
    fn secondary_click_clamps_x_to_secondary_screen() {
        // 副屏鼠标靠右（x=1020，副屏宽 1024）→ clamp 到 1024−680=344
        let (x, y) = popup_from_mouse((1020.0, 1120.0), THICKNESS, WIN_W, &screens_ak());
        assert!((x - 344.0).abs() < 1e-6, "x={x}");
        assert!((y - 1105.5).abs() < 1e-6, "y={y}");
    }
}
