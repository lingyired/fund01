// 持仓分组聚合：从 FundQuoteRow 列表按 allocations 计算各组汇总。
// 逻辑原位于 HoldingsModule，抽出为纯函数便于 popup 新布局复用，不改动 core。

import type {FundQuoteRow} from '@fund01/core'

/** 该基金在某分组的份额 */
export function groupShares(row: FundQuoteRow, group: string): number {
  return row.allocations?.[group] || 0
}

/** 该基金在某分组的金额（按总金额比例拆分，线性精确） */
export function groupAmount(row: FundQuoteRow, group: string): number {
  const gs = groupShares(row, group)
  const total = row.shares || 0
  if (gs <= 0 || total <= 0) return 0
  return Math.round((row.amount * (gs / total)) * 100) / 100
}

/** 该基金在某分组的收益（按总收益比例拆分）。
 *  当日收益为空（QDII 盘中 pnl=null）时返回 null，聚合时跳过该成员（§六：分组当日
 *  收益额不把空值按 0 计入，避免既少算又误导；盘后 QDII pnl 有值则正常计入）。 */
export function groupPnl(row: FundQuoteRow, group: string): number | null {
  const gs = groupShares(row, group)
  const total = row.shares || 0
  if (gs <= 0 || total <= 0) return 0
  if (row.pnl == null) return null
  return Math.round((row.pnl * (gs / total)) * 100) / 100
}

/** 该基金在某分组的持仓成本 = 成本单价 × 分组份额 */
export function groupCost(row: FundQuoteRow, group: string): number {
  const gs = groupShares(row, group)
  const price = row.costs?.[group] ?? 0
  if (gs <= 0 || price <= 0) return 0
  return Math.round(price * gs * 100) / 100
}

/** 该基金在某分组的累计收益 = 分组市值 − 分组成本；null 表示该分组未录入成本 */
export function groupCumPnl(row: FundQuoteRow, group: string): number | null {
  const gs = groupShares(row, group)
  const total = row.shares || 0
  if (gs <= 0 || total <= 0) return null
  const price = row.costs?.[group] ?? 0
  if (price <= 0) return null
  const gCost = price * gs
  const live = row.liveAmount ?? row.amount
  const gLive = (live * gs) / total
  return Math.round((gLive - gCost) * 100) / 100
}

/** 该基金在某分组的累计收益率(%) */
export function groupCumPnlPercent(row: FundQuoteRow, group: string): number | null {
  const gs = groupShares(row, group)
  const price = row.costs?.[group] ?? 0
  if (gs <= 0 || price <= 0) return null
  const gCost = price * gs
  const cum = groupCumPnl(row, group)
  if (cum == null || gCost <= 0) return null
  return Math.round((cum / gCost) * 10000) / 100
}

/** 分组 key：'' 表示未分组 */
export type GroupKey = string

/**
 * 返回有持仓的分组 key 列表（按 holdingGroups 顺序，未分组 '' 永远放最后）。
 * 不在 holdingGroups 中、但出现在 allocations 里的分组也会被纳入。
 */
export function getGroupKeys(
  list: FundQuoteRow[],
  holdingGroups: string[],
): GroupKey[] {
  const order = [...holdingGroups]
  for (const row of list) {
    for (const g of Object.keys(row.allocations || {})) {
      if (g && !order.includes(g)) order.push(g)
    }
  }
  const keys: GroupKey[] = []
  for (const g of order) {
    if (list.some((r) => groupShares(r, g) > 0)) keys.push(g)
  }
  if (list.some((r) => groupShares(r, '') > 0)) keys.push('')
  return keys
}

export interface GroupSummary {
  key: GroupKey
  label: string
  count: number
  amount: number
  pnl: number
  pnlPercent: number | null
  cumPnl: number | null
  cumPnlPercent: number | null
  up: number
  down: number
}

/** 该基金是否属于某分组（键存在即算，含 0 份额：0 金额关注/待加仓基金也属于其分组）。
 *  不能用 groupShares >= 0（不在分组的基金返回 0 会误判）。 */
export function inGroup(row: FundQuoteRow, group: string): boolean {
  return (row.allocations?.[group] ?? -1) >= 0
}

/** 计算单个分组的汇总（含资产/当日收益/累计收益/涨跌家数）。
 *  包含 0 份额基金（0 金额关注/待加仓）：其金额/收益/涨跌均贡献 0，
 *  但计入 count（分组 tab 显示「N 只」含关注占位），与分组 tab 列表一致。 */
export function summarizeGroup(list: FundQuoteRow[], groupKey: GroupKey): GroupSummary {
  const rows = groupKey
    ? list.filter((r) => inGroup(r, groupKey))
    : list.filter((r) => inGroup(r, ''))
  const amount = rows.reduce((s, r) => s + groupAmount(r, groupKey), 0)
  // 当日收益聚合：跳过当日收益为空的成员（QDII 盘中 pnl=null → groupPnl 返回 null），
  // 不按 0 计入（§六）；盘后 QDII 有值自动补回
  const pnl = rows.reduce((s, r) => {
    const p = groupPnl(r, groupKey)
    return p == null ? s : s + p
  }, 0)
  const pnlPercent = amount > 0 ? (pnl / amount) * 100 : null

  let cost = 0
  let cum = 0
  let hasCost = false
  for (const r of rows) {
    const c = groupCost(r, groupKey)
    if (c > 0) {
      hasCost = true
      cost += c
      cum += groupCumPnl(r, groupKey) ?? 0
    }
  }
  const cumPnl = hasCost ? Math.round(cum * 100) / 100 : null
  const cumPnlPercent =
    hasCost && cost > 0 ? Math.round((cum / cost) * 10000) / 100 : null

  let up = 0
  let down = 0
  for (const r of rows) {
    const p = groupPnl(r, groupKey)
    if (p == null) continue
    if (p > 0) up++
    else if (p < 0) down++
  }

  return {
    key: groupKey,
    label: groupKey || '未分组',
    count: rows.length,
    amount: Math.round(amount * 100) / 100,
    pnl: Math.round(pnl * 100) / 100,
    pnlPercent,
    cumPnl,
    cumPnlPercent,
    up,
    down,
  }
}

export interface TabInfo {
  /** tab 唯一 id：'all' 或分组 key（未分组用 '__ungrouped__'） */
  id: string
  /** 分组 key（未分组为 ''） */
  key: GroupKey
  label: string
  count: number
  /** 该 tab 持仓金额合计（'all' 为全部持仓，分组为该分组金额，与 GroupSummary.amount 同口径） */
  amount: number
  /** 当日收益额（用于分组 tab 红绿点与收益详情：>0 红 / <0 绿 / 0 或全 nil 不画点）。
   *  聚合规则同 GroupSummary.pnl：跳过当日收益为空的成员（QDII 盘中 pnl=null），
   *  不按 0 计入（§六）。 */
  pnl: number
  /** 当日收益率(%) = pnl / amount × 100；amount 为 0（全部 0 金额关注）时为 null。
   *  精度同 GroupSummary.pnlPercent（不 round，UI 展示时格式化）。 */
  pnlPercent: number | null
  up: number
  down: number
}

/**
 * 构建分组 Tab 列表（全部 + 各分组）。
 * `excludedGroups`：不纳入总览的分组名列表（'' 表示未分组，默认空 = 全部纳入）。
 * 「全部」Tab 即总览视图：剔除被排除分组的持仓（份额/金额/收益按未排除部分拆分），
 * 与后端 calcHoldings summary 的排除口径 1:1 一致；各分组 Tab 不受影响。
 */
export function buildTabs(
  list: FundQuoteRow[],
  groupKeys: GroupKey[],
  excludedGroups: string[] = [],
): TabInfo[] {
  const ovRows = buildOverviewRows(list, excludedGroups)
  let allUp = 0
  let allDown = 0
  let allPnl = 0
  let allAmount = 0
  for (const d of ovRows) {
    const p = d.pnl ?? 0
    if (p > 0) allUp++
    else if (p < 0) allDown++
    // 当日收益额聚合：跳过空值（QDII 盘中 pnl=null），不按 0 计入（§六）；
    // 与 summarizeGroup 的 groupPnl 口径一致（null 跳过，等价于 ??0 的求和）
    if (d.pnl != null) allPnl += d.pnl
    allAmount += d.amount || 0
  }
  const tabs: TabInfo[] = [
    {
      id: 'all',
      key: '',
      label: '全部',
      count: ovRows.length,
      amount: Math.round(allAmount * 100) / 100,
      pnl: Math.round(allPnl * 100) / 100,
      pnlPercent: allAmount > 0 ? (allPnl / allAmount) * 100 : null,
      up: allUp,
      down: allDown,
    },
  ]
  for (const g of groupKeys) {
    const s = summarizeGroup(list, g)
    tabs.push({
      id: g === '' ? '__ungrouped__' : g,
      key: g,
      label: s.label,
      count: s.count,
      amount: s.amount,
      pnl: s.pnl,
      pnlPercent: s.pnlPercent,
      up: s.up,
      down: s.down,
    })
  }
  return tabs
}

/**
 * 总览视图行：剔除「不纳入总览」分组后的持仓列表（popup「全部」Tab 与总览一致）。
 * - 基金在未排除分组有 allocation 键（含 0 份额的关注/待加仓）→ 保留，份额/金额/收益
 *   按未排除部分占全部份额的比例拆分（与 groupAmount/groupPnl 同口径）；
 * - 基金只在被排除分组有份额（或 0 份额）→ 整行过滤。
 * 口径与 calcHoldings summary 的排除逻辑 1:1（金额/收益比例拆分、成本按分组精确加总）。
 */
export function buildOverviewRows(
  list: FundQuoteRow[],
  excludedGroups: string[] = [],
): DisplayRow[] {
  if (!excludedGroups.length) {
    return list.map((row) => ({
      row,
      shares: row.shares || 0,
      amount: row.amount,
      pnl: row.pnl ?? null,
      cumPnl: row.totalCumPnl ?? null,
      cumPnlPercent: row.totalCumPnlPercent ?? null,
      group: '',
    }))
  }
  const excluded = new Set(excludedGroups)
  const out: DisplayRow[] = []
  for (const row of list) {
    const allocs = row.allocations || {}
    const keptKeys = Object.keys(allocs).filter((g) => !excluded.has(g))
    // 在未排除分组无任何键（份额全在被排除分组，或该基金本就只属于被排除分组）→ 过滤
    if (keptKeys.length === 0) continue
    const total = row.shares || 0
    const ovShares = keptKeys.reduce((s, g) => s + (Number(allocs[g]) || 0), 0)
    const ratio = total > 0 ? ovShares / total : 0
    // 成本按分组精确加总（不按比例）：仅未排除分组
    let ovCost = 0
    const costs = row.costs || {}
    for (const g of keptKeys) {
      const price = Number(costs[g]) || 0
      const sh = Number(allocs[g]) || 0
      if (price > 0 && sh > 0) ovCost += price * sh
    }
    ovCost = Math.round(ovCost * 100) / 100
    const ovLive = Math.round(((row.liveAmount ?? row.amount) * ratio) * 100) / 100
    const cumPnl = ovCost > 0 ? Math.round((ovLive - ovCost) * 100) / 100 : null
    const cumPnlPercent =
      cumPnl != null && ovCost > 0 ? Math.round((cumPnl / ovCost) * 10000) / 100 : null
    out.push({
      row,
      shares: ovShares,
      amount: Math.round(row.amount * ratio * 100) / 100,
      pnl: row.pnl == null ? null : Math.round(row.pnl * ratio * 100) / 100,
      cumPnl,
      cumPnlPercent,
      group: '',
    })
  }
  return out
}

/** 某分组 tab 下的基金行（用于基金列表渲染） */
export interface DisplayRow {
  row: FundQuoteRow
  shares: number
  amount: number
  /** 当日收益额；当日收益为空（QDII 盘中）时为 null，UI 渲染「-」 */
  pnl: number | null
  cumPnl: number | null
  cumPnlPercent: number | null
  group: GroupKey
}

export function buildDisplayRows(
  list: FundQuoteRow[],
  activeTab: string,
  groupKeys: GroupKey[],
): DisplayRow[] {
  const isAll = activeTab === 'all'
  const activeKey =
    activeTab === 'all' ? '' : activeTab === '__ungrouped__' ? '' : activeTab
  const rows = isAll
    ? list
    : list.filter((r) => inGroup(r, activeKey))
  return rows.map((row) => {
    if (isAll) {
      return {
        row,
        shares: row.shares || 0,
        amount: row.amount,
        pnl: row.pnl ?? null,
        cumPnl: row.totalCumPnl ?? null,
        cumPnlPercent: row.totalCumPnlPercent ?? null,
        group: '',
      }
    }
    return {
      row,
      shares: groupShares(row, activeKey),
      amount: groupAmount(row, activeKey),
      pnl: groupPnl(row, activeKey),
      cumPnl: groupCumPnl(row, activeKey),
      cumPnlPercent: groupCumPnlPercent(row, activeKey),
      group: activeKey,
    }
  })
}
