import {ArrowDown, ArrowUp} from 'lucide-react'
import type {GroupSummary} from '../../lib/groupStats'
import {cn, formatAmount, formatMoney, formatPct, pctClass} from '@fund01/core'

function SummaryCol({
  label,
  value,
  percent,
  valueClass,
  percentClass,
}: {
  label: string
  value: string
  percent?: string
  valueClass?: string
  percentClass?: string
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={cn('font-mono text-sm font-semibold tabular-nums', valueClass)}>
        {value}
      </div>
      {percent !== undefined ? (
        <div className={cn('font-mono text-[11px] tabular-nums', percentClass)}>
          {percent}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 全部 Tab 下的分组汇总卡片网格。
 * 列数：1 个分组→1 列，偶数个→2 列，奇数个(>1)→3 列。
 * 卡片可点击跳转到对应分组 Tab。
 */
export function GroupSummaryGrid({
  summaries,
  onSelect,
}: {
  summaries: GroupSummary[]
  onSelect: (key: string) => void
}) {
  if (!summaries.length) return null
  const n = summaries.length
  const cols =
    n <= 1 ? 'grid-cols-1' : n % 2 === 0 ? 'grid-cols-2' : 'grid-cols-3'

  return (
    <div className={cn('grid gap-2 px-3 pt-3', cols)}>
      {summaries.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => onSelect(s.key)}
          className="rounded-xl border border-line/70 bg-panel p-3 text-left transition-colors hover:bg-paper-deep"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-ink">{s.label}</span>
            <span className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
              {s.up > 0 ? (
                <span className="inline-flex items-center text-rise">
                  <ArrowUp className="h-3 w-3" />
                  {s.up}
                </span>
              ) : null}
              {s.down > 0 ? (
                <span className="inline-flex items-center text-fall">
                  <ArrowDown className="h-3 w-3" />
                  {s.down}
                </span>
              ) : null}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1">
            <SummaryCol label="资产" value={formatAmount(s.amount)} />
            <SummaryCol
              label="持有收益"
              value={formatMoney(s.cumPnl)}
              percent={formatPct(s.cumPnlPercent)}
              valueClass={pctClass(s.cumPnl)}
              percentClass={pctClass(s.cumPnlPercent)}
            />
            <SummaryCol
              label="当日收益"
              value={formatMoney(s.pnl)}
              percent={formatPct(s.pnlPercent)}
              valueClass={pctClass(s.pnl)}
              percentClass={pctClass(s.pnlPercent)}
            />
          </div>
        </button>
      ))}
    </div>
  )
}
