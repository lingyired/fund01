import {useEffect, useMemo, useState} from 'react'
import type {HoldingsPayload, SettingsAnchorId} from '@fund01/core'
import {usePorts} from '../../context'
import {fetchSettings, listHoldingGroups} from '../../lib/fundOps'
import {
  buildDisplayRows,
  buildOverviewRows,
  buildTabs,
  getGroupKeys,
  summarizeGroup,
} from '../../lib/groupStats'
import {GroupTabs} from './GroupTabs'
import type {GroupTabDetailMode} from './GroupTabs'
import {FundList} from './FundList'
import {FooterBar} from './FooterBar'

/** 持仓区域布局：分组 Tab +（全部）分组卡片 + 基金列表 + 底部汇总栏 */
export function PopupLayout({
  data,
  loading,
  quotePending = false,
  onEditHoldings,
  requestedTab,
}: {
  data: HoldingsPayload | null
  loading?: boolean
  /** 行情快照未就绪（持仓骨架已用本地配置渲染）：数值列显示 -- 并附加载提示 */
  quotePending?: boolean
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
  // 分组 Tab 收益详情设置（设置页「分组 Tab 收益详情」控制；默认开启，popup 每次打开/刷新读取最新值）
  const groupTabSettings = fetchSettings(ports)
  const showTabDetail = groupTabSettings.groupTabShowDetail !== false
  // 隐私模式：popup 金额打码为 ****；分组 Tab 收益详情强制百分比（不暴露收益额）
  const privacyMode = groupTabSettings.privacyMode === true
  const tabDetailMode: GroupTabDetailMode = privacyMode
    ? 'percent'
    : groupTabSettings.groupTabDetailMode === 'amount'
      ? 'amount'
      : 'percent'
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
  // 不纳入总览的分组：popup「全部」Tab（总览视图）与汇总统计同步剔除（设置页「持仓分组」开关）
  const overviewExcludedGroups = groupTabSettings.overviewExcludedGroups || []
  const tabs = useMemo(
    () => buildTabs(list, groupKeys, overviewExcludedGroups),
    [list, groupKeys, overviewExcludedGroups],
  )

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
  const validTab = tabs.some((t) => t.id === activeTab) ? activeTab : 'all'
  const isAll = validTab === 'all'
  const activeGroupKey =
    validTab === 'all' ? '' : validTab === '__ungrouped__' ? '' : validTab

  const displayRows = useMemo(
    () =>
      // 「全部」Tab = 总览视图：剔除不纳入总览的分组（与 summary 口径一致）
      isAll
        ? buildOverviewRows(list, overviewExcludedGroups)
        : buildDisplayRows(list, validTab, groupKeys),
    [list, groupKeys, validTab, isAll, overviewExcludedGroups],
  )

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
      <GroupTabs
        tabs={tabs}
        activeTab={validTab}
        onChange={setActiveTab}
        showDetail={showTabDetail}
        detailMode={tabDetailMode}
      />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-3 scrollbar-thin">
        <FundList
          rows={displayRows}
          activeTab={validTab}
          tabTotalAmount={tabTotalAmount}
          loading={loading}
          quotePending={quotePending}
          privacyMode={privacyMode}
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
        quotePending={quotePending}
        privacyMode={privacyMode}
        onEditHoldings={onEditHoldings}
      />
    </div>
  )
}
