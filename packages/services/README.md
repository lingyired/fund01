# @fund01/services

数据请求层，基于原生 `fetch`。零 Chrome / Tauri 耦合，可在任何 JS 运行时（popup / Service Worker / Tauri webview / Node）中使用。

## 职责

| 文件 | 内容 |
|---|---|
| `http.ts` | 通用 HTTP 封装：`httpGet` / `httpPost` + 超时控制（`AbortController`）+ `UA` / `MOBILE_UA` / `DEFAULT_HEADERS` / `fmtDate` 常量 |
| `fund.ts` | 基金数据：`getFundsQuotes` / `getFundHistory` / `resolveFund` / `searchFund` / `getFundMatiaria` / `fetchFundSectors` / `fetchFundEstimateIntraday` / `fetchFundIntradayForDialog` |
| `gold.ts` | 黄金 AU9999：`getGoldRealtime` / `fetchGoldTrend`（东方财富主源 + 新浪备用 + jijinhao 走势备用） |
| `market.ts` | 指数大盘：`getIndices` / `getMarketOverview` / `getIndexHistory`（东方财富 + 腾讯 + 新浪多源） |
| `index.ts` | 统一导出 |

## 依赖

- `@fund01/core`（types 和 `tradingCalendar` 的 `nextTradingDay` / `isConfirmedSessionActive`）
- 无其他 `@fund01/*` 依赖

## 导出 API

```typescript
import {
  // HTTP
  httpGet, httpPost, UA, MOBILE_UA, fmtDate,
  // 基金
  getFundsQuotes, getFundHistory, resolveFund, searchFund,
  getFundMatiaria, fetchFundSectors, fetchFundEstimateIntraday,
  // 黄金
  getGoldRealtime, fetchGoldTrend,
  // 指数大盘
  getIndices, getMarketOverview, getIndexHistory,
} from '@fund01/services'
```

## 数据源

| 数据源 | 用途 | 要点 |
|---|---|---|
| `www.fund123.cn` | 基金搜索 / 实时估值走势 / CSRF | 蚂蚁基金（非天天基金）；CSRF token 从页面正则提取，模块级 Map 缓存（10 分钟 TTL）；POST 需带 `X-API-Key: foobar` |
| `fundmobapi.eastmoney.com` | 基金净值历史 / 基金信息 / 持仓 | 东方财富移动端 API，需 `MOBILE_UA`；批量接口 `FundMNFInfo` 一次最多 200 个 |
| `push2delay.eastmoney.com` | 指数实时 / 黄金实时 / 板块排行 | 公共参数 `ut=fa5fd1943c7b386f172d6893dbbd4dc`；备用 `push2.eastmoney.com` / `82.push2.eastmoney.com` |
| `emdatah5.eastmoney.com` | 涨跌家数 | H5 数据接口 |
| `web.ifzq.gtimg.cn` | 指数日 K 线（主源） | 腾讯，支持 A 股 + 美股 |
| `money.finance.sina.com.cn` | 指数日 K 线（备用，北证 50 等） | 新浪 |
| `stock.finance.sina.com.cn` | 美股指数日 K 线（备用） | 新浪 US |
| `hq.sinajs.cn` | 黄金实时（备用） | **GBK 编码**，用 `TextDecoder('gbk')` 解码 |
| `api.jijinhao.com` | 黄金分钟走势（备用） | 基金好 |

## 使用示例

```typescript
import { getFundsQuotes, getIndices, getGoldRealtime } from '@fund01/services'

// 批量拉基金行情
const quotes = await getFundsQuotes(holdFunds, 'fund123')

// 拉指数
const indices = await getIndices()

// 拉黄金
const gold = await getGoldRealtime({ holding: 100, avgPrice: 450 })
```

## Pitfalls

- **CSRF 缓存用模块级 Map**：`fund.ts` 顶部 `const csrfCache = new Map<string, { token: string; expiresAt: number }>()`。MV3 SW 重启时丢失，会多请求一次 `fund123.cn/fund` 抓 HTML 提取 token——可接受。Tauri 后端常驻，自然保留
- **新浪黄金 GBK 解码**：`fetchSinaGold` 用 `responseType: 'arraybuffer'` + `new TextDecoder('gbk').decode(buf)`，**不要**引入 `iconv-lite`
- **fetch 与 cookie**：扩展有 `host_permissions` 时 fetch 默认带 cookie；如 fund123 返回 403，尝试加 `credentials: 'include'`
- **并发控制**：批量基金请求保持 4 路并发（`Promise.allSettled` 分 chunk），避免触发数据源限流
- **多源 fallback**：黄金和指数都有主源 + 备用源，主源超时（8 秒）后自动切换备用源
- **User-Agent 设置**：fund123、东方财富校验 UA。扩展 fetch 可直接在 headers 里设置 `User-Agent`（MV3 允许）

## 设计说明

- 原 `wzk-fund/chrome/src/services/http.ts` 的 `cookieHeader` 函数未使用，已删除
- 原 `fund.ts` 内部重复定义的 `nextTradingDay` / `isConfirmedSessionActive` 已删除，改为 `import { nextTradingDay, isConfirmedSessionActive } from '@fund01/core'`
- 本包不抽象 `HttpClient` 接口（见 `ARCHITECTURE.md` §6），直接用原生 `fetch`
