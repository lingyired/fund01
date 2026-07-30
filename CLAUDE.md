# CLAUDE.md — fund01 开发指南

你是一位精通 Chrome Extension (MV3)、TypeScript、React、pnpm workspaces、Tauri 2 的工程师。你写可维护、高性能的代码。本文档指导你在 `fund01` monorepo 中进行开发与扩展。

## 项目目标

`fund01` 是一个基金/组合盯盘工具的 monorepo，目标支持多个运行时：

- **apps/chrome**：Chrome 扩展（popup + badge 模式），MV3 Service Worker 后端定时刷新
- **apps/tauri**（未来）：Tauri 2 桌面应用（macOS menubar app），Rust 后端常驻

共享代码在 `packages/`：

- `@fund01/core` — 纯业务逻辑 + 接口契约（DataPort / ConfigPort / EventPort）
- `@fund01/services` — 数据请求层（原生 fetch）
- `@fund01/ui` — React 组件（无运行时耦合，通过 PortsContext 接受 Port 实现）

## 目录保护规则

- **严禁修改** `node_modules/`、`dist/`、`pnpm-lock.yaml`（除非依赖变更）
- 所有新增、修改、重构工作在 `packages/`、`apps/`、根配置文件、`docs/` 中进行
- 如果需要参考原始实现，`wzk-fund` 仓库（`/Users/lingsmbp/Documents/github/wzk-fund`）的 `server/`、`web/`、`chrome/` **只读查阅**，不要使用 Edit/Write 修改它们
- 迁移代码时，从原仓库读取后，在 `fund01/` 对应位置重新实现

## 命令

```bash
pnpm install          # 安装依赖
pnpm dev:chrome       # 启动 Chrome 扩展开发模式（rsbuild --watch）
pnpm build:chrome     # 构建生产版本到 apps/chrome/dist/
pnpm zip:chrome       # 打包 Chrome 扩展为可上传 Web Store 的 zip
pnpm typecheck        # 全仓库递归 TypeScript 类型检查
```

加载扩展：Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `apps/chrome/dist/`。

## 架构总览

详见 `ARCHITECTURE.md`。要点：

1. **后端权威**：合并计算在 SW（Chrome）/ Rust（Tauri），UI 是被动视图
2. **三个 Port 接口**：UI 通过 `DataPort` / `ConfigPort` / `EventPort` 与具体运行时解耦
3. **源码直引**：app 通过 tsconfig `paths` + rsbuild `resolve.alias` 引用 packages 源码，packages 不单独构建，无需预构建产物

依赖方向：

```
packages/core  ◀── packages/services
              ◀── packages/ui
              ◀── apps/chrome（同时依赖 services + ui）
```

`core` 不依赖任何 `@fund01/*` 包；`services` 和 `ui` 依赖 `core`；`apps/chrome` 依赖三者并注入 Port 实现。

## 三个 Port 接口

定义在 `packages/core/src/port.ts`：

### DataPort（异步数据访问）

UI 首次打开主动拉一次缓存，避免等事件：

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

### ConfigPort（同步读 + 异步推）

```typescript
export interface ConfigPort {
  getConfig(): AppConfig                  // 同步读本地缓存，UI 不闪
  saveConfig(config: AppConfig): Promise<void>  // 写本地 + 异步推后端
  onChanged(cb: (config: AppConfig) => void): () => void
}
```

设计理由：localStorage 同步读避免 UI 闪烁；Tauri 端可用内存镜像 + invoke 实现同样的「同步读 + 异步推」语义。

### EventPort（后端 → 前端事件）

```typescript
export interface EventPort {
  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void
  onConfigChange(cb: (config: AppConfig) => void): () => void
}
```

设计理由：统一 Chrome `chrome.storage.onChanged` 与 Tauri `listen` 两种事件机制，UI 不感知运行时差异。

### Port 实现

- `apps/chrome/src/ports/chromeDataPort.ts` — 通过 `chrome.runtime.sendMessage` 调 SW，缓存读 `chrome.storage.local`
- `apps/chrome/src/ports/chromeConfigPort.ts` — 同步读 `localStorage`，写时同时落 `localStorage`（同步读源）和 `chrome.storage.local`（key=`session-config`，SW 监听 `onChanged` 自动重排 alarm）
- `apps/chrome/src/ports/chromeEventPort.ts` — `onQuoteUpdate` 监听 `chrome.storage.onChanged` 的 `cache-time`；`onConfigChange` 监听 `window.addEventListener('storage', ...)`（跨窗口同步）
- `apps/tauri/src/ports/*`（未来）— 基于 `@tauri-apps/api` 的 `invoke` / `listen`

### 不抽象的部分

- **HttpClient**：fetch 跨 JS 运行时通用；Rust 后端用 reqwest 独立实现，不参与 TS 抽象
- **CSRF 缓存**：services 内部用模块级 Map，SW 重启时丢失（多请求一次 fund123.cn，可接受）
- **badge / 图标更新**：Chrome `setBadgeText` 与 Tauri 动态图标机制差异大，各 app 自行实现

## 数据源迁移指南

数据源请求要点（从 wzk-fund server 端迁移而来）：

### fund123.cn（蚂蚁基金，非天天基金）

- CSRF token 从 `https://www.fund123.cn/fund` 页面正则提取（`/"csrf":"([^"]+)"/`）
- 服务层用模块级 `Map` 缓存（TTL 10 分钟），SW 重启时丢失
- 扩展有 `host_permissions` 时 fetch 默认带 cookie；如遇 403 加 `credentials: 'include'`
- POST 请求需带 `X-API-Key: foobar`、`Origin`、`Referer` 头

### 东方财富 fundmobapi / push2

- 移动端 API，需设 `MOBILE_UA`
- 基金批量接口 `FundMNFInfo` 一次最多 200 个
- 指数 / 黄金走 `push2delay.eastmoney.com`（主），`push2.eastmoney.com` / `82.push2.eastmoney.com` 备用
- 公共参数 `ut=fa5fd1943c7b386f172d6893dbbd4dc`

### 腾讯 / 新浪

- 指数 K 线主源腾讯 `web.ifzq.gtimg.cn`，备用新浪 `money.finance.sina.com.cn`
- 美股指数备用新浪 US `stock.finance.sina.com.cn`
- 新浪黄金 `hq.sinajs.cn` 返回 GBK 编码，用 `TextDecoder('gbk')` 原生解码，**不要**引入 iconv-lite

## Service Worker 定时刷新

`apps/chrome/src/background/index.ts` 的核心流程：

1. **动态 alarm**：`chrome.alarms.create` 用单次 `delayInMinutes`，每次触发后根据当前是否任一市场开盘（`isAnyMarketActive`）重排，自动切换 trading / nonTrading 间隔
2. **配置驱动**：SW 通过 `chrome.storage.onChanged` 监听 `session-config` 变化（前端 `ConfigPort.saveConfig` 写入），自动按新间隔重排 alarm
3. **市场时段过滤**：用 `shouldRefreshFund` / `shouldRefreshAShareMarket` / `shouldRefreshGold` 跳过非交易时段的数据源（保留旧缓存，避免无谓请求）
4. **并发拉取**：`Promise.allSettled` 并发拉取基金 / 指数 / 大盘 / 黄金，任一失败不影响其他
5. **后端合并计算**（关键）：SW 调 `@fund01/core` 的 `calcHoldings` / `mergeWatchlist` 把行情与配置合并成 UI 可直接渲染的 payload，结果写 `chrome.storage.local` 的 `cache-*` keys
6. **badge 更新**：合并完成后用 `chrome.action.setBadgeText` 显示持仓总收益率（如 `↑0.8%` / `-1.2%`），颜色红涨绿跌
7. **消息分发**：`chrome.runtime.onMessage` 处理 `REFRESH` / `FETCH_FUND_HISTORY` / `FETCH_INDEX_HISTORY` / `FETCH_FUND_INTRADAY` / `RESOLVE_FUND` 等同步类请求（DataPort 转发到此）

## Tauri 端规划（占位）

详见 `apps/tauri/README.md`。本次未实现 Rust 代码，仅文档说明未来路径：

- Rust 后端常驻，用 `tokio::time::interval` 定时刷新（不像 MV3 SW 30s 休眠）
- 通过 `app.emit` 推送事件到前端，前端用 `@tauri-apps/api/event` 的 `listen` 订阅
- menubar 模式：`TrayIconBuilder` + `WebviewWindow`（`decorations: false`、`skip_taskbar: true`、`always_on_top: true`）
- 配置存储用 Tauri store plugin 或文件
- 托盘徽章需动态生成图标 PNG（macOS 也支持 `tray.set_title` 显示文本）
- 实现路径决策（Rust 重写 services vs JS sidecar）延后到真正动手时再选

## 实际实现中的发现（重要）

以下是在 Task 1-11 实施过程中发现的、与原 plan 预期不完全一致的点，文档需如实记录：

### 1. `packages/ui/src/lib/fundOps.ts` 的存在

原 plan 设想组件直接调 `usePorts().config.saveConfig(...)` 修改配置。实际迁移时发现原 `lib/api.ts` + `lib/portfolioStore.ts` 中存在大量组合操作（`createFund` / `updateFund` / `removeFund` / `addHoldingGroup` / `renameHoldingGroup` / `setFundAllocation` / `updateSettings` / `importConfig` 等），这些函数封装了「金额反推份额」「成本反推」「分组维护」「归一化」等业务规则。

为避免在每个组件中重复展开这些逻辑，新增了 `packages/ui/src/lib/fundOps.ts`，把这些组合操作迁移为以 `Ports` 为参数的纯函数（不直接依赖 chrome.*），既保留原有业务规则，又通过 Ports 保持运行时解耦。组件中改为：

```tsx
import { createFund, removeFund } from '../lib/fundOps'
const { data, config } = usePorts()
await createFund({ data, config }, { code: '025687', amount: 1000, amountBasis: 'prev', group: '默认' })
```

`fundOps.ts` 不导出 Port 接口，仅是 UI 层的便利封装；Tauri 端可同样复用。

### 2. rsbuild 必须显式配置 `resolve.alias`

tsconfig 的 `paths` 字段只对 TypeScript 类型检查生效，**rsbuild 打包时不读 tsconfig paths**。因此 `apps/chrome/rsbuild.config.ts` 必须显式配置：

```typescript
resolve: {
  alias: {
    '@fund01/core': path.resolve(__dirname, '../../packages/core/src'),
    '@fund01/services': path.resolve(__dirname, '../../packages/services/src'),
    '@fund01/ui': path.resolve(__dirname, '../../packages/ui/src'),
  },
},
```

否则 build 时报 `Module not found: Can't resolve '@fund01/core'`。

### 3. tsconfig.json 不要设 `rootDir` / `outDir`

`apps/chrome/tsconfig.json`、`packages/services/tsconfig.json`、`packages/ui/tsconfig.json` 都**不设** `rootDir` 和 `outDir`。原因：

- 这些包都通过 `noEmit: true`（继承自 `tsconfig.base.json`）只做类型检查，不emit
- 设 `rootDir` 会触发 TS6059（"File is not under rootDir"），因为 `paths` 引用的源文件在包目录之外
- 仅 `packages/core/tsconfig.json` 保留了 `rootDir: ./src` + `outDir: ./dist`（无 paths 引用，不会触发 TS6059，保留以备未来单独构建）

### 4. `env.d.ts` 需声明 `*.css` 模块

`apps/chrome/src/env.d.ts` 和 `packages/ui/src/env.d.ts` 都需要：

```typescript
declare module '*.css';
```

否则 `import './index.css'` 在 strict 模式下报错。`apps/chrome/src/env.d.ts` 还需 `/// <reference types="chrome" />` 和 `/// <reference types="node" />`。

### 5. `output.distPath.js` 必须为空字符串

`apps/chrome/rsbuild.config.ts` 的 `output.distPath` 中 `js: ''`（不是默认的 `static/js`），确保 `background.js` 和 `popup.js` 直接产出在 `dist/` 根目录，匹配 `manifest.json` 中 `"service_worker": "background.js"` 的路径要求。MV3 SW 不允许 chunk 分割，配合 `chunkSplit: { strategy: 'all-in-one' }` 与 `filename: { js: '[name].js' }` 保证单文件输出。

### 6. SW 端配置读取改 `chrome.storage.local`

原 plan 设想 SW 读 `chrome.storage.session`。实际实现中，`ChromeConfigPort.saveConfig` 直接写 `chrome.storage.local`（key=`session-config`），SW 的 `getSessionConfig()` 也从 `chrome.storage.local` 读。`chrome.storage.session` 在 popup 关闭后仍可访问，但跨 SW 重启行为不如 local 稳定，统一用 local 更简单。

## Pitfalls

- **MV3 SW 生命周期**：空闲约 30 秒休眠，所有模块级状态（含 CSRF 缓存 Map）丢失。alarm 唤醒后重新获取可接受；不要依赖 SW 内存做持久状态
- **CSRF 内存 Map**：`services/fund.ts` 用模块级 Map 缓存 token，SW 重启时丢失，会多请求一次 `fund123.cn/fund` 抓 HTML。如需跨重启保留，可改用 `chrome.storage.session`，但当前实现选择「丢失可接受」
- **CSP 限制**：MV3 不允许 `eval()`、内联脚本，所有库（含 echarts）必须通过打包引入，不能用 CDN script 标签
- **localStorage 跨窗口**：每个 popup 实例独立 localStorage，跨窗口同步需用 `window.addEventListener('storage', ...)`（`ChromeEventPort.onConfigChange` 已处理）。同窗口修改不触发 storage 事件，靠 `ChromeConfigPort.saveConfig` 手动通知本地监听器
- **pnpm workspaces**：修改 packages 源码后无需 rebuild，rsbuild 直接打包源码；`pnpm install` 后 symlink 自动建立
- **rsbuild alias**：见上文「实际实现中的发现」第 2 条，必须显式配置
- **TypeScript strict**：所有 undefined 值用 nullish coalescing（`??`）或显式 null 检查处理；`noEmit: true` 全局开启
- **fetch 与 cookie**：扩展有 `host_permissions` 时 fetch 默认带 cookie，遇到 403 再尝试 `credentials: 'include'`
- **GBK 解码**：仅新浪黄金接口需要，用 `TextDecoder('gbk')` 原生解码，不引入 iconv-lite
- **chrome.alarms 最小间隔**：浏览器强制最小 0.5 分钟（30 秒），低于此值会被截断。`scheduleNextAlarm` 中 `Math.max(0.5, delaySec / 60)` 已处理
- **Popup 关闭即销毁**：Popup 关闭后 DOM 和 JS 全部销毁，不能依赖 popup 做后台轮询。所有定时逻辑必须在 Service Worker + chrome.alarms 中
- **popup 模式 vs dashboard 标签页**：原 wzk-fund 是 dashboard 标签页（全屏浏览器窗口），CSS 用 min-height: 100vh 是为标签页设计。重构为 popup 模式后，100vh = popup 视口高度但视口本身未定义 → 内容为 0 高度。修复：popup/index.html 内联 <style> 用 !important 强制固定尺寸（666x600）。详见 ARCHITECTURE.md §9.7
