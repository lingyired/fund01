import {Fragment, useEffect, useState} from 'react'
import {ChevronDown, ChevronRight, Pencil, Plus, Upload} from 'lucide-react'
import type {
  FundQuoteRow,
  GoldPayload,
  HoldingsPayload,
} from '@fund01/core'
import {createFund, listHoldingGroups, updateFund} from '../lib/fundOps'
import {usePorts} from '../context'
import {formatAmount, formatMoney, formatPct, pctClass} from '@fund01/core'
import {Button} from './ui/button'
import {Panel, PanelHeader} from './ui/panel'
import {FundFormDialog} from './FundFormDialog'
import {ImportHoldingsDialog} from './ImportHoldingsDialog'
import {BatchEditHoldingsDialog} from './BatchEditHoldingsDialog'
import {FundDetailDialog} from './FundDetailDialog'
import {GoldPanel} from './GoldHoldingsRow'

/** 该基金在某分组的份额 */
function groupShares(row: FundQuoteRow, group: string): number {
  return row.allocations?.[group] || 0
}

/** 该基金在某分组的金额（按总金额比例拆分，线性精确） */
function groupAmount(row: FundQuoteRow, group: string): number {
  const gs = groupShares(row, group)
  const total = row.shares || 0
  if (gs <= 0 || total <= 0) return 0
  return Math.round((row.amount * (gs / total)) * 100) / 100
}

/** 该基金在某分组的收益（按总收益比例拆分） */
function groupPnl(row: FundQuoteRow, group: string): number {
  const gs = groupShares(row, group)
  const total = row.shares || 0
  if (gs <= 0 || total <= 0) return 0
  return Math.round(((row.pnl ?? 0) * (gs / total)) * 100) / 100
}

/** 该基金在某分组的持仓成本 = 成本单价 × 分组份额 */
function groupCost(row: FundQuoteRow, group: string): number {
  const gs = groupShares(row, group)
  const price = row.costs?.[group] ?? 0
  if (gs <= 0 || price <= 0) return 0
  return Math.round(price * gs * 100) / 100
}

/** 该基金在某分组的累计收益 = 分组市值 − 分组成本；null 表示该分组未录入成本 */
function groupCumPnl(row: FundQuoteRow, group: string): number | null {
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
function groupCumPnlPercent(row: FundQuoteRow, group: string): number | null {
  const gs = groupShares(row, group)
  const price = row.costs?.[group] ?? 0
  if (gs <= 0 || price <= 0) return null
  const gCost = price * gs
  const cum = groupCumPnl(row, group)
  if (cum == null || gCost <= 0) return null
  return Math.round((cum / gCost) * 10000) / 100
}

export function HoldingsModule({
  data,
  gold,
  showGold,
  loading,
  onChanged,
}: {
  data: HoldingsPayload | null
  gold: GoldPayload | null
  showGold: boolean
  loading?: boolean
  onChanged: () => void
}) {
  const ports = usePorts()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<FundQuoteRow | null>(null)
  /** 编辑时指定的分组（分组 tab 内编辑某分组份额） */
  const [editingGroup, setEditingGroup] = useState<string>('')
  const [importOpen, setImportOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [groups, setGroups] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string>('all')
  /** 全部 tab 下展开的基金 code 集合 */
  const [expandedCodes, setExpandedCodes] = useState<Set<string>>(new Set())
  /** 详情弹窗：点击基金名称时弹出，展示占比/板块/走势 */
  const [detailRow, setDetailRow] = useState<FundQuoteRow | null>(null)

  const summary = data?.summary ?? null
  const list = data?.list || []

  useEffect(() => {
    setGroups(listHoldingGroups(ports))
  }, [data])

  function refreshGroups() {
    setGroups(listHoldingGroups(ports))
  }

  function openEditHold(row: FundQuoteRow, group: string) {
    setEditing(row)
    setEditingGroup(group)
    setOpen(true)
  }

  function openAddHold() {
    setEditing(null)
    // 在分组 tab 下点添加：预选当前分组；在「全部」tab 下：预选未分组
    setEditingGroup(isAllTab ? '' : activeGroupKey)
    setOpen(true)
  }

  function toggleExpand(code: string) {
    setExpandedCodes((cur) => {
      const next = new Set(cur)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  // 分组聚合：基于 allocations keys
  const groupOrder = [...groups]
  for (const row of list) {
    for (const g of Object.keys(row.allocations || {})) {
      if (g && !groupOrder.includes(g)) groupOrder.push(g)
    }
  }
  const groupedKeys: string[] = []
  for (const g of groupOrder) {
    if (list.some((r) => groupShares(r, g) > 0)) groupedKeys.push(g)
  }
  // 未分组
  const hasUngrouped = list.some((r) => groupShares(r, '') > 0)
  if (hasUngrouped) groupedKeys.push('')

  const hasAny = list.length > 0

  const tabs: {id: string; label: string}[] = [
    {id: 'all', label: '全部'},
    ...groupedKeys.map((g) => ({id: g || '__ungrouped__', label: g || '未分组'})),
  ]
  const showTabs = groupedKeys.length >= 2
  const validTab = tabs.some((t) => t.id === activeTab) ? activeTab : 'all'

  // 当前 tab 的行
  const isAllTab = validTab === 'all'
  const activeGroupKey =
    validTab === 'all' ? '' : validTab === '__ungrouped__' ? '' : validTab
  // 分组 tab：只显示在该分组有份额的基金
  const activeRows = isAllTab
    ? list
    : list.filter((r) => groupShares(r, activeGroupKey) > 0)

  // 当日收益对应的净值日期（取活跃行中最新的 netValueDate）
  const pnlDate = activeRows.reduce((d, r) => {
    const nd = r.netValueDate || ''
    return nd > d ? nd : d
  }, '')

  // 当前 tab 的统计
  const groupStats = isAllTab
    ? {
        totalAmount: summary?.totalAmount ?? null,
        totalPnl: summary?.totalPnl ?? null,
        totalPnlPercent: summary?.totalPnlPercent ?? null,
        totalCost: summary?.totalCost ?? null,
        totalCumPnl: summary?.totalCumPnl ?? null,
        totalCumPnlPercent: summary?.totalCumPnlPercent ?? null,
      }
    : (() => {
        const totalAmount = activeRows.reduce(
          (s, r) => s + groupAmount(r, activeGroupKey),
          0,
        )
        const totalPnl = activeRows.reduce(
          (s, r) => s + groupPnl(r, activeGroupKey),
          0,
        )
        const totalPnlPercent = totalAmount > 0 ? (totalPnl / totalAmount) * 100 : null
        // 分组累计收益：仅统计有成本的行
        let gCost = 0
        let gCumPnl = 0
        let hasCost = false
        for (const r of activeRows) {
          const c = groupCost(r, activeGroupKey)
          if (c > 0) {
            hasCost = true
            gCost += c
            // 分组累计收益 = 分组市值 - 分组成本；分组市值按 liveAmount 比例拆分
            const gs = groupShares(r, activeGroupKey)
            const total = r.shares || 0
            const live = r.liveAmount ?? r.amount
            const gLive = gs > 0 && total > 0 ? (live * (gs / total)) : 0
            gCumPnl += Math.round((gLive - c) * 100) / 100
          }
        }
        return {
          totalAmount,
          totalPnl,
          totalPnlPercent,
          totalCost: hasCost ? Math.round(gCost * 100) / 100 : null,
          totalCumPnl: hasCost ? Math.round(gCumPnl * 100) / 100 : null,
          totalCumPnlPercent:
            hasCost && gCost > 0 ? Math.round((gCumPnl / gCost) * 10000) / 100 : null,
        }
      })()

  // 渲染用的行数据：分组 tab 用该分组份额算 amount/pnl；全部 tab 用总额
  type DisplayRow = {
    row: FundQuoteRow
    shares: number
    amount: number
    pnl: number
    group: string
  }
  const displayRows: DisplayRow[] = isAllTab
    ? activeRows.map((row) => ({
        row,
        shares: row.shares || 0,
        amount: row.amount,
        pnl: row.pnl ?? 0,
        group: '',
      }))
    : activeRows.map((row) => ({
        row,
        shares: groupShares(row, activeGroupKey),
        amount: groupAmount(row, activeGroupKey),
        pnl: groupPnl(row, activeGroupKey),
        group: activeGroupKey,
      }))

  return (
    <div className="flex min-w-0 w-full flex-col gap-4">
      <Panel className="min-w-0 w-full">
        <PanelHeader
          title="持仓列表"
          desc="仅基金 · 总金额 / 当日收益 / 收益率不含黄金"
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setBatchOpen(true)}>
                <Pencil className="h-4 w-4" />
                编辑持仓
              </Button>
              <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                <Upload className="h-4 w-4" />
                导入持仓
              </Button>
              <Button size="sm" onClick={openAddHold}>
                <Plus className="h-4 w-4" />
                添加持仓
              </Button>
            </div>
          }
        />

        {/* 分组 Tab 栏 */}
        {showTabs ? (
          <div className="flex gap-1 overflow-x-auto border-b border-line/70 px-3 pb-px sm:px-5">
            {tabs.map((t) => {
              const active = t.id === validTab
              const count =
                t.id === 'all'
                  ? list.length
                  : list.filter((r) =>
                      groupShares(r, t.id === '__ungrouped__' ? '' : t.id) > 0,
                    ).length
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  className={`relative whitespace-nowrap px-3 py-2 text-sm transition-colors ${
                    active ? 'font-medium text-ink' : 'text-muted hover:text-ink-soft'
                  }`}
                >
                  {t.label}
                  <span className="ml-1 text-xs text-muted">{count}</span>
                  {active ? (
                    <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}

        {/* 当前 tab 的统计条 */}
        <div className="grid grid-cols-2 gap-2 px-3 py-3 sm:grid-cols-3 sm:gap-3 sm:px-5 sm:py-4">
          <Stat
            label={isAllTab ? '总持仓金额' : '分组持仓金额'}
            hint="基金确认净值市值合计，不含盘中估算浮动，不含黄金"
            value={formatAmount(groupStats.totalAmount)}
            loading={loading}
          />
          <Stat
            label="当日收益"
            hint="盘中实时估算收益 / 确认后当日收益"
            value={formatMoney(groupStats.totalPnl)}
            percent={formatPct(groupStats.totalPnlPercent)}
            className={pctClass(groupStats.totalPnl)}
            percentClassName={pctClass(groupStats.totalPnlPercent)}
            loading={loading}
            sub={pnlDate ? `净值日 ${pnlDate}` : undefined}
          />
          {groupStats.totalCumPnl != null ? (
            <Stat
              label="累计收益"
              hint="当前市值 − 成本单价 × 份额（仅统计已录入成本单价的持仓）；下方百分比为累计收益率"
              value={formatMoney(groupStats.totalCumPnl)}
              percent={formatPct(groupStats.totalCumPnlPercent)}
              className={pctClass(groupStats.totalCumPnl)}
              percentClassName={pctClass(groupStats.totalCumPnlPercent)}
              loading={loading}
            />
          ) : null}
        </div>

        {/* 移动端：当前 tab 卡片 */}
        <div className="space-y-2 px-3 pb-4 md:hidden">
          {!hasAny ? (
            <div className="py-6 text-center text-sm text-muted">暂无基金持仓</div>
          ) : displayRows.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted">该分组暂无持仓</div>
          ) : (
            displayRows.map(({row, shares, amount, pnl, group}) => {
              const allocKeys = Object.keys(row.allocations || {})
              const canExpand = isAllTab && allocKeys.length > 1
              const expanded = expandedCodes.has(row.code)
              const cumPnl = isAllTab ? (row.totalCumPnl ?? null) : groupCumPnl(row, group)
              const cumPnlPercent = isAllTab ? (row.totalCumPnlPercent ?? null) : groupCumPnlPercent(row, group)
              const latestNav = row.estimateNetValue ?? row.netValue ?? null
              return (
                <div
                  key={row.code}
                  className="rounded-xl border border-line/70 bg-paper/40 p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {canExpand ? (
                        <button
                          type="button"
                          onClick={() => toggleExpand(row.code)}
                          className="shrink-0 text-muted"
                        >
                          {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setDetailRow(row)}
                        className="truncate text-left font-medium text-ink hover:underline"
                        title="点击查看详情"
                      >
                        {row.name}
                      </button>
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="font-mono text-xs text-muted">{row.code}</span>
                      <span className="font-mono text-xs text-muted">·</span>
                      <span
                        className="font-mono text-xs text-ink-soft"
                        title="上一确认点市值，不含盘中估算浮动"
                      >
                        ¥{formatAmount(amount)}
                      </span>
                      <ConfirmedUpdatedBadge
                        show={row.confirmedUpdated}
                        percent={row.dayGrowth ?? row.percent}
                        netValue={row.netValue}
                      />
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <div
                        className="text-[11px] text-muted"
                        title={
                          row.confirmedUpdated
                            ? '官方确认涨跌已更新持仓金额与当日收益'
                            : '盘中实时估算收益'
                        }
                      >
                        当日收益
                      </div>
                      <div className={`font-mono tabular-nums ${pctClass(pnl)}`}>
                        {formatMoney(pnl)}
                      </div>
                      <div className={`font-mono text-xs tabular-nums ${pctClass(row.percent)}`}>
                        {formatPct(row.percent)}
                      </div>
                    </div>
                    <div>
                      <div
                        className="text-[11px] text-muted"
                        title="当前市值 − 持仓成本；未录入成本单价时显示 --"
                      >
                        持有收益
                      </div>
                      <div className={`font-mono tabular-nums ${pctClass(cumPnl)}`}>
                        {formatMoney(cumPnl)}
                      </div>
                      <div className={`font-mono text-xs tabular-nums ${pctClass(cumPnlPercent)}`}>
                        {formatPct(cumPnlPercent)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-muted">最新净值</div>
                      <div className="font-mono tabular-nums text-ink-soft">
                        {latestNav != null && Number.isFinite(latestNav)
                          ? latestNav.toFixed(4)
                          : '--'}
                      </div>
                      <div className={`font-mono text-xs tabular-nums ${pctClass(row.percent)}`}>
                        {formatPct(row.percent)}
                      </div>
                    </div>
                  </div>
                  {canExpand && expanded ? (
                    <div className="mt-2 space-y-1 rounded-lg border border-line/50 bg-panel/50 p-2 text-xs">
                      {allocKeys.map((g) => (
                        <div key={g} className="flex justify-between gap-2">
                          <span className="text-muted">{g || '未分组'}</span>
                          <span className="font-mono tabular-nums">
                            {formatAmount(groupAmount(row, g))} ·{' '}
                            <span className={pctClass(groupPnl(row, g))}>
                              {formatMoney(groupPnl(row, g))}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>

        {/* 桌面：当前 tab 表格 */}
        <div className="hidden w-full overflow-x-auto px-2 pb-4 md:block">
          {!hasAny ? (
            <div className="py-8 text-center text-sm text-muted">
              暂无基金持仓，可点击右上角添加
            </div>
          ) : displayRows.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted">该分组暂无持仓</div>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr className="border-y border-line/70">
                  <th className="px-3 py-2 font-medium">名称</th>
                  <th className="px-3 py-2 font-medium" title="盘中实时估算收益 / 确认后当日收益">
                    当日收益
                  </th>
                  <th className="px-3 py-2 font-medium" title="当前市值 − 持仓成本；未录入成本单价显示 --">
                    持有收益
                  </th>
                  <th className="px-3 py-2 font-medium" title="最新净值（盘中为估值，确认后为披露净值）">
                    最新净值
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map(({row, amount, pnl, group}) => {
                  const allocKeys = Object.keys(row.allocations || {})
                  const canExpand = isAllTab && allocKeys.length > 1
                  const expanded = expandedCodes.has(row.code)
                  const cumPnl = isAllTab ? (row.totalCumPnl ?? null) : groupCumPnl(row, group)
                  const cumPnlPercent = isAllTab ? (row.totalCumPnlPercent ?? null) : groupCumPnlPercent(row, group)
                  const latestNav = row.estimateNetValue ?? row.netValue ?? null
                  return (
                    <Fragment key={row.code}>
                      <tr className="border-b border-line/50 hover:bg-paper/60">
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5">
                            {canExpand ? (
                              <button
                                type="button"
                                onClick={() => toggleExpand(row.code)}
                                className="shrink-0 text-muted hover:text-ink"
                              >
                                {expanded ? (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5" />
                                )}
                              </button>
                            ) : null}
                            <div className="min-w-0">
                              <button
                                type="button"
                                onClick={() => setDetailRow(row)}
                                className="block max-w-full truncate text-left font-medium text-ink hover:underline"
                                title="点击查看详情"
                              >
                                {row.name}
                              </button>
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span className="font-mono text-xs text-muted">{row.code}</span>
                                <span className="font-mono text-xs text-muted">·</span>
                                <span
                                  className="font-mono text-xs text-ink-soft"
                                  title="上一确认点市值（确认净值市值），不含盘中估算浮动"
                                >
                                  ¥{formatAmount(amount)}
                                </span>
                                <ConfirmedUpdatedBadge
                                  show={row.confirmedUpdated}
                                  percent={row.dayGrowth ?? row.percent}
                                  netValue={row.netValue}
                                />
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className={`font-mono tabular-nums ${pctClass(pnl)}`}>
                            {formatMoney(pnl)}
                          </div>
                          <div className={`font-mono text-xs tabular-nums ${pctClass(row.percent)}`}>
                            {formatPct(row.percent)}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className={`font-mono tabular-nums ${pctClass(cumPnl)}`}>
                            {formatMoney(cumPnl)}
                          </div>
                          <div className={`font-mono text-xs tabular-nums ${pctClass(cumPnlPercent)}`}>
                            {formatPct(cumPnlPercent)}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-mono tabular-nums text-ink-soft">
                            {latestNav != null && Number.isFinite(latestNav)
                              ? latestNav.toFixed(4)
                              : '--'}
                          </div>
                          <div className={`font-mono text-xs tabular-nums ${pctClass(row.percent)}`}>
                            {formatPct(row.percent)}
                          </div>
                        </td>
                      </tr>
                      {canExpand && expanded ? (
                        <tr className="border-b border-line/30 bg-paper/30">
                          <td colSpan={4} className="px-3 py-2">
                            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                              {allocKeys.map((g) => (
                                <div key={g} className="flex items-center gap-1.5">
                                  <span className="text-muted">{g || '未分组'}</span>
                                  <span className="font-mono tabular-nums">
                                    {formatAmount(groupAmount(row, g))}
                                  </span>
                                  <span className={`font-mono tabular-nums ${pctClass(groupPnl(row, g))}`}>
                                    {formatMoney(groupPnl(row, g))}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <FundFormDialog
          open={open}
          onOpenChange={setOpen}
          mode="hold"
          initial={editing}
          editingGroup={editingGroup}
          initialAmount={editing ? groupAmount(editing, editingGroup) : undefined}
          groups={groups}
          onGroupsChanged={refreshGroups}
          onSubmit={async (payload) => {
            if (editing) {
              await updateFund(
                ports,
                editing.code,
                {
                  amount: payload.amount,
                  amountBasis: payload.amountBasis,
                  group: payload.group,
                },
                'hold',
              )
            } else {
              await createFund(ports, {
                code: payload.code,
                amount: payload.amount,
                amountBasis: payload.amountBasis,
                type: 'hold',
                group: payload.group,
              })
            }
            onChanged()
          }}
        />

        <ImportHoldingsDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          onImported={onChanged}
        />

        <BatchEditHoldingsDialog
          open={batchOpen}
          onOpenChange={setBatchOpen}
          onChanged={onChanged}
        />

        <FundDetailDialog
          open={!!detailRow}
          onOpenChange={(v) => !v && setDetailRow(null)}
          row={detailRow}
          proportion={
            detailRow && groupStats.totalAmount && groupStats.totalAmount > 0
              ? ((isAllTab
                  ? detailRow.amount
                  : groupAmount(detailRow, activeGroupKey)) /
                  groupStats.totalAmount) *
                100
              : null
          }
          stats={
            detailRow
              ? {
                  amount: isAllTab
                    ? detailRow.amount
                    : groupAmount(detailRow, activeGroupKey),
                  dayPnl: isAllTab
                    ? (detailRow.pnl ?? 0)
                    : groupPnl(detailRow, activeGroupKey),
                  cumPnl: isAllTab
                    ? (detailRow.totalCumPnl ?? null)
                    : groupCumPnl(detailRow, activeGroupKey),
                  cumPnlPercent: isAllTab
                    ? (detailRow.totalCumPnlPercent ?? null)
                    : groupCumPnlPercent(detailRow, activeGroupKey),
                  latestNav:
                    detailRow.estimateNetValue ?? detailRow.netValue ?? null,
                }
              : null
          }
        />
      </Panel>

      {showGold ? (
        <GoldPanel data={gold} loading={loading} onChanged={onChanged} />
      ) : null}
    </div>
  )
}

function Stat({
  label,
  value,
  percent,
  className,
  percentClassName,
  loading,
  hint,
  sub,
}: {
  label: string
  value: string
  percent?: string
  className?: string
  percentClassName?: string
  loading?: boolean
  hint?: string
  sub?: string
}) {
  return (
    <div className="min-w-0 rounded-xl border border-line/60 bg-paper/50 px-3 py-3 sm:px-4">
      <div className="flex items-center gap-2 text-xs text-muted" title={hint}>
        <span className="shrink-0">
          {label}
          {hint ? <span className="ml-0.5 text-muted/80">ⓘ</span> : null}
        </span>
        {sub ? <span className="truncate text-[10px] text-muted/80">{sub}</span> : null}
      </div>
      <div
        className={`mt-1 break-all font-mono text-lg font-semibold tabular-nums sm:text-xl ${className || ''}`}
      >
        {loading ? '...' : value}
      </div>
      {percent !== undefined ? (
        <div
          className={`mt-0.5 break-all font-mono text-base font-semibold tabular-nums sm:text-lg ${percentClassName || ''}`}
        >
          {loading ? '' : percent}
        </div>
      ) : null}
    </div>
  )
}

export function ConfirmedUpdatedBadge({
  show,
  percent,
  netValue,
}: {
  show?: boolean
  percent?: number | null
  netValue?: number | null
}) {
  if (!show) return null
  const pctText = formatPct(percent)
  const navText =
    netValue != null && Number.isFinite(netValue) ? netValue.toFixed(4) : '--'
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none tabular-nums ${percent == null || Number.isNaN(percent)
        ? 'border-line bg-paper text-muted'
        : percent >= 0
          ? 'border-rise/35 bg-rise/10 text-rise'
          : 'border-fall/35 bg-fall/10 text-fall'
        }`}
      title="已拉到官方确认涨跌，持仓金额与收益已按确认值更新；下一交易日开盘后自动清除"
    >
      <span>已更新</span>
      {pctText !== '--' ? (
        <>
          <span className="opacity-50">｜</span>
          <span>{pctText}</span>
        </>
      ) : null}
      <span className="opacity-50">｜</span>
      <span>{navText}</span>
    </span>
  )
}

export function SectorTags({sectors}: {sectors?: string[]}) {
  if (!sectors?.length) return <span className="text-xs text-muted">--</span>
  return (
    <div className="flex flex-wrap gap-1">
      {sectors.map((s) => (
        <span
          key={s}
          className="rounded border border-line bg-paper px-1.5 py-0.5 text-[11px] text-ink-soft"
        >
          {s}
        </span>
      ))}
    </div>
  )
}
