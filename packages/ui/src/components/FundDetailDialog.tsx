import {useState} from 'react'
import {LineChart} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import {Button} from './ui/button'
import {FundTrendDialog} from './FundTrendDialog'
import {SectorTags} from './fundBits'
import {formatAmount, formatMoney, formatPct, pctClass} from '@fund01/core'
import type {FundQuoteRow} from '@fund01/core'

/** 按当前 tab 口径计算后的收益数据（由调用方传入） */
export type FundDetailStats = {
  /** 持仓金额（分组 tab 为分组金额） */
  amount: number
  /** 当日收益（元） */
  dayPnl: number
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
 * 点击持仓列表中基金名称时弹出。
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
  const [trendOpen, setTrendOpen] = useState(false)
  if (!row) return null
  const trendPoints = (row.trend || [])
    .filter((p) => p.growth != null)
    .map((p) => ({time: p.time, value: p.growth as number}))
  const dayPnlPercent = row.percent
  const s = stats

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-2xl p-4 sm:p-5">
        <DialogHeader className="pr-6">
          <DialogTitle className="truncate text-base sm:text-lg">
            {row.name}
          </DialogTitle>
          <div className="font-mono text-xs text-muted">{row.code}</div>
        </DialogHeader>

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

        {/* 占比 / 板块 */}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-line/60 bg-paper/50 px-3 py-2">
            <div className="text-[11px] text-muted">占比</div>
            <div className="mt-0.5 font-mono tabular-nums text-ink-soft">
              {formatPct(proportion, 1).replace('+', '')}
            </div>
          </div>
          <div className="rounded-lg border border-line/60 bg-paper/50 px-3 py-2">
            <div className="text-[11px] text-muted">板块</div>
            <div className="mt-0.5">
              <SectorTags sectors={row.sectors} />
            </div>
          </div>
        </div>

        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] text-muted">走势（涨幅）</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => setTrendOpen(true)}
            >
              <LineChart className="h-3.5 w-3.5" />
              查看走势
            </Button>
          </div>
          <div
            className="flex w-full items-center justify-center rounded-md border border-line/50 bg-paper/30 py-3 text-xs text-muted"
          >
            点击「查看走势」加载分时/历史曲线
          </div>
        </div>
      </DialogContent>

      <FundTrendDialog
        open={trendOpen}
        onOpenChange={setTrendOpen}
        code={row.code}
        name={row.name}
        fundKey={row.fundKey || undefined}
        intradayPoints={trendPoints}
        badgePercent={row.percent ?? null}
      />
    </Dialog>
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
    <div className="rounded-lg border border-line/60 bg-paper/50 px-3 py-2">
      <div className="text-[11px] text-muted" title={hint}>
        {label}
        {hint ? <span className="ml-0.5 text-muted/80">ⓘ</span> : null}
      </div>
      <div className="mt-0.5 flex flex-col gap-0.5">{children}</div>
    </div>
  )
}
