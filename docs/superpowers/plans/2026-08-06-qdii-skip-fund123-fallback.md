# QDII 自算估值失败时跳过 fund123 fallback — 实施记录

> **Goal:** QDII 基金在 FundMNFInfo 数据源自算估值失败后，不再 fallback fund123 分时估值，保持 FundMNFInfo 原始估值口径（盘中 GSZ 正确；空窗期如实无估值，等 T+1 净值确认）。

## 背景（调查结论，2026-08-06 晚间实测）

对用户持仓 6 只 QDII（005698 / 012922 / 016532 / 022184 / 040046 / 100050）实测：

| 数据路径 | QDII 实测结果 |
|---|---|
| FundMNFInfo（东财批量，移动 UA） | GSZ/GSZZL/GZTIME 全 null，仅返回 T+1 确认净值（PDATE/NAV/NAVCHGRT） |
| FundMNInverstPosition（重仓股） | `fundStocks` 全空 → 自算估值结构性失败（东财不覆盖 QDII 海外持仓） |
| fund123 queryFundEstimateIntraday | **0 个分时点**（黄金对照组 008987 有 242 点；换宽窗口 08-05~08-07 仍 0 点） |
| fund123 matiaria | `dayOfGrowth=-0.78%` + `netValueDate=08-05` → **把 T+1 披露的昨日涨幅冒充今日涨幅** |

**结论：**
- QDII 净值 T+1 披露（8/6 的涨幅 8/7 才出），fund123 对 QDII **无任何分时估值**（美股非交易时段实测 0 点），fallback 必然失败且其资料接口存在「昨日涨幅冒充今日」的误导风险。
- QDII 的可靠估值只来自 FundMNFInfo 链路：A 股盘中 GSZ 正常；收盘后如实无当日收益（行业惯例，等 T+1 净值确认）。
- 用户决策：针对 QDII 的 fallback 使用 FundMNFInfo 这条路（即不引入 fund123）。

## 实现

- [x] **Tauri** `apps/tauri/src-tauri/src/providers/fundmnfinfo.rs`
  - 新增 `is_qdii_name()`（名称含 "QDII"，证监会命名规范，半角/全角括号兼容）
  - `fetch_one` 自算失败分支：`is_qdii_name(&name)` → 跳过 `fund123_estimate_fallback`，打 eprintln 日志
- [x] **Chrome** `packages/services/src/fund.ts`（tauri 前端共用）
  - 新增 `isQdiiName()`（/QDII/i）
  - `fetchOne` 自算失败分支：`isQdiiName(name)` → 跳过 `fund123EstimateFallback`，打 console.warn

## 验证

- [x] `pnpm -r typecheck` 全绿
- [x] `cargo check` 0 警告（fund01-tauri v1.0.7）

## 行为影响

- 非 QDII 基金（含黄金 008987 / 商品等）：**不受影响**，保持「自算失败 → fund123 fallback」现状
- QDII（名称含 QDII）：自算失败后不再发起 fund123 请求（省 searchFund + CSRF + POST），估值口径统一为 FundMNFInfo

## 已知遗留（未在本分支处理）

- **fund123 数据源**（quoteSource=fund123 的 `getFundQuote` / `get_fund_quote`）：QDII 的 percent 会把 T+1 披露的昨日 dayOfGrowth 冒充今日涨幅显示（`resolveDisplayPercent` 对 QDII 净值的确认会话判断）。用户当前用 FundMNFInfo 源不受影响，是否修另行确认。

## 提交

- `7d8366a` feat(tauri): QDII 自算失败跳过 fund123 fallback
- `1fb9e10` feat(chrome): QDII 自算失败跳过 fund123 fallback

分支：`feat/qdii-mnfinfo-estimate`（基线 f5480e0，main）
