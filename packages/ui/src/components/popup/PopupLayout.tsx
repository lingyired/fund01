import {useMemo, useState} from 'react'
import type {HoldingsPayload} from '@fund01/core'
import {usePorts} from '../../context'
import {listHoldingGroups} from '../../lib/fundOps'
import {
  buildDisplayRows,
  buildTabs,
  getGroupKeys,
  summarizeGroup,
} from '../../lib/groupStats'
import {GroupTabs} from './GroupTabs'
import {FundList} from './FundList'
import {FooterBar} from './FooterBar'

/** 持仓区域布局：分组 Tab +（全部）分组卡片 + 基金列表 + 底部汇总栏 */
export function PopupLayout({
  data,
  loading,
}: {
  data: HoldingsPayload | null
  loading?: boolean
}) {
  const ports = usePorts()
  const list = data?.list || []
  const holdingGroups = listHoldingGroups(ports)
  const [activeTab, setActiveTab] = useState('all')

  const groupKeys = useMemo(
    () => getGroupKeys(list, holdingGroups),
    [list, holdingGroups],
  )
  const tabs = useMemo(() => buildTabs(list, groupKeys), [list, groupKeys])
  const summaries = useMemo(
    () => groupKeys.map((k) => summarizeGroup(list, k)),
    [list, groupKeys],
  )
  const displayRows = useMemo(
    () => buildDisplayRows(list, activeTab, groupKeys),
    [list, groupKeys, activeTab],
  )

  const validTab = tabs.some((t) => t.id === activeTab) ? activeTab : 'all'
  const isAll = validTab === 'all'
  const activeGroupKey =
    validTab === 'all' ? '' : validTab === '__ungrouped__' ? '' : validTab

  const allSummary = data?.summary ?? null
  const tabTotalAmount = isAll
    ? allSummary?.totalAmount ?? 0
    : summaries.find((s) => s.key === activeGroupKey)?.amount ?? 0

  const footer = isAll
    ? {
        amount: allSummary?.totalAmount ?? 0,
        pnl: allSummary?.totalPnl ?? 0,
        pnlPercent: allSummary?.totalPnlPercent ?? null,
        up: tabs[0]?.up ?? 0,
        down: tabs[0]?.down ?? 0,
      }
    : (() => {
        const s = summaries.find((x) => x.key === activeGroupKey)
        return s
          ? {
              amount: s.amount,
              pnl: s.pnl,
              pnlPercent: s.pnlPercent,
              up: s.up,
              down: s.down,
            }
          : {amount: 0, pnl: 0, pnlPercent: null, up: 0, down: 0}
      })()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GroupTabs tabs={tabs} activeTab={validTab} onChange={setActiveTab} />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-3 scrollbar-thin">
        <FundList
          rows={displayRows}
          activeTab={validTab}
          tabTotalAmount={tabTotalAmount}
          loading={loading}
        />
      </div>
      <FooterBar
        amount={footer.amount}
        pnl={footer.pnl}
        pnlPercent={footer.pnlPercent}
        up={footer.up}
        down={footer.down}
      />
    </div>
  )
}
