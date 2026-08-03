/**
 * 批量编辑持仓的纯数据逻辑（与具体 UI 解耦）。
 * 原 BatchEditHoldingsDialog 依赖 Dialog，这里把行加载单独抽出来，
 * 供 OptionsApp 的内联「编辑持仓」区块复用。
 */
import type {FundRecord, Ports} from '@fund01/core'
import {getHoldingGroupOrder, listFunds, listHoldingGroups} from './fundOps'

/** 一行可编辑项：某基金在某分组的份额与成本 */
export type EditRow = {
  code: string
  name: string
  group: string
  shares: string
  cost: string
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
      })
    }
  }
  return {rows, groups}
}
