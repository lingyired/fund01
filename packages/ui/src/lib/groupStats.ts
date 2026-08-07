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

/** 计算单个分组的汇总（含资产/当日收益/累计收益/涨跌家数） */
export function summarizeGroup(list: FundQuoteRow[], groupKey: GroupKey): GroupSummary {
  const rows = groupKey
    ? list.filter((r) => groupShares(r, groupKey) > 0)
    : list.filter((r) => groupShares(r, '') > 0)
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
  up: number
  down: number
}

/** 构建分组 Tab 列表（全部 + 各分组） */
export function buildTabs(list: FundQuoteRow[], groupKeys: GroupKey[]): TabInfo[] {
  const allRows = list
  let allUp = 0
  let allDown = 0
  for (const r of allRows) {
    const p = r.pnl ?? 0
    if (p > 0) allUp++
    else if (p < 0) allDown++
  }
  const tabs: TabInfo[] = [
    {id: 'all', key: '', label: '全部', count: allRows.length, up: allUp, down: allDown},
  ]
  for (const g of groupKeys) {
    const s = summarizeGroup(list, g)
    tabs.push({
      id: g === '' ? '__ungrouped__' : g,
      key: g,
      label: s.label,
      count: s.count,
      up: s.up,
      down: s.down,
    })
  }
  return tabs
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
    : list.filter((r) => groupShares(r, activeKey) > 0)
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
