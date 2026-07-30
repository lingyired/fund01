# @fund01/ui

React 组件库，无运行时耦合。通过 `PortsContext` 接受 `DataPort` / `ConfigPort` / `EventPort` 三个 Port 实现，不直接调用 `chrome.*` 或 `@tauri-apps/api`。

## 职责

| 文件 / 目录 | 内容 |
|---|---|
| `App.tsx` | 主界面：持仓 + 自选 + 指数 + 大盘 + 黄金，含主题切换、版本号显示 |
| `context.ts` | `PortsContext` + `usePorts()` hook |
| `hooks.ts` | `useMarketData()`：订阅 `EventPort.onQuoteUpdate` + 首次拉 `DataPort` |
| `theme.ts` | 主题（亮 / 暗）切换与持久化 |
| `index.css` | Tailwind v4 入口 + 全局样式 |
| `lib/fundOps.ts` | 配置操作封装（见下文） |
| `components/` | 业务组件（见组件清单） |
| `components/ui/` | shadcn 基础组件（button / dialog / input / label / panel / switch） |
| `env.d.ts` | `declare module '*.css'` |

## 依赖

- `@fund01/core`（types + Port 接口 + `normalizeConfig` / `DEFAULT_CONFIG` / `clampRefreshInterval` 等纯逻辑）
- React 19 + Radix UI + echarts + echarts-for-react + lucide-react + tailwind-merge + clsx + class-variance-authority

## 使用方式

app 必须用 `PortsContext.Provider` 注入 Ports：

```tsx
import { PortsContext, App } from '@fund01/ui'
import type { Ports } from '@fund01/core'
import { ChromeDataPort } from './ports/chromeDataPort'
import { ChromeConfigPort } from './ports/chromeConfigPort'
import { ChromeEventPort } from './ports/chromeEventPort'

const ports: Ports = {
  data: new ChromeDataPort(),
  config: new ChromeConfigPort(),
  event: new ChromeEventPort(),
}

const version = chrome.runtime.getManifest().version

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PortsContext.Provider value={ports}>
      <App version={version} />
    </PortsContext.Provider>
  </React.StrictMode>,
)
```

组件内通过 `usePorts()` 获取 Ports：

```tsx
import { usePorts } from '../context'
import { useMarketData } from '../hooks'

function MyComponent() {
  const { data, config, event } = usePorts()
  const { holdings, watchlist, indices, market, gold, lastUpdate, loading, refresh } = useMarketData()
  // ...
}
```

## `lib/fundOps.ts`（重要）

封装原 `lib/api.ts` + `lib/portfolioStore.ts` 中的组合操作，以 `Ports` 为参数，保持运行时解耦。封装了：

- `createFund(ports, payload)` — 录入基金（含金额反推份额、成本反推）
- `updateFund(ports, code, payload, type)` — 更新基金
- `removeFund(ports, code, type)` — 删除基金
- `updateGoldConfig(ports, payload)` — 更新黄金配置
- `fetchSettings(ports)` / `updateSettings(ports, patch)` — 设置读写
- `listFunds(ports, type?)` / `listHoldingGroups(ports)` — 查询
- `addHoldingGroup` / `removeHoldingGroup` / `removeHoldingGroupWithFunds` / `renameHoldingGroup` — 分组管理
- `getHoldingGroupOrder` / `setHoldingGroupOrder` — 分组内排序
- `setFundAllocation(ports, code, group, shares, cost?)` — 直接设置份额与成本（批量编辑用）
- `exportConfig(ports)` / `importConfig(ports, payload)` — 配置导入导出

这些函数内部调 `config.getConfig()` 读当前配置，修改后调 `config.saveConfig(next)` 推后端。Tauri 端可同样复用（传入 Tauri 版 Port 实现即可）。

```tsx
import { createFund } from '../lib/fundOps'

const handleCreate = async () => {
  await createFund({ data, config }, {
    code: '025687',
    amount: 1000,
    amountBasis: 'prev',
    group: '默认',
    type: 'hold',
  })
}
```

## 组件清单

| 组件 | 职责 |
|---|---|
| `HoldingsModule` | 持仓列表（按分组展示，含收益率、市值） |
| `WatchlistModule` | 自选列表 |
| `MarketModules` | 指数 + 大盘 + 涨跌统计 |
| `GoldHoldingsRow` | 黄金持仓行 |
| `FundDetailDialog` | 基金详情弹窗（点击持仓弹窗） |
| `FundTrendDialog` | 盘中估值走势图（echarts） |
| `IndexTrendDialog` | 指数 K 线图（echarts） |
| `FundFormDialog` | 基金添加 / 编辑表单 |
| `ConfigDialog` | 设置弹窗 |
| `BatchEditHoldingsDialog` | 批量编辑持仓 |
| `ImportHoldingsDialog` | 导入持仓 |
| `SparkTrend` | 迷你走势图（echarts） |
| `ui/button` `ui/dialog` `ui/input` `ui/label` `ui/panel` `ui/switch` | shadcn 基础组件 |

## 设计说明

- 组件**不直接调** `chrome.*`，所有运行时能力通过 `usePorts()` 获取
- 组件**不直接调** `@fund01/services`，数据访问走 `DataPort`（`fetchHoldings` 等）
- 配置修改走 `lib/fundOps.ts` 的封装函数，不散落在各组件中
- 行情数据通过 `useMarketData()` hook 订阅，首次拉缓存 + 后续增量更新
- 主题（亮 / 暗）通过 `theme.ts` 管理，持久化到 `localStorage`（主题不属于业务配置，独立存储）
