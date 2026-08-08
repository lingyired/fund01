//! 浮窗（menubar popup）生命周期 + 设置窗口。
//!
//! 生命周期：点击 menubar → show；失焦 → hide + 延迟 N 分钟销毁（默认 5min，
//! 期间再点击直接 show 状态保留；已销毁则重建）。窗口 680×600 与 Chrome popup 同尺寸。

use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, Position, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

#[cfg(target_os = "macos")]
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use objc2::runtime::{AnyObject, Sel};
#[cfg(target_os = "macos")]
use objc2_app_kit::NSApplicationTerminateReply;

use crate::state::AppState;

pub const POPUP_LABEL: &str = "menubar";
pub const SETTINGS_LABEL: &str = "settings";
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
    }
    (win, false)
}

/// 失焦 → hide + 启动延迟销毁计时器
fn attach_popup_handlers(app: &AppHandle, win: &WebviewWindow) {
    let app = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
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

/// 把窗口定位到状态项正下方（macOS y 向上，Tauri y 向下，需翻转）
fn position_below(app: &AppHandle, win: &WebviewWindow, rect: (f64, f64, f64, f64)) {
    let (rx, ry, rw, _rh) = rect;
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = win.scale_factor().unwrap_or(1.0);
        let outer = win.outer_size().unwrap_or_default();
        let win_w = outer.width as f64 / scale;
        let win_h = outer.height as f64 / scale;
        let msize = monitor.size();
        let mscale = monitor.scale_factor();
        let screen_w = msize.width as f64 / mscale;
        let screen_h = msize.height as f64 / mscale;
        let mut x = rx + rw / 2.0 - win_w / 2.0;
        x = x.clamp(0.0, (screen_w - win_w).max(0.0));
        let y = screen_h - ry - win_h;
        let _ = win.set_position(Position::Logical(LogicalPosition::new(x, y)));
    }
}

/// 显示浮窗（点击 menubar 实例时调用；rect 为该实例屏幕位置）。
/// tab = 该实例对应的 popup 分组 tab id（'all' / 分组名 / '__ungrouped__'）：
/// 窗口已存在（webview 已加载）→ emit 事件直达；新建 → 前端读 ?tab= 初始化。
pub fn show_popup(app: &AppHandle, rect: Option<(f64, f64, f64, f64)>, tab: Option<&str>) {
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
            let hash = anchor.filter(|_| t == "holdings").map(|a| format!("#{a}")).unwrap_or_default();
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
        // 窗口销毁后恢复 Accessory（menubar 常驻、不占 Dock）
        #[cfg(target_os = "macos")]
        {
            let _ = app.set_dock_visibility(true);
            let app2 = app.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::Destroyed = event {
                    let _ = app2.set_dock_visibility(false);
                }
            });
        }
        let _ = win.show();
    }
}

/// macOS：拦截 Dock 右键「退出」/ Cmd+Q（`NSApp terminate:`），把「退出」改写成
/// 「只关闭设置窗口，menubar 保持常驻」。
///
/// 为什么需要原生 hook：tauri 的 `RunEvent::ExitRequested` + `prevent_exit()` 只覆盖
/// 「最后一个窗口销毁」和 `app.exit(code)` 两条路径；macOS 系统级 `terminate:`（Dock
/// 右键退出、Cmd+Q）直接走 `NSApplication` 默认行为退出进程，tao 0.35 的 AppDelegate
/// 没有实现 `applicationShouldTerminate:`，tauri 拦不到。
///
/// 做法：给现有 AppDelegate 类动态挂 `applicationShouldTerminate:` ——
/// 有设置窗口 → 关闭它 + 恢复 Accessory + 返回 `TerminateCancel`（取消退出）；
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
            let impl_fn = application_should_terminate as unsafe extern "C-unwind" fn(
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
    let Some(win) = app.get_webview_window(SETTINGS_LABEL) else {
        // 无设置窗口（纯 menubar 态）→ 放行真正退出
        return NSApplicationTerminateReply::TerminateNow;
    };
    eprintln!("[fund01] Dock/Cmd+Q 退出被拦截：仅关闭设置窗口，menubar 保持常驻");
    let _ = app.set_dock_visibility(false);
    let _ = win.close();
    NSApplicationTerminateReply::TerminateCancel
}
