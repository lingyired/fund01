import {formatPct, pctClass} from '@fund01/core'

/**
 * 天天基金口径说明（spec 持仓录入与展示统一 D4 定稿文案）。
 * 落地两处：popup 列表「持有收益」表头 ℹ️ + 设置页「名词说明」区块。
 */
export const HOLD_PROFIT_TERMS_NOTE = (
  <div className="space-y-1 text-left">
    <p>
      天天基金的「<b>持仓收益</b>」= 我们的「持有收益」（当前市值 − 当前持仓成本）。
    </p>
    <p>
      天天基金列表另列的「<b>持有收益</b>」（含已赎回的已实现部分）≠ 我们的持有收益。
      Fund01 不追踪已实现，只认前者。
    </p>
  </div>
)

/** 已确认涨跌的徽标：展示「已更新 + 当日涨跌% + 最新净值」，仅 confirmedUpdated 时渲染 */
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
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none tabular-nums ${
        percent == null || Number.isNaN(percent)
          ? 'border-line bg-paper text-muted'
          : percent >= 0
            ? 'border-rise/35 bg-rise/10 text-rise'
            : 'border-fall/35 bg-fall/10 text-fall'
      }`}
      title={
        '已拉到官方确认涨跌，持仓金额与收益已按确认值更新；下一交易日开盘后自动清除'
      }
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
