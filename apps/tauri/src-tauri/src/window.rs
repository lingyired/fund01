//! 浮窗（menubar popup）生命周期 + 设置窗口。
//!
//! 生命周期：点击 menubar → show；失焦 → hide + 延迟 N 分钟销毁（默认 5min，
//! 期间再点击直接 show 状态保留；已销毁则重建）。窗口 680×600 与 Chrome popup 同尺寸。

use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, Position, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

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
pub fn open_settings_window(app: &AppHandle, tab: Option<&str>) {
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let url = match tab {
        Some(t) if t == "holdings" || t == "data" => format!("options.html?tab={t}"),
        _ => "options.html".to_string(),
    };
    if let Ok(win) = WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App(url.into()))
        .title("fund01 · 设置")
        .inner_size(1200.0, 800.0)
        .build()
    {
        let _ = win.show();
    }
}
