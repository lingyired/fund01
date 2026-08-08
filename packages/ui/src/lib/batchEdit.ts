/**
 * 批量编辑持仓的纯数据逻辑（与具体 UI 解耦）。
 * 原 BatchEditHoldingsDialog 依赖 Dialog，这里把行加载单独抽出来，
 * 供 OptionsApp 的内联「编辑持仓」区块复用。
 *
 * 口径（spec 持仓录入与展示统一 §4.3）：编辑表格可编辑列 = 持有金额 + 持有收益；
 * 持有份额 / 成本单价 / 持有成本 均为只读派生展示。落库仍写 allocations/costs。
 */
import type {FundRecord, Ports} from '@fund01/core'
import {getHoldingGroupOrder, listFunds, listHoldingGroups} from './fundOps'

/** 一行可编辑项：某基金在某分组的持有金额与持有收益（编辑用），份额/成本只读派生 */
export type EditRow = {
  code: string
  name: string
  group: string
  /** 持有份额（只读展示；loadEditRows 时为原值，UI 按 amount÷净值 实时派生） */
  shares: string
  /** 成本单价（只读展示；UI 按 (金额−收益)÷份额 实时派生） */
  cost: string
  /** 可编辑：该分组持有金额（当前市值） */
  amount: string
  /** 可编辑：该分组持有收益（留空 = 保留原成本单价） */
  holdProfit: string
  /** 是否已按当前金额口径完成 amount/holdProfit 预填（防止重载时覆盖用户编辑） */
  initialized: boolean
  /** 用户是否手动编辑过该行（切换金额口径时保留，不被重新预填覆盖） */
  touched?: boolean
}

/**
 * 实时派生一组只读展示值（持有份额 / 成本单价 / 持有成本）。
 * nav 缺失（无确认净值）时份额派不出 → 三项均为 null，UI 显示 --。
 */
export function deriveRowReadonly(
  row: Pick<EditRow, 'amount' | 'holdProfit'>,
  nav: number | undefined,
): {shares: number | null; costPrice: number | null; holdingCost: number | null} {
  const a = Number(row.amount) || 0
  const hpRaw = row.holdProfit.trim()
  const hp = hpRaw === '' ? Number.NaN : Number(hpRaw)
  const hasNav = nav != null && nav > 0
  if (!(a > 0) || !hasNav) return {shares: null, costPrice: null, holdingCost: null}
  const shares = Math.round((a / nav) * 10000) / 10000
  const costPrice =
    shares > 0 && Number.isFinite(hp)
      ? (() => {
          const cp = (a - hp) / shares
          return cp > 0 ? Math.round(cp * 1e6) / 1e6 : null
        })()
      : null
  const holdingCost = Number.isFinite(hp) ? Math.round((a - hp) * 100) / 100 : null
  return {shares, costPrice, holdingCost}
}

/** 把基金记录按分组展开成 EditRow 列表，应用排序 */
export async function loadEditRows(
  ports: Ports,
): Promise<{rows: EditRow[]; groups: string[]}> {
  const [funds, declaredGroups] = await Promise.all([
    listFunds(ports, 'hold'),
    listHoldingGroups(ports),
  ])
  // 收集所有出现过的分组（含未分组 ''），保序
  const groupSet = new Set<string>(declaredGroups)
  for (const f of funds) {
    for (const g of Object.keys(f.allocations || {})) {
      groupSet.add(g)
    }
  }
  // 排序：声明的分组在前（保声明顺序），未声明的在后，未分组 '' 最后
  const groups: string[] = []
  for (const g of declaredGroups) if (groupSet.has(g)) groups.push(g)
  for (const g of groupSet) if (g && !groups.includes(g)) groups.push(g)
  if (groupSet.has('')) groups.push('')

  // 每个分组读取排序 + 展开行
  const rows: EditRow[] = []
  for (const g of groups) {
    const order = getHoldingGroupOrder(ports, g)
    const inGroup = funds.filter((f) => (f.allocations?.[g] ?? 0) > 0)
    // 按 order 排序，未在 order 中的按金额降序补在后面
    const ordered: FundRecord[] = []
    const used = new Set<string>()
    for (const code of order) {
      const f = inGroup.find((x) => x.code === code)
      if (f) {
        ordered.push(f)
        used.add(code)
      }
    }
    for (const f of inGroup) {
      if (!used.has(f.code)) ordered.push(f)
    }
    for (const f of ordered) {
      const shares = f.allocations?.[g] ?? 0
      const cost = f.costs?.[g]
      rows.push({
        code: f.code,
        name: f.name || f.code,
        group: g,
        shares: shares ? String(shares) : '',
        cost: cost != null && cost > 0 ? String(cost) : '',
        // 金额/收益预填依赖行情净值，由 OptionsApp 在 navMap 就绪后回填（见 initialized）
        amount: '',
        holdProfit: '',
        initialized: false,
      })
    }
  }
  return {rows, groups}
}
