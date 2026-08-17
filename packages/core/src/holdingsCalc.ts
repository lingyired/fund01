import type {FundQuoteRow, FundRecord, HoldingsPayload} from './types'
import {
  shouldShowConfirmedUpdatedBadge,
  normalizeNetValueDate,
} from './tradingCalendar'

function round2(n: number) {
  return Math.round(Number(n) * 100) / 100
}

/** 收益取分：与支付宝一致，舍去厘（向 0 截断），不用四舍五入 */
export function truncPnl2(n: number) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return (x >= 0 ? Math.floor(x * 100) : Math.ceil(x * 100)) / 100
}

export type QuoteLike = {
  code: string
  name?: string
  fundKey?: string
  percent?: number | null
  percentSource?: 'estimate' | 'confirmed' | null
  estimateGrowth?: number | null
  dayGrowth?: number | null
  netValueDate?: string
  netValue?: number | null
  estimateNetValue?: number | null
  prevNetValue?: number | null
  time?: string | null
  trend?: {time: string; growth: number | null; netValue?: number | null}[]
  sectors?: string[]
  isQdii?: boolean
}

/** 从估值分时末点取净值（比涨幅更精确） */
function latestEstimateNav(quote: QuoteLike): number | null {
  if (quote.estimateNetValue != null && quote.estimateNetValue > 0) {
    return quote.estimateNetValue
  }
  const trend = quote.trend || []
  for (let i = trend.length - 1; i >= 0; i--) {
    const nv = trend[i]?.netValue
    if (nv != null && nv > 0) return nv
  }
  return null
}

/**
 * 解析昨净值 / 今净值。
 * 金钱一律用净值差；涨幅只用于展示，禁止用涨幅反推净值。
 *
 * - 确认会话 → 昨/今均为披露净值
 * - 有估值净值 → 昨=上一确认，今=估值（盘中实时）
 * - 否则有披露净值对 → QDII 等延迟净值仍按披露差计算
 */
export function resolveNavPair(quote: QuoteLike): {
  prevNav: number | null
  currNav: number | null
} {
  const confirmedNav = quote.netValue != null && quote.netValue > 0 ? quote.netValue : null
  const prev =
    quote.prevNetValue != null && quote.prevNetValue > 0 ? quote.prevNetValue : null
  const estimateNav = latestEstimateNav(quote)

  let result: {prevNav: number | null; currNav: number | null}
  if (quote.percentSource === 'confirmed' && confirmedNav != null && prev != null) {
    result = {prevNav: prev, currNav: confirmedNav}
  } else if (estimateNav != null) {
    result = {prevNav: prev ?? confirmedNav, currNav: estimateNav}
  } else if (confirmedNav != null && prev != null) {
    result = {prevNav: prev, currNav: confirmedNav}
  } else {
    // 兜底：仅有确认净值（无昨净值/无盘中估值）时，用确认净值作为市值基准。
    // 场景：QDII 延迟净值、黄金 ETF 联接等无 GSZ/无重仓股可自算估值的基金，
    // 此时 prev 为 null → 当日收益算不出（pnl=0），但持仓金额 = 份额 × NAV 必须能显示。
    result = {prevNav: null, currNav: confirmedNav}
  }
  return result
}

/**
 * 持仓合并计算。
 *
 * `opts.excludedGroups`：不纳入总览的分组名列表（'' 表示未分组）。这些分组的持仓份额
 * 从总览汇总（summary）中剔除，但行（list）保持全量 —— 分组 Tab / 全部 Tab 仍可浏览。
 * 无该参数或空数组 = 全部分组纳入总览（默认）。与 Rust `calc_holdings` 1:1 对齐。
 */
export function calcHoldings(
  localFunds: FundRecord[],
  quotes: QuoteLike[],
  opts?: {excludedGroups?: string[]},
): HoldingsPayload & {
  persistPatches: Array<{
    code: string
    sectors?: string[]
  }>
} {
  const excluded = new Set(opts?.excludedGroups ?? [])
  const quoteMap = new Map(quotes.map((q) => [q.code, q]))
  const rows: FundQuoteRow[] = []
  const persistPatches: Array<{
    code: string
    sectors?: string[]
  }> = []
  let totalAmount = 0
  let totalPnl = 0
  let totalCost = 0
  let totalCumPnl = 0
  let bodTotal = 0
  let hasAnyCost = false

  for (const raw of localFunds) {
    const q = quoteMap.get(raw.code) || ({} as QuoteLike)
    // percent 只认 provider 的展示口径（confirmed/estimate/兜底已由 provider 决定）。
    // ⚠️ 不回退到 q.dayGrowth：QDII 未披露日 provider 有意给 percent=null（当日收益
    // 显示「-」），回退 dayGrowth 会把东财 hist 滞后净值日涨幅冒充「当日」（fund123 源
    // 实测 005698 被回退成 +0.90% 的根因，2026-08-07）。
    const percent = q.percent ?? q.estimateGrowth ?? null
    const {prevNav, currNav} = resolveNavPair(q)

    const navDay = normalizeNetValueDate(q.netValueDate)
    // 总份额 = 各分组 allocation 之和（兼容旧版 shares 字段）
    const allocations = raw.allocations || {}
    const shares =
      Object.keys(allocations).length > 0
        ? Object.values(allocations).reduce((a, b) => a + (Number(b) || 0), 0)
        : Number(raw.shares) || 0

    // 成本单价按分组存储：总成本 = Σ(单价[g] × 份额[g])；无 costs 则为 0（未录入）
    const costs = raw.costs || {}
    let totalCostRow = 0
    for (const g of Object.keys(costs)) {
      const price = Number(costs[g]) || 0
      const sh = Number(allocations[g]) || 0
      if (price > 0 && sh > 0) totalCostRow += price * sh
    }
    totalCostRow = round2(totalCostRow)
    const hasCost = totalCostRow > 0

    // 总览口径：仅统计非排除分组的份额/成本（被排除分组不纳入总览汇总，但行数据保持全量）
    const overviewShares = excluded.size
      ? Object.entries(allocations)
          .filter(([g]) => !excluded.has(g))
          .reduce((a, [, s]) => a + (Number(s) || 0), 0)
      : shares
    const overviewRatio = shares > 0 ? overviewShares / shares : 0
    let overviewCostRow = totalCostRow
    if (excluded.size) {
      overviewCostRow = 0
      for (const g of Object.keys(costs)) {
        if (excluded.has(g)) continue
        const price = Number(costs[g]) || 0
        const sh = Number(allocations[g]) || 0
        if (price > 0 && sh > 0) overviewCostRow += price * sh
      }
      overviewCostRow = round2(overviewCostRow)
    }
    const overviewHasCost = overviewCostRow > 0

    const usingEstimate =
      q.percentSource === 'estimate' ||
      (q.percentSource !== 'confirmed' && latestEstimateNav(q) != null)

    let pnl: number | null = null
    if (shares > 0 && prevNav != null && currNav != null) {
      pnl = truncPnl2(shares * (currNav - prevNav))
    }
    // percent 为空（QDII 未披露日/新基金等）→ 当日收益无展示意义，pnl 置 null
    // （UI 渲染「-」、分组聚合跳过），避免滞后净值差被计入「当日」（fund123 源
    // 005698 曾把 08-05 净值差 +161.53 算进当日收益，2026-08-07）
    if (percent == null) pnl = null

    // 展示用市值实时计算：估值期看最新确认净值；确认期看当日确认净值。
    let displayAmount = 0
    if (shares > 0) {
      if (usingEstimate && prevNav != null) {
        displayAmount = round2(shares * prevNav)
      } else if (currNav != null) {
        displayAmount = round2(shares * currNav)
      } else if (prevNav != null) {
        displayAmount = round2(shares * prevNav)
      }
    }

    const liveAmount =
      shares > 0 && currNav != null ? round2(shares * currNav) : displayAmount

    // 总览口径的金额/收益（按份额比例拆分，与 groupStats 分组拆分同口径，保证
    // 总览 = Σ 各纳入分组的汇总一致；pnl 为空时保持空，不按 0 计入）
    const ovAmount = round2(displayAmount * overviewRatio)
    const ovLive = round2(liveAmount * overviewRatio)
    const ovPnl = pnl == null ? null : round2(pnl * overviewRatio)

    totalAmount += ovAmount
    totalPnl += ovPnl ?? 0
    if (overviewHasCost) {
      hasAnyCost = true
      totalCost += overviewCostRow
      // 累计收益用总览口径最新市值减成本
      totalCumPnl += round2(ovLive - overviewCostRow)
    }
    // 开盘前基数（总览口径）：总览份额 × 昨净值（与涨幅无关）
    if (overviewShares > 0 && prevNav != null && prevNav > 0) {
      bodTotal += round2(overviewShares * prevNav)
    } else {
      bodTotal += ovAmount - (ovPnl ?? 0)
    }

    const sectors = raw.sectors?.length
      ? raw.sectors
      : q.sectors?.length
        ? q.sectors
        : []

    const patch: {
      code: string
      sectors?: string[]
    } = {code: raw.code}
    let needPersist = false

    if (!raw.sectors?.length && sectors.length) {
      patch.sectors = sectors
      needPersist = true
    }
    if (needPersist) persistPatches.push(patch)

    rows.push({
      ...raw,
      name: q.name || raw.name,
      fundKey: q.fundKey || raw.fundKey,
      percent,
      percentSource: q.percentSource || null,
      estimateGrowth: q.estimateGrowth,
      dayGrowth: q.dayGrowth,
      netValueDate: navDay || q.netValueDate || '',
      netValue: q.netValue ?? null,
      estimateNetValue: latestEstimateNav(q),
      prevNetValue: prevNav,
      time: q.time,
      trend: q.trend || [],
      amount: round2(displayAmount),
      liveAmount: round2(liveAmount),
      pnl,
      sectors,
      shares,
      allocations,
      costs: hasCost ? costs : undefined,
      type: raw.type,
      code: raw.code,
      confirmedUpdated: shouldShowConfirmedUpdatedBadge({
        percentSource: q.percentSource || null,
        netValueDate: navDay || q.netValueDate || '',
        isQdii: q.isQdii,
      }),
      totalCost: round2(totalCostRow),
      totalCumPnl: hasCost ? round2(liveAmount - totalCostRow) : null,
      totalCumPnlPercent: hasCost && totalCostRow > 0
        ? round2(((liveAmount - totalCostRow) / totalCostRow) * 100)
        : null,
      isQdii: q.isQdii,
    })
  }

  for (const row of rows) {
    row.weight = totalAmount > 0 ? round2((row.amount / totalAmount) * 100) : 0
  }
  bodTotal = round2(bodTotal)

  return {
    summary: {
      totalAmount: round2(totalAmount),
      bodTotal,
      // 总收益 = 各基金已截尾收益之和（与支付宝单只加总一致）
      totalPnl: round2(totalPnl),
      totalPnlPercent: bodTotal > 0 ? round2((totalPnl / bodTotal) * 100) : 0,
      // 累计收益：仅统计录入成本的持仓；未录入成本时为 null
      totalCost: hasAnyCost ? round2(totalCost) : 0,
      totalCumPnl: hasAnyCost ? round2(totalCumPnl) : null,
      totalCumPnlPercent:
        hasAnyCost && totalCost > 0
          ? round2((totalCumPnl / totalCost) * 100)
          : null,
    },
    list: rows.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)),
    persistPatches,
  }
}

