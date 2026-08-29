//! Windows 系统托盘（tauri 官方 tray-icon 能力，仅 Windows 创建）。
//!
//! 与 macOS 的差异：macOS 无托盘（menubar 实例本身即 UI，Accessory 无 Dock 图标）；
//! Windows 上任务栏分组之外再提供一个托盘常驻入口：
//! - **左键单击** → 打开浮窗并选中「总览」分组（与点任务栏「总览」分组一致）；
//! - **右键** → 弹托盘菜单：打开设置… / 退出 fund01（菜单项 id 用裸 action id，
//!   事件走 lib.rs 注册的全局 on_menu_event → taskband::on_menu_event 统一分发）。
//!
//! 浮窗复用 window.rs 的 ensure/show/position（Windows 定位实现），
//! 闲置销毁、失焦隐藏等生命周期与 macOS 完全一致。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

/// 托盘图标 id（tauri 内部标识，当前仅一个托盘）
const TRAY_ID: &str = "fund01-tray";

/// 创建托盘图标（lib.rs setup 调用一次；进程常驻，无需重建）。
pub fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    // 菜单项 id 与任务栏实例右键菜单一致（open-settings / quit），
    // 事件统一走全局 on_menu_event 分发（taskband::on_menu_event 已剥前缀兼容裸 id）。
    let open_settings = MenuItem::with_id(app, "open-settings", "打开设置…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 fund01", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_settings, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("fund01")
        .menu(&menu)
        // 左键留给「打开浮窗（总览）」，右键才弹菜单（Windows 默认左键也弹菜单，需显式关掉）
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            // 左键单击 → 打开浮窗并选中「总览」分组。rect 为托盘图标屏幕位置
            //（tauri 的 Rect.position/size 是 Physical/Logical 枚举；Windows 托盘事件恒为
            // Physical 物理像素，Logical 分支按 1:1 透传兜底，仅理论路径），
            // Windows 版 position_below 会把浮窗定位到其正上方。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                rect,
                ..
            } = event
            {
                let (px, py) = match rect.position {
                    tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
                    tauri::Position::Logical(p) => (p.x, p.y),
                };
                let (rw, rh) = match rect.size {
                    tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
                    tauri::Size::Logical(s) => (s.width, s.height),
                };
                let app = tray.app_handle().clone();
                crate::window::show_popup(&app, Some((px, py, rw, rh)), Some("all"));
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        eprintln!("[fund01] 未找到默认窗口图标，托盘使用系统占位图标");
    }

    builder.build(app)?;
    eprintln!("[fund01] 已创建系统托盘图标");
    Ok(())
}
