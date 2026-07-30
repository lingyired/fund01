# fund01 Monorepo 重构设计

**日期**：2026-07-30
**状态**：已确认，待生成实施计划

---

## 1. 背景与目标

### 1.1 起源

本项目从 `wzk-fund` 项目的 `chrome/` 扩展演化而来。原 `wzk-fund` 是 Koa server + React web 架构，改造为 Chrome 扩展后去除了后端，所有数据请求逻辑迁到 Service Worker + popup 前端。

### 1.2 重构动机

当前 `chrome/` 单一目录内 UI、业务逻辑、数据请求、Chrome 胶水代码混合。未来希望：

1. **基于同一份前端代码打包 Tauri 桌面应用**（macOS menubar app）
2. **Tauri 后端定时刷新数据，不依赖 UI 打开**（menubar 模式）
3. **Chrome 扩展也改为 popup + badge 模式**，行为与 Tauri menubar 一致

### 1.3 目标

将 `chrome/` 重构为 monorepo，分层独立、可复用：

- **packages/core** — 纯业务逻辑 + 接口契约
- **packages/services** — 数据请求层（纯 fetch）
- **packages/ui** — React 组件（无 chrome/tauri 耦合）
- **apps/chrome** — Chrome 扩展（popup + badge + SW）
- **apps/tauri** — Tauri 应用（占位，本次只写文档）

### 1.4 非目标

- 本次不实际编写 Tauri Rust 代码
- 不修改原 `wzk-fund/server/` 和 `wzk-fund/web/`（只读参考）
- 不引入测试框架（迁移优先，测试后续补）

---

## 2. 顶层架构

### 2.1 分层与依赖

```
┌─────────────────────────────────────────────────────────┐
│  packages/core (纯逻辑 + 接口契约)                       │
│  - holdingsCalc / tradingCalendar / types                │
│  - DataPort / ConfigPort / EventPort 接口               │
└─────────────────────────────────────────────────────────┘
                            ▲
              ┌─────────────┼─────────────┐
              │             │             │
   ┌──────────┴───┐  ┌──────┴────┐  ┌────┴─────┐
   │ packages/    │  │ packages/ │  │ apps/    │
   │ services     │  │ ui        │  │ chrome/  │
   │ (fetch)      │  │ (React)   │  │ tauri/   │
   └──────────────┘  └───────────┘  └──────────┘
```

依赖规则：
- `core` 不依赖任何外部包（除 ts）
- `services` 依赖 `core` 的 types
- `ui` 依赖 `core` 的接口与 types；不直接调用 services
- `apps/chrome` 依赖三者，提供 port 实现
- `apps/tauri` 未来同上

### 2.2 后端权威架构

**核心决策：合并计算在后端，UI 是被动视图。**

原因：
1. Tauri menubar 模式下，点击托盘弹出 popup 之前可能 UI 未渲染，必须由后端预先计算好结果
2. Chrome popup 关闭后 SW 继续刷新，badge 文字依赖后端独立计算
3. 多窗口（Tauri 主窗口 + menubar）订阅同一后端结果，避免重复计算

**数据流：**
1. 后端定时拉数据 → 调 core 计算合并 → 写本地存储/内存 → 推送事件 + 更新 badge/图标
2. 前端首次打开 → 主动 invoke 一次拉缓存 → 订阅事件流增量更新
3. 前端写配置 → 同步写本地缓存（避免闪烁）+ 异步推后端

### 2.3 Chrome vs Tauri 行为对照

| 功能 | Chrome | Tauri |
|---|---|---|
| 定时刷新 | chrome.alarms（SW 30s 唤醒） | tokio::interval（常驻） |
| 数据请求 | services/*.ts（fetch） | Rust reqwest 或 JS sidecar |
| 合并计算 | SW 调 core/holdingsCalc | Rust 重写或 sidecar 调 TS |
| 结果缓存 | chrome.storage.local | Rust 内存 + 文件 |
| 事件推送 | chrome.storage.onChanged | app.emit + listen |
| UI 拉取 | sendMessage → SW | invoke → Rust command |
| 图标徽章 | setBadgeText | 动态生成 PNG + set_icon |
| 配置存储 | chrome.storage.local | Tauri store plugin / 文件 |
| 关闭后行为 | SW 30s 休眠，alarm 唤醒 | 后端常驻 |

---

## 3. 三个 Port 接口

`packages/core/src/port.ts` 定义三个接口，是 UI 与具体 app 之间的契约。

### 3.1 DataPort（异步数据访问）

```typescript
export interface DataPort {
  /** 触发后端立即刷新（异步，不等待结果） */
  triggerRefresh(): Promise<void>
  /** 持仓汇总（后端已合并行情 + 配置） */
  fetchHoldings(): Promise<HoldingsPayload>
  fetchWatchlist(): Promise<WatchlistPayload>
  fetchIndices(): Promise<IndexItem[]>
  fetchMarketOverview(): Promise<MarketOverview | null>
  fetchGold(): Promise<GoldPayload | null>
  fetchFundHistory(code: string, count?: number): Promise<FundHistoryPayload>
  fetchIndexHistory(code: string, range: string): Promise<IndexHistoryPayload>
  fetchFundIntraday(fundKey: string): Promise<IntradayPoint[]>
  resolveFund(code: string): Promise<ResolveFundPayload>
}
```

**用途**：UI 首次打开主动拉一次缓存，避免等事件。

### 3.2 ConfigPort（同步配置 + 异步推送）

```typescript
export interface ConfigPort {
  /** 同步读本地缓存（UI 不闪） */
  getConfig(): AppConfig
  /** 写本地缓存 + 异步推后端 */
  saveConfig(config: AppConfig): Promise<void>
  /** 订阅配置变更（多窗口同步） */
  onChanged(cb: (config: AppConfig) => void): () => void
}
```

**设计理由**：localStorage 同步读避免 UI 闪烁；Tauri 端用内存镜像 + invoke 实现。

### 3.3 EventPort（后端 → 前端事件）

```typescript
export interface EventPort {
  /** 订阅后端推送的行情更新事件 */
  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void
  /** 订阅配置变更（多窗口同步） */
  onConfigChange(cb: (config: AppConfig) => void): () => void
}
```

**设计理由**：统一 Chrome `chrome.storage.onChanged` 和 Tauri `listen`。

### 3.4 不抽象的部分

- **HttpClient**：fetch 跨 JS 运行时通用；Rust 后端用 reqwest 独立实现，不参与 TS 抽象。
- **CSRF 缓存**：services 内部用模块级 Map，Chrome SW 重启时多一次请求（可接受），Tauri 不休眠自然保留。
- **badge/图标更新**：各 app 自行实现（Chrome setBadgeText / Tauri 动态图标）。

---

## 4. 目录结构

```
fund01/
├── package.json                 # root: pnpm workspaces + scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json           # 共享 TS 配置
├── CLAUDE.md                    # 项目开发指南
├── README.md                    # 项目入口文档
├── ARCHITECTURE.md              # 架构设计文档
├── .gitignore
├── .npmrc
├── docs/
│   └── superpowers/specs/       # 设计文档
├── packages/
│   ├── core/
│   │   ├── package.json         # @fund01/core
│   │   ├── tsconfig.json
│   │   ├── README.md
│   │   └── src/
│   │       ├── index.ts
│   │       ├── port.ts          # DataPort/ConfigPort/EventPort
│   │       ├── types.ts
│   │       ├── holdingsCalc.ts
│   │       ├── tradingCalendar.ts
│   │       ├── portfolioLogic.ts  # normalizeConfig 等纯逻辑
│   │       └── utils.ts
│   ├── services/
│   │   ├── package.json         # @fund01/services
│   │   ├── tsconfig.json
│   │   ├── README.md
│   │   └── src/
│   │       ├── index.ts
│   │       ├── http.ts
│   │       ├── fund.ts          # CSRF 改模块级 Map
│   │       ├── gold.ts
│   │       └── market.ts
│   └── ui/
│       ├── package.json         # @fund01/ui
│       ├── tsconfig.json
│       ├── README.md
│       └── src/
│           ├── index.ts
│           ├── App.tsx
│           ├── context.ts       # PortsContext
│           ├── components/       # 含 ui/ shadcn 基础组件
│           ├── hooks/
│           ├── theme.ts
│           └── index.css
└── apps/
    ├── chrome/
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── rsbuild.config.ts
    │   ├── manifest.json
    │   ├── scripts/
    │   │   ├── copy-manifest.mjs
    │   │   └── zip.ts
    │   ├── public/icons/
    │   └── src/
    │       ├── background/
    │       │   └── index.ts     # SW：alarms + services + core 合并 + storage + badge
    │       ├── popup/
    │       │   ├── index.html
    │       │   └── index.tsx
    │       └── ports/
    │           ├── chromeDataPort.ts
    │           ├── chromeConfigPort.ts
    │           └── chromeEventPort.ts
    └── tauri/
        └── README.md            # 占位文档
```

---

## 5. 工程配置

### 5.1 包管理器

`pnpm` workspaces。

### 5.2 包命名空间

- `@fund01/core`
- `@fund01/services`
- `@fund01/ui`
- `apps/chrome`、`apps/tauri` 不发布

### 5.3 引用方式

所有 app 在开发时通过 tsconfig `paths` 直接引用 packages 源码，不依赖 dist 产物。优点：
- 不需要在 dev 时先 build packages
- 修改 packages 源码立即生效
- 生产构建时 rsbuild/vite 一并打包

```jsonc
// apps/chrome/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "paths": {
      "@fund01/core": ["../../packages/core/src"],
      "@fund01/core/*": ["../../packages/core/src/*"],
      "@fund01/services": ["../../packages/services/src"],
      "@fund01/services/*": ["../../packages/services/src/*"],
      "@fund01/ui": ["../../packages/ui/src"],
      "@fund01/ui/*": ["../../packages/ui/src/*"]
    }
  }
}
```

### 5.4 构建策略

| 包 | 构建方式 | 产物 |
|---|---|---|
| `@fund01/core` | 不单独构建 | 源码被 app 引用 |
| `@fund01/services` | 不单独构建 | 源码被 app 引用 |
| `@fund01/ui` | 不单独构建 | 源码被 app 引用 |
| `apps/chrome` | `rsbuild build` | `dist/background.js` + `dist/popup.js` |
| `apps/tauri` | 未来 | 未来 |

### 5.5 根 package.json scripts

```json
{
  "scripts": {
    "dev:chrome": "pnpm --filter chrome dev",
    "build:chrome": "pnpm --filter chrome build",
    "zip:chrome": "pnpm --filter chrome zip",
    "typecheck": "pnpm -r typecheck"
  }
}
```

---

## 6. 迁移映射表

从 `wzk-fund/chrome/src` 到 `fund01`。

| 原文件 | 目标位置 | 处理方式 |
|---|---|---|
| `lib/holdingsCalc.ts` | `packages/core/src/holdingsCalc.ts` | 直接复制 |
| `lib/tradingCalendar.ts` | `packages/core/src/tradingCalendar.ts` | 直接复制 |
| `lib/utils.ts` | `packages/core/src/utils.ts` | 直接复制 |
| `lib/api.ts`（类型部分） | `packages/core/src/types.ts` | 提取所有 type/interface |
| `lib/api.ts`（合并逻辑） | 删除 | 合并迁到 SW 后端 |
| `lib/api.ts`（sendMessage 调用） | `apps/chrome/src/ports/chromeDataPort.ts` | 重写为 DataPort 实现 |
| `lib/portfolioStore.ts`（normalizeConfig 等） | `packages/core/src/portfolioLogic.ts` | 提取纯逻辑部分 |
| `lib/portfolioStore.ts`（localStorage 读写） | `apps/chrome/src/ports/chromeConfigPort.ts` | 重写为 ConfigPort 实现 |
| `lib/theme.ts` | `packages/ui/src/theme.ts` | 移到 ui |
| `services/http.ts` | `packages/services/src/http.ts` | 删除 `cookieHeader` 遗留 |
| `services/fund.ts` | `packages/services/src/fund.ts` | CSRF 缓存改模块级 Map；删除内部 `nextTradingDay` 重复实现，改为 import `@fund01/core` |
| `services/gold.ts` | `packages/services/src/gold.ts` | 直接复制 |
| `services/market.ts` | `packages/services/src/market.ts` | 直接复制 |
| `background/index.ts` | `apps/chrome/src/background/index.ts` | 重构：新增合并计算 + setBadgeText；移除 dashboard 标签页管理 |
| `App.tsx` | `packages/ui/src/App.tsx` | 替换 chrome.* 为 EventPort/ConfigPort；通过 Context 接受 ports |
| `components/*` | `packages/ui/src/components/*` | 直接复制，替换 import 路径 |
| `components/ui/*` | `packages/ui/src/components/ui/*` | shadcn 基础组件，直接复制 |
| `dashboard/index.html` | `apps/chrome/src/popup/index.html` | 改名 + 改 entry 路径 |
| `dashboard/index.tsx` | `apps/chrome/src/popup/index.tsx` | 改为挂载 `@fund01/ui` 的 App + 注入 ports |
| `index.css` | `packages/ui/src/index.css` | 直接复制 |
| `manifest.json` | `apps/chrome/manifest.json` | 改 `action.default_popup`，移除 `tabs` 权限 |
| `rsbuild.config.ts` | `apps/chrome/rsbuild.config.ts` | 入口改 `background` + `popup`；alias 调整 |
| `scripts/*` | `apps/chrome/scripts/*` | 直接复制 |
| `public/icons/*` | `apps/chrome/public/icons/*` | 直接复制 |

### 6.1 UI 层的 Port 注入方式

`packages/ui` 不直接 import `chrome.*`，通过 React Context 接受 ports：

```typescript
// packages/ui/src/context.ts
import { createContext, useContext } from 'react'
import type { DataPort, ConfigPort, EventPort } from '@fund01/core'

export interface Ports {
  data: DataPort
  config: ConfigPort
  event: EventPort
}

export const PortsContext = createContext<Ports | null>(null)
export const usePorts = () => {
  const p = useContext(PortsContext)
  if (!p) throw new Error('PortsProvider missing')
  return p
}
```

```typescript
// apps/chrome/src/popup/index.tsx
import { PortsContext } from '@fund01/ui'
import { ChromeDataPort } from './ports/chromeDataPort'
// ... mount
<PortsContext.Provider value={{ data, config, event }}>
  <App />
</PortsContext.Provider>
```

### 6.2 background SW 的新职责

```typescript
// apps/chrome/src/background/index.ts（伪代码）
import { getFundsQuotes, getIndices, getMarketOverview, getGoldRealtime } from '@fund01/services'
import { calcHoldings, mergeWatchlist } from '@fund01/core'
import { loadConfig } from './storage'  // SW 自己读 chrome.storage.local

chrome.alarms.create('refresh', { periodInMinutes: 0.5 })

chrome.alarms.onAlarm.addListener(async () => {
  const config = await loadConfig()
  const [holdings, watchlist, indices, market, gold] = await Promise.allSettled([
    getFundsQuotes(holdFunds, config.quoteSource),
    getFundsQuotes(watchFunds, config.quoteSource),
    getIndices(),
    getMarketOverview(),
    getGoldRealtime(config.gold),
  ])

  // 后端合并计算（新增）
  const holdingsResult = holdings.status === 'fulfilled'
    ? calcHoldings(holdings.value, config) : null
  const watchlistResult = watchlist.status === 'fulfilled'
    ? mergeWatchlist(watchlist.value, config) : null

  await chrome.storage.local.set({
    'cache-holdings': holdingsResult,
    'cache-watchlist': watchlistResult,
    'cache-indices': indices.status === 'fulfilled' ? indices.value : null,
    'cache-market': market.status === 'fulfilled' ? market.value : null,
    'cache-gold': gold.status === 'fulfilled' ? gold.value : null,
    'cache-time': Date.now(),
  })

  // 更新 badge（新增）
  if (holdingsResult) {
    const totalPnlPct = holdingsResult.summary.totalPnlPct
    const text = totalPnlPct > 0 ? `↑${totalPnlPct.toFixed(2)}%` : `${totalPnlPct.toFixed(2)}%`
    chrome.action.setBadgeText({ text })
    chrome.action.setBadgeBackgroundColor({ color: totalPnlPct >= 0 ? '#dc2626' : '#16a34a' })
  }
})
```

### 6.3 manifest.json 改动

```jsonc
{
  "manifest_version": 3,
  "permissions": ["storage", "alarms"],  // 移除 "tabs"
  "action": {
    "default_popup": "popup.html",       // 新增（替代 dashboard）
    "default_icon": { "16": "...", "48": "...", "128": "..." }
  },
  "web_accessible_resources": []         // 移除 dashboard.html
}
```

### 6.4 删除/不迁移的代码

- `lib/api.ts` 中 `localListFunds`、`patchFunds`、`createFund` 等配置操作的前端入口 → 改为 `chromeConfigPort` 内部调用
- `fund.ts` 内部的 `nextTradingDay`/`isConfirmedSessionActive` 重复实现 → 改为 import `@fund01/core`
- `services/http.ts` 的 `cookieHeader` 未使用函数 → 删除
- `background/index.ts` 中 dashboard 标签页管理逻辑 → 删除（不再需要）

---

## 7. Tauri 端规划（占位）

本次不实现 Tauri 代码，只在 `apps/tauri/README.md` 写文档。

### 7.1 Tauri 2 menubar app 真实架构

- 依赖：`tauri = { version = "2", features = ["tray-icon"] }`
- 创建：`TrayIconBuilder` (Rust) 或 `TrayIcon.new` (JS)
- 默认行为：左键/右键点击 → 弹出原生菜单
- 可设 `menu_on_left_click(false)` 禁用左键弹菜单

### 7.2 自定义 popup 窗口（menubar app 模式）

1. `TrayIconBuilder::on_tray_icon_event` 监听 `TrayIconEvent::Click`
2. 在事件中创建/显示一个 `WebviewWindow`：
   - `decorations: false`（无标题栏）
   - `skip_taskbar: true`（不出现在任务栏）
   - `resizable: false`、`visible: false`（先创建为隐藏）
   - `always_on_top: true`（macOS 上浮于其他窗口）
3. 计算托盘图标屏幕位置，把窗口 setPosition 到图标下方
4. 点击窗口外部时 hide（macOS 上需监听失焦事件）
5. macOS 上调 `app.set_activation_policy(Accessory)` 让应用不出现在 Dock

### 7.3 后端定时任务

- Rust 后端是常驻进程（不像 MV3 SW 30s 休眠）
- 用 `tauri::async_runtime::spawn` + `tokio::time::interval` 定时刷新
- CSRF token、内存缓存都可常驻

### 7.4 事件推送（后端 → 前端）

- Rust → 前端：`app.emit("event-name", payload)` 或 `window.emit_to("label", ...)`
- 前端订阅：`import { listen } from '@tauri-apps/api/event'`

### 7.5 托盘图标「徽章」差异

| 平台 | 机制 |
|---|---|
| Chrome | `chrome.action.setBadgeText({text: "3"})` 在图标上叠加数字 |
| Tauri macOS | 无原生 badge，需动态生成图标图片（绘制数字到 icon PNG 后 `tray.set_icon`） |
| Tauri Windows | 同上，需动态图标 |
| Tauri (所有) | `tray.set_title("↑0.8%")` 显示在图标旁的文本（macOS 才有，Windows/Linux 无） |

### 7.6 主窗口 vs menubar popup

Tauri 一个 app 可有多个 `WebviewWindow`，label 区分：
- `main` — 可选的主窗口（设置页/详细页）
- `menubar` — 点击托盘弹出的浮窗
- 两者订阅同一套后端事件，渲染同一份 `packages/ui`

### 7.7 Rust 后端需要实现的命令清单（对应 DataPort）

- `trigger_refresh()`
- `fetch_holdings() -> HoldingsPayload`
- `fetch_watchlist() -> WatchlistPayload`
- `fetch_indices() -> Vec<IndexItem>`
- `fetch_market_overview() -> Option<MarketOverview>`
- `fetch_gold() -> Option<GoldPayload>`
- `fetch_fund_history(code, count) -> FundHistoryPayload`
- `fetch_index_history(code, range) -> IndexHistoryPayload`
- `fetch_fund_intraday(fund_key) -> Vec<IntradayPoint>`
- `resolve_fund(code) -> ResolveFundPayload`

### 7.8 事件清单（对应 EventPort）

- `quote-update` — 行情刷新完成
- `config-change` — 配置变更（多窗口同步）

### 7.9 未来实现路径决策（延后）

实现 Tauri 时二选一：
- **A. Rust 重写 services + holdingsCalc**：性能好、单二进制，但要重写约 1500 行业务逻辑
- **B. JS sidecar（Bun/Node）跑 TS services + core**：复用代码，但需打包 sidecar 二进制

抽象接口不依赖该决策。

---

## 8. 文档结构

### 8.1 CLAUDE.md（项目根）

包含章节：

1. **项目目标** — monorepo，packages + apps 架构，目标支持 Chrome 扩展和 Tauri 桌面应用
2. **目录保护规则** — `wzk-fund/server/` 和 `wzk-fund/web/` 只读参考（迁移完成后可删除），所有修改在 `packages/` 和 `apps/`
3. **架构总览** — packages/core/services/ui + apps/chrome/tauri 的分层
4. **三个 Port 接口** — DataPort/ConfigPort/EventPort 的职责与契约
5. **命令** — `pnpm dev:chrome`、`pnpm build:chrome`、`pnpm zip:chrome`、`pnpm typecheck`
6. **数据源迁移指南** — fund123 / 东方财富 / 腾讯 / 新浪的请求要点
7. **Service Worker 定时刷新** — alarms + 合并计算 + storage + badge
8. **Tauri 端规划** — 占位说明，未来如何复用 packages
9. **Pitfalls** — MV3 SW 休眠、CSRF 内存 Map、CSP 限制、pnpm workspaces 注意事项

### 8.2 README.md（项目根）

- 项目简介（一句话）
- 当前状态：Chrome 扩展可用，Tauri 待开发
- 快速开始：`pnpm install` → `pnpm dev:chrome`
- 目录结构图
- 各 package 链接

### 8.3 ARCHITECTURE.md

- 三个 Port 接口的详细设计动机
- 数据流图（后端权威 + 事件推送）
- Chrome vs Tauri 行为对照表
- 后端权威架构的决策原因（menubar 无 UI 也能工作）
- 为什么不抽象 HttpClient
- 为什么不抽象 badge
- 未来的 Tauri 实现路径（Rust 重写 vs JS sidecar）

### 8.4 packages/*/README.md

每个 package：
- 职责
- 依赖关系
- 导出 API
- 使用示例

### 8.5 apps/tauri/README.md

- 说明本目录是占位
- 未来如何创建 Tauri 项目（`pnpm create tauri-app`）
- Rust 后端需要实现的命令清单（对应 DataPort）
- 事件清单（对应 EventPort）
- 托盘图标 + popup 窗口的实现要点
- 配置存储方案（Tauri store plugin）
- menubar app 模式的关键代码片段示例（不实际实现）

---

## 9. 关键设计决策汇总

| 决策 | 选择 | 理由 |
|---|---|---|
| 项目结构 | Monorepo（pnpm workspaces） | Tauri 复用目标明确，独立 package 可保证 apps/tauri 像 apps/chrome 一样按需 import |
| packages 划分 | 3 个：core / services / ui | 性质不同（纯逻辑 / IO / 视图）应分开；未来 Rust 重写时清晰看到「services 层要重写，core 不用」 |
| HttpClient | 不抽象，用原生 fetch | 跨 JS 运行时通用；Rust 后端独立实现不参与 TS 抽象 |
| 抽象层 | DataPort + ConfigPort + EventPort | UI 与 app 之间的契约；各 app 提供实现 |
| 配置权威 | 后端存储（Chrome: chrome.storage.local；Tauri: 文件） | menubar 无 UI 也能工作；多窗口同步 |
| 合并计算位置 | 后端（SW / Rust） | menubar 模式必需；多窗口复用 |
| CSRF 缓存 | 模块级 Map | SW 重启多一次请求可接受；Tauri 不休眠 |
| 包引用方式 | tsconfig paths 源码引用 | dev 体验好，无需先 build packages |
| 包构建 | packages 不单独构建 | 由 app bundler 处理 |
| badge/图标 | 各 app 自行实现 | Chrome 与 Tauri 机制差异大，抽象无收益 |
| Tauri 实现 | 本次只写文档 | 用户明确「后续基于这个目录重新开始一个项目」 |

---

## 10. 验收标准

1. `fund01/` 目录结构按本设计建立
2. `pnpm install` 无错误
3. `pnpm typecheck` 通过（所有 packages + apps）
4. `pnpm build:chrome` 产出 `apps/chrome/dist/` 包含 `background.js` 和 `popup.js`
5. `apps/chrome/dist/` 可加载到 Chrome，popup 显示完整 UI
6. SW 定时刷新，badge 文字更新（如「↑0.8%」）
7. 配置修改后 popup 关闭重开仍保留
8. `apps/tauri/README.md` 文档完整，说明未来实现路径
9. CLAUDE.md / README.md / ARCHITECTURE.md / packages/*/README.md 文档齐全
10. 原 `wzk-fund/server/` 和 `wzk-fund/web/` 未被修改

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| pnpm workspaces 在某些 IDE 中路径解析不稳定 | tsconfig paths 双重保障；IDE 用 VS Code |
| shadcn ui 组件迁移后 tailwind 配置不生效 | ui 包内保留 tailwind 配置；app 引入时合并 |
| SW 重构后合并计算逻辑出错 | 迁移时逐函数对照原 `lib/api.ts` 的合并逻辑 |
| `fund.ts` 内部 `nextTradingDay` 重复实现删除后循环依赖 | core 不依赖 services，services 依赖 core，无循环 |
| Tauri 占位文档与未来实现脱节 | 文档中明确标注「基于 Tauri 2.x，未来实现时需验证 API 变化」 |
