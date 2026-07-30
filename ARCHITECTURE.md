# fund01 架构设计

本文档描述 `fund01` monorepo 的架构决策与数据流。设计 spec 见 `docs/superpowers/specs/2026-07-30-monorepo-refactor-design.md`。

## 1. 顶层架构

```
┌─────────────────────────────────────────────────────────┐
│  packages/core (纯逻辑 + 接口契约)                       │
│  - types / holdingsCalc / tradingCalendar / utils        │
│  - portfolioLogic（normalizeConfig 等纯函数）             │
│  - DataPort / ConfigPort / EventPort 接口                │
└─────────────────────────────────────────────────────────┘
                            ▲
              ┌─────────────┼─────────────┐
              │             │             │
   ┌──────────┴───┐  ┌──────┴────┐  ┌────┴──────────────┐
   │ packages/    │  │ packages/ │  │ apps/chrome/      │
   │ services     │  │ ui        │  │ apps/tauri/ (未来) │
   │ (fetch)      │  │ (React)   │  │                   │
   └──────────────┘  └───────────┘  └───────────────────┘
```

依赖规则：

- `core` 不依赖任何 `@fund01/*` 包
- `services` 依赖 `core` 的 types 和 tradingCalendar
- `ui` 依赖 `core` 的接口与 types；**不直接调用 services**（数据访问走 DataPort）
- `apps/chrome` 依赖三者，提供 Port 实现 + SW 后端
- `apps/tauri` 未来同上

## 2. 三个 Port 接口的设计动机

UI 与具体运行时（Chrome / Tauri）之间通过三个接口解耦。接口定义在 `packages/core/src/port.ts`，是整个架构的核心契约。

### 2.1 DataPort（异步数据访问）

```typescript
export interface DataPort {
  triggerRefresh(): Promise<void>
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

**设计动机**：

- UI 首次打开主动拉一次缓存，避免等后端事件推送（解决「popup 打开后空白 30 秒」问题）
- Chrome 实现：`fetchHoldings` 直接读 `chrome.storage.local` 的 `cache-holdings`；`fetchFundHistory` 等同步类请求通过 `chrome.runtime.sendMessage` 转发给 SW
- Tauri 实现（未来）：通过 `invoke('fetch_holdings')` 调 Rust 命令
- 接口返回的是**后端已合并好的数据**（如 `HoldingsPayload` 已包含计算后的收益率），UI 不做业务计算

### 2.2 ConfigPort（同步读 + 异步推）

```typescript
export interface ConfigPort {
  getConfig(): AppConfig                                  // 同步读
  saveConfig(config: AppConfig): Promise<void>            // 异步推
  onChanged(cb: (config: AppConfig) => void): () => void  // 订阅变更
}
```

**设计动机**：

- **同步读避免 UI 闪烁**：popup 打开瞬间需要立即渲染持仓列表，若 `getConfig` 是异步的，UI 会先空白再填充。Chrome 实现用 `localStorage.getItem`（同步）；Tauri 实现可用 Rust 端维护的内存镜像 + `invoke` 同步返回（或前端缓存一份）
- **异步推后端**：写配置时不阻塞 UI，后台同步到 SW（Chrome 通过 `chrome.storage.local.set`）或 Rust（Tauri 通过 `invoke('save_config')`）
- **多窗口同步**：`onChanged` 订阅配置变更，Chrome 用 `window.addEventListener('storage', ...)` 监听跨窗口 localStorage 变化；Tauri 用 `listen('config-change')`

### 2.3 EventPort（后端 → 前端事件）

```typescript
export interface EventPort {
  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void
  onConfigChange(cb: (config: AppConfig) => void): () => void
}
```

**设计动机**：

- 统一 Chrome `chrome.storage.onChanged` 与 Tauri `listen` 两种事件机制
- 后端刷新完成后推送 `QuoteUpdate`（含 holdings / watchlist / indices / market / gold / time），UI 增量更新 state
- Chrome 实现：监听 `chrome.storage.onChanged` 的 `cache-time` 变化，触发时一次性读所有 `cache-*` 组装 `QuoteUpdate`
- Tauri 实现（未来）：`listen('quote-update', ...)`

## 3. 数据流图

### 3.1 行情刷新流（后端权威）

```
┌─────────────────────────────────────────────────────────────┐
│ Service Worker (Chrome) / Rust 后端 (Tauri)                 │
│                                                             │
│  chrome.alarms 触发 / tokio::interval                       │
│           │                                                 │
│           ▼                                                 │
│  读配置 (chrome.storage.local['session-config'])             │
│           │                                                 │
│           ▼                                                 │
│  Promise.allSettled([                                       │
│    getFundsQuotes(holdFunds),     ← @fund01/services        │
│    getFundsQuotes(watchFunds),                              │
│    getIndices(),                                            │
│    getMarketOverview(),                                     │
│    getGoldRealtime(config.gold),                           │
│  ])                                                         │
│           │                                                 │
│           ▼                                                 │
│  后端合并计算（@fund01/core）:                                │
│    holdingsResult  = calcHoldings(holdFunds, quotes)        │
│    watchlistResult = mergeWatchlist(watchFunds, quotes)     │
│           │                                                 │
│           ▼                                                 │
│  写 chrome.storage.local:                                   │
│    cache-holdings, cache-watchlist, cache-indices,          │
│    cache-market, cache-gold, cache-time                     │
│           │                                                 │
│           ▼                                                 │
│  更新 badge: chrome.action.setBadgeText('↑0.8%')            │
└─────────────────────────────────────────────────────────────┘
                          │
                  chrome.storage.onChanged
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Popup (React UI)                                            │
│                                                             │
│  EventPort.onQuoteUpdate(cb) 被触发                          │
│           │                                                 │
│           ▼                                                 │
│  读取 cache-* 组装 QuoteUpdate                               │
│           │                                                 │
│           ▼                                                 │
│  setHoldings / setWatchlist / setIndices / ... (增量更新)    │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 UI 首次打开流

```
Popup 打开
   │
   ├──▶ ConfigPort.getConfig()           [同步读 localStorage，立即渲染框架]
   │
   ├──▶ DataPort.fetchHoldings() / fetchWatchlist() / ...   [异步读 cache-*]
   │         │
   │         └──▶ setState，填充数据（避免等事件）
   │
   ├──▶ DataPort.triggerRefresh()        [通知 SW 立即刷新一次]
   │
   └──▶ EventPort.onQuoteUpdate(cb)      [订阅后续增量更新]
```

### 3.3 配置写入流

```
用户在 ConfigDialog 修改配置
   │
   ▼
fundOps.updateSettings(ports, patch)   [packages/ui/src/lib/fundOps.ts]
   │
   ├──▶ ConfigPort.getConfig()          [同步读当前配置]
   ├──▶ 修改配置对象（归一化、清理无效分组等）
   └──▶ ConfigPort.saveConfig(next)     [异步推]
            │
            ├──▶ localStorage.setItem   [同步读源，本窗口立即生效]
            ├──▶ chrome.storage.local.set({ 'session-config': next })  [推给 SW]
            │         │
            │         └──▶ SW 的 chrome.storage.onChanged 触发
            │              └──▶ scheduleNextAlarm(newConfig)  [按新间隔重排 alarm]
            │
            └──▶ 通知本地 listeners    [本窗口组件同步刷新]
```

## 4. Chrome vs Tauri 行为对照

| 功能 | Chrome（已实现） | Tauri（未来） |
|---|---|---|
| 定时刷新 | `chrome.alarms`（SW 30s 唤醒，单次 `delayInMinutes` + 重排） | `tokio::time::interval`（常驻，无需重排） |
| 数据请求 | `@fund01/services`（fetch） | Rust `reqwest` 或 JS sidecar 跑 services |
| 合并计算 | SW 调 `@fund01/core` 的 `calcHoldings` / `mergeWatchlist` | Rust 重写或 sidecar 调 TS core |
| 结果缓存 | `chrome.storage.local`（`cache-*` keys） | Rust 内存 + 文件 / Tauri store |
| 事件推送 | `chrome.storage.onChanged`（监听 `cache-time`） | `app.emit('quote-update', payload)` + 前端 `listen` |
| UI 拉取 | `chrome.runtime.sendMessage` → SW | `invoke('fetch_holdings')` → Rust command |
| 图标徽章 | `chrome.action.setBadgeText({ text: '↑0.8%' })` | 动态生成 PNG（绘制数字到 icon）后 `tray.set_icon`；macOS 也可 `tray.set_title` |
| 配置存储 | `localStorage`（同步读）+ `chrome.storage.local`（推 SW） | Tauri store plugin 或文件 + 前端内存镜像 |
| 关闭后行为 | popup 关闭销毁，SW 30s 休眠，alarm 唤醒 | 后端常驻，popup 窗口 hide 而非销毁 |
| CSRF 缓存 | 模块级 Map，SW 重启丢失 | Rust 后端常驻，自然保留 |

## 5. 后端权威架构的决策原因

**核心决策：合并计算在后端（SW / Rust），UI 是被动视图。**

三个理由：

1. **menubar 无 UI 也能工作**：Tauri menubar 模式下，点击托盘弹出 popup 之前 UI 未渲染，必须由后端预先计算好结果。Chrome 同理——popup 关闭时 badge 仍需更新，依赖后端独立计算
2. **多窗口复用**：Tauri 一个 app 可有多个 `WebviewWindow`（主窗口 + menubar popup），它们订阅同一后端结果，避免重复计算
3. **badge 依赖后端独立计算**：Chrome badge 显示持仓总收益率，即使 popup 关闭也要持续更新，必须由 SW 计算

如果合并计算在前端，popup 关闭后 badge 就无法更新，Tauri menubar 弹出时也会出现「先空白再填充」的闪烁。

## 6. 为什么不抽象 HttpClient

`packages/services` 直接用原生 `fetch`，不抽象 `HttpClient` 接口。原因：

- **fetch 跨 JS 运行时通用**：Chrome popup、Chrome SW、Tauri webview 都有 fetch
- **Rust 后端独立实现**：Tauri 的 Rust 后端用 `reqwest`，不参与 TS 抽象
- **抽象无收益**：如果抽象 `HttpClient`，Chrome 和 Tauri 的 JS 端实现完全相同（都是 fetch），只有 Rust 端不同——但 Rust 端本来就不在 TS 抽象范围内
- **服务层有定制需求**：fund123 的 CSRF、东方财富的 UA、新浪的 GBK 解码，这些差异在服务层内部处理，不需要通过 HttpClient 抽象暴露

## 7. 为什么不抽象 badge / 图标

各 app 自行实现 badge / 图标更新，不在 core 中定义接口。原因：

- **Chrome 与 Tauri 机制差异大**：Chrome 用 `chrome.action.setBadgeText` 在图标上叠加文字；Tauri 无原生 badge，需动态生成 PNG 图片或用 `tray.set_title`（仅 macOS）
- **抽象无复用价值**：两个实现完全不同，抽象后只是把 `setBadge(text)` 转发到不同机制，没有逻辑复用
- **badge 是 app 级关注点**：badge 显示什么、何时更新，由 app 决定（Chrome SW 在 `refreshAll` 末尾更新），不属于 core 业务逻辑

## 8. 未来 Tauri 实现路径（延后决策）

实现 Tauri 时二选一：

### 路径 A：Rust 重写 services + holdingsCalc

- **优点**：性能好，单二进制分发，无 JS 运行时依赖
- **缺点**：要重写约 1500 行业务逻辑（fund.ts / gold.ts / market.ts / holdingsCalc.ts / tradingCalendar.ts / portfolioLogic.ts），其中 tradingCalendar 的节假日规则、板块推断正则等维护成本高
- **适用**：追求极致性能与分发体积

### 路径 B：JS sidecar（Bun / Node）跑 TS services + core

- **优点**：复用现有 TS 代码，维护一份逻辑
- **缺点**：需打包 sidecar 二进制（Bun compile 或 Node SEA），分发体积大；Tauri 与 sidecar 的 IPC 增加复杂度
- **适用**：快速验证，逻辑迭代频繁

**当前决策**：抽象接口（Port）不依赖该决策，延后到真正动手实现 Tauri 时再选。`apps/tauri/README.md` 详细记录了两种路径的实现要点。

## 9. 实际实现中的架构决策

以下是在 Task 1-11 实施过程中做出的、与原 plan 预期不完全一致的架构决策：

### 9.1 `packages/ui/src/lib/fundOps.ts` 的引入

原 plan 设想组件直接调 `usePorts().config.saveConfig(...)`。实际迁移时发现原 `lib/api.ts` + `lib/portfolioStore.ts` 中存在大量组合操作（`createFund` / `updateFund` / `removeFund` / `addHoldingGroup` / `renameHoldingGroup` / `setFundAllocation` / `updateSettings` / `importConfig` 等），封装了「金额反推份额」「成本反推」「分组维护」「归一化」等业务规则。

为避免在每个组件中重复展开，新增 `fundOps.ts` 把这些操作迁移为以 `Ports` 为参数的纯函数。这样：

- 业务规则集中维护，不散落在组件中
- 通过 `Ports` 参数保持运行时解耦（不直接依赖 `chrome.*`）
- Tauri 端可同样复用（传入 Tauri 版 Port 实现即可）

`fundOps.ts` 不导出 Port 接口，仅是 UI 层的便利封装，属于 `@fund01/ui` 包。

### 9.2 SW 配置读取改用 `chrome.storage.local`

原 plan 设想 SW 读 `chrome.storage.session`。实际实现统一用 `chrome.storage.local`（key=`session-config`）：

- `chrome.storage.session` 在 popup 关闭后仍可访问，但跨 SW 重启行为不如 local 稳定
- `ChromeConfigPort.saveConfig` 同时写 `localStorage`（同步读源）和 `chrome.storage.local`（推 SW）
- SW 通过 `chrome.storage.onChanged` 监听 `session-config` 变化，自动按新间隔重排 alarm
- 不再需要原 plan 中的 `SYNC_CONFIG` message handler，简化了消息通道

### 9.3 rsbuild 必须显式配置 `resolve.alias`

tsconfig 的 `paths` 字段只对 TypeScript 类型检查生效，rsbuild 打包时**不读** tsconfig paths。因此 `apps/chrome/rsbuild.config.ts` 必须显式配置 `resolve.alias`，否则 build 报 `Module not found: Can't resolve '@fund01/core'`。

### 9.4 tsconfig 不设 `rootDir` / `outDir`

`apps/chrome/tsconfig.json`、`packages/services/tsconfig.json`、`packages/ui/tsconfig.json` 都不设 `rootDir` 和 `outDir`，避免 `paths` 引用的源文件在包目录之外触发 TS6059。仅 `packages/core/tsconfig.json` 保留（无 paths 引用，不会触发）。

### 9.5 SW 合并计算结果的结构

`mergeWatchlist` 返回 `{ list: WatchlistPayload, ... }`，SW 写 `cache-watchlist` 时取 `.list` 字段；`calcHoldings` 直接返回 `HoldingsPayload`。这是原 `lib/api.ts` 的实现细节，迁移时保持一致。

### 9.6 市场时段过滤

SW 的 `refreshAll` 不是每次都拉所有数据源，而是根据 `shouldRefreshFund` / `shouldRefreshAShareMarket` / `shouldRefreshGold` 跳过非交易时段的数据源（保留旧缓存）。仅当至少刷新了一个数据源时才写 `cache-time`，避免 UI 无谓重载。

### 9.7 Chrome popup 模式 vs dashboard 标签页模式（关键差异 + 待解决问题）

本项目从 wzk-fund/chrome 迁移而来，原架构是 dashboard **标签页**模式（`chrome.action.onClicked` → `chrome.tabs.create({url: 'dashboard.html'})`），重构为 popup 模式（`manifest.json` 的 `action.default_popup`）。

**已解决：CSS 尺寸问题**
- 原 `packages/ui/src/index.css` 用 `min-height: 100vh` 是为 dashboard 标签页（全屏浏览器窗口）设计的
- popup 模式下 Chrome popup 默认无固定尺寸，`100vh` = popup 视口高度但视口本身未定义 → 内容为 0 高度 → popup 看起来"没显示"
- 修复：`apps/chrome/src/popup/index.html` 内联 `<style>` 强制设置 `width: 666px !important; min-height: 600px !important` 覆盖 index.css

**待解决：左键点击图标 popup 不弹出**
- 现象：左键点击工具栏图标无反应，右键→"检查" 才能弹出 popup
- 可能原因（待排查）：
  1. `manifest.json` 的 `action` 配置问题
  2. 图标文件问题导致 action 未正确注册
  3. Service Worker 注册失败导致 action 未激活
  4. Chrome 扩展加载缓存问题（需完全卸载后重新加载）
- 建议排查步骤：
  1. `chrome://extensions` 检查 SW 是否报错
  2. 完全移除扩展后重新加载 `dist/`
  3. 检查 `chrome.action` API 在 SW 中是否正确调用
  4. 尝试移除 `background.type: "module"` 测试

**架构启示**
- `packages/ui/src/index.css` 的 `100vh` 设计同时服务 popup 和未来 Tauri menubar，但两者的视口尺寸语义不同：
  - Chrome popup：视口 = popup 窗口尺寸（需显式设定）
  - Tauri menubar：视口 = WebviewWindow 尺寸（需在 Rust 端设定）
  - Dashboard 标签页 / Tauri 主窗口：视口 = 浏览器窗口（100vh 自然有意义）
- 未来 Tauri 实现时也需注意 menubar WebviewWindow 的尺寸设定
