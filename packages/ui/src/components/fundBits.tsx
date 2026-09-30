import {formatPct, pctClass} from '@fund01/core'
import type {SectorQuote} from '@fund01/core'

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

/** 已确认涨跌的徽标：只表达确认状态，涨跌和净值由表格右侧专栏展示，避免重复。 */
export function ConfirmedUpdatedBadge({
  show,
  compact,
}: {
  show?: boolean
  compact?: boolean
}) {
  if (!show) return null
  return (
    <span
      className="inline-flex shrink-0 items-center rounded border border-emerald-400/40 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-emerald-500"
      title={
        '已拉到官方确认涨跌，持仓金额与收益已按确认值更新；下一交易日开盘后自动清除'
      }
    >
      {compact ? '已更新' : '今日已更新'}
    </span>
  )
}

/**
 * 关联板块标签。
 *
 * 优先渲染 `quotes`（小倍 `relatedIndustryV2`：板块名 + **板块指数**实时涨跌幅）；
 * 仅在没有板块行情时回落纯文本 `sectors`（自研推断标签，无涨跌）。
 *
 * ⚠️ 展示口径：涨跌幅是**板块指数**的，不是本基金的收益，禁止与「当日收益」并列比较。
 * 境内板块随 A 股盘中变动；美股板块为「北京 21:30 → 次日 04:00」场次，白天看到的是昨夜值。
 */
export function SectorTags({
  sectors,
  quotes,
}: {
  sectors?: string[]
  quotes?: SectorQuote[]
}) {
  if (quotes?.length) {
    return (
      <div className="flex flex-wrap gap-1">
        {quotes.map((q) => (
          <span
            key={q.name}
            title={
              `${q.name}${q.indexCode ? `（${q.indexCode}）` : ''}` +
              '　板块指数涨跌幅，非本基金收益' +
              (q.market === 'USA' ? '；美股场次：北京 21:30 → 次日 04:00' : '')
            }
            className="inline-flex items-center gap-1 rounded border border-line bg-paper px-1.5 py-0.5 text-[11px] leading-none"
          >
            <span className="text-ink-soft">{q.name}</span>
            {q.change != null ? (
              <span className={`font-mono tabular-nums ${pctClass(q.change)}`}>
                {formatPct(q.change)}
              </span>
            ) : null}
          </span>
        ))}
      </div>
    )
  }
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
