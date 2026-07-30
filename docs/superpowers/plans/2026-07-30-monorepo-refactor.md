# fund01 Monorepo 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `wzk-fund/chrome/` 单一目录重构为 `fund01/` monorepo（packages/core + packages/services + packages/ui + apps/chrome），并改造为 popup + badge 模式，为未来 Tauri menubar app 复用做好准备。

**Architecture:** pnpm workspaces，源码直引（tsconfig paths）。后端权威架构：合并计算在 SW，UI 被动订阅。三个 Port 接口（DataPort/ConfigPort/EventPort）解耦 UI 与具体运行时。

**Tech Stack:** TypeScript 6 / React 19 / pnpm / Rsbuild 2 / Tailwind v4 / chrome.* MV3 / @fund01/* workspace packages

**Spec:** `docs/superpowers/specs/2026-07-30-monorepo-refactor-design.md`

---

## 文件结构总览

```
fund01/
├── package.json                      # Task 1
├── pnpm-workspace.yaml                # Task 1
├── tsconfig.base.json                 # Task 1
├── .gitignore                         # Task 1
├── .npmrc                             # Task 1
├── CLAUDE.md                          # Task 12
├── README.md                          # Task 12
├── ARCHITECTURE.md                    # Task 12
├── packages/
│   ├── core/
│   │   ├── package.json               # Task 2
│   │   ├── tsconfig.json              # Task 2
│   │   ├── README.md                  # Task 12
│   │   └── src/
│   │       ├── index.ts               # Task 2
│   │       ├── port.ts                # Task 2
│   │       ├── types.ts               # Task 2
│   │       ├── holdingsCalc.ts        # Task 3
│   │       ├── tradingCalendar.ts     # Task 3
│   │       ├── portfolioLogic.ts      # Task 4
│   │       └── utils.ts               # Task 3
│   ├── services/
│   │   ├── package.json               # Task 5
│   │   ├── tsconfig.json              # Task 5
│   │   ├── README.md                  # Task 12
│   │   └── src/
│   │       ├── index.ts               # Task 5
│   │       ├── http.ts                # Task 5
│   │       ├── fund.ts                # Task 6
│   │       ├── gold.ts                # Task 6
│   │       └── market.ts              # Task 6
│   └── ui/
│       ├── package.json               # Task 7
│       ├── tsconfig.json              # Task 7
│       ├── README.md                  # Task 12
│       └── src/
│           ├── index.ts               # Task 7
│           ├── App.tsx                # Task 8
│           ├── context.ts             # Task 7
│           ├── hooks.ts                # Task 8
│           ├── theme.ts               # Task 8
│           ├── index.css              # Task 8
│           └── components/            # Task 9
└── apps/
    ├── chrome/
    │   ├── package.json               # Task 10
    │   ├── tsconfig.json              # Task 10
    │   ├── rsbuild.config.ts          # Task 10
    │   ├── manifest.json              # Task 10
    │   ├── postcss.config.mjs         # Task 10
    │   ├── scripts/                    # Task 10
    │   ├── public/icons/               # Task 10
    │   └── src/
    │       ├── background/index.ts    # Task 11
    │       ├── popup/                  # Task 11
    │       └── ports/                  # Task 11
    └── tauri/
        └── README.md                  # Task 13
```

**源文件路径（仅读取，禁止修改）：**
- `/Users/lingsmbp/Documents/github/wzk-fund/chrome/src/lib/*`
- `/Users/lingsmbp/Documents/github/wzk-fund/chrome/src/services/*`
- `/Users/lingsmbp/Documents/github/wzk-fund/chrome/src/background/index.ts`
- `/Users/lingsmbp/Documents/github/wzk-fund/chrome/src/components/*`
- `/Users/lingsmbp/Documents/github/wzk-fund/chrome/src/App.tsx`
- `/Users/lingsmbp/Documents/github/wzk-fund/chrome/{package.json,manifest.json,rsbuild.config.ts,tsconfig.json,postcss.config.mjs,scripts/*,public/icons/*}`


---

## Task 1: 初始化 Monorepo 骨架

**Files:**
- Create: `/Users/lingsmbp/Documents/aiwork/fund01/package.json`
- Create: `/Users/lingsmbp/Documents/aiwork/fund01/pnpm-workspace.yaml`
- Create: `/Users/lingsmbp/Documents/aiwork/fund01/tsconfig.base.json`
- Create: `/Users/lingsmbp/Documents/aiwork/fund01/.gitignore`
- Create: `/Users/lingsmbp/Documents/aiwork/fund01/.npmrc`

- [ ] **Step 1: 写根 package.json**

```json
{
  "name": "fund01",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:chrome": "pnpm --filter @fund01/chrome dev",
    "build:chrome": "pnpm --filter @fund01/chrome build",
    "zip:chrome": "pnpm --filter @fund01/chrome zip",
    "typecheck": "pnpm -r typecheck"
  },
  "packageManager": "pnpm@9.15.0"
}
```

写到 `/Users/lingsmbp/Documents/aiwork/fund01/package.json`。

- [ ] **Step 2: 写 pnpm-workspace.yaml**

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

- [ ] **Step 3: 写 tsconfig.base.json**

```json
{
  "compilerOptions": {
    "lib": ["DOM", "ES2022", "WebWorker"],
    "jsx": "react-jsx",
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: 写 .gitignore**

```
node_modules/
dist/
*.log
.DS_Store
.env
.env.local
coverage/
```

- [ ] **Step 5: 写 .npmrc**

```
shamefully-hoist=false
strict-peer-dependencies=false
```

- [ ] **Step 6: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore .npmrc
git commit -m "chore: 初始化 monorepo 骨架"
```

---

## Task 2: 创建 packages/core 接口与类型骨架

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/port.ts`
- Create: `packages/core/src/types.ts`

- [ ] **Step 1: 写 packages/core/package.json**

```json
{
  "name": "@fund01/core",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "tailwind-merge": "^3.6.0",
    "clsx": "^2.1.1"
  },
  "devDependencies": {
    "typescript": "^6.0.3"
  }
}
```

注意：`tailwind-merge` 和 `clsx` 是 `utils.ts` 中 `cn()` 的依赖。

- [ ] **Step 2: 写 packages/core/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 写 packages/core/src/types.ts**

从原 `chrome/src/lib/api.ts` 提取所有类型定义（FundRecord、FundQuoteRow、HoldingsPayload、IndexItem、SectorItem、MarketOverview、GoldPayload、RefreshInterval、QuoteSource、AppSettings、AppConfig、IndexHistoryRange、IndexHistoryPayload、FundHistoryRange、FundHistoryPayload、ResolveFundResult、FundIntradayPayload）。

完整复制 `/Users/lingsmbp/Documents/github/wzk-fund/chrome/src/lib/api.ts` 第 23-206 行的类型定义到 `packages/core/src/types.ts`，并在文件顶部加：

```typescript
// 共享类型定义
```

新增一个类型：

```typescript
export type ResolveFundPayload = ResolveFundResult

export type IntradayPoint = { time: string; growth: number | null; netValue?: number | null }

export type WatchlistPayload = FundQuoteRow[]

export type QuoteUpdate = {
  holdings: HoldingsPayload | null
  watchlist: WatchlistPayload | null
  indices: IndexItem[] | null
  market: MarketOverview | null
  gold: GoldPayload | null
  time: number
}
```

- [ ] **Step 4: 写 packages/core/src/port.ts**

```typescript
import type {
  AppConfig,
  FundHistoryPayload,
  FundIntradayPayload,
  GoldPayload,
  HoldingsPayload,
  IndexHistoryPayload,
  IndexItem,
  IntradayPoint,
  MarketOverview,
  QuoteUpdate,
  ResolveFundPayload,
  WatchlistPayload,
} from './types'

/** UI 数据访问抽象 —— 各 app 必须提供实现 */
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

/** UI 配置访问抽象（同步读避免闪烁 + 异步推后端） */
export interface ConfigPort {
  /** 同步读本地缓存（UI 不闪） */
  getConfig(): AppConfig
  /** 写本地缓存 + 异步推后端 */
  saveConfig(config: AppConfig): Promise<void>
  /** 订阅配置变更（多窗口同步） */
  onChanged(cb: (config: AppConfig) => void): () => void
}

/** 后端 → 前端事件订阅抽象 */
export interface EventPort {
  /** 订阅后端推送的行情更新事件 */
  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void
  /** 订阅配置变更（多窗口同步） */
  onConfigChange(cb: (config: AppConfig) => void): () => void
}

/** UI 与具体 app 之间注入的 Port 集合 */
export interface Ports {
  data: DataPort
  config: ConfigPort
  event: EventPort
}
```

- [ ] **Step 5: 写 packages/core/src/index.ts**

```typescript
export * from './types'
export * from './port'
export * from './holdingsCalc'
export * from './tradingCalendar'
export * from './portfolioLogic'
export * from './utils'
```

注意：此时 holdingsCalc/tradingCalendar/portfolioLogic/utils 还未创建，typecheck 会失败。本任务只验证 port.ts 和 types.ts 的语法正确性。

- [ ] **Step 6: 临时验证 types 和 port 语法**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01/packages/core
npx tsc --noEmit src/port.ts src/types.ts 2>&1 | head -20
```

Expected: 无错误（或仅有 "Cannot find module './holdingsCalc'" 这类尚未创建的引用错误，可忽略，因为是从 index.ts 引用的）。

- [ ] **Step 7: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add packages/core/
git commit -m "feat(core): 接口契约 DataPort/ConfigPort/EventPort 与类型定义"
```


---

## Task 3: 迁移 core 纯逻辑（holdingsCalc / tradingCalendar / utils）

**Files:**
- Create: `packages/core/src/holdingsCalc.ts`（从 `chrome/src/lib/holdingsCalc.ts` 复制）
- Create: `packages/core/src/tradingCalendar.ts`（从 `chrome/src/lib/tradingCalendar.ts` 复制）
- Create: `packages/core/src/utils.ts`（从 `chrome/src/lib/utils.ts` 复制）

- [ ] **Step 1: 复制 holdingsCalc.ts**

```bash
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/src/lib/holdingsCalc.ts /Users/lingsmbp/Documents/aiwork/fund01/packages/core/src/holdingsCalc.ts
```

然后用 Edit 修改：把 `from '@/lib/api'` 替换为 `from './types'`（holdingsCalc 引用了 FundRecord / FundQuoteRow / HoldingsPayload 等类型）。

打开新文件检查 import 行，所有 `@/lib/api` 的类型引用改 `./types`，所有 `@/lib/tradingCalendar` 改 `./tradingCalendar`，所有 `@/lib/utils` 改 `./utils`。

- [ ] **Step 2: 复制 tradingCalendar.ts**

```bash
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/src/lib/tradingCalendar.ts /Users/lingsmbp/Documents/aiwork/fund01/packages/core/src/tradingCalendar.ts
```

检查 import 行：tradingCalendar 应该没有外部 `@/` 引用（纯函数）。如果有 `@/lib/api`，改为 `./types`。

- [ ] **Step 3: 复制 utils.ts**

```bash
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/src/lib/utils.ts /Users/lingsmbp/Documents/aiwork/fund01/packages/core/src/utils.ts
```

检查 import：`utils.ts` 的 `cn()` 使用 `clsx` 和 `tailwind-merge`，import 路径是 `clsx` 和 `tailwind-merge`（npm 包，无需改）。

- [ ] **Step 4: typecheck**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01/packages/core
npx tsc --noEmit
```

Expected: 无错误。

如果有 "Cannot find name 'FundRecord'" 之类的错误，检查 holdingsCalc.ts 顶部是否漏改了 import。

- [ ] **Step 5: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add packages/core/src/
git commit -m "feat(core): 迁移 holdingsCalc/tradingCalendar/utils 纯逻辑"
```

---

## Task 4: 迁移 core 配置归一化逻辑（portfolioLogic.ts）

**Files:**
- Create: `packages/core/src/portfolioLogic.ts`（从 `chrome/src/lib/portfolioStore.ts` 提取纯逻辑部分）

- [ ] **Step 1: 读取原始 portfolioStore.ts**

读取 `/Users/lingsmbp/Documents/github/wzk-fund/chrome/src/lib/portfolioStore.ts` 全文，识别以下「纯函数/常量」需要提取到 portfolioLogic.ts：
- `DEFAULT_CONFIG`
- `DEFAULT_REFRESH_INTERVAL`
- `MIN_REFRESH_INTERVAL`
- `normalizeConfig`
- `normalizeFund`
- `normalizeFundMap`
- `clampRefreshInterval`
- 其他与 localStorage 无关的归一化逻辑

识别以下「localStorage 操作」**不**提取（留在 app 层实现 ConfigPort）：
- `loadConfig`
- `saveConfig`
- `listFunds`
- `upsertFund`
- `updateFund`
- `removeFund`
- 等所有读写 localStorage 的函数

- [ ] **Step 2: 写 packages/core/src/portfolioLogic.ts**

在 `/Users/lingsmbp/Documents/aiwork/fund01/packages/core/src/portfolioLogic.ts` 中：

1. 顶部 import：
```typescript
import type { AppConfig, AppSettings, FundRecord, RefreshInterval } from './types'
```

2. 从原 `portfolioStore.ts` 复制以下纯函数/常量到该文件（保持实现完全一致）：
   - `DEFAULT_REFRESH_INTERVAL`
   - `MIN_REFRESH_INTERVAL`
   - `normalizeFund`
   - `normalizeFundMap`
   - `normalizeConfig`
   - `clampRefreshInterval`
   - `DEFAULT_CONFIG`

3. 检查这些函数内部如果有 `localStorage.*` 调用（不应该有，但保险），剥离掉。

4. 删除任何 `STORAGE_KEY` 常量（属于 app 层）。

- [ ] **Step 3: typecheck**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01/packages/core
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add packages/core/src/portfolioLogic.ts
git commit -m "feat(core): 提取配置归一化纯逻辑到 portfolioLogic"
```

---

## Task 5: 创建 packages/services 骨架 + 迁移 http.ts

**Files:**
- Create: `packages/services/package.json`
- Create: `packages/services/tsconfig.json`
- Create: `packages/services/src/index.ts`
- Create: `packages/services/src/http.ts`（从 `chrome/src/services/http.ts` 复制并清理）

- [ ] **Step 1: 写 packages/services/package.json**

```json
{
  "name": "@fund01/services",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fund01/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "@types/node": "^24.13.3"
  }
}
```

- [ ] **Step 2: 写 packages/services/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "paths": {
      "@fund01/core": ["../core/src"],
      "@fund01/core/*": ["../core/src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 复制 http.ts 并清理**

```bash
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/src/services/http.ts /Users/lingsmbp/Documents/aiwork/fund01/packages/services/src/http.ts
```

打开新文件，删除 `cookieHeader` 函数（spec §6.4 要求删除未使用的遗留）。保留 `httpGet`、`httpPost`、`MOBILE_UA`、`fmtDate`、`DEFAULT_HEADERS`、`UA` 常量。

检查 import：如有 `@/lib/*` 引用，改为 `@fund01/core`。

- [ ] **Step 4: 写 packages/services/src/index.ts**

```typescript
export * from './http'
export * from './fund'
export * from './gold'
export * from './market'
```

注意：fund/gold/market 尚未创建，typecheck 会失败，本步骤只验证 http.ts 语法。

- [ ] **Step 5: 验证 http.ts 语法**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01/packages/services
npx tsc --noEmit src/http.ts 2>&1 | head
```

Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add packages/services/
git commit -m "feat(services): 骨架 + http 封装迁移"
```

---

## Task 6: 迁移 services 业务文件（fund / gold / market）

**Files:**
- Create: `packages/services/src/fund.ts`（从 `chrome/src/services/fund.ts` 改造）
- Create: `packages/services/src/gold.ts`（从 `chrome/src/services/gold.ts` 复制）
- Create: `packages/services/src/market.ts`（从 `chrome/src/services/market.ts` 复制）

- [ ] **Step 1: 复制三个文件**

```bash
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/src/services/fund.ts /Users/lingsmbp/Documents/aiwork/fund01/packages/services/src/fund.ts
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/src/services/gold.ts /Users/lingsmbp/Documents/aiwork/fund01/packages/services/src/gold.ts
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/src/services/market.ts /Users/lingsmbp/Documents/aiwork/fund01/packages/services/src/market.ts
```

- [ ] **Step 2: 修改 fund.ts —— 替换 import 路径**

打开 `/Users/lingsmbp/Documents/aiwork/fund01/packages/services/src/fund.ts`，替换 import：
- `from '@/services/http'` → `from './http'`
- `from '@/lib/tradingCalendar'` → `from '@fund01/core'`
- `from '@/lib/api'`（如有，类型引用）→ `from '@fund01/core'`

- [ ] **Step 3: 修改 fund.ts —— CSRF 缓存改模块级 Map**

在 fund.ts 顶部找到 `getCsrf/setCsrf/ensureCsrf` 三个函数（约第 9-50 行，使用 `chrome.storage.session`）。将它们替换为模块级 Map 实现：

```typescript
// CSRF token 缓存：SW 重启时丢失，会多请求一次 fund123.cn（可接受）
const csrfCache = new Map<string, { token: string; expiresAt: number }>()
const CSRF_KEY = 'fund123-csrf'
const CSRF_TTL = 10 * 60 * 1000

async function getCsrf(): Promise<string | null> {
  const c = csrfCache.get(CSRF_KEY)
  if (c && c.token && Date.now() < c.expiresAt) return c.token
  return null
}

async function setCsrf(token: string): Promise<void> {
  csrfCache.set(CSRF_KEY, { token, expiresAt: Date.now() + CSRF_TTL })
}

async function ensureCsrf(force = false): Promise<string> {
  if (!force) {
    const cached = await getCsrf()
    if (cached) return cached
  }
  const res = await fetch('https://www.fund123.cn/fund', {
    headers: { 'User-Agent': UA, Referer: 'https://www.fund123.cn/' },
  })
  const html = await res.text()
  const match = html.match(/"csrf":"([^"]+)"/)
  if (!match) throw new Error('获取 fund123 CSRF 失败')
  await setCsrf(match[1])
  return match[1]
}
```

- [ ] **Step 4: 修改 fund.ts —— 删除内部重复 nextTradingDay/isConfirmedSessionActive**

搜索 fund.ts 内部是否定义了 `nextTradingDay` 和 `isConfirmedSessionActive`（spec §6.4 要求删除）。如果有，删除这些本地实现，改用 `import { nextTradingDay, isConfirmedSessionActive } from '@fund01/core'`（这两个函数在 tradingCalendar.ts 中已存在）。

注意：如果 `core/tradingCalendar.ts` 中没有 `isConfirmedSessionActive`，需在 tradingCalendar.ts 末尾补上（从 fund.ts 内部实现复制过去）。

检查方法：
```bash
grep -n "isConfirmedSessionActive\|nextTradingDay" /Users/lingsmbp/Documents/aiwork/fund01/packages/core/src/tradingCalendar.ts
grep -n "isConfirmedSessionActive\|nextTradingDay" /Users/lingsmbp/Documents/aiwork/fund01/packages/services/src/fund.ts
```

如果 core 没有 `isConfirmedSessionActive`：从原 fund.ts 复制该函数到 `packages/core/src/tradingCalendar.ts`（保持实现），然后从 fund.ts 删除本地实现。

- [ ] **Step 5: 修改 gold.ts 和 market.ts —— 替换 import 路径**

打开两个文件，把 `from '@/services/http'` 改为 `from './http'`。其余 import 路径同理处理。

- [ ] **Step 6: 安装依赖并 typecheck**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
pnpm install
cd packages/services
npx tsc --noEmit
```

Expected: 无错误。如果出现 "Cannot find module '@fund01/core'"，检查 tsconfig.json paths 是否正确。

- [ ] **Step 7: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add packages/services/src/ pnpm-lock.yaml
git commit -m "feat(services): 迁移 fund/gold/market，CSRF 改模块级 Map"
```


---

## Task 7: 创建 packages/ui 骨架 + Context

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/src/index.ts`
- Create: `packages/ui/src/context.ts`

- [ ] **Step 1: 写 packages/ui/package.json**

```json
{
  "name": "@fund01/ui",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fund01/core": "workspace:*",
    "@radix-ui/react-dialog": "^1.1.20",
    "@radix-ui/react-dropdown-menu": "^2.1.21",
    "@radix-ui/react-label": "^2.1.12",
    "@radix-ui/react-scroll-area": "^1.2.15",
    "@radix-ui/react-select": "^2.3.4",
    "@radix-ui/react-separator": "^1.1.12",
    "@radix-ui/react-slot": "^1.3.0",
    "@radix-ui/react-switch": "^1.3.4",
    "@radix-ui/react-tabs": "^1.1.18",
    "@radix-ui/react-tooltip": "^1.2.13",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "echarts": "^6.1.0",
    "echarts-for-react": "^3.0.6",
    "lucide-react": "^1.25.0",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "tailwind-merge": "^3.6.0"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

- [ ] **Step 2: 写 packages/ui/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "paths": {
      "@fund01/core": ["../core/src"],
      "@fund01/core/*": ["../core/src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 写 packages/ui/src/context.ts**

```typescript
import { createContext, useContext } from 'react'
import type { Ports } from '@fund01/core'

export const PortsContext = createContext<Ports | null>(null)

export function usePorts(): Ports {
  const p = useContext(PortsContext)
  if (!p) throw new Error('PortsContext.Provider 未注入')
  return p
}
```

- [ ] **Step 4: 写 packages/ui/src/index.ts（占位）**

```typescript
export { PortsContext, usePorts } from './context'
export { App } from './App'
```

注意：App.tsx 尚未创建，typecheck 会失败。本任务只验证 context.ts 语法。

- [ ] **Step 5: 验证 context.ts 语法**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01/packages/ui
npx tsc --noEmit src/context.ts 2>&1 | head
```

Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add packages/ui/
git commit -m "feat(ui): 骨架 + PortsContext"
```

---

## Task 8: 迁移 ui 入口（App.tsx / hooks / theme / css）

**Files:**
- Create: `packages/ui/src/App.tsx`（从 `chrome/src/App.tsx` 改造）
- Create: `packages/ui/src/hooks.ts`（新建，封装 DataPort + EventPort 订阅）
- Create: `packages/ui/src/theme.ts`（从 `chrome/src/lib/theme.ts` 复制）
- Create: `packages/ui/src/index.css`（从 `chrome/src/index.css` 复制）

- [ ] **Step 1: 复制 theme.ts 和 index.css**

```bash
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/src/lib/theme.ts /Users/lingsmbp/Documents/aiwork/fund01/packages/ui/src/theme.ts
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/src/index.css /Users/lingsmbp/Documents/aiwork/fund01/packages/ui/src/index.css
```

theme.ts 无外部 `@/` 引用，无需修改。

- [ ] **Step 2: 复制 App.tsx**

```bash
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/src/App.tsx /Users/lingsmbp/Documents/aiwork/fund01/packages/ui/src/App.tsx
```

- [ ] **Step 3: 修改 App.tsx —— 替换 import**

打开 `/Users/lingsmbp/Documents/aiwork/fund01/packages/ui/src/App.tsx`，替换 import：
- `from '@/lib/api'` → `from '@fund01/core'`（FundQuoteRow 等类型）
- `from '@/lib/portfolioStore'` → `from '@fund01/core'`（DEFAULT_CONFIG 等）
- `from '@/lib/utils'` → `from '@fund01/core'`
- `from '@/lib/theme'` → `from './theme'`
- `from '@/components/*'` → `from './components/*'`
- `from '@/lib/holdingsCalc'` → `from '@fund01/core'`

- [ ] **Step 4: 修改 App.tsx —— 替换 chrome.* 调用**

在 App.tsx 中搜索 `chrome\.`，找到 3 处：

1. `chrome.storage.onChanged.addListener`（监听 cache-time 变化触发刷新）
2. `chrome.runtime.onMessage.addListener`（监听 RELOAD_DATA）
3. `chrome.runtime.getManifest().version`（显示版本号）

替换方案：
- 第 1、2 处：改为通过 `usePorts().event.onQuoteUpdate(cb)` 订阅，删除原 chrome.storage 监听代码
- 第 3 处：改为从 `usePorts().config.getConfig().version` 读取，或通过 prop 注入（推荐：app 在 mount 时传入 version）

具体改法见 Step 5 的 hooks.ts 设计。

- [ ] **Step 5: 写 packages/ui/src/hooks.ts**

```typescript
import { useEffect, useState } from 'react'
import { usePorts } from './context'
import type { HoldingsPayload, WatchlistPayload, IndexItem, MarketOverview, GoldPayload, QuoteUpdate } from '@fund01/core'

/** 订阅后端行情更新 + 首次主动拉取 */
export function useMarketData() {
  const { data, event } = usePorts()
  const [holdings, setHoldings] = useState<HoldingsPayload | null>(null)
  const [watchlist, setWatchlist] = useState<WatchlistPayload | null>(null)
  const [indices, setIndices] = useState<IndexItem[]>([])
  const [market, setMarket] = useState<MarketOverview | null>(null)
  const [gold, setGold] = useState<GoldPayload | null>(null)
  const [lastUpdate, setLastUpdate] = useState<number>(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 1. 首次拉缓存
    Promise.all([
      data.fetchHoldings(),
      data.fetchWatchlist(),
      data.fetchIndices(),
      data.fetchMarketOverview(),
      data.fetchGold(),
    ]).then(([h, w, i, m, g]) => {
      setHoldings(h)
      setWatchlist(w)
      setIndices(i)
      setMarket(m)
      setGold(g)
      setLoading(false)
    }).catch(() => setLoading(false))

    // 2. 订阅事件增量更新
    const off = event.onQuoteUpdate((q: QuoteUpdate) => {
      if (q.holdings) setHoldings(q.holdings)
      if (q.watchlist) setWatchlist(q.watchlist)
      if (q.indices) setIndices(q.indices)
      if (q.market) setMarket(q.market)
      if (q.gold !== undefined) setGold(q.gold)
      setLastUpdate(q.time)
    })

    return off
  }, [data, event])

  return { holdings, watchlist, indices, market, gold, lastUpdate, loading, refresh: () => data.triggerRefresh() }
}
```

- [ ] **Step 6: 修改 App.tsx —— 用 hooks 替换 chrome.* 逻辑**

打开 App.tsx，在主组件中：

1. 删除原有 `chrome.storage.onChanged` 和 `chrome.runtime.onMessage` 监听代码
2. 改为 `const { holdings, watchlist, indices, market, gold, lastUpdate, loading, refresh } = useMarketData()`
3. 删除 `chrome.runtime.getManifest().version` 调用，改为通过 prop 接受（App 组件签名加 `version?: string`）

最终 App.tsx 顶部应类似：

```tsx
import { useMarketData } from './hooks'
import { usePorts } from './context'

export function App({ version }: { version?: string }) {
  const { config } = usePorts()
  const { holdings, watchlist, indices, market, gold, lastUpdate, loading, refresh } = useMarketData()
  // ...
}
```

- [ ] **Step 7: typecheck（components 未迁移前会失败，本步骤只验证 App.tsx/hooks.ts 语法）**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01/packages/ui
npx tsc --noEmit src/App.tsx src/hooks.ts src/theme.ts 2>&1 | head -30
```

Expected: 仅有 "Cannot find module './components/*'" 类错误（components 还没迁移），无其他错误。

- [ ] **Step 8: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add packages/ui/src/App.tsx packages/ui/src/hooks.ts packages/ui/src/theme.ts packages/ui/src/index.css
git commit -m "feat(ui): 迁移 App/hooks/theme/css，替换 chrome.* 为 Ports"
```

---

## Task 9: 迁移 ui 组件目录

**Files:**
- Create: `packages/ui/src/components/*`（从 `chrome/src/components/*` 复制）
- Create: `packages/ui/src/components/ui/*`（shadcn 基础组件）

- [ ] **Step 1: 批量复制 components 目录**

```bash
cp -r /Users/lingsmbp/Documents/github/wzk-fund/chrome/src/components /Users/lingsmbp/Documents/aiwork/fund01/packages/ui/src/components
```

验证文件清单：
```bash
ls /Users/lingsmbp/Documents/aiwork/fund01/packages/ui/src/components/
# 期望：BatchEditHoldingsDialog.tsx, ConfigDialog.tsx, FundDetailDialog.tsx,
#       FundFormDialog.tsx, FundTrendDialog.tsx, GoldHoldingsRow.tsx,
#       HoldingsModule.tsx, ImportHoldingsDialog.tsx, IndexTrendDialog.tsx,
#       MarketModules.tsx, SparkTrend.tsx, WatchlistModule.tsx, ui/
```

- [ ] **Step 2: 批量替换 import 路径**

在 `packages/ui/src/components/` 目录下批量替换所有 .tsx 文件中的 import：

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01/packages/ui/src/components
# macOS sed 需要 -i ''
grep -rl "@/lib/api" . | xargs sed -i '' 's|@/lib/api|@fund01/core|g'
grep -rl "@/lib/portfolioStore" . | xargs sed -i '' 's|@/lib/portfolioStore|@fund01/core|g'
grep -rl "@/lib/utils" . | xargs sed -i '' 's|@/lib/utils|@fund01/core|g'
grep -rl "@/lib/holdingsCalc" . | xargs sed -i '' 's|@/lib/holdingsCalc|@fund01/core|g'
grep -rl "@/lib/tradingCalendar" . | xargs sed -i '' 's|@/lib/tradingCalendar|@fund01/core|g'
grep -rl "@/components/ui" . | xargs sed -i '' 's|@/components/ui|./ui|g'
grep -rl "@/components/" . | xargs sed -i '' 's|@/components/|./|g'
```

注意：`@/lib/api` 中除了类型还有 `createFund/updateFund/removeFund` 等配置函数。这些函数现在通过 `usePorts().config` 调用。需要在 typecheck 阶段（Step 4）逐一处理：

- 配置写入（createFund/updateFund/removeFund 等）：原 api.ts 中是直接调 portfolioStore，现在改为 `usePorts().config.saveConfig(...)` 修改对应 fund 后保存
- 行情拉取（fetchHoldings 等）：改为 useMarketData hook 已提供的 state

- [ ] **Step 3: 手动检查并修改调用方式**

逐个组件检查（重点）：
- `WatchlistModule.tsx`：原调用 `createFund / removeFund` → 改为通过 `usePorts().config.saveConfig(updatedConfig)`
- `GoldHoldingsRow.tsx`：原调用 `updateGoldConfig` → 改为 `usePorts().config.saveConfig`
- `FundFormDialog.tsx`：原调用 `addHoldingGroup` → 改为 `usePorts().config.saveConfig`
- `ImportHoldingsDialog.tsx`：原调用 `addHoldingGroup / createFund / listHoldingGroups` → 改为读写 `usePorts().config`
- `HoldingsModule.tsx`：从 props 接收 holdings（已是 HoldingsPayload），不直接调 api
- `BatchEditHoldingsDialog.tsx`：操作配置，改为 `usePorts().config.saveConfig`

具体修改方式：每个组件顶部添加 `import { usePorts } from '../hooks'`（注意：hooks.ts 在 src/ 下，从 components/ 引用是 `../hooks`），用 `const { config } = usePorts()` 拿到 ConfigPort，然后通过 `config.getConfig()` 读当前配置，构造新配置后 `config.saveConfig(newConfig)`。

由于原 `lib/api.ts` 中 `createFund` 等函数是组合操作（normalizeConfig + 单字段修改 + saveConfig），需要在组件内展开为：
```tsx
const { config } = usePorts()
const handleCreate = async (newFund: FundRecord) => {
  const cfg = config.getConfig()
  cfg.watchlist[newFund.code] = newFund
  await config.saveConfig(cfg)
}
```

- [ ] **Step 4: typecheck**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01/packages/ui
npx tsc --noEmit
```

Expected: 无错误。如有 "Property 'createFund' does not exist on ConfigPort" 之类错误，按 Step 3 方法展开。

- [ ] **Step 5: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add packages/ui/src/components/
git commit -m "feat(ui): 迁移全部组件，替换 api.ts 调用为 ConfigPort"
```


---

## Task 10: 创建 apps/chrome 骨架（配置文件 + manifest + scripts + icons）

**Files:**
- Create: `apps/chrome/package.json`
- Create: `apps/chrome/tsconfig.json`
- Create: `apps/chrome/rsbuild.config.ts`
- Create: `apps/chrome/manifest.json`
- Create: `apps/chrome/postcss.config.mjs`
- Create: `apps/chrome/scripts/copy-manifest.mjs`
- Create: `apps/chrome/scripts/zip.ts`
- Create: `apps/chrome/public/icons/*`

- [ ] **Step 1: 写 apps/chrome/package.json**

```json
{
  "name": "@fund01/chrome",
  "version": "1.0.18",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "rsbuild build --watch",
    "build": "rsbuild build && node scripts/copy-manifest.mjs",
    "zip": "tsx scripts/zip.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fund01/core": "workspace:*",
    "@fund01/services": "workspace:*",
    "@fund01/ui": "workspace:*",
    "@radix-ui/react-dialog": "^1.1.20",
    "@radix-ui/react-dropdown-menu": "^2.1.22",
    "@radix-ui/react-label": "^2.1.12",
    "@radix-ui/react-scroll-area": "^1.2.15",
    "@radix-ui/react-select": "^2.3.4",
    "@radix-ui/react-separator": "^1.1.12",
    "@radix-ui/react-slot": "^1.3.0",
    "@radix-ui/react-switch": "^1.3.4",
    "@radix-ui/react-tabs": "^1.1.18",
    "@radix-ui/react-tooltip": "^1.2.13",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "echarts": "^6.1.0",
    "echarts-for-react": "^3.0.6",
    "lucide-react": "^1.25.0",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "tailwind-merge": "^3.6.0"
  },
  "devDependencies": {
    "@rsbuild/core": "^2.1.7",
    "@rsbuild/plugin-react": "^2.1.0",
    "@tailwindcss/postcss": "^4.3.3",
    "@types/chrome": "^0.0.287",
    "@types/node": "^24.13.3",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "postcss": "^8.5.21",
    "tailwindcss": "^4.3.3",
    "tsx": "^4.19.2",
    "typescript": "^6.0.3"
  }
}
```

- [ ] **Step 2: 写 apps/chrome/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["chrome", "node"],
    "paths": {
      "@fund01/core": ["../../packages/core/src"],
      "@fund01/core/*": ["../../packages/core/src/*"],
      "@fund01/services": ["../../packages/services/src"],
      "@fund01/services/*": ["../../packages/services/src/*"],
      "@fund01/ui": ["../../packages/ui/src"],
      "@fund01/ui/*": ["../../packages/ui/src/*"]
    }
  },
  "include": ["src", "scripts"]
}
```

- [ ] **Step 3: 写 apps/chrome/rsbuild.config.ts**

```typescript
import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
) as { version: string }

export default defineConfig({
  plugins: [pluginReact()],
  source: {
    entry: {
      background: './src/background/index.ts',
      popup: './src/popup/index.tsx',
    },
  },
  output: {
    distPath: { root: 'dist' },
    filename: { js: '[name].js' },
  },
  performance: {
    chunkSplit: { strategy: 'all-in-one' },
  },
  html: {
    template: './src/popup/index.html',
    title: `wzk-fund · 基金盯盘 v${pkg.version}`,
  },
})
```

注意：相比原 rsbuild.config.ts，移除了 `@/` alias（packages 用 tsconfig paths 解析，rsbuild 需要额外 alias，见 Step 4 补充）。

**Step 4 补充：rsbuild 也需要 alias**

实际上 rsbuild 不读 tsconfig paths，需要额外配置。在 rsbuild.config.ts 的 `resolve.alias` 中加入 packages 路径：

```typescript
resolve: {
  alias: {
    '@fund01/core': path.resolve(__dirname, '../../packages/core/src'),
    '@fund01/services': path.resolve(__dirname, '../../packages/services/src'),
    '@fund01/ui': path.resolve(__dirname, '../../packages/ui/src'),
  },
},
```

把这段 alias 加到上面的 defineConfig 中。

- [ ] **Step 4: 写 apps/chrome/manifest.json**

```json
{
  "manifest_version": 3,
  "name": "wzk-fund 基金盯盘",
  "version": "1.0.18",
  "description": "基金实时估值、持仓收益、大盘指数一站式盯盘",
  "permissions": ["storage", "alarms"],
  "host_permissions": [
    "https://www.fund123.cn/*",
    "https://fundmobapi.eastmoney.com/*",
    "https://push2delay.eastmoney.com/*",
    "https://push2.eastmoney.com/*",
    "https://82.push2.eastmoney.com/*",
    "https://push2his.eastmoney.com/*",
    "https://emdatah5.eastmoney.com/*",
    "https://web.ifzq.gtimg.cn/*",
    "https://hq.sinajs.cn/*",
    "https://api.jijinhao.com/*",
    "https://money.finance.sina.com.cn/*",
    "https://stock.finance.sina.com.cn/*"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

变化（vs 原 manifest.json）：
- 移除 `"tabs"` permission（不再用 dashboard 标签页）
- 添加 `"default_popup": "popup.html"`
- 移除 `web_accessible_resources`

- [ ] **Step 5: 复制 postcss.config.mjs**

```bash
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/postcss.config.mjs /Users/lingsmbp/Documents/aiwork/fund01/apps/chrome/postcss.config.mjs
```

打开检查内容（应该只是引入 `@tailwindcss/postcss`）。

- [ ] **Step 6: 复制 scripts/**

```bash
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/scripts/copy-manifest.mjs /Users/lingsmbp/Documents/aiwork/fund01/apps/chrome/scripts/copy-manifest.mjs
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/scripts/zip.ts /Users/lingsmbp/Documents/aiwork/fund01/apps/chrome/scripts/zip.ts
```

打开 `copy-manifest.mjs` 检查路径，原文件用 package.json 的 version 覆盖 manifest version，路径应该正确。如果 zip.ts 中有 `chrome/` 路径引用，需调整为相对 `apps/chrome/` 的路径（脚本本身在 scripts/ 下，应该已经是相对路径）。

- [ ] **Step 7: 复制 icons**

```bash
mkdir -p /Users/lingsmbp/Documents/aiwork/fund01/apps/chrome/public/icons
cp /Users/lingsmbp/Documents/github/wzk-fund/chrome/public/icons/*.png /Users/lingsmbp/Documents/aiwork/fund01/apps/chrome/public/icons/
```

验证：
```bash
ls /Users/lingsmbp/Documents/aiwork/fund01/apps/chrome/public/icons/
# 期望：icon-128.png  icon-16.png  icon-48.png
```

- [ ] **Step 8: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add apps/chrome/
git commit -m "feat(chrome): 配置文件 + manifest + scripts + icons"
```

---

## Task 11: 创建 apps/chrome 源码（popup + background + ports）

**Files:**
- Create: `apps/chrome/src/popup/index.html`
- Create: `apps/chrome/src/popup/index.tsx`
- Create: `apps/chrome/src/ports/chromeDataPort.ts`
- Create: `apps/chrome/src/ports/chromeConfigPort.ts`
- Create: `apps/chrome/src/ports/chromeEventPort.ts`
- Create: `apps/chrome/src/background/index.ts`

- [ ] **Step 1: 写 popup/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>wzk-fund · 基金盯盘</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
```

注意：相比原 dashboard/index.html，不需要 web_accessible_resources，文件更简洁。

- [ ] **Step 2: 写 popup/index.tsx**

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@fund01/ui'
import { PortsContext } from '@fund01/ui'
import type { Ports } from '@fund01/core'
import { ChromeDataPort } from '../ports/chromeDataPort'
import { ChromeConfigPort } from '../ports/chromeConfigPort'
import { ChromeEventPort } from '../ports/chromeEventPort'

const ports: Ports = {
  data: new ChromeDataPort(),
  config: new ChromeConfigPort(),
  event: new ChromeEventPort(),
}

// 读取版本号注入 App
const version = chrome.runtime.getManifest().version

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PortsContext.Provider value={ports}>
      <App version={version} />
    </PortsContext.Provider>
  </React.StrictMode>,
)
```

注意：`PortsContext` 是从 `@fund01/ui` 导出的，需要在 `packages/ui/src/index.ts` 中也 export 它（Task 7 已写，但需要确认 index.ts 内容）。

打开 `packages/ui/src/index.ts` 检查：
```typescript
export { PortsContext, usePorts } from './context'
export { App } from './App'
```

如果没有 PortsContext，补上。

- [ ] **Step 3: 写 ports/chromeConfigPort.ts**

```typescript
import type { ConfigPort } from '@fund01/core'
import type { AppConfig } from '@fund01/core'
import { normalizeConfig, DEFAULT_CONFIG } from '@fund01/core'

const STORAGE_KEY = 'wzk-fund-config'

// SW 端读取的配置 key（chrome.storage.local）
const SW_CONFIG_KEY = 'session-config'

export class ChromeConfigPort implements ConfigPort {
  private listeners = new Set<(config: AppConfig) => void>()

  getConfig(): AppConfig {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return structuredClone(DEFAULT_CONFIG)
    try {
      return normalizeConfig(JSON.parse(raw))
    } catch {
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  async saveConfig(config: AppConfig): Promise<void> {
    const next = normalizeConfig(config)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    // 同步推送给 SW
    await chrome.storage.local.set({ [SW_CONFIG_KEY]: next })
    // 通知本地监听器（同窗口）
    this.listeners.forEach((cb) => cb(next))
  }

  onChanged(cb: (config: AppConfig) => void): () => void {
    this.listeners.add(cb)
    // 监听 chrome.storage.local 变化（其他窗口修改时同步）
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        // localStorage 被其他窗口改了？不会，localStorage 是每个窗口独立的
        // 这里主要监听 SW 写入 SW_CONFIG_KEY 的情况（实际上 SW 不写 SW_CONFIG_KEY，只是读）
        // 所以这里主要处理：popup 打开多个实例时同步配置
      }
    }
    chrome.storage.onChanged.addListener(listener)
    return () => {
      this.listeners.delete(cb)
      chrome.storage.onChanged.removeListener(listener)
    }
  }
}
```

注意：localStorage 是每窗口独立的，跨窗口同步需要手动处理。当前 popup 一般只开一个实例，可接受。如需多窗口同步，可改用 chrome.storage.local 作为配置主存储。

- [ ] **Step 4: 写 ports/chromeDataPort.ts**

```typescript
import type { DataPort } from '@fund01/core'
import type {
  FundHistoryPayload,
  FundIntradayPayload,
  GoldPayload,
  HoldingsPayload,
  IndexHistoryPayload,
  IndexItem,
  IntradayPoint,
  MarketOverview,
  ResolveFundPayload,
  WatchlistPayload,
} from '@fund01/core'

type Message =
  | { type: 'REFRESH' }
  | { type: 'FETCH_QUOTES'; funds: any[]; quoteType: 'hold' | 'watch' }
  | { type: 'FETCH_FUND_HISTORY'; code: string; range: string }
  | { type: 'FETCH_INDEX_HISTORY'; code: string; range: string }
  | { type: 'FETCH_INDICES' }
  | { type: 'FETCH_MARKET' }
  | { type: 'FETCH_GOLD'; holding: number; avgPrice: number }
  | { type: 'RESOLVE_FUND'; code: string; fundType?: 'hold' | 'watch'; name?: string; sectors?: string[] }
  | { type: 'FETCH_FUND_INTRADAY'; code: string; fundKey?: string; name?: string }

function sendMessage<T>(msg: Message): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: { ok: boolean; data?: T; error?: string }) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      if (res?.ok) resolve(res.data as T)
      else reject(new Error(res?.error || 'unknown error'))
    })
  })
}

export class ChromeDataPort implements DataPort {
  async triggerRefresh(): Promise<void> {
    await sendMessage({ type: 'REFRESH' })
  }

  async fetchHoldings(): Promise<HoldingsPayload> {
    // SW 已合并，直接读缓存
    const r = await chrome.storage.local.get('cache-holdings')
    return r['cache-holdings'] as HoldingsPayload
  }

  async fetchWatchlist(): Promise<WatchlistPayload> {
    const r = await chrome.storage.local.get('cache-watchlist')
    return r['cache-watchlist'] as WatchlistPayload
  }

  async fetchIndices(): Promise<IndexItem[]> {
    const r = await chrome.storage.local.get('cache-indices')
    return (r['cache-indices'] as IndexItem[]) || []
  }

  async fetchMarketOverview(): Promise<MarketOverview | null> {
    const r = await chrome.storage.local.get('cache-market')
    return (r['cache-market'] as MarketOverview) || null
  }

  async fetchGold(): Promise<GoldPayload | null> {
    const r = await chrome.storage.local.get('cache-gold')
    return (r['cache-gold'] as GoldPayload) || null
  }

  async fetchFundHistory(code: string, range: string = '1y'): Promise<FundHistoryPayload> {
    return sendMessage({ type: 'FETCH_FUND_HISTORY', code, range })
  }

  async fetchIndexHistory(code: string, range: string = '3m'): Promise<IndexHistoryPayload> {
    return sendMessage({ type: 'FETCH_INDEX_HISTORY', code, range })
  }

  async fetchFundIntraday(fundKey: string): Promise<IntradayPoint[]> {
    // 这个方法签名可能需要 code+fundKey+name，重新设计为兼容
    // 这里简化：调用 FETCH_FUND_INTRADAY
    const data = await sendMessage<FundIntradayPayload>({
      type: 'FETCH_FUND_INTRADAY',
      code: fundKey,
      fundKey,
    })
    return data.points
  }

  async resolveFund(code: string): Promise<ResolveFundPayload> {
    return sendMessage({ type: 'RESOLVE_FUND', code })
  }
}
```

注意：DataPort 接口中 `fetchFundHistory(code, count?)` 与原 message `FETCH_FUND_HISTORY(code, range)` 签名不一致。这里把 count 参数当作 range 字符串使用（兼容旧逻辑）。在后续如果需要重构，可在 core 接口中区分 count vs range。

- [ ] **Step 5: 写 ports/chromeEventPort.ts**

```typescript
import type { EventPort } from '@fund01/core'
import type { AppConfig, QuoteUpdate } from '@fund01/core'

export class ChromeEventPort implements EventPort {
  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local') return
      if (!changes['cache-time']) return
      // cache-time 变化意味着 SW 刷新完成，组装 QuoteUpdate
      chrome.storage.local.get([
        'cache-holdings',
        'cache-watchlist',
        'cache-indices',
        'cache-market',
        'cache-gold',
        'cache-time',
      ]).then((cached) => {
        const payload: QuoteUpdate = {
          holdings: (cached['cache-holdings'] as QuoteUpdate['holdings']) || null,
          watchlist: (cached['cache-watchlist'] as QuoteUpdate['watchlist']) || null,
          indices: (cached['cache-indices'] as QuoteUpdate['indices']) || null,
          market: (cached['cache-market'] as QuoteUpdate['market']) || null,
          gold: (cached['cache-gold'] as QuoteUpdate['gold']) || null,
          time: (cached['cache-time'] as number) || Date.now(),
        }
        cb(payload)
      })
    }
    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }

  onConfigChange(cb: (config: AppConfig) => void): () => void {
    // 多窗口同步：监听 localStorage 变化（其他窗口修改时同步）
    // localStorage 没有 onChanged 事件，需要用 storage 事件
    const listener = (e: StorageEvent) => {
      if (e.key === 'wzk-fund-config' && e.newValue) {
        try {
          cb(JSON.parse(e.newValue))
        } catch {}
      }
    }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  }
}
```

注意：`window.addEventListener('storage', ...)` 只在其他窗口修改 localStorage 时触发，同窗口修改不触发。ChromeConfigPort.saveConfig 已手动通知本地监听器，所以这里只处理跨窗口情况。

- [ ] **Step 6: 写 background/index.ts**

读取原 `/Users/lingsmbp/Documents/github/wzk-fund/chrome/src/background/index.ts` 全文，作为基础。新文件 `/Users/lingsmbp/Documents/aiwork/fund01/apps/chrome/src/background/index.ts` 在原基础上做以下修改：

1. **import 路径替换**：
   - `from '@/services/fund'` → `from '@fund01/services'`
   - `from '@/services/market'` → `from '@fund01/services'`
   - `from '@/services/gold'` → `from '@fund01/services'`
   - `from '@/lib/tradingCalendar'` → `from '@fund01/core'`
   - 新增 `import { calcHoldings, mergeWatchlist } from '@fund01/core'`

2. **配置读取改为 chrome.storage.local**：
   原 SW 通过 `chrome.storage.session` 读 session-config（前端 syncConfig 推送）。现在 ConfigPort.saveConfig 直接写 chrome.storage.local（key='session-config'），所以 SW 改为：
   ```typescript
   async function getSessionConfig(): Promise<AppConfig | null> {
     const r = await chrome.storage.local.get(CONFIG_KEY)
     return (r[CONFIG_KEY] as AppConfig) || null
   }
   ```
   （把 `chrome.storage.session` 改为 `chrome.storage.local`）

3. **删除 `chrome.action.onClicked` 整段**（不再用 dashboard 标签页）

4. **refreshAll 中新增合并计算**：
   在 `Promise.allSettled(tasks)` 之后、`chrome.storage.local.set` 之前，加入合并逻辑：

   ```typescript
   // 后端合并计算（新增）
   const holdingsQuotes = holdings.status === 'fulfilled' ? holdings.value[1] : null
   const watchlistQuotes = watchlist.status === 'fulfilled' ? watchlist.value[1] : null
   let holdingsResult: any = null
   let watchlistResult: any = null
   if (holdingsQuotes) {
     try {
       holdingsResult = calcHoldings(holdingsQuotes, config)
     } catch (e) {
       console.warn('[wzk-fund] calcHoldings failed', e)
     }
   }
   if (watchlistQuotes) {
     try {
       watchlistResult = mergeWatchlist(watchlistQuotes, config)
     } catch (e) {
       console.warn('[wzk-fund] mergeWatchlist failed', e)
     }
   }
   ```

   注意原 tasks.push 用的是 `.then((v) => ['holdings', v])` 元组形式，这里 holdings.value 是 `['holdings', quotes]`，所以 `holdings.value[1]` 是 quotes。

   修改 patch：
   ```typescript
   const patch: Record<string, any> = { [CACHE_KEYS.time]: Date.now() }
   if (holdingsResult) patch[CACHE_KEYS.holdings] = holdingsResult
   if (watchlistResult) patch[CACHE_KEYS.watchlist] = watchlistResult
   if (indices.status === 'fulfilled') patch[CACHE_KEYS.indices] = indices.value[1]
   if (market.status === 'fulfilled') patch[CACHE_KEYS.market] = market.value[1]
   if (gold.status === 'fulfilled') patch[CACHE_KEYS.gold] = gold.value[1]
   ```

5. **新增 badge 更新**（在 `chrome.storage.local.set(patch)` 之后）：

   ```typescript
   if (holdingsResult) {
     const totalPnlPct = holdingsResult.summary?.totalPnlPercent ?? 0
     const text = totalPnlPct > 0
       ? `↑${totalPnlPct.toFixed(2)}%`
       : `${totalPnlPct.toFixed(2)}%`
     chrome.action.setBadgeText({ text })
     chrome.action.setBadgeBackgroundColor({
       color: totalPnlPct >= 0 ? '#dc2626' : '#16a34a',
     })
   }
   ```

6. **保留 SYNC_CONFIG message handler**（前端 ConfigPort.saveConfig 仍会调 sendMessage SYNC_CONFIG 吗？）

   实际上 ConfigPort.saveConfig 直接写 chrome.storage.local，不再走 sendMessage。所以可删除 SYNC_CONFIG handler。但保留也无害，且兼容性更好。决定：删除 SYNC_CONFIG handler，简化代码。SW 通过 `chrome.storage.onChanged` 监听 session-config 变化自动重排 alarm：

   在 SW 顶部添加：
   ```typescript
   chrome.storage.onChanged.addListener((changes, area) => {
     if (area === 'local' && changes['session-config']) {
       const newConfig = changes['session-config'].newValue as AppConfig | undefined
       scheduleNextAlarm(newConfig)
     }
   })
   ```

   然后从 onMessage switch 中删除 `case 'SYNC_CONFIG'`。

- [ ] **Step 7: typecheck**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
pnpm install
pnpm typecheck
```

Expected: 所有 packages + apps/chrome 通过。

如有错误：
- "Cannot find module '@fund01/core'"：检查 tsconfig.json paths
- "Cannot find name 'calcHoldings'"：检查 background/index.ts 是否漏 import
- 类型不匹配：检查 DataPort 方法签名与 chromeDataPort 实现是否一致

- [ ] **Step 8: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add apps/chrome/src/ pnpm-lock.yaml
git commit -m "feat(chrome): popup + background + 三个 Port 实现"
```


---

## Task 12: 写文档（CLAUDE.md / README.md / ARCHITECTURE.md / packages READMEs）

**Files:**
- Create: `CLAUDE.md`
- Create: `README.md`
- Create: `ARCHITECTURE.md`
- Create: `packages/core/README.md`
- Create: `packages/services/README.md`
- Create: `packages/ui/README.md`

- [ ] **Step 1: 写 CLAUDE.md**

在 `/Users/lingsmbp/Documents/aiwork/fund01/CLAUDE.md` 中写以下内容（章节结构按 spec §8.1）：

```markdown
# CLAUDE.md — fund01 开发指南

你是一位精通 Chrome Extension (MV3)、TypeScript、React、pnpm workspaces、Tauri 2 的工程师。你写可维护、高性能的代码。

## 项目目标

`fund01` 是一个基金/组合盯盘工具的 monorepo，目标支持多个运行时：

- **apps/chrome**：Chrome 扩展（popup + badge 模式），MV3 Service Worker 后端定时刷新
- **apps/tauri**（未来）：Tauri 2 桌面应用（macOS menubar app），Rust 后端常驻

共享代码在 `packages/`：
- `@fund01/core`：纯业务逻辑 + 接口契约（DataPort/ConfigPort/EventPort）
- `@fund01/services`：数据请求层（原生 fetch）
- `@fund01/ui`：React 组件（无运行时耦合）

## 目录保护规则

- 严禁修改 `node_modules/`、`dist/`
- 所有修改在 `packages/`、`apps/`、根配置文件、`docs/` 中进行
- 如果需要参考原始实现，`wzk-fund` 仓库（`/Users/lingsmbp/Documents/github/wzk-fund`）的 `server/`、`web/`、`chrome/` 只读查阅

## 命令

- `pnpm install` — 安装依赖
- `pnpm dev:chrome` — 启动 Chrome 扩展开发模式（rsbuild watch）
- `pnpm build:chrome` — 构建生产版本到 `apps/chrome/dist/`
- `pnpm zip:chrome` — 打包 Chrome 扩展 zip
- `pnpm typecheck` — 全仓库 TypeScript 类型检查

## 架构总览

详见 `ARCHITECTURE.md`。要点：

1. **后端权威**：合并计算在 SW（Chrome）/ Rust（Tauri），UI 是被动视图
2. **三个 Port 接口**：UI 通过 DataPort/ConfigPort/EventPort 与具体运行时解耦
3. **源码直引**：app 通过 tsconfig paths + rsbuild alias 引用 packages 源码，无需预构建

## 三个 Port 接口

`packages/core/src/port.ts` 定义：

- **DataPort**（异步）：UI 拉取后端已合并好的数据
- **ConfigPort**（同步读 + 异步推）：配置读写，同步读避免 UI 闪烁
- **EventPort**：订阅后端推送的事件（行情更新、配置变更）

各 app 提供 Port 实现：
- `apps/chrome/src/ports/`：chromeDataPort / chromeConfigPort / chromeEventPort
- `apps/tauri/src/ports/`（未来）：基于 @tauri-apps/api invoke / listen

## 数据源迁移指南

数据源请求要点（与 wzk-fund server 端对照）：

### fund123.cn（蚂蚁基金）
- CSRF token 从 `https://www.fund123.cn/fund` 页面正则提取
- 服务层用模块级 Map 缓存（10 分钟 TTL）
- fetch 默认带 cookie（host_permissions 豁免）

### 东方财富 fundmobapi / push2
- 移动端 API，需设 MOBILE_UA
- 批量基金接口 FundMNFInfo 一次最多 200 个

### 腾讯 / 新浪
- 指数 K 线主源腾讯，备用新浪
- 新浪黄金接口 GBK 编码，用 `TextDecoder('gbk')` 原生解码

## Service Worker 定时刷新

- `chrome.alarms` 单次 `delayInMinutes` + 每次触发后重排（动态切换 trading/nonTrading 间隔）
- `Promise.allSettled` 并发拉取基金/指数/大盘/黄金
- **合并计算在 SW**：调 `@fund01/core` 的 `calcHoldings` / `mergeWatchlist`
- 结果写 `chrome.storage.local`（cache-* keys）
- 更新 badge：`chrome.action.setBadgeText` 显示总收益率

## Tauri 端规划（占位）

详见 `apps/tauri/README.md`。本次未实现 Rust 代码，仅文档说明：

- Rust 后端常驻，用 `tokio::time::interval` 定时刷新
- 通过 `app.emit` 推送事件到前端
- menubar 模式：点击托盘弹出 `WebviewWindow`（无标题栏、skip_taskbar）
- 配置存储用 Tauri store plugin 或文件
- 托盘徽章需动态生成图标 PNG

## Pitfalls

- **MV3 SW 生命周期**：空闲 30 秒休眠，所有模块级状态丢失（含 CSRF 缓存）。alarm 唤醒后重新获取可接受
- **CSRF 内存 Map**：services/fund.ts 用模块级 Map，SW 重启时丢失，会多请求一次 fund123.cn
- **CSP 限制**：MV3 不允许 eval、内联脚本，所有库通过打包引入
- **localStorage 跨窗口**：每个 popup 实例独立 localStorage，跨窗口同步需用 `window.addEventListener('storage', ...)`
- **pnpm workspaces**：修改 packages 后无需 rebuild，rsbuild 直接打包源码
- **rsbuild alias**：tsconfig paths 不被 rsbuild 识别，需在 rsbuild.config.ts 中重复配置 resolve.alias
- **TypeScript strict**：所有 undefined 值用 nullish coalescing 处理
- **fetch 与 cookie**：扩展有 host_permissions 时 fetch 默认带 cookie，遇到 403 加 `credentials: 'include'`
- **GBK 解码**：仅新浪黄金接口需要，用 `TextDecoder('gbk')`，不引入 iconv-lite
```

- [ ] **Step 2: 写 README.md**

```markdown
# fund01

基金/组合盯盘工具，支持 Chrome 扩展和未来 Tauri 桌面应用。

## 状态

- ✅ Chrome 扩展：可用（popup + badge 模式）
- 🚧 Tauri 桌面应用：占位，仅文档

## 快速开始

```bash
pnpm install
pnpm dev:chrome        # 开发模式（rsbuild watch）
pnpm build:chrome      # 构建到 apps/chrome/dist/
pnpm zip:chrome        # 打包 zip
pnpm typecheck         # 全仓库类型检查
```

加载扩展：Chrome 打开 `chrome://extensions` → 开启开发者模式 → 加载 `apps/chrome/dist/`。

## 目录结构

```
fund01/
├── packages/
│   ├── core/       @fund01/core    纯逻辑 + 接口契约
│   ├── services/   @fund01/services 数据请求层（fetch）
│   └── ui/         @fund01/ui      React 组件
├── apps/
│   ├── chrome/     Chrome 扩展
│   └── tauri/      Tauri 应用（占位）
└── docs/superpowers/  设计文档与实施计划
```

## 文档

- [CLAUDE.md](./CLAUDE.md) — 开发指南
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构设计
- [设计 spec](./docs/superpowers/specs/2026-07-30-monorepo-refactor-design.md)
- [实施计划](./docs/superpowers/plans/2026-07-30-monorepo-refactor.md)

## 技术栈

TypeScript 6 / React 19 / pnpm / Rsbuild 2 / Tailwind v4 / chrome MV3 / @fund01/* workspace packages
```

- [ ] **Step 3: 写 ARCHITECTURE.md**

参考 spec §2-§3 内容，写详细的架构文档。包含：

1. **三个 Port 接口的设计动机**
   - DataPort：异步拉取，UI 首次打开不闪
   - ConfigPort：同步读避免闪烁，异步推后端
   - EventPort：统一 Chrome onChanged 和 Tauri listen
2. **数据流图**（后端权威 + 事件推送）
3. **Chrome vs Tauri 行为对照表**（spec §2.3）
4. **后端权威架构的决策原因**：menubar 无 UI 也能工作；多窗口复用；badge 依赖后端独立计算
5. **为什么不抽象 HttpClient**：fetch 跨 JS 运行时通用；Rust 后端独立实现
6. **为什么不抽象 badge**：Chrome 与 Tauri 机制差异大
7. **未来 Tauri 实现路径**：Rust 重写 vs JS sidecar，决策延后

直接从 spec 的对应章节复制并扩展。

- [ ] **Step 4: 写 packages/core/README.md**

```markdown
# @fund01/core

纯业务逻辑 + 接口契约。零运行时依赖（除 tailwind-merge / clsx 用于 utils.ts 的 cn 函数）。

## 职责

- 类型定义（types.ts）：FundRecord / AppConfig / HoldingsPayload 等
- Port 接口（port.ts）：DataPort / ConfigPort / EventPort / Ports
- 持仓收益计算（holdingsCalc.ts）：calcHoldings / mergeWatchlist / truncPnl2
- 交易日判断（tradingCalendar.ts）：nextTradingDay / isTradingDayStarted / shouldRefresh*
- 配置归一化（portfolioLogic.ts）：normalizeConfig / DEFAULT_CONFIG
- 工具函数（utils.ts）：cn / formatPct / formatMoney

## 依赖关系

- 不依赖任何 @fund01/* 包
- 被所有 packages/* 和 apps/* 依赖

## 导出

```typescript
import { 
  type DataPort, type ConfigPort, type EventPort, type Ports,
  type AppConfig, type FundRecord, type HoldingsPayload,
  calcHoldings, mergeWatchlist,
  normalizeConfig, DEFAULT_CONFIG,
  nextTradingDay, isTradingDayStarted,
  cn, formatPct, formatMoney
} from '@fund01/core'
```
```

- [ ] **Step 5: 写 packages/services/README.md**

```markdown
# @fund01/services

数据请求层，基于原生 fetch。零 Chrome/tauri 耦合。

## 职责

- 通用 HTTP（http.ts）：httpGet / httpPost + 超时控制
- 基金数据（fund.ts）：fund123 + 东方财富
- 黄金数据（gold.ts）：AU9999（东方财富主源 + 新浪备用）
- 指数大盘（market.ts）：东方财富 + 腾讯 + 新浪

## 依赖

- `@fund01/core`（types 和 tradingCalendar）

## 导出

```typescript
import { 
  httpGet, httpPost,
  getFundsQuotes, getFundHistory, resolveFund,
  getGoldRealtime,
  getIndices, getMarketOverview, getIndexHistory
} from '@fund01/services'
```

## 数据源

- fund123.cn：CSRF token 从页面正则提取，模块级 Map 缓存
- fundmobapi.eastmoney.com：东方财富移动端 API
- push2.eastmoney.com：指数 + 黄金
- web.ifzq.gtimg.cn：腾讯指数 K 线
- hq.sinajs.cn：新浪黄金（GBK 编码）

## Pitfalls

- CSRF 缓存用模块级 Map，SW 重启时丢失（多请求一次 fund123.cn，可接受）
- 新浪黄金需 `TextDecoder('gbk')` 解码，不引入 iconv-lite
```

- [ ] **Step 6: 写 packages/ui/README.md**

```markdown
# @fund01/ui

React 组件库，无运行时耦合。通过 PortsContext 接受 Port 实现。

## 职责

- App.tsx：主界面
- components/：HoldingsModule / WatchlistModule / MarketModules / 各种 Dialog
- hooks.ts：useMarketData（订阅 EventPort + 首次拉 DataPort）
- context.ts：PortsContext + usePorts
- theme.ts / index.css：主题 + Tailwind

## 依赖

- `@fund01/core`（types + Port 接口）
- React 19 + Radix UI + echarts + lucide-react

## 使用

app 必须用 PortsContext.Provider 注入 Ports：

```tsx
import { PortsContext, App } from '@fund01/ui'
import type { Ports } from '@fund01/core'

const ports: Ports = { data, config, event }

<PortsContext.Provider value={ports}>
  <App version="1.0.0" />
</PortsContext.Provider>
```

## 组件清单

- HoldingsModule：持仓列表
- WatchlistModule：自选列表
- MarketModules：指数 + 大盘 + 涨跌统计
- FundDetailDialog：基金详情（点击持仓弹窗）
- FundTrendDialog：盘中估值走势
- IndexTrendDialog：指数 K 线
- GoldHoldingsRow：黄金持仓行
- FundFormDialog：基金添加/编辑
- ConfigDialog：设置
- BatchEditHoldingsDialog：批量编辑持仓
- ImportHoldingsDialog：导入持仓
- SparkTrend：迷你走势图
- ui/：shadcn 基础组件
```

- [ ] **Step 7: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add CLAUDE.md README.md ARCHITECTURE.md packages/*/README.md
git commit -m "docs: CLAUDE/README/ARCHITECTURE + packages README"
```

---

## Task 13: 写 apps/tauri/README.md（占位文档）

**Files:**
- Create: `apps/tauri/README.md`

- [ ] **Step 1: 写 apps/tauri/README.md**

写完整占位文档，包含 spec §7 的全部内容：

1. 说明本目录是占位
2. 未来如何创建 Tauri 项目（`pnpm create tauri-app`）
3. Tauri 2 menubar app 真实架构（tray-icon feature）
4. 自定义 popup 窗口的实现要点
5. 后端定时任务（tokio::interval）
6. 事件推送（app.emit + listen）
7. 托盘徽章差异（动态图标）
8. Rust 后端需要实现的命令清单（对应 DataPort 10 个方法）
9. 事件清单（quote-update / config-change）
10. 配置存储（Tauri store plugin）
11. 主窗口 vs menubar popup（多 WebviewWindow）
12. 未来实现路径决策（Rust 重写 vs JS sidecar）

直接从 spec §7 复制并扩展为更详细的实现指引。

- [ ] **Step 2: 提交**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add apps/tauri/README.md
git commit -m "docs(tauri): 占位 README，说明未来实现路径"
```

---

## Task 14: 构建验证 + Chrome 加载测试

**Files:** 无（验证步骤）

- [ ] **Step 1: 完整 typecheck**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
pnpm install
pnpm typecheck
```

Expected: 所有 packages + apps/chrome 通过，无错误。

如有错误，回到对应 Task 修复。

- [ ] **Step 2: 构建 Chrome 扩展**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
pnpm build:chrome
```

Expected: 产出 `apps/chrome/dist/` 包含：
- `background.js`
- `popup.js`
- `popup.html`
- `manifest.json`
- `icons/` 目录

如有错误，检查：
- rsbuild.config.ts 的 resolve.alias 是否正确
- HTML 模板路径
- chunkSplit 配置

- [ ] **Step 3: 加载到 Chrome 验证**

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `apps/chrome/dist/`
5. 确认无报错

验证清单：
- [ ] 扩展图标出现在工具栏
- [ ] badge 文字显示（如「↑0.8%」或「0.00%」）
- [ ] 点击图标弹出 popup
- [ ] popup 显示持仓列表、自选、指数、大盘、黄金
- [ ] 修改配置后 popup 关闭重开仍保留
- [ ] 等待 30 秒后 popup 数据自动刷新
- [ ] FundTrendDialog 走势图正常
- [ ] FundDetailDialog 详情弹窗正常
- [ ] 网络异常时各数据源 fallback 正常

- [ ] **Step 4: 打包 zip 验证**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
pnpm zip:chrome
```

Expected: 产出 `apps/chrome/dist/newtab01-1.0.18.zip` 或类似文件。

- [ ] **Step 5: 提交构建配置调整（如有）**

如果前几步有 fix，提交：

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git add -A
git commit -m "fix: 构建验证修复"
```

如果没有需要 fix，跳过本步骤。

---

## Task 15: 最终验证 + 完成

**Files:** 无（最终验证）

- [ ] **Step 1: 验证 spec 验收标准**

对照 spec §10 的 10 项验收标准逐一检查：

1. [ ] `fund01/` 目录结构按本设计建立
2. [ ] `pnpm install` 无错误
3. [ ] `pnpm typecheck` 通过
4. [ ] `pnpm build:chrome` 产出 `apps/chrome/dist/` 包含 background.js 和 popup.js
5. [ ] `apps/chrome/dist/` 可加载到 Chrome，popup 显示完整 UI
6. [ ] SW 定时刷新，badge 文字更新
7. [ ] 配置修改后 popup 关闭重开仍保留
8. [ ] `apps/tauri/README.md` 文档完整
9. [ ] CLAUDE.md / README.md / ARCHITECTURE.md / packages/*/README.md 文档齐全
10. [ ] 原 `wzk-fund/server/` 和 `wzk-fund/web/` 未被修改（验证 git status）

- [ ] **Step 2: 验证原 wzk-fund 未被修改**

```bash
cd /Users/lingsmbp/Documents/github/wzk-fund
git status
```

Expected: 无 modified（除了之前已提交的 chrome/ 改动）。

- [ ] **Step 3: 最终提交（如有未提交文件）**

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01
git status
git add -A
git commit -m "chore: 重构完成"
```

- [ ] **Step 4: 完成**

重构完成。`fund01/` 现在是一个可独立运行的 monorepo，包含：
- 3 个独立 package（core / services / ui）
- 1 个可用的 Chrome 扩展 app（popup + badge 模式）
- 1 个 Tauri 占位文档
- 完整的文档体系（CLAUDE.md / README.md / ARCHITECTURE.md / packages READMEs）

后续可基于 `apps/tauri/README.md` 的指引开始 Tauri 实现。

