# @fund01/core

纯业务逻辑 + 接口契约。是整个 monorepo 的基石，被所有 `packages/*` 和 `apps/*` 依赖。

## 职责

| 文件 | 内容 |
|---|---|
| `types.ts` | 共享类型定义：`FundRecord` / `AppConfig` / `HoldingsPayload` / `WatchlistPayload` / `IndexItem` / `MarketOverview` / `GoldPayload` / `QuoteUpdate` / `ResolveFundPayload` / `IntradayPoint` 等 |
| `port.ts` | 三个 Port 接口：`DataPort` / `ConfigPort` / `EventPort` / `Ports` |
| `holdingsCalc.ts` | 持仓收益计算：`calcHoldings` / `mergeWatchlist` / `truncPnl2` / `resolveNavPair` |
| `tradingCalendar.ts` | 交易日判断：`nextTradingDay` / `isTradingDayStarted` / `isAnyMarketActive` / `shouldRefreshFund` / `shouldRefreshAShareMarket` / `shouldRefreshGold` / `isConfirmedSessionActive` |
| `portfolioLogic.ts` | 配置归一化纯逻辑：`normalizeConfig` / `normalizeFund` / `normalizeFundMap` / `clampRefreshInterval` / `DEFAULT_CONFIG` / `DEFAULT_REFRESH_INTERVAL` / `MIN_REFRESH_INTERVAL` |
| `utils.ts` | 工具函数：`cn`（clsx + tailwind-merge）/ `formatPct` / `formatMoney` / `fmtDate` 等 |
| `index.ts` | 统一导出（`export *`） |

## 依赖关系

- **不依赖**任何 `@fund01/*` 包
- 运行时依赖仅 `tailwind-merge` + `clsx`（用于 `utils.ts` 的 `cn()` 函数）
- 被所有其他包依赖

## 导出 API

```typescript
import {
  // 接口契约
  type DataPort, type ConfigPort, type EventPort, type Ports,
  // 类型
  type AppConfig, type FundRecord, type HoldingsPayload,
  type WatchlistPayload, type IndexItem, type MarketOverview,
  type GoldPayload, type QuoteUpdate, type ResolveFundPayload,
  // 持仓计算
  calcHoldings, mergeWatchlist, truncPnl2,
  // 交易日
  nextTradingDay, isTradingDayStarted, isAnyMarketActive,
  shouldRefreshFund, shouldRefreshAShareMarket, shouldRefreshGold,
  isConfirmedSessionActive,
  // 配置归一化
  normalizeConfig, normalizeFund, clampRefreshInterval,
  DEFAULT_CONFIG, DEFAULT_REFRESH_INTERVAL,
  // 工具
  cn, formatPct, formatMoney, fmtDate,
} from '@fund01/core'
```

## 使用示例

### 在 SW（后端）中做合并计算

```typescript
import { calcHoldings, mergeWatchlist } from '@fund01/core'

const holdingsResult = calcHoldings(holdFunds, holdingsQuotes)
const watchlistResult = mergeWatchlist(watchFunds, watchlistQuotes)
// holdingsResult.summary.totalPnlPercent 可用于 badge
```

### 在 UI 中归一化用户配置

```typescript
import { normalizeConfig, DEFAULT_CONFIG } from '@fund01/core'

const config = normalizeConfig(userInput)  // 补全缺失字段、归一化基金记录
```

### 实现自己的 Port

```typescript
import type { DataPort, HoldingsPayload } from '@fund01/core'

class MyDataPort implements DataPort {
  async fetchHoldings(): Promise<HoldingsPayload> {
    // 你的实现
  }
  // ... 其他方法
}
```

## 构建

本包**不单独构建**。源码通过 tsconfig `paths` + rsbuild `resolve.alias` 被 app 直接引用。`tsconfig.json` 中保留 `rootDir` / `outDir` 仅供 `tsc --noEmit` 类型检查使用。

## 设计说明

- `portfolioLogic.ts` 是从原 `wzk-fund/chrome/src/lib/portfolioStore.ts` 提取的**纯函数部分**（`normalizeConfig` 等），不包含任何 `localStorage` / `chrome.storage` 操作。读写存储的逻辑在各 app 的 `ConfigPort` 实现中
- `holdingsCalc.ts` 的 `truncPnl2` 函数实现截断式收益计算（与支付宝一致），是核心业务规则，迁移时保持完全一致
- `tradingCalendar.ts` 的 `isConfirmedSessionActive` 原本在 `services/fund.ts` 内部重复实现，已统一迁移到此文件
