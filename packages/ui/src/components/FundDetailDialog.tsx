import {X} from 'lucide-react'
import {Dialog} from '@radix-ui/themes'
import {FundTrendChart} from './FundTrendChart'
import {SectorTags} from './fundBits'
import {formatAmount, formatMoney, formatPct, pctClass} from '@fund01/core'
import type {FundQuoteRow} from '@fund01/core'

/** 按当前 tab 口径计算后的收益数据（由调用方传入） */
export type FundDetailStats = {
  /** 持仓金额（分组 tab 为分组金额） */
  amount: number
  /** 当日收益（元）；当日收益为空（QDII 盘中）时为 null，UI 渲染「--」 */
  dayPnl: number | null
  /** 持有收益（元，null 表示未录入成本） */
  cumPnl: number | null
  /** 持有收益率(%) */
  cumPnlPercent: number | null
  /** 最新净值（盘中估值 / 确认净值） */
  latestNav: number | null
}

/**
 * 基金详情弹窗：展示「持仓金额 / 当日收益 / 持有收益 / 最新净值」
 * 以及持仓列表中精简掉的「占比 / 板块 / 走势」。
 * 点击持仓列表中基金名称时弹出。走势图直接内嵌在底部，无需二次点击。
 */
export function FundDetailDialog({
  open,
  onOpenChange,
  row,
  proportion,
  stats,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  row: FundQuoteRow | null
  /** 占比（%），由调用方按当前 tab 口径计算后传入 */
  proportion: number | null
  /** 收益数据，由调用方按当前 tab 口径计算后传入 */
  stats: FundDetailStats | null
}) {
  if (!row) return null
  const trendPoints = (row.trend || [])
    .filter((p) => p.growth != null)
    .map((p) => ({time: p.time, value: p.growth as number}))
  const dayPnlPercent = row.percent
  const s = stats
  // popup 模式（URL 无 ?tab=1）下详情 dialog 铺满整个 popup 视口；tab 模式保持居中弹窗。
  const isPopupMode =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('tab') !== '1'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        className={
          'rt-popup-dialog flex flex-col overflow-y-auto ' +
          (isPopupMode
            ? 'fixed inset-0 z-50 max-w-none rounded-none p-3 sm:p-4'
            : 'max-h-[88vh] w-[calc(100%-1rem)] max-w-2xl p-4 sm:p-5')
        }
      >
        <div className="mb-4 flex items-end gap-1.5 pr-12">
          <Dialog.Title
            size="4"
            mb="0"
            className="font-display min-w-0 truncate text-base leading-none sm:text-lg"
          >
            {row.name}
          </Dialog.Title>
          <span className="shrink-0 self-end font-mono text-[11px] leading-none text-muted">
            {row.code}
          </span>
        </div>

        {/* 收益数据：与列表一致，4 项两行展示 */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <DetailStat label="持仓金额">
            <span className="font-mono tabular-nums text-ink-soft">
              {s ? formatAmount(s.amount) : '--'}
            </span>
          </DetailStat>
          <DetailStat label="当日收益">
            <span className={`font-mono tabular-nums ${pctClass(s?.dayPnl)}`}>
              {s ? formatMoney(s.dayPnl) : '--'}
            </span>
            <span className={`font-mono text-xs tabular-nums ${pctClass(dayPnlPercent)}`}>
              {formatPct(dayPnlPercent)}
            </span>
          </DetailStat>
          <DetailStat label="持有收益" hint="当前市值 − 持仓成本；未录入成本单价显示 --">
            <span className={`font-mono tabular-nums ${pctClass(s?.cumPnl)}`}>
              {s ? formatMoney(s.cumPnl) : '--'}
            </span>
            <span className={`font-mono text-xs tabular-nums ${pctClass(s?.cumPnlPercent)}`}>
              {s ? formatPct(s.cumPnlPercent) : '--'}
            </span>
          </DetailStat>
          <DetailStat label="最新净值" hint="盘中为估值，确认后为披露净值">
            <span className="font-mono tabular-nums text-ink-soft">
              {s && s.latestNav != null && Number.isFinite(s.latestNav)
                ? s.latestNav.toFixed(4)
                : '--'}
            </span>
            <span className={`font-mono text-xs tabular-nums ${pctClass(dayPnlPercent)}`}>
              {formatPct(dayPnlPercent)}
            </span>
          </DetailStat>
        </div>

        {/* 占比 / 板块（暂隐藏）
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-line/60 bg-paper-deep/50 px-3 py-2">
            <div className="text-[11px] text-muted">占比</div>
            <div className="mt-0.5 font-mono tabular-nums text-ink-soft">
              {formatPct(proportion, 1).replace('+', '')}
            </div>
          </div>
          <div className="rounded-lg border border-line/60 bg-paper-deep/50 px-3 py-2">
            <div className="text-[11px] text-muted">板块</div>
            <div className="mt-0.5">
              <SectorTags sectors={row.sectors} />
            </div>
          </div>
        </div>
        */}

        {/* 走势（涨幅）：直接内嵌在底部，无需额外点击 */}
        <div className="mt-3 flex-1 border-t border-line/60 pt-3">
          <div className="mb-1 text-[11px] text-muted">走势（涨幅）</div>
          <FundTrendChart
            active={open}
            code={row.code}
            intradayPoints={trendPoints}
            badgePercent={row.percent ?? null}
            fundKey={row.fundKey || undefined}
            chartHeight={isPopupMode ? 360 : undefined}
          />
        </div>

        <Dialog.Close className="rt-dialog-close" aria-label="关闭">
          <X className="h-4 w-4" />
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Root>
  )
}

function DetailStat({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-line/60 bg-paper-deep/50 px-3 py-2">
      <div className="text-[11px] text-muted" title={hint}>
        {label}
        {hint ? <span className="ml-0.5 text-muted/80">ⓘ</span> : null}
      </div>
      <div className="mt-0.5 flex flex-col gap-0.5">{children}</div>
    </div>
  )
}
