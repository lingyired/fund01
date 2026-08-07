import {Fragment, useMemo, useState} from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
} from 'lucide-react'
import {Skeleton, Table} from '@radix-ui/themes'
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
import {ConfirmedUpdatedBadge} from '../fundBits'
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
  hint,
  align,
  sort,
  onSort,
}: {
  sortKey: SortKey
  label: string
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
        aria-label={`按${label}排序`}
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
}: {
  rows: DisplayRow[]
  activeTab: string
  tabTotalAmount: number
  loading?: boolean
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
    return (
      <div className="space-y-2 px-3 py-3">
        {Array.from({length: 6}).map((_, i) => (
          <Skeleton key={i} className="h-[52px] w-full" />
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted">
        {isAll ? '暂无基金持仓' : '该分组暂无持仓'}
      </div>
    )
  }

  return (
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
            label="持有收益"
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
        {sortedRows.map(({row, amount, pnl, cumPnl, cumPnlPercent, group}) => {
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
                        title="点击查看详情"
                      >
                        {row.name}
                      </span>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="font-mono text-xs text-muted">
                          {row.code}
                        </span>
                        <span className="font-mono text-xs text-muted">·</span>
                        <span
                          className="font-mono text-xs text-ink-soft"
                          title="上一确认点市值，不含盘中估算浮动"
                        >
                          ¥{formatAmount(amount)}
                        </span>
                        {row.isQdii && row.netValueDate ? (
                          <span
                            className="shrink-0 font-mono text-[10px] text-muted"
                            title="最新已披露净值日期（QDII 延迟披露）"
                          >
                            净值{row.netValueDate.slice(5)}
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
                        {formatMoney(pnl)}
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
                      pctClass(cumPnl),
                    )}
                  >
                    {formatMoney(cumPnl)}
                  </div>
                  <div
                    className={cn(
                      'font-mono text-[11px] tabular-nums',
                      pctClass(cumPnlPercent),
                    )}
                  >
                    {formatPct(cumPnlPercent)}
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
                              {formatAmount(groupAmount(row, g))}
                            </span>
                            <span
                              className={cn(
                                'font-mono tabular-nums',
                                pctClass(groupPnl(row, g)),
                              )}
                            >
                              {formatMoney(groupPnl(row, g))}
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
      />
    </Table.Root>
    </div>
  )
}
