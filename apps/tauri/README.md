# apps/tauri

> **状态：✅ 已实现并保持维护（截至 2026-08-12）。**
>
> macOS menubar 常驻应用，`Rust` 重写全部数据层与合并计算（路径 A，见 §10）。
> 本文档为**当前实现说明（as-built）**：§0 起的内容与实际代码一致，命令/事件/窗口清单以
> `src-tauri/src/` 与 `src/ports/` 为准。设计期遗留的「未来 / 未采用」表述已清理。
>
> **构建校验**：`cargo check`（Rust 后端）与 `pnpm --filter @fund01/tauri typecheck`（前端 TS）均通过。

## 0. 已实现的能力（截至 2026-08-12）

- **形态**：macOS menubar 常驻（`ActivationPolicy::Accessory`，不占 Dock）；多实例 = 总览
  （`menubar-overview`）+ 每个持仓分组一个 `NSStatusItem`（上行分组名 / 下行涨跌%，可配置），未分组持仓进兜底实例 `menubar-ungrouped`。
- **菜单栏着色**：`tauri-plugin-multiline-menubar` 原生 `set_colors`（`ColorStyle::Solid` 直接传 hex，涨/跌/平分行着色）、`set_bold`（行独立加粗）、`set_alignment`（行独立 0=左 1=中 2=右）、`set_visible`（显隐，不销毁）、`set_menu`、`remove`。
  - 默认色：涨 `#FF4F44` / 跌 `#34C759` / 平灰 `#8e8e93`（可在设置里改 `menubarRiseColor` / `menubarFallColor`）。
  - 实例生命周期：`create` 一次终生不销毁；显隐只翻 `set_visible`；仅分组被删除/重命名、未分组持仓清空时才 `remove`（避免 macOS 13+ `removeStatusItem` 丢位置）。
  - **⌘-拖出单个实例**：插件 v1.6.0 在用户拖出时 emit `multiline-menubar://{id}//remove`，Rust 侧 `menubar.rs` 监听并 `remove` 该实例（不影响其他实例），与 `is_visible` 回读无关。
- **架构**：Rust 持有全部数据与计算（`src-tauri/src/{providers,market,gold,history,calc,calendar,portfolio,theme,fundname,format,badge,model,state,refresh,window,menubar,commands}`），TS 只留 `packages/ui` + `packages/core`；4 个 Tauri Port 已实现（`src/ports/`）。
- **数据源**：fund123（蚂蚁基金 CSRF + `reqwest` cookie_store）+ fundmnfinfo（东方财富批量，桌面 UA，200/批）双全，`quoteSource` 切换（`providers/mod.rs`）。
- **刷新**：`refresh.rs` 两个独立 tokio 循环（日盘 A 股 / 夜盘美股）+ 立即全量；按 `tradingCalendar` 分档，并在时段翻转点「准点切档」（醒来重判，不滞后一个周期）；完成后 `emit('quote-update')` + 重建/更新 menubar，并 `emit('refresh-schedule')` 驱动前端进度环。
- **浮窗**：680×600 无装饰窗口（`window.rs`），失焦 hide + 闲置 5min 销毁（`POPUP_DESTROY_DELAY_SECS`），点击重建；状态保留至销毁前。
- **popup-tab 独立页面**：「在新窗口打开」对齐 Chrome `popup.html?tab=1` 标签页模式，1000×760 持久化窗口，手动关闭才销毁，不随 menubar 浮窗隐藏/销毁。
- **设置窗口**：`options.html?tab=` + `#anchor` 直达（`open_settings_window(tab, anchor)`），1200×800 正常窗口。
- **存储**：`tauri-plugin-store`（config.json）+ `AppState` 内存镜像；`save_config` 归一化落盘 + `emit('config-change')` 广播；纯「菜单栏展示类」变更（隐藏分组/布局/字号/颜色）**不触发网络刷新**。
- **Dock 跟随主界面窗口**：仅 `settings` / `popup-tab` 存在时切 Regular（Dock 显示图标），全部销毁恢复 Accessory；menubar 浮窗始终 Accessory。
- **退出拦截**：`window::install_terminate_hook`（objc2 给 AppDelegate 挂 `applicationShouldTerminate:`）拦截 Dock 右键「退出」/ Cmd+Q → 只关主界面窗口、menubar 保持常驻；纯 menubar 态（无主界面窗口）放行真正退出。另通过 `RunEvent::ExitRequested` 拦「最后一个窗口销毁 → 隐式退出」，进程常驻。
- **插件版本**：`tauri-plugin-multiline-menubar` git 依赖固定 `tag = "v1.6.0"`（v1.5.0 新增 per-line 水平对齐；v1.6.0 新增 `NSStatusItemBehaviorRemovalAllowed` 与 remove 事件）。

未来可基于同一份 `packages/ui` + `packages/core` 扩展 Windows / Linux（当前 menubar 形态仅 macOS，插件本身是 macOS 多 `NSStatusItem` 实现）。

## 1. 项目与构建

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
pnpm --filter @fund01/tauri dev      # rsbuild dev（devUrl http://localhost:1420）
pnpm --filter @fund01/tauri build    # rsbuild build → apps/tauri/dist
pnpm --filter @fund01/tauri tauri dev    # 拉起桌面端（开发）
pnpm --filter @fund01/tauri tauri build  # 打包 .app / .dmg（release）
```

- 前端入口（rsbuild 双入口）：`index` → `src/menubar.tsx`（浮窗，加载 `packages/ui` 的 `App`）；
  `options` → `src/options.tsx`（设置窗口，加载 `OptionsApp`）。`?tab=` / `?tab=1` / `#anchor` 由前端解析。
- `tauri.conf.json`：`frontendDist: "../dist"`，`app.windows: []`（不创建默认窗口，menubar 按需创建），`security.csp: null`（echarts 内联样式），`macOSPrivateApi: true`，`bundle.targets: ["app","dmg"]`，`identifier: com.lingyi.fund01`。
- Rust 依赖见 `src-tauri/Cargo.toml`：`tauri`（features `tray-icon` + `macos-private-api`）、`tauri-plugin-store`、`tokio`（full）、`reqwest`（json + rustls-tls + cookies）、`chrono`、`regex`、`futures`、`tauri-plugin-multiline-menubar`；macOS-only `objc2` / `objc2-app-kit`（版本与 tauri 依赖链 objc2 0.6.x 对齐）。`profile.release` 用 `lto = "thin"`（fat LTO 与插件 native ObjC++ block 符号不兼容）。

## 2. macOS menubar 架构（实际实现）

菜单栏实例由 `tauri-plugin-multiline-menubar` 提供（非手写 `TrayIconBuilder`）。`lib.rs` setup 中：

```rust
// 禁用插件自动 popup（生命周期由 window.rs 自管），浮窗 label 固定 "menubar"
app.multiline_menubar().set_auto_popup(false)?;
app.multiline_menubar().set_popup_window(window::POPUP_LABEL.to_string())?;
// 右键菜单事件
app.on_menu_event(|app, event| menubar::on_menu_event(app, event.id().0.as_str()));
// 重建多实例
menubar::rebuild_menubar(&handle, &config, quote.as_ref());
```

- **多实例编排**（`menubar.rs`）：`rebuild_menubar` 收敛实例集合（create 缺失 + `set_visible` 显隐 + 删分组时 `remove`），并 `set_menu` / `set_colors` / `set_bold` / `set_alignment` 下发每行样式；点击实例 → `show_popup(rect, tab)` 打开浮窗并 `emit('popup-open-group', tabId)`。
- **Dock 不占**：`app.set_activation_policy(Accessory)`（仅 macOS）。
- **Dock 跟随主界面窗口**（`window.rs`）：`open_settings_window` / `open_popup_tab_window` 打开时 `set_dock_visibility(true)`；窗口 `WindowEvent::Destroyed` 后若 `has_main_window()` 为 false 则恢复 `set_dock_visibility(false)`。
- **退出拦截**（`window.rs::install_terminate_hook`）：objc2 给 AppDelegate 动态挂 `applicationShouldTerminate:` —— 有 `settings` / `popup-tab` 窗口 → 关闭它们 + 恢复 Accessory + 返回 `TerminateCancel`（menubar 保持常驻）；无主界面窗口（纯 menubar 态）→ 返回 `TerminateNow` 放行真正退出。`RunEvent::ExitRequested` 中 `code.is_none()` 时 `api.prevent_exit()` 拦「窗口全关隐式退出」。

## 3. 后端定时刷新（Rust，`refresh.rs`）

常驻进程，两个独立 `tauri::async_runtime::spawn` + `tokio::time::sleep` 循环，任意时刻至多一个走盘中档：

| 循环 | 负责数据 | 盘中窗口 | 非交易退化 |
|---|---|---|---|
| 日盘 | 基金持仓 + A 股指数（含黄金 AU9999 入口） | `is_day_market_active` 09:00–15:30 | 用 non_trading 档 |
| 夜盘 | 美股指数（NDX/SPX） | `is_night_market_active` 20:00–次日 04:00 | 无美股指数 → 低频空转（不拉不广播） |

- 间隔取 `config.settings.refresh_interval`（`trading` / `non_trading` 分档），低于 5s 夹到 5s。
- **准点切档**：`seconds_until_next_switch` 计算到下一时段翻转点的秒数，若比当前档位周期更近则先睡到翻转点、醒来重判，消除「非交易档最坏滞后一个周期」。
- **手动刷新**（`trigger_refresh(reset_timer)`）：`reset_timer=true`（点击刷新）→ 全量拉取 + `emit('refresh-schedule')` 重置进度环 + `Notify::notify_one()` 唤醒两循环使其从「现在」重新计时；`reset_timer=false`（打开浮窗拉数据）→ 仅拉数据、不动定时器，避免进度环与后台脱节。
- 每轮合并缓存 → `state.quote` → `app.emit('quote-update')` + 更新 menubar。

## 4. 事件推送（后端 → 前端，`@tauri-apps/api/event`）

| 事件名 | Payload | 触发时机 |
|---|---|---|
| `quote-update` | `QuoteUpdate`（holdings / indices / time） | 每次刷新完成 |
| `config-change` | `AppConfig` | `save_config` 落盘后广播（多窗口同步） |
| `refresh-schedule` | `{intervalSeconds, nextRefreshAt}` | 每轮定时器重置 / 手动刷新（驱动刷新按钮进度环） |
| `popup-open-group` | `string`（分组 tab id） | 点击 menubar 实例打开浮窗时（前端 `App` 直达分组 tab） |

前端经 `TauriEventPort` 订阅（含 `emitDebug` → `dbg_log` 把 webview 日志打到 stdout）。

## 5. 菜单栏着色与角标

- **菜单栏每行着色**走 `menubar.rs::color_for`（涨/跌/平）+ 插件 `set_colors(ColorStyle::Solid)`，颜色来自配置 `menubarRiseColor` / `menubarFallColor`（默认 `#FF4F44` / `#34C759`）与 `menubarTopColor`（上行固定色，默认 `#ffffff`）。不计 macOS `tray.set_title` 文本徽章——本应用用多实例 + 原生 hex 着色表达涨跌。
- **`badge.rs`**：1:1 迁移 `packages/core/src/badge.ts`（`compute_badge(mode, pct, pnl)` → `{text, color}`，`percent` / `amount` / `hidden` 三模式，涨 `#dc2626` / 跌 `#16a34a`），当前 `#![allow(dead_code)]` 预留给未来紧凑角标文本复用。

## 6. Rust 命令清单（已注册，对应 4 个 Port）

`lib.rs` `invoke_handler` 注册共 15 个命令：

| 命令 | 签名 | 对应 Port / 用途 |
|---|---|---|
| `trigger_refresh` | `(reset_timer: bool)` | DataPort.triggerRefresh |
| `fetch_holdings` | `() -> Option<HoldingsPayload>` | DataPort.fetchHoldings（读内存缓存） |
| `fetch_indices` | `() -> Vec<IndexItem>` | DataPort.fetchIndices |
| `fetch_last_update` | `() -> i64` | DataPort.fetchLastUpdate（最近刷新时间戳 ms） |
| `fetch_fund_history` | `(code, range: Option<String>)` | DataPort.fetchFundHistory（`1m/3m/1y/...`，默认 `3m`） |
| `fetch_index_history` | `(code, range: Option<String>)` | DataPort.fetchIndexHistory（默认 `1m`） |
| `fetch_fund_intraday` | `(req: FundIntradayRequest)` | DataPort.fetchFundIntraday（对话框分时） |
| `resolve_fund` | `(req: ResolveFundRequest)` | DataPort.resolveFund（解析基金名/代码/板块） |
| `get_config` | `() -> AppConfig` | ConfigPort.getConfig（Rust 持有权威副本） |
| `save_config` | `(config: AppConfig) -> AppConfig` | ConfigPort.saveConfig（归一化 + 落盘 + 广播 + 按需重建 menubar/刷新） |
| `open_settings_window` | `(tab: Option<String>, anchor: Option<String>)` | WindowPort.openSettings（`?tab=` + `#anchor`） |
| `open_popup_tab_window` | `()` | WindowPort.openInNewWindow（popup-tab 独立页面） |
| `get_version` | `() -> String` | WindowPort.getVersion（`CARGO_PKG_VERSION`） |
| `open_external` | `(url: String)` | WindowPort.openExternal（系统浏览器打开 http(s)） |
| `dbg_log` | `(msg: String)` | EventPort.emitDebug（webview 日志 → stdout） |

`FundIntradayRequest { code, fund_key, name }`、`ResolveFundRequest { code, type, name, sectors }` 定义见 `model.rs`。

前端 Port 实现（`src/ports/`）：

```typescript
// tauriDataPort.ts（节选）
async triggerRefresh(resetTimer = true) { await invoke('trigger_refresh', { resetTimer }) }
async fetchHoldings() { return (await invoke('fetch_holdings')) ?? EMPTY }
async fetchFundHistory(code, range = '1y') { return invoke('fetch_fund_history', { code, range: range ?? null }) }
async fetchFundIntraday(fundKey) { return (await invoke('fetch_fund_intraday', { req: { code: fundKey, fundKey } })).points }
async resolveFund(p) { return invoke('resolve_fund', { req: { code: p.code, type: p.type ?? null, name: p.name ?? null, sectors: p.sectors ?? null } }) }
```

```typescript
// tauriWindowPort.ts（节选）
async openSettings(tab?, anchor?) { await invoke('open_settings_window', { tab: tab ?? null, anchor: tab === 'holdings' ? (anchor ?? null) : null }) }
async openInNewWindow() { await invoke('open_popup_tab_window') }
async openExternal(url) { await invoke('open_external', { url }) }
getVersion() { /* 首调 invoke('get_version') 缓存 */ return versionCache || '1.0.0' }
supportsMenubar() { return true }   // 桌面端支持菜单栏设置 tab
supportsBadge() { return false }    // 扩展角标是 Chrome 能力，桌面版不显示
```

## 7. 配置存储（命令式，非前端直读 store）

配置权威副本在 Rust `AppState.config`（`RwLock<AppConfig>`），`tauri-plugin-store` 仅做持久化。`TauriConfigPort`：

```typescript
class TauriConfigPort implements ConfigPort {
  async init() { memo.set(normalizeConfig(await invoke<AppConfig>('get_config'))) }  // 启动拉一次
  getConfig() { return memo.get() ? normalizeConfig(memo.get()!) : DEFAULT_CONFIG }  // 同步读内存
  async saveConfig(config) {
    memo.set(normalizeConfig(config))                       // 乐观同步，避免回包前读到旧值
    saveChain = saveChain.then(async () => {                // 串行化：快速连续保存严格有序
      memo.set(await invoke<AppConfig>('save_config', { config }))
    })
  }
  onChanged(cb) { return listen<AppConfig>('config-change', e => { memo.set(e.payload); cb(e.payload) }) }
}
```

- `save_config`（Rust）：归一化 → 写 `AppState` → `persist_config`（store 写盘 + `emit('config-change')`）→ 重建 menubar 实例；仅当变更「影响行情数据口径」（`!is_menubar_only_settings_change`）时才 `trigger_refresh`，纯展示类设置不触发网络请求。
- `saveChain` 串行队列 + `memo` 乐观值，解决「快速连点开关 → 旧快照覆盖新快照」（开关 A 却隐藏 B）问题。

## 8. 窗口与前端入口

| 窗口 label | 尺寸 | 形态 | 生命周期 |
|---|---|---|---|
| `menubar` | 680×600 | `decorations:false`、`skip_taskbar:true`、`always_on_top:true` | 点击实例 show / 失焦 hide / 闲置 5min 销毁 |
| `settings` | 1200×800 | 正常窗口（标题栏、可进 Dock） | 用户开关，关闭即销毁 |
| `popup-tab` | 1000×760（min 680×600） | 正常窗口（持久化） | 手动关闭才销毁，复用聚焦 |

- `menubar` 加载 `index.html`（→ `src/menubar.tsx`，`App`），可带 `?tab=` 直达分组；`settings` 加载 `options.html`（→ `src/options.tsx`，`OptionsApp`），带 `?tab=` + `#anchor`（`open_settings_window` 拼入，前端 `initialTab` 解析零改动）；`popup-tab` 加载 `index.html?tab=1`（对齐 Chrome `popup.html?tab=1`，`App` 自动进 tab 模式铺满视口）。
- 三个窗口共享同一套 `PortsContext.Provider`（注入 `TauriDataPort` / `TauriConfigPort` / `TauriEventPort` / `TauriWindowPort`），渲染同一份 `packages/ui`。

```tsx
// src/options.tsx（节选，与 Chrome options 同构）
const urlTab = new URLSearchParams(window.location.search).get('tab')   // 'holdings' | 'data'
const initialTab = urlTab === 'holdings' || urlTab === 'data' ? urlTab : 'general'
createRoot(...).render(<PortsContext.Provider value={ports}>
  <OptionsApp initialTab={initialTab} version={ports.window.getVersion()} />
</PortsContext.Provider>)
```

## 9. 实现路径决策（✅ 路径 A，Rust 重写，已落地）

- **范围**：`reqwest` 重写 `packages/services` 的 fund/gold/market；Rust 重写 `packages/core` 的 holdingsCalc / tradingCalendar / portfolioLogic / format / fundName / badge。
- **落实模块**：`providers/{fund123,fundmnfinfo}`、`market.rs`、`history.rs`、`calc.rs`、`calendar.rs`、`portfolio.rs`、`theme.rs`（板块正则迁移）、`fundname.rs`、`format.rs`、`model.rs`、`state.rs`、`refresh.rs`、`window.rs`、`menubar.rs`、`commands.rs`、`badge.rs`、`dbglog.rs`、`error.rs`、`http.rs`。全部编译通过（`cargo check` + `tsc --noEmit`）。
- **决策理由**：menubar 常驻 + 托盘实时显示需后端独立持有数据；UI 层经 4 Port 契约零改动复用（monorepo 重构核心收益）。

## 10. 与 Chrome 实现的对照

| 关注点 | Chrome 实现 | Tauri 实现（已实现） |
|---|---|---|
| 后端运行时 | MV3 Service Worker（30s 休眠，alarm 唤醒） | Rust 常驻进程 |
| 定时调度 | `chrome.alarms` | `tokio` 双循环 + `Notify` 唤醒 + `seconds_until_next_switch` 准点切档 |
| 数据请求 | `@fund01/services`（fetch） | Rust `reqwest`（fund123 CSRF+cookie / fundmnfinfo 批量） |
| 合并计算 | SW 调 `@fund01/core` | Rust 重写（`calc` / `portfolio` / `calendar`） |
| 配置存储 | `localStorage` + `chrome.storage.local` | `tauri-plugin-store` + Rust `AppState` 权威副本 |
| 事件推送 | `chrome.storage.onChanged` | `emit('quote-update' / 'config-change' / 'refresh-schedule' / 'popup-open-group')` |
| UI 拉取 | `chrome.runtime.sendMessage` → SW | `invoke('fetch_*')` → Rust command |
| 菜单栏 | `chrome.action.setBadgeText` 单图标文本 | 多 `NSStatusItem` 实例 + 原生 hex 每行着色（`set_colors`） |
| 浮窗生命周期 | 关闭即销毁 | hide / show / 闲置 5min 销毁（状态保留） |
| 多窗口 | popup 一般单实例 | `menubar` + `settings` + `popup-tab` 多 WebviewWindow |
| 打开设置页 | `openOptionsPage()` / `tabs.create(?tab=)` | `open_settings_window`（`?tab=` + `#anchor`） |
| 新窗口/标签页 | `tabs.create` | `open_popup_tab_window`（popup-tab 独立页面） |
| 外部链接 | `window.open` | `open_external`（系统浏览器，webview 默认拦截） |
| 版本号 | `getManifest().version` | `get_version`（`CARGO_PKG_VERSION`） |
| UI 复用 | `packages/ui` | 同一份 `packages/ui` |

## 11. 完成度清单

原始设计清单（共 16 项）**已全部实现**：

- [x] Tauri 项目初始化（rsbuild 双入口，复用 `packages/ui` / `packages/core` 源码别名）
- [x] `tauri.conf.json`：`app.windows:[]` + `macOSPrivateApi` + `csp:null` + `bundle [app,dmg]`
- [x] `tauri-plugin-multiline-menubar` 多实例菜单栏（`rebuild_menubar` / `set_colors` / `set_visible` / `remove`）
- [x] 浮窗 `window.rs`：`show_popup` / 失焦 hide / 闲置销毁 / `position_below`
- [x] 双 tokio 刷新循环 + 准点切档 + `refresh-schedule` 进度环
- [x] 15 个 `#[tauri::command]`（DataPort 8 / ConfigPort 2 / WindowPort 4 + `get_version` / `dbg_log`）
- [x] `open_settings_window`（`?tab=` + `#anchor`）+ `get_version`
- [x] `emit('quote-update')` / `emit('config-change')` / `emit('refresh-schedule')` / `emit('popup-open-group')`
- [x] 菜单栏原生 hex 每行着色 + 加粗 + 对齐（`menubar.rs`）
- [x] 4 个前端 Port（`src/ports/`）+ `lazyMemo` + 串行保存队列
- [x] `menubar.tsx` / `options.tsx` 挂载 `packages/ui`（零改动复用）
- [x] `ActivationPolicy::Accessory` 不占 Dock
- [x] 点击窗口外部自动 hide（浮窗 `Focused(false)`）
- [x] `packages/ui` 无需修改即可在 Tauri webview 渲染
- [x] 路径 A：Rust 重写数据请求 + 合并计算（全模块编译通过）
- [x] `popup-tab` 独立页面（对齐 Chrome 标签页模式）

**待办 / 已知限制**：

- [ ] macOS 分发需 Developer ID 签名 + 公证（否则 Gatekeeper 拦截首次打开）；当前未签名。
- [ ] Windows / Linux 适配未做（menubar 形态依赖 macOS 多 `NSStatusItem` 插件；`objc2` 代码 `#[cfg(target_os="macos")]` 隔离）。
- [ ] `POPUP_DESTROY_DELAY_SECS` 为固定 5min，尚未接入设置项。

## 12. 启动检查清单（实现核对）

原始 §12「未来实现时」的 16 个构建步骤，按实际落地情况勾选（截至 2026-08-12）：

- [x] `pnpm create tauri-app` 初始化 `apps/tauri/`（rsbuild 双入口，复用 `packages/ui` / `packages/core` 源码别名）
- [x] `tauri.conf.json`：`app.windows:[]` + `macOSPrivateApi:true` + `csp:null` + `bundle [app,dmg]`（tray-icon 由 multiline-menubar 插件提供，无需手写 tray-icon feature）
- [x] menubar 实现：`tauri-plugin-multiline-menubar`（`rebuild_menubar` / `set_colors` / `set_visible` / `remove`）替代原计划的 `TrayIconBuilder`，浮窗仍用 `WebviewWindowBuilder`（`window.rs`）；功能已落地，实现方式有别于原清单
- [x] 定时刷新循环：`refresh.rs` 双 `tokio` 循环（日盘 / 夜盘）+ `Notify` 唤醒 + `seconds_until_next_switch` 准点切档（等价且强于 `tokio::time::interval`）
- [x] `#[tauri::command]`：已实现 **15** 个（原计划 10 个，覆盖 DataPort 8 / ConfigPort 2 / WindowPort 4 + `get_version` / `dbg_log`）
- [x] `open_settings_window`（`?tab=` + `#anchor`）+ `get_version` 已实现
- [x] `emit('quote-update')` / `emit('config-change')` 已实现，另增 `refresh-schedule` / `popup-open-group`
- [ ] ~~托盘徽章（动态 PNG 或 `set_title`）~~：**已改用 `tauri-plugin-multiline-menubar` 原生 hex 每行着色表达涨跌，本项取消**；`badge.rs` 仅预留（`#[allow(dead_code)]`），`TauriWindowPort.supportsBadge()` 返回 false
- [x] 前端 4 个 Port（`tauriDataPort` / `tauriConfigPort` / `tauriEventPort` / `tauriWindowPort`）已实现
- [x] `menubar.tsx` 挂载 `App` + 注入 Tauri Ports 已实现
- [x] `options.tsx` 挂载 `OptionsApp`（`?tab=` 解析）已实现
- [x] `set_activation_policy(Accessory)` 不占 Dock 已验证
- [x] 点击窗口外部自动 hide 已实现（`Focused(false)` 事件）
- [x] `packages/ui` 无需修改即可在 Tauri webview 渲染 已验证
- [x] 路径 A（Rust 重写 services + holdingsCalc）已落地
- [ ] 打包 `dmg` 分发：**未签名 / 未公证**（Gatekeeper 会拦截首次打开），见 §13 注意事项

> 16 项中 14 项已完成，2 项未做：第 8 项 ~~托盘徽章~~（已被 multiline-menubar 多实例 hex 着色方案取代，删除线标注）、第 16 项（dmg 签名分发）。第 3 项实现方式与原清单不同（插件 vs `TrayIconBuilder`），但功能等价。

## 13. 注意事项

- **Tauri 2.x API**：实现基于 Tauri 2.x；`multiline-menubar` 插件以 API 文档为准（插件版本固定 `v1.6.0`，不随 tauri 升级自动变）。
- **CSP**：`security.csp: null` 放宽，echarts 内联样式需要；生产可分发时建议收紧。
- **macOS 签名/公证**：见 §11 待办。
- **图标资源**：`src-tauri/icons/`（含 `icon.icns` / `icon.ico` / 各尺寸 png + 移动端占位），macOS 用 `icon.icns`。
- **`packages/ui` 复用**：Tauri webview 加载同一份 `packages/ui` 构建产物（rsbuild devUrl / dist），无需改 UI 代码即可运行——monorepo 重构核心收益。
- **配置文件位置**：`~/Library/Application Support/com.lingyi.fund01/config.json`（macOS，`tauri-plugin-store` 默认目录）。
