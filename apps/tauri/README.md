# apps/tauri

> **状态：✅ 已实现（2026-08-04）**。macOS menubar 常驻应用，Rust 重写数据层与合并计算（路径 A，见 §10）。
>
> 本文档为设计蓝本，以下部分标注「已实现」的章节与实际代码一致，未标注的为设计参考（实现时以 `src-tauri/src/` 为准）。

## 0. 已落地的实现（2026-08-04）

- **形态**：menubar 常驻（`ActivationPolicy::Accessory` 不占 Dock）；**多实例** = 总览 + 每个持仓分组一个 NSStatusItem（上行分组名 / 下行涨跌%，`tauri-plugin-multiline-menubar` 的 `set_colors` 原生 hex 着色，涨 #e5484d / 跌 #46a758 / 平灰）
- **架构**：Rust 重写全部数据与计算（`src-tauri/src/{providers,market,gold,history,calc,calendar,portfolio,theme,fundname,format,badge}`），TS 只留 `packages/ui`；4 个 Tauri Port 已实现（`src/ports/`）
- **数据源**：fund123（CSRF + `reqwest` cookie_store）+ fundmnfinfo（桌面 UA 批量 200/批）双全，`quoteSource` 切换
- **刷新**：`refresh.rs` tokio 循环，按 `tradingCalendar` 分档（交易 60s / 非交易 600s）；完成后 `emit('quote-update')` + 更新 menubar
- **浮窗**：680×600 无装饰窗口（`window.rs`），失焦 hide + 闲置 5min 销毁（`POPUP_DESTROY_DELAY_SECS`），点击重建；`?tab=` 设置窗口 1200×800
- **存储**：`tauri-plugin-store`（config.json）+ `AppState` 内存镜像；`save_config` 归一化落盘 + 广播 `config-change`
- **插件**：`tauri-plugin-multiline-menubar` 1.0.0 已内置 `set_colors`（Rust API + command），本地 path 依赖 `../../../../tauri-plugin-multiline-menubar`，无需改动

未来基于同一份 `packages/ui` + `packages/core` 实现 macOS menubar app（也可扩展 Windows / Linux）。本文档说明实现路径、关键架构点、Rust 后端需要实现的命令与事件清单。

## 1. 创建 Tauri 项目

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01/apps/tauri
pnpm create tauri-app@latest .
# 选择：React + TypeScript + pnpm
# 项目名：fund01-tauri
```

或手动初始化：

```bash
pnpm add -D @tauri-apps/cli@latest
pnpm tauri init
```

`tauri.conf.json` 关键配置：

```jsonc
{
  "productName": "fund01",
  "version": "1.0.0",
  "identifier": "com.wzk.fund01",
  "build": {
    "frontendDist": "../chrome/dist",   // 复用 chrome 的 popup 产物（或独立构建）
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "pnpm dev:web",
    "beforeBuildCommand": "pnpm build:web"
  },
  "app": {
    "windows": [],                       // 不创建默认窗口，menubar 模式按需创建
    "security": {
      "csp": null                        // 允许内联样式（echarts 需要）
    },
    "trayIcon": {
      "iconPath": "icons/icon.png",
      "iconAsTemplate": true             // macOS: 适配深色模式
    }
  },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"]
  }
}
```

## 2. Tauri 2 menubar app 真实架构

### 2.1 依赖

`Cargo.toml`：

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-store = "2"      # 配置持久化
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["json", "rustls-tls"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### 2.2 tray-icon feature

Tauri 2 的 `tray-icon` feature 启用托盘图标支持。核心 API：

- Rust：`TrayIconBuilder::new(app).build()`
- JS：`@tauri-apps/api/tray` 的 `TrayIcon.new()`

默认行为：左键或右键点击托盘图标 → 弹出原生菜单。menubar 模式需禁用左键弹菜单，改为弹出 popup 窗口。

### 2.3 自定义 popup 窗口（menubar 模式实现要点）

```rust
use tauri::{Manager, TrayIconBuilder, WebviewWindowBuilder, TrayIconEvent, LogicalPosition};
use tauri::tray::TrayIconEvent;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 1. 创建托盘图标
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("fund01 基金盯盘")
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, .. } => {
                            let app = tray.app_handle();
                            // 2. 点击托盘图标时显示/隐藏 popup 窗口
                            show_or_toggle_menubar_window(app, position);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // 3. 预创建隐藏的 popup 窗口
            WebviewWindowBuilder::new(app, "menubar", tauri::WebviewUrl::App("index.html".into()))
                .title("")
                .decorations(false)              // 无标题栏
                .skip_taskbar(true)              // 不出现在任务栏
                .resizable(false)
                .visible(false)                  // 先创建为隐藏
                .always_on_top(true)             // macOS 上浮于其他窗口
                .inner_size(400.0, 600.0)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_or_toggle_menubar_window(app: &AppHandle, position: PhysicalPosition<f64>) {
    if let Some(window) = app.get_webview_window("menubar") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            // 计算托盘图标屏幕位置，把窗口 setPosition 到图标下方
            let pos = LogicalPosition::new(position.x, position.y + 20);
            let _ = window.set_position(pos);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
```

点击窗口外部时 hide（macOS 上需监听失焦事件）：

```rust
window.on_window_event(|event| {
    if let WindowEvent::Focused(false) = event {
        let _ = window.hide();
    }
});
```

macOS 上调 `app.set_activation_policy(Accessory)` 让应用不出现在 Dock：

```rust
app.set_activation_policy(tauri::ActivationPolicy::Accessory);
```

**Dock 图标随设置窗口切换**（`window.rs::open_settings_window`）：应用整体 Accessory 常驻，
打开 `settings` 窗口时 `app.set_dock_visibility(true)` 切到 Regular（Dock 出现应用图标，
可 Cmd+Tab 切换），窗口销毁（`WindowEvent::Destroyed`）后 `set_dock_visibility(false)` 恢复
Accessory 不占 Dock。menubar 浮窗始终 Accessory，不参与切换。

## 3. 后端定时任务（Rust）

Rust 后端是常驻进程（不像 MV3 SW 30s 休眠）。用 `tauri::async_runtime::spawn` + `tokio::time::interval`：

```rust
use tauri::async_runtime;
use std::time::Duration;

fn start_refresh_loop(app: AppHandle) {
    async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Err(e) = refresh_all(&app).await {
                eprintln!("[fund01] refresh failed: {:?}", e);
            }
        }
    });
}

async fn refresh_all(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let config = load_config(app).await?;
    let (holdings, watchlist, indices, market, gold) = tokio::join!(
        fetch_funds_quotes(&config.holdings),
        fetch_funds_quotes(&config.watchlist),
        fetch_indices(),
        fetch_market_overview(),
        fetch_gold_realtime(&config.gold),
    );
    // 合并计算（Rust 重写或 sidecar 调 TS）
    let holdings_result = calc_holdings(&config.holdings, &holdings?);
    // ...
    // 推送事件到前端
    app.emit("quote-update", QuoteUpdate {
        holdings: holdings_result,
        watchlist: watchlist_result,
        indices, market, gold,
        time: chrono::Utc::now().timestamp_millis(),
    })?;
    // 更新托盘图标徽章
    update_tray_badge(app, holdings_result.summary.total_pnl_pct);
    Ok(())
}
```

CSRF token、内存缓存都可常驻（Rust 全局变量或 `tauri::State`）。

## 4. 事件推送（后端 → 前端）

### Rust → 前端

```rust
use tauri::Emitter;

// 广播到所有窗口
app.emit("quote-update", &payload)?;

// 仅推给特定窗口
window.emit_to("menubar", "quote-update", &payload)?;
```

### 前端订阅

```typescript
import { listen } from '@tauri-apps/api/event'

const unlisten = await listen<QuoteUpdate>('quote-update', (event) => {
  const payload = event.payload
  setHoldings(payload.holdings)
  // ...
})

// 清理
unlisten()
```

## 5. 托盘图标「徽章」差异

| 平台 | 机制 | 备注 |
|---|---|---|
| Chrome | `chrome.action.setBadgeText({text: "↑0.8%"})` 在图标上叠加文字 | 原生支持 |
| Tauri macOS | `tray.set_title("↑0.8%")` 显示在图标旁的文本 | **仅 macOS** 有 |
| Tauri（所有平台） | 动态生成图标 PNG（用 `image` crate 绘制数字到 icon），然后 `tray.set_icon(Some(icon))` | 跨平台通用 |
| Tauri Windows | 同上动态图标 | 无原生 badge |

Rust 端实现（使用 `image` crate 动态生成图标）：

```rust
use image::{ImageBuffer, Rgba};
use tauri::image::Image;

fn make_badge_icon(base_icon: &[u8], text: &str) -> Image {
    // 1. 解码基础图标
    let mut img = image::load_from_memory(base_icon).unwrap().to_rgba8();
    // 2. 用 imageproc 或 rusttype 在图标右下角绘制 text
    //    （此处省略绘图细节，需引入 rusttype 或 ab_glyph）
    // 3. 转 Tauri Image
    let rgba = img.into_raw();
    Image::new(&rgba, img.width(), img.height())
}

fn update_tray_badge(app: &AppHandle, total_pnl_pct: f64) {
    let text = if total_pnl_pct > 0.0 {
        format!("↑{:.2}%", total_pnl_pct)
    } else {
        format!("{:.2}%", total_pnl_pct)
    };
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_title(Some(&text));   // macOS 显示文本
        // 跨平台：动态图标
        // let icon = make_badge_icon(BASE_ICON, &text);
        // let _ = tray.set_icon(Some(icon));
    }
}
```

## 6. Rust 后端命令清单（对应 DataPort）

前端通过 `invoke` 调用 Rust 命令，对应 `@fund01/core` 的 `DataPort` 接口：

```rust
#[tauri::command]
async fn trigger_refresh(state: tauri::State<'_, AppState>) -> Result<(), String> { ... }

#[tauri::command]
async fn fetch_holdings(state: tauri::State<'_, AppState>) -> Result<HoldingsPayload, String> { ... }

#[tauri::command]
async fn fetch_watchlist(state: tauri::State<'_, AppState>) -> Result<WatchlistPayload, String> { ... }

#[tauri::command]
async fn fetch_indices(state: tauri::State<'_, AppState>) -> Result<Vec<IndexItem>, String> { ... }

#[tauri::command]
async fn fetch_market_overview(state: tauri::State<'_, AppState>) -> Result<Option<MarketOverview>, String> { ... }

#[tauri::command]
async fn fetch_gold(state: tauri::State<'_, AppState>) -> Result<Option<GoldPayload>, String> { ... }

#[tauri::command]
async fn fetch_fund_history(code: String, count: Option<u32>) -> Result<FundHistoryPayload, String> { ... }

#[tauri::command]
async fn fetch_index_history(code: String, range: String) -> Result<IndexHistoryPayload, String> { ... }

#[tauri::command]
async fn fetch_fund_intraday(fund_key: String) -> Result<Vec<IntradayPoint>, String> { ... }

#[tauri::command]
async fn resolve_fund(code: String) -> Result<ResolveFundPayload, String> { ... }
```

注册：

```rust
tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
        trigger_refresh,
        fetch_holdings,
        fetch_watchlist,
        fetch_indices,
        fetch_market_overview,
        fetch_gold,
        fetch_fund_history,
        fetch_index_history,
        fetch_fund_intraday,
        resolve_fund,
    ])
    .setup(|app| { ... })
    .run(tauri::generate_context!())
```

前端 Port 实现（`apps/tauri/src/ports/tauriDataPort.ts`）：

```typescript
import { invoke } from '@tauri-apps/api/core'
import type { DataPort, HoldingsPayload /* ... */ } from '@fund01/core'

export class TauriDataPort implements DataPort {
  async triggerRefresh() { await invoke('trigger_refresh') }
  async fetchHoldings() { return await invoke<HoldingsPayload>('fetch_holdings') }
  async fetchWatchlist() { return await invoke('fetch_watchlist') }
  async fetchIndices() { return await invoke('fetch_indices') }
  async fetchMarketOverview() { return await invoke('fetch_market_overview') }
  async fetchGold() { return await invoke('fetch_gold') }
  async fetchFundHistory(code: string, count?: number) { return await invoke('fetch_fund_history', { code, count }) }
  async fetchIndexHistory(code: string, range: string) { return await invoke('fetch_index_history', { code, range }) }
  async fetchFundIntraday(fundKey: string) { return await invoke('fetch_fund_intraday', { fundKey }) }
  async resolveFund(code: string) { return await invoke('resolve_fund', { code }) }
}
```

### WindowPort 对应命令（打开设置页 / 读版本号）

`packages/core` 的 `WindowPort` 是第 4 个 Port（`Ports.window` **必填**），Tauri 端必须实现，漏实现编译报错。对应两个 Rust command：

```rust
#[tauri::command]
async fn open_settings_window(app: AppHandle, tab: Option<String>) -> Result<(), String> {
    // tab: None → 打开 settings 窗口（或复用/聚焦已有 settings 窗口）
    // tab: Some("holdings" | "data") → 创建/聚焦时 URL 带 ?tab=，前端 OptionsApp initialTab 直达
    //   注：WebviewWindowBuilder 创建时无法直接拼 query，可先 WebviewUrl::App("options.html"),
    //   再 webview.eval() 修改 location，或由前端读前端可访问的共享状态；简化方案见下方「URL 参数替代」
    Ok(())
}

#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
```

前端 Port 实现（`apps/tauri/src/ports/tauriWindowPort.ts`）：

```typescript
import { invoke } from '@tauri-apps/api/core'
import type { WindowPort } from '@fund01/core'

export class TauriWindowPort implements WindowPort {
  async openSettings(tab?: 'general' | 'holdings' | 'data') {
    await invoke('open_settings_window', { tab: tab ?? null })
  }
  // openInNewWindow 不实现 → UI 自动隐藏「新标签页」按钮（可选方法）
  getVersion(): string {
    return APP_VERSION // 构建注入，或 invoke('get_version')
  }
}
```

**URL 参数替代方案**（推荐，复用现有 `?tab=` 机制）：Tauri 创建 settings 窗口时用 `WebviewUrl::App("options.html")` 加载同一入口，前端通过 `window.location.search` 解析 `?tab=`。若 `WebviewWindowBuilder` 不便拼 query，可用两个静态入口（`options.html` / `options-holdings.html` 同一 bundle）或由 `open_settings_window` 用 `window.eval` 改写 location 后 reload。无论哪种，**保持 `options.html?tab=` 约定不变**，`OptionsApp` 的 `initialTab` 解析无需改动。

## 7. 事件清单（对应 EventPort）

| 事件名 | Payload | 触发时机 |
|---|---|---|
| `quote-update` | `QuoteUpdate`（holdings / watchlist / indices / market / gold / time） | 后端每次刷新完成 |
| `config-change` | `AppConfig` | 配置变更（多窗口同步） |

前端 Port 实现（`apps/tauri/src/ports/tauriEventPort.ts`）：

```typescript
import { listen } from '@tauri-apps/api/event'
import type { EventPort, QuoteUpdate, AppConfig } from '@fund01/core'

export class TauriEventPort implements EventPort {
  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void {
    let unlisten: (() => void) | undefined
    listen<QuoteUpdate>('quote-update', (e) => cb(e.payload)).then((fn) => (unlisten = fn))
    return () => unlisten?.()
  }
  onConfigChange(cb: (config: AppConfig) => void): () => void {
    let unlisten: (() => void) | undefined
    listen<AppConfig>('config-change', (e) => cb(e.payload)).then((fn) => (unlisten = fn))
    return () => unlisten?.()
  }
}
```

## 8. 配置存储（Tauri store plugin）

使用 `tauri-plugin-store` 持久化配置：

```rust
use tauri_plugin_store::StoreExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let store = app.store("config.json")?;
            // 读取
            if let Some(config) = store.get("config") {
                println!("loaded config: {:?}", config);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
}
```

前端 `ConfigPort` 实现（`apps/tauri/src/ports/tauriConfigPort.ts`）：

```typescript
import { Store } from '@tauri-apps/plugin-store'
import { LazyMemo } from './lazyMemo'  // 前端内存镜像，保证同步读
import type { ConfigPort, AppConfig } from '@fund01/core'
import { DEFAULT_CONFIG, normalizeConfig } from '@fund01/core'

const STORE_KEY = 'config'
const memo = new LazyMemo<AppConfig>()  // 启动时从 store 加载一次

async function initMemo() {
  const store = await Store.load('config.json')
  const raw = await store.get<AppConfig>(STORE_KEY)
  memo.set(raw ? normalizeConfig(raw) : structuredClone(DEFAULT_CONFIG))
}

export class TauriConfigPort implements ConfigPort {
  getConfig(): AppConfig {
    return memo.get() ?? structuredClone(DEFAULT_CONFIG)
  }
  async saveConfig(config: AppConfig): Promise<void> {
    const next = normalizeConfig(config)
    memo.set(next)
    const store = await Store.load('config.json')
    await store.set(STORE_KEY, next)
    await store.save()
    // 通知其他窗口
    await invoke('broadcast_config_change', { config: next })
  }
  onChanged(cb: (config: AppConfig) => void): () => void {
    let unlisten: (() => void) | undefined
    listen<AppConfig>('config-change', (e) => {
      memo.set(e.payload)
      cb(e.payload)
    }).then((fn) => (unlisten = fn))
    return () => unlisten?.()
  }
}
```

**关键**：Tauri 的 `invoke` / `Store.get` 都是异步的，无法像 `localStorage.getItem` 那样同步读。解决方案是启动时从 store 加载一次到前端内存镜像（`LazyMemo`），之后 `getConfig` 同步读内存。这保持了 `ConfigPort.getConfig()` 的同步语义，避免 UI 闪烁。

## 9. 主窗口 vs menubar popup（多 WebviewWindow）

Tauri 一个 app 可有多个 `WebviewWindow`，用 label 区分：

- `main` / `settings` — 可选的主窗口（设置页 / 详细页 / 全屏看盘）；设置页由 `WindowPort.openSettings` 打开（见 9.1）
- `menubar` — 点击托盘弹出的浮窗

两者订阅同一套后端事件（`quote-update` / `config-change`），渲染同一份 `packages/ui`。差异仅在窗口尺寸与生命周期：

| 窗口 | 尺寸 | 生命周期 |
|---|---|---|
| `menubar` | 400×600，`decorations: false`、`skip_taskbar: true`、`always_on_top: true` | 点击托盘 show / 失焦 hide |
| `main` / `settings` | 1200×800，正常窗口 | 用户主动开关 |

两个窗口共享 `PortsContext.Provider`（注入同样的 Port 实现）。

### 9.1 打开设置页（WindowPort.openSettings）

- popup 齿轮按钮 / footer「修改持仓」在 UI 层只调 `windowPort.openSettings(tab?)`，不感知平台差异
- **设置界面 = 普通页面窗口，不做浮窗**：`settings` 窗口是带标题栏的正常窗口（1200×800，默认装饰、可出现在任务栏 / Dock），等价于浏览器里打开一个 options 标签页；与 `menubar` 浮窗（`decorations: false`、`skip_taskbar: true`、`always_on_top: true`）形态完全相反
- **macOS Dock 图标随设置窗口出现**：应用默认 `ActivationPolicy::Accessory`（不占 Dock），`open_settings_window` 打开设置窗口时临时切 Regular 显示 Dock 图标，窗口关闭后恢复 Accessory（见 2.1）
- Tauri 实现 = 创建（或聚焦已存在的）`settings` 窗口：`WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("options.html"))`；已存在则 `get_webview_window("settings").show()` + `set_focus()`，避免重复开窗
- 带 tab 定位（footer「修改持仓」→ `openSettings('holdings')`）：沿用 `options.html?tab=holdings` URL 参数约定（见 6.5），`OptionsApp.initialTab` 解析零改动
- Chrome 对照：无 tab 走 `openOptionsPage()`（复用已开标签），带 tab 走 `tabs.create(?tab=)`

settings 窗口的前端入口（`apps/tauri/src/options.tsx`，与 Chrome 的 options 入口同构）：

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { OptionsApp, PortsContext, initTheme } from '@fund01/ui'
import type { Ports } from '@fund01/core'
import { TauriDataPort } from '../ports/tauriDataPort'
import { TauriConfigPort } from '../ports/tauriConfigPort'
import { TauriEventPort } from '../ports/tauriEventPort'
import { TauriWindowPort } from '../ports/tauriWindowPort'

initTheme()

// 与 Chrome 端一致的 ?tab= 解析（Tauri webview 的 window.location.search 同样可用）
const urlTab = new URLSearchParams(window.location.search).get('tab')
const initialTab = urlTab === 'holdings' || urlTab === 'data' ? urlTab : 'general'

const ports: Ports = {
  data: new TauriDataPort(),
  config: new TauriConfigPort(),
  event: new TauriEventPort(),
  window: new TauriWindowPort(),
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PortsContext.Provider value={ports}>
      <OptionsApp initialTab={initialTab} version={ports.window.getVersion()} />
    </PortsContext.Provider>
  </React.StrictMode>,
)
```

注意：`menubar` 浮窗加载 `index.html`（App.tsx），`settings` 窗口加载 `options.html`（OptionsApp.tsx），两者是不同的前端入口、同一套 Ports 注入与后端事件。

## 10. 实现路径决策（✅ 已拍板：路径 A，2026-08-04）

实现 Tauri 时有以下两条路径，2026-08-04 已拍板 **路径 A（Rust 重写）** 并落地：

### 路径 A：Rust 重写 services + holdingsCalc ✅

- **范围**：用 `reqwest` 重写 `packages/services` 的 fund.ts / gold.ts / market.ts；用 Rust 重写 `packages/core` 的 holdingsCalc.ts / tradingCalendar.ts / portfolioLogic.ts / format.ts / fundName.ts / badge.ts
- **优点**：
  - 性能好（原生 HTTP、无 JS 运行时开销）
  - 单二进制分发，无 JS 运行时依赖
  - CSRF token、内存缓存常驻，无 SW 重启问题
- **缺点**：
  - 要重写约 1500 行业务逻辑
  - 双份逻辑（TS + Rust）长期维护负担
- **落地情况**：`src-tauri/src/` 下 `providers/*`（fund123/fundmnfinfo）、`market.rs`、`gold.rs`、`history.rs`、`calc.rs`、`calendar.rs`、`portfolio.rs`、`theme.rs`（板块正则迁移）、`fundname.rs`、`format.rs` 已全部实现并通过编译与单测

### 路径 B：JS sidecar（Bun / Node）跑 TS services + core（未采用）

- 复用现有 TS 代码，但分发体积大、IPC 复杂，最终未选

### 路径 C：混合（Rust 调度 + TS sidecar 业务）

- 早期设想（Rust 拉原始数据 + sidecar 计算），随路径 A 拍板而弃用

**决策理由**：menubar 常驻 + 托盘实时显示需要后端独立持有数据；UI 层经 4 Port 契约零改动复用（monorepo 重构的核心收益）。

## 11. 与 Chrome 实现的对照

| 关注点 | Chrome 实现 | Tauri 实现（未来） |
|---|---|---|
| 后端运行时 | MV3 Service Worker（30s 休眠，alarm 唤醒） | Rust 常驻进程 |
| 定时调度 | `chrome.alarms` | `tokio::time::interval` |
| 数据请求 | `@fund01/services`（fetch） | Rust `reqwest` 或 sidecar 调 services |
| 合并计算 | SW 调 `@fund01/core` | Rust 重写 或 sidecar 调 core |
| 配置存储 | `localStorage` + `chrome.storage.local` | `tauri-plugin-store` + 前端内存镜像 |
| 事件推送 | `chrome.storage.onChanged`（监听 `cache-time`） | `app.emit('quote-update', ...)` + 前端 `listen` |
| UI 拉取 | `chrome.runtime.sendMessage` → SW | `invoke('fetch_holdings')` → Rust command |
| 托盘徽章 | `chrome.action.setBadgeText` | 动态 PNG 或 `tray.set_title`（仅 macOS） |
| popup 生命周期 | 关闭即销毁 | hide / show（窗口常驻，状态保留） |
| 多窗口 | popup 一般单实例 | `main` + `menubar` 多 WebviewWindow |
| 打开设置页 | `openOptionsPage()` / `tabs.create(?tab=)` | `open_settings_window`（`settings` 窗口，沿用 `?tab=` 约定） |
| 版本号 | `getManifest().version` | `get_version`（`CARGO_PKG_VERSION`）或构建注入 |
| UI 复用 | `packages/ui` | 同一份 `packages/ui` |

## 12. 启动检查清单（未来实现时）

实现 Tauri 端时，按以下顺序推进：

1. [ ] `pnpm create tauri-app` 初始化 `apps/tauri/`
2. [ ] `tauri.conf.json` 配置 tray-icon，不创建默认窗口
3. [ ] Rust 端实现 `TrayIconBuilder` + `WebviewWindowBuilder`（menubar 模式）
4. [ ] Rust 端实现 `tokio::time::interval` 定时刷新循环
5. [ ] Rust 端实现 10 个 `#[tauri::command]`（对应 DataPort）
6. [ ] Rust 端实现 `open_settings_window`（创建/聚焦 settings 窗口，支持 `?tab=`）+ `get_version`（对应 WindowPort）
7. [ ] Rust 端实现 `app.emit('quote-update', ...)` / `app.emit('config-change', ...)`
8. [ ] Rust 端实现托盘徽章（动态 PNG 或 `set_title`）
9. [ ] 前端实现 `apps/tauri/src/ports/tauriDataPort.ts` / `tauriConfigPort.ts` / `tauriEventPort.ts` / `tauriWindowPort.ts`
10. [ ] 前端入口 `apps/tauri/src/menubar.tsx` 挂载 `@fund01/ui` 的 App + 注入 Tauri Ports（含 `window`，否则编译报错）
11. [ ] 前端入口 `apps/tauri/src/options.tsx` 挂载 `OptionsApp`（settings 普通窗口页面，`?tab=` 解析见 9.1）
12. [ ] 验证 macOS 上 `set_activation_policy(Accessory)` 不出现在 Dock
13. [ ] 验证点击窗口外部自动 hide
14. [ ] 验证 `packages/ui` 无需修改即可在 Tauri webview 中渲染
15. [ ] 决定路径 A / B / C，实现数据请求与合并计算
16. [ ] 打包 `dmg` 测试分发

## 13. 注意事项

- **Tauri 2.x API 变化**：本文档基于 Tauri 2.x 编写，未来实现时需对照官方文档验证 `TrayIconBuilder` / `WebviewWindowBuilder` / `Emitter` 等 API 是否有变化
- **CSP**：Tauri 默认有 CSP 限制，echarts 可能需要内联样式，需在 `tauri.conf.json` 中配置 `security.csp` 放宽
- **macOS 签名**：分发需 Developer ID 签名 + 公证，否则用户首次打开会被 Gatekeeper 拦截
- **图标资源**：托盘图标需要 `.png`（macOS 推荐 16x16 / 32x32 模板图标，`iconAsTemplate: true` 适配深色模式）
- **`packages/ui` 复用**：Tauri webview 加载的是同一份 `packages/ui` 构建产物（或源码直引），无需修改 UI 代码即可运行——这是 monorepo 重构的核心收益
