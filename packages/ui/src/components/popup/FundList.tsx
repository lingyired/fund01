import {Fragment, useState} from 'react'
import {ChevronDown, ChevronRight} from 'lucide-react'
import {Table} from '@radix-ui/themes'
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
import {Skeleton} from '../ui/skeleton'

const COL_W = {day: 84, cum: 84, nav: 76}

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
    <Table.Root
      variant="surface"
      className="rt-fund-table w-full"
      style={{tableLayout: 'fixed'}}
    >
      <Table.Header className="rt-sticky-thead">
        <Table.Row>
          <Table.ColumnHeaderCell>基金</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell align="right">当日收益</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell align="right">持有收益</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell align="right">最新净值</Table.ColumnHeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map(({row, amount, pnl, cumPnl, cumPnlPercent, group}) => {
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
                      <button
                        type="button"
                        onClick={() => toggleExpand(row.code)}
                        className="shrink-0 text-muted hover:text-ink"
                        aria-label="展开分组"
                      >
                        {expandedRow ? (
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
                        className="block max-w-full truncate text-left text-sm font-medium text-ink hover:underline"
                        title="点击查看详情"
                      >
                        {row.name}
                      </button>
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
                        <ConfirmedUpdatedBadge
                          show={row.confirmedUpdated}
                          percent={row.dayGrowth ?? row.percent}
                          netValue={row.netValue}
                        />
                      </div>
                    </div>
                  </div>
                </Table.Cell>

                {/* 当日收益 */}
                <Table.Cell className="text-right" style={{width: COL_W.day}}>
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
                      pctClass(row.percent),
                    )}
                  >
                    {formatPct(row.percent)}
                  </div>
                </Table.Cell>
              </Table.Row>

              {/* 展开：分组明细（仅全部 tab 多分组基金） */}
              {canExpand && expandedRow ? (
                <Table.Row>
                  <Table.Cell colSpan={4}>
                    <div className="border-t border-line/30 bg-paper/30 px-3 py-2">
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
  )
}
