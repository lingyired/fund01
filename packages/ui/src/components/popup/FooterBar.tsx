import {ArrowDown, ArrowUp} from 'lucide-react'
import {cn, formatAmount, formatMoney, formatPct, pctClass} from '@fund01/core'

/** 底部汇总栏（单行）：左侧当日收益（label+值+百分比），右侧总资产与涨跌基金数（无 label） */
export function FooterBar({
  amount,
  pnl,
  pnlPercent,
  up,
  down,
}: {
  amount: number
  pnl: number
  pnlPercent: number | null
  up: number
  down: number
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-line/70 bg-panel/90 px-3 py-2 text-sm backdrop-blur">
      <div className="flex items-baseline gap-1.5">
        <span className="shrink-0 text-xs text-muted">当日收益</span>
        <span className={cn('font-mono font-semibold tabular-nums', pctClass(pnl))}>
          {formatMoney(pnl)}
        </span>
        <span
          className={cn('font-mono text-xs tabular-nums', pctClass(pnlPercent))}
        >
          {formatPct(pnlPercent)}
        </span>
      </div>
      <div className="flex items-center gap-2.5 font-mono text-xs tabular-nums">
        <span className="text-ink-soft">¥{formatAmount(amount)}</span>
        {up > 0 ? (
          <span className="inline-flex items-center text-rise">
            <ArrowUp className="h-3 w-3" />
            {up}
          </span>
        ) : null}
        {down > 0 ? (
          <span className="inline-flex items-center text-fall">
            <ArrowDown className="h-3 w-3" />
            {down}
          </span>
        ) : null}
      </div>
    </div>
  )
}
