import {Fragment, useMemo, useState} from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ClipboardPaste,
  Info,
  Plus,
} from 'lucide-react'
import {Button, Skeleton, Table, Tooltip} from '@radix-ui/themes'
import type {FundQuoteRow} from '@fund01/core'
import {
  cn,
  formatAmount,
  formatMoney,
  formatPct,
  pctClass,
} from '@fund01/core'
import type {DisplayRow} from '../../lib/groupStats'
import {groupAmount, groupPnl} from '../../lib/groupStats'
import {ConfirmedUpdatedBadge, HOLD_PROFIT_TERMS_NOTE} from '../fundBits'
import {FundDetailDialog} from '../FundDetailDialog'

const COL_W = {day: 84, cum: 84, nav: 76}

type SortKey = 'amount' | 'pnl' | 'cumPnl' | 'netValue'
type SortDir = 'asc' | 'desc'

function sortValue(row: DisplayRow, key: SortKey): number {
  switch (key) {
    case 'amount':
      return row.amount
    case 'pnl':
      // 当日收益为空（QDII 盘中）排到最后
      return row.pnl ?? Number.NEGATIVE_INFINITY
    case 'cumPnl':
      // 未录入成本的行缺乏可比数据，排到最后
      return row.cumPnl ?? Number.NEGATIVE_INFINITY
    case 'netValue': {
      const v = row.row.estimateNetValue ?? row.row.netValue ?? null
      return v != null && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY
    }
  }
}

function SortIcon({active, dir}: {active: boolean; dir?: SortDir}) {
  if (!active) {
    return (
      <ChevronsUpDown className="rt-sort-icon rt-sort-icon--idle" aria-hidden />
    )
  }
  return dir === 'asc' ? (
    <ArrowUp className="rt-sort-icon rt-sort-icon--active" aria-hidden />
  ) : (
    <ArrowDown className="rt-sort-icon rt-sort-icon--active" aria-hidden />
  )
}

function SortableHeader({
  sortKey,
  label,
  sortLabel,
  hint,
  align,
  sort,
  onSort,
}: {
  sortKey: SortKey
  label: React.ReactNode
  /** aria-label 用纯文本（label 为 ReactNode 时需显式给） */
  sortLabel?: string
  /** 表头 label 后的辅助提示语（仅基金列使用） */
  hint?: string
  align?: 'left' | 'right'
  sort: {key: SortKey; dir: SortDir} | null
  onSort: (k: SortKey) => void
}) {
  const active = sort?.key === sortKey
  return (
    <Table.ColumnHeaderCell
      align={align}
      aria-sort={
        active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        type="button"
        className={cn(
          'rt-sort-btn',
          align === 'right' ? 'rt-sort-btn--right' : 'rt-sort-btn--left',
        )}
        onClick={() => onSort(sortKey)}
        aria-label={`按${sortLabel ?? (typeof label === 'string' ? label : '')}排序`}
      >
        {label}
        {hint ? (
          <span className="ml-1 shrink-0 text-[10px] font-normal text-muted">
            {hint}
          </span>
        ) : null}
        <SortIcon active={active} dir={sort?.dir} />
      </button>
    </Table.ColumnHeaderCell>
  )
}

export function FundList({
  rows,
  activeTab,
  tabTotalAmount,
  loading,
  quotePending = false,
  privacyMode = false,
  onAddFund,
  onImportHoldings,
}: {
  rows: DisplayRow[]
  activeTab: string
  tabTotalAmount: number
  loading?: boolean
  /** 行情快照未就绪（列表骨架已渲染）：数值列显示 --、顶部附加载提示 */
  quotePending?: boolean
  /** 隐私模式：持仓金额 / 当日收益额 / 持有收益额显示为 **** */
  privacyMode?: boolean
  /** 空状态「添加持仓」入口：打开设置页持仓 tab 并定位到「添加持仓」区块 */
  onAddFund?: () => void
  /** 空状态「批量导入」入口：打开设置页持仓 tab 并定位到「导入持仓」区块 */
  onImportHoldings?: () => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [detailRow, setDetailRow] = useState<FundQuoteRow | null>(null)
  const isAll = activeTab === 'all'

  const [sort, setSort] = useState<{key: SortKey; dir: SortDir} | null>(null)
  function handleSort(key: SortKey) {
    setSort((cur) =>
      cur && cur.key === key
        ? {key, dir: cur.dir === 'asc' ? 'desc' : 'asc'}
        : // 金额/收益类默认降序更符合直觉；再次点击切换方向
          {key, dir: 'desc'},
    )
  }

  // 默认（sort 为 null）保持入参顺序（后端按持仓金额降序），仅点击表头后才排序，
  // 避免污染 PopupLayout 的汇总计算。
  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort(
      (a, b) => (sortValue(a, sort.key) - sortValue(b, sort.key)) * factor,
    )
  }, [rows, sort])

  function toggleExpand(code: string) {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  const detail = detailRow
    ? (() => {
        const d = rows.find((r) => r.row.code === detailRow.code)
        if (!d) return null
        return {
          display: d,
          stats: {
            amount: d.amount,
            dayPnl: d.pnl,
            cumPnl: d.cumPnl,
            cumPnlPercent: d.cumPnlPercent,
            latestNav:
              detailRow.estimateNetValue ?? detailRow.netValue ?? null,
          },
          proportion:
            tabTotalAmount > 0 ? (d.amount / tabTotalAmount) * 100 : null,
        }
      })()
    : null

  if (loading && !rows.length) {
    // 加载中（数据在途，非「暂无持仓」）：spinner + 文案 + skeleton 行，
    // 与下方空状态（暂无基金持仓 + 引导）视觉区分。
    // 注意：有持仓时上游会用本地配置合成骨架行（rows 非空），走不到这里——
    // 那种场景由 quotePending 驱动「真实列表 + 数值 --」的占位渲染（见下）。
    return (
      <div className="px-3 py-3">
        <div className="mb-3 flex items-center gap-2 text-xs text-muted">
          <span
            aria-hidden
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-line border-t-accent"
          />
          正在加载数据…
        </div>
        <div className="space-y-2">
          {Array.from({length: 6}).map((_, i) => (
            <Skeleton key={i} className="h-[52px] w-full" />
          ))}
        </div>
      </div>
    )
  }

  if (rows.length === 0) {
    // 初始状态（全部 tab 无持仓）：引导去设置页添加/导入，并提示两种方式
    if (isAll && (onAddFund || onImportHoldings)) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line/70 bg-paper/50 px-4 py-10 text-center">
          <Plus className="h-8 w-8 text-muted" />
          <div>
            <p className="text-sm font-medium text-ink">暂无基金持仓</p>
            <p
              className="mx-auto mt-1 text-xs leading-relaxed text-muted"
              style={{maxWidth: 280}}
            >
              添加第一只基金即可开始跟踪收益：可以单独添加持仓，也可以从基金 App 批量导入持仓。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {onAddFund ? (
              <Button size="1" variant="soft" onClick={onAddFund}>
                <Plus className="h-3 w-3" />
                添加持仓
              </Button>
            ) : null}
            {onImportHoldings ? (
              <Button size="1" variant="outline" onClick={onImportHoldings}>
                <ClipboardPaste className="h-3 w-3" />
                批量导入
              </Button>
            ) : null}
          </div>
        </div>
      )
    }
    return (
      <div className="py-10 text-center text-sm text-muted">
        {isAll ? '暂无基金持仓' : '该分组暂无持仓'}
      </div>
    )
  }

  return (
    <div>
    {quotePending ? (
      // 行情在途：持仓结构已用本地配置渲染，仅数值待填（对齐 IndexBar 占位卡片体验）
      <div className="mb-3 flex items-center gap-2 px-1 text-xs text-muted">
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-line border-t-accent"
        />
        正在加载行情…
      </div>
    ) : null}
    <div className="overflow-hidden rounded-xl border border-line/70 bg-paper shadow-card">
    <Table.Root
      variant="surface"
      className="rt-fund-table w-full"
      style={{tableLayout: 'fixed'}}
    >
      <Table.Header className="rt-sticky-thead">
        <Table.Row>
          {/* 基金：按持仓金额排序 */}
          <SortableHeader
            sortKey="amount"
            label="基金（持仓金额）"
            hint="点击基金名称查看走势"
            sort={sort}
            onSort={handleSort}
          />
          <SortableHeader
            sortKey="pnl"
            label="当日收益"
            align="right"
            sort={sort}
            onSort={handleSort}
          />
          <SortableHeader
            sortKey="cumPnl"
            sortLabel="持有收益"
            label={
              <span className="inline-flex items-center gap-0.5">
                持有收益
                <Tooltip content={HOLD_PROFIT_TERMS_NOTE} maxWidth="280px">
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="持有收益口径说明"
                    className="cursor-help text-muted hover:text-ink"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Info className="h-3 w-3" />
                  </span>
                </Tooltip>
              </span>
            }
            align="right"
            sort={sort}
            onSort={handleSort}
          />
          <SortableHeader
            sortKey="netValue"
            label="最新净值"
            align="right"
            sort={sort}
            onSort={handleSort}
          />
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {sortedRows.map(({row, amount, pnl, cumPnl, cumPnlPercent}) => {
          const allocKeys = Object.keys(row.allocations || {})
          const canExpand = isAll && allocKeys.length > 1
          const expandedRow = expanded.has(row.code)
          const latestNav = row.estimateNetValue ?? row.netValue ?? null
          return (
            <Fragment key={row.code}>
              <Table.Row>
                {/* 基金：名称 + code·资产 + 已更新徽标 */}
                <Table.Cell>
                  <div className="flex min-w-0 items-center gap-1.5">
                    {canExpand ? (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleExpand(row.code)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            toggleExpand(row.code)
                          }
                        }}
                        className="shrink-0 cursor-pointer text-muted hover:text-ink"
                        aria-label="展开分组"
                      >
                        {expandedRow ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </span>
                    ) : null}
                    <div className="min-w-0">
                      <Tooltip content="点击查看详情">
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={() => setDetailRow(row)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setDetailRow(row)
                            }
                          }}
                          className={cn(
                            'block max-w-full cursor-pointer truncate text-left text-sm font-medium hover:underline',
                            pctClass(pnl),
                          )}
                        >
                          {row.name}
                        </span>
                      </Tooltip>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="font-mono text-xs text-muted">
                          {row.code}
                        </span>
                        <span className="font-mono text-xs text-muted">·</span>
                        <span
                          className="font-mono text-xs text-ink-soft"
                          title="上一确认点市值，不含盘中估算浮动"
                        >
                          {privacyMode ? '****' : quotePending ? '--' : `¥${formatAmount(amount)}`}
                        </span>
                        {row.isQdii && row.netValueDate ? (
                          <span
                            className="shrink-0 font-mono text-[10px] text-muted"
                            title="最新已披露净值日期（QDII 延迟披露）"
                          >
                            净值{row.netValueDate.slice(5)}
                          </span>
                        ) : null}
                        {row.time ? (
                          <span
                            className="shrink-0 font-mono text-[10px] leading-none text-muted opacity-60 tabular-nums"
                            title="该基金行情最后更新时间"
                          >
                            {row.time}
                          </span>
                        ) : null}
                        <ConfirmedUpdatedBadge
                          show={row.confirmedUpdated}
                          percent={row.dayGrowth ?? row.percent}
                          netValue={row.netValue}
                        />
                      </div>
                    </div>
                  </div>
                </Table.Cell>

                {/* 当日收益（无当日涨跌幅时显示「-」灰色：QDII 盘中/新基金/错误态） */}
                <Table.Cell className="text-right" style={{width: COL_W.day}}>
                  {row.percent == null ? (
                    <>
                      <div className="font-mono text-[13px] font-semibold text-muted">-</div>
                      <div className="font-mono text-[11px] text-muted">-</div>
                    </>
                  ) : (
                    <>
                      <div
                        className={cn(
                          'font-mono text-[13px] font-semibold tabular-nums',
                          pctClass(pnl),
                        )}
                      >
                        {privacyMode ? '****' : formatMoney(pnl)}
                      </div>
                      <div
                        className={cn(
                          'font-mono text-[11px] tabular-nums',
                          pctClass(row.percent),
                        )}
                      >
                        {formatPct(row.percent)}
                      </div>
                    </>
                  )}
                </Table.Cell>

                {/* 持有收益 */}
                <Table.Cell className="text-right" style={{width: COL_W.cum}}>
                  <div
                    className={cn(
                      'font-mono text-[13px] font-semibold tabular-nums',
                      quotePending ? 'text-muted' : pctClass(cumPnl),
                    )}
                  >
                    {quotePending ? '--' : privacyMode ? '****' : formatMoney(cumPnl)}
                  </div>
                  <div
                    className={cn(
                      'font-mono text-[11px] tabular-nums',
                      quotePending ? 'text-muted' : pctClass(cumPnlPercent),
                    )}
                  >
                    {quotePending ? '--' : formatPct(cumPnlPercent)}
                  </div>
                </Table.Cell>

                {/* 最新净值（带当日涨跌%） */}
                <Table.Cell className="text-right" style={{width: COL_W.nav}}>
                  <div className="font-mono text-[13px] tabular-nums text-ink-soft">
                    {latestNav != null && Number.isFinite(latestNav)
                      ? latestNav.toFixed(4)
                      : '--'}
                  </div>
                  <div
                    className={cn(
                      'font-mono text-[11px] tabular-nums',
                      row.percent == null ? 'text-muted' : pctClass(row.percent),
                    )}
                  >
                    {row.percent == null ? '-' : formatPct(row.percent)}
                  </div>
                </Table.Cell>
              </Table.Row>

              {/* 展开：分组明细（仅全部 tab 多分组基金） */}
              {canExpand && expandedRow ? (
                <Table.Row>
                  <Table.Cell colSpan={4}>
                    <div className="border-t border-line/30 bg-paper-deep/40 px-3 py-2">
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                        {allocKeys.map((g) => (
                          <div
                            key={g}
                            className="flex items-center gap-1.5"
                          >
                            <span className="text-muted">{g || '未分组'}</span>
                            <span className="font-mono tabular-nums">
                              {privacyMode ? '****' : formatAmount(groupAmount(row, g))}
                            </span>
                            <span
                              className={cn(
                                'font-mono tabular-nums',
                                pctClass(groupPnl(row, g)),
                              )}
                            >
                              {privacyMode ? '****' : formatMoney(groupPnl(row, g))}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Table.Cell>
                </Table.Row>
              ) : null}
            </Fragment>
          )
        })}
      </Table.Body>
      <FundDetailDialog
        open={!!detailRow}
        onOpenChange={(v) => !v && setDetailRow(null)}
        row={detailRow}
        proportion={detail?.proportion ?? null}
        stats={detail?.stats ?? null}
        privacyMode={privacyMode}
      />
    </Table.Root>
    </div>
    </div>
  )
}
