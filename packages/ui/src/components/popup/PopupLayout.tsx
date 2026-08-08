import {useEffect, useMemo, useState} from 'react'
import type {HoldingsPayload, SettingsAnchorId} from '@fund01/core'
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
  onEditHoldings,
  requestedTab,
}: {
  data: HoldingsPayload | null
  loading?: boolean
  /** 打开设置页「持仓」tab（footer「修改持仓」按钮触发） */
  onEditHoldings?: () => void
  /**
   * 外部请求直达的分组 tab id（Tauri 点击 menubar 分组实例时传入）：
   * {id: 'all' | 分组名 | '__ungrouped__'}；null 表示不干预当前选中。
   * 每次请求都是新对象（对象身份变化触发），重复点击同一分组也能重新定位；
   * 数据未就绪时先挂起，tabs 出来后自动应用；分组已不存在则保持当前选中。
   */
  requestedTab?: {id: string} | null
}) {
  const ports = usePorts()
  const list = data?.list || []
  const holdingGroups = listHoldingGroups(ports)
  // 空状态直达设置页「持仓」tab 的对应区块（单独添加 / 批量导入）
  const openSettingsAnchor = (anchor: SettingsAnchorId) => {
    void ports.window.openSettings('holdings', anchor)
  }
  const [activeTab, setActiveTab] = useState('all')
  // 外部请求但 tabs 尚未就绪时挂起，待 tabs 可用后应用
  const [pendingTab, setPendingTab] = useState<string | null>(null)

  const groupKeys = useMemo(
    () => getGroupKeys(list, holdingGroups),
    [list, holdingGroups],
  )
  const tabs = useMemo(() => buildTabs(list, groupKeys), [list, groupKeys])

  // 外部请求（点击 menubar 分组）：挂起到 pending
  useEffect(() => {
    if (requestedTab == null) return
    setPendingTab(requestedTab.id)
  }, [requestedTab])

  // pending tab 在 tabs 可用时应用；无效（分组已不存在/未加载）则丢弃，保持当前
  useEffect(() => {
    if (!pendingTab) return
    if (tabs.some((t) => t.id === pendingTab)) {
      setActiveTab(pendingTab)
    }
    setPendingTab(null)
  }, [tabs, pendingTab])

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
          onAddFund={() => openSettingsAnchor('add-fund')}
          onImportHoldings={() => openSettingsAnchor('import-holdings')}
        />
      </div>
      <FooterBar
        amount={footer.amount}
        pnl={footer.pnl}
        pnlPercent={footer.pnlPercent}
        up={footer.up}
        down={footer.down}
        onEditHoldings={onEditHoldings}
      />
    </div>
  )
}
