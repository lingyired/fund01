# apps/tauri

> **状态：占位文档，未实现。** 本目录目前仅含此 README，无任何 Rust / JS 源码。
>
> 本文档基于 Tauri 2.x 编写。真正动手实现时需验证 API 是否有变化。

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
  "productName": "wzk-fund",
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
                .tooltip("wzk-fund 基金盯盘")
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
                eprintln!("[wzk-fund] refresh failed: {:?}", e);
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

- `main` — 可选的主窗口（设置页 / 详细页 / 全屏看盘）
- `menubar` — 点击托盘弹出的浮窗

两者订阅同一套后端事件（`quote-update` / `config-change`），渲染同一份 `packages/ui`。差异仅在窗口尺寸与生命周期：

| 窗口 | 尺寸 | 生命周期 |
|---|---|---|
| `menubar` | 400×600，`decorations: false`、`skip_taskbar: true`、`always_on_top: true` | 点击托盘 show / 失焦 hide |
| `main` | 1200×800，正常窗口 | 用户主动开关 |

两个窗口共享 `PortsContext.Provider`（注入同样的 Port 实现）。

## 10. 未来实现路径决策（Rust 重写 vs JS sidecar）

实现 Tauri 时需在以下两条路径中二选一：

### 路径 A：Rust 重写 services + holdingsCalc

- **范围**：用 `reqwest` 重写 `packages/services` 的 fund.ts / gold.ts / market.ts；用 Rust 重写 `packages/core` 的 holdingsCalc.ts / tradingCalendar.ts / portfolioLogic.ts
- **优点**：
  - 性能好（原生 HTTP、无 JS 运行时开销）
  - 单二进制分发，无 JS 运行时依赖
  - CSRF token、内存缓存常驻，无 SW 重启问题
- **缺点**：
  - 要重写约 1500 行业务逻辑
  - `tradingCalendar.ts` 的 A 股 / 美股 / 黄金交易日规则、节假日表维护成本高
  - 板块推断正则（SECTOR_RULES）需迁移
  - 双份逻辑（TS + Rust）长期维护负担
- **适用**：追求极致性能与分发体积，逻辑稳定不频繁迭代

### 路径 B：JS sidecar（Bun / Node）跑 TS services + core

- **范围**：用 Bun compile 打包 `packages/services` + `packages/core` 为 sidecar 二进制；Rust 后端通过 `Command::sidecar` 启动并通过 stdio / IPC 通信
- **优点**：
  - 复用现有 TS 代码，维护一份逻辑
  - 迭代快（改 TS 即生效）
- **缺点**：
  - 分发体积大（Bun runtime + sidecar 二进制 ~50MB）
  - Tauri 与 sidecar 的 IPC 增加复杂度
  - 启动时需先拉起 sidecar
- **适用**：快速验证，逻辑迭代频繁

### 路径 C（推荐）：混合——Rust 做调度 + TS sidecar 做业务

- Rust 后端只做：定时调度、`reqwest` 拉数据、推送事件、托盘徽章
- TS sidecar 做：合并计算（`calcHoldings` / `mergeWatchlist`）、配置归一化
- Rust 把原始行情丢给 sidecar 计算，sidecar 返回结果后 Rust 推事件
- 平衡性能与维护成本

**当前决策**：抽象接口（Port）不依赖该决策，延后到真正动手实现 Tauri 时再选。本目录仅为占位，不预设路径。

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
| UI 复用 | `packages/ui` | 同一份 `packages/ui` |

## 12. 启动检查清单（未来实现时）

实现 Tauri 端时，按以下顺序推进：

1. [ ] `pnpm create tauri-app` 初始化 `apps/tauri/`
2. [ ] `tauri.conf.json` 配置 tray-icon，不创建默认窗口
3. [ ] Rust 端实现 `TrayIconBuilder` + `WebviewWindowBuilder`（menubar 模式）
4. [ ] Rust 端实现 `tokio::time::interval` 定时刷新循环
5. [ ] Rust 端实现 10 个 `#[tauri::command]`（对应 DataPort）
6. [ ] Rust 端实现 `app.emit('quote-update', ...)` / `app.emit('config-change', ...)`
7. [ ] Rust 端实现托盘徽章（动态 PNG 或 `set_title`）
8. [ ] 前端实现 `apps/tauri/src/ports/tauriDataPort.ts` / `tauriConfigPort.ts` / `tauriEventPort.ts`
9. [ ] 前端入口 `apps/tauri/src/menubar.tsx` 挂载 `@fund01/ui` 的 App + 注入 Tauri Ports
10. [ ] 验证 macOS 上 `set_activation_policy(Accessory)` 不出现在 Dock
11. [ ] 验证点击窗口外部自动 hide
12. [ ] 验证 `packages/ui` 无需修改即可在 Tauri webview 中渲染
13. [ ] 决定路径 A / B / C，实现数据请求与合并计算
14. [ ] 打包 `dmg` 测试分发

## 13. 注意事项

- **Tauri 2.x API 变化**：本文档基于 Tauri 2.x 编写，未来实现时需对照官方文档验证 `TrayIconBuilder` / `WebviewWindowBuilder` / `Emitter` 等 API 是否有变化
- **CSP**：Tauri 默认有 CSP 限制，echarts 可能需要内联样式，需在 `tauri.conf.json` 中配置 `security.csp` 放宽
- **macOS 签名**：分发需 Developer ID 签名 + 公证，否则用户首次打开会被 Gatekeeper 拦截
- **图标资源**：托盘图标需要 `.png`（macOS 推荐 16x16 / 32x32 模板图标，`iconAsTemplate: true` 适配深色模式）
- **`packages/ui` 复用**：Tauri webview 加载的是同一份 `packages/ui` 构建产物（或源码直引），无需修改 UI 代码即可运行——这是 monorepo 重构的核心收益
