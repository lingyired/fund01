import {ArrowDown, ArrowUp, PencilLine} from 'lucide-react'
import {Button, Tooltip} from '@radix-ui/themes'
import {cn, formatAmount, formatMoney, formatPct, pctClass} from '@fund01/core'

/** 底部汇总栏（单行）：左侧持仓金额（大字）+ 当日收益 + 涨跌基金数，右侧「修改持仓」入口 */
export function FooterBar({
  amount,
  pnl,
  pnlPercent,
  up,
  down,
  quotePending = false,
  privacyMode = false,
  onEditHoldings,
}: {
  amount: number
  pnl: number
  pnlPercent: number | null
  up: number
  down: number
  /** 行情快照未就绪（列表骨架已渲染）：金额/收益显示 -- */
  quotePending?: boolean
  /** 隐私模式：持仓金额 / 当日收益额显示为 **** */
  privacyMode?: boolean
  /** 打开设置页并定位到「持仓」tab（Chrome 端由 popup 注入实现） */
  onEditHoldings?: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line/70 bg-panel/90 px-3 py-2 text-sm backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-xs text-muted">持仓金额</span>
          <span className="font-mono text-lg font-semibold tabular-nums">
            {privacyMode ? '****' : quotePending ? '--' : `¥${formatAmount(amount)}`}
          </span>
        </div>
        <div className="flex items-baseline gap-1.5 border-l border-line/50 pl-3">
          <span className="shrink-0 text-xs text-muted">当日收益</span>
          <span className={cn('font-mono font-semibold tabular-nums', pctClass(pnl))}>
            {privacyMode ? '****' : quotePending ? '--' : formatMoney(pnl)}
          </span>
          <span
            className={cn('font-mono text-xs tabular-nums', pctClass(pnlPercent))}
          >
            {quotePending ? '--' : formatPct(pnlPercent)}
          </span>
        </div>
        <div className="flex items-center gap-2.5 border-l border-line/50 pl-3 font-mono text-xs tabular-nums">
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
      <Tooltip content="在设置中修改持仓">
        <Button
          size="1"
          variant="soft"
          color="gray"
          onClick={onEditHoldings}
          className="shrink-0"
        >
          <PencilLine className="h-3 w-3" />
          修改持仓
        </Button>
      </Tooltip>
    </div>
  )
}
