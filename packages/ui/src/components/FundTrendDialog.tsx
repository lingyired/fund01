import {useEffect, useMemo, useState} from 'react'
import ReactECharts from 'echarts-for-react'
import type {FundHistoryPayload, FundHistoryRange} from '@fund01/core'
import {usePorts} from '../context'
import {cn, formatPct, pctClass} from '@fund01/core'
import {Button} from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import type {TrendPoint} from './SparkTrend'

type TabKey = 'intraday' | FundHistoryRange

const TABS: {key: TabKey; label: string}[] = [
  {key: 'intraday', label: '分时涨幅'},
  {key: '3m', label: '近3月'},
  {key: '1y', label: '近1年'},
  {key: '3y', label: '近3年'},
  {key: 'since', label: '成立以来'},
]

const HISTORY_RANGES: FundHistoryRange[] = ['3m', '1y', '3y', 'since']

export function FundTrendDialog({
  open,
  onOpenChange,
  code,
  name,
  intradayPoints,
  badgePercent,
  fundKey,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  code: string
  name: string
  /** 预加载的盘中分时点（fund123 数据源刷新时已拉取）；为空则懒加载 */
  intradayPoints?: TrendPoint[]
  badgePercent?: number | null
  /** fund123 的 productId，懒加载分时走势时需要；缺失则 SW 内 searchFund 兜底 */
  fundKey?: string
}) {
  const ports = usePorts()
  const [range, setRange] = useState<TabKey>('intraday')
  const [byRange, setByRange] = useState<
    Partial<Record<FundHistoryRange, FundHistoryPayload>>
  >({})
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [loadingSince, setLoadingSince] = useState(false)
  const [error, setError] = useState('')
  const [chartHeight, setChartHeight] = useState(220)

  // 懒加载盘中分时（FundMNFInfo 数据源：刷新时不拉分时，打开 dialog 才拉）
  const [lazyIntraday, setLazyIntraday] = useState<TrendPoint[]>([])
  const [loadingIntraday, setLoadingIntraday] = useState(false)
  const [intradayError, setIntradayError] = useState('')

  const effectiveIntraday =
    intradayPoints && intradayPoints.length ? intradayPoints : lazyIntraday

  const intradayPct =
    badgePercent != null
      ? badgePercent
      : (effectiveIntraday[effectiveIntraday.length - 1]?.value ?? null)

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    const apply = () => setChartHeight(mq.matches ? 300 : 220)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    if (!open || !code) return
    setRange('intraday')
  }, [open, code])

  // 懒加载盘中分时走势：仅在预加载点为空时（FundMNFInfo 数据源）
  useEffect(() => {
    if (!open || !code) return
    if (intradayPoints && intradayPoints.length) return
    if (lazyIntraday.length) return
    let cancelled = false
    setLoadingIntraday(true)
    setIntradayError('')
    ports.data.fetchFundIntraday(fundKey || code)
      .then((points) => {
        if (cancelled) return
        setLazyIntraday(
          (points || [])
            .filter((p) => p.growth != null)
            .map((p) => ({time: p.time, value: p.growth as number})),
        )
      })
      .catch((e: Error) => {
        if (cancelled) return
        setIntradayError(e?.message || '盘中走势加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoadingIntraday(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, code, fundKey, name, intradayPoints, lazyIntraday.length])

  useEffect(() => {
    if (!open || !code) return
    let cancelled = false
    setLoadingHistory(true)
    setError('')
    setByRange({})

    const prefetch = HISTORY_RANGES.filter((k) => k !== 'since')
    Promise.allSettled(prefetch.map((r) => ports.data.fetchFundHistory(code, r)))
      .then((results) => {
        if (cancelled) return
        const next: Partial<Record<FundHistoryRange, FundHistoryPayload>> = {}
        results.forEach((res, i) => {
          if (res.status === 'fulfilled') next[prefetch[i]] = res.value
        })
        setByRange(next)
        if (!Object.keys(next).length) {
          const firstFail = results.find((r) => r.status === 'rejected') as
            | PromiseRejectedResult
            | undefined
          setError((firstFail?.reason as Error)?.message || '加载失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, code])

  useEffect(() => {
    if (!open || !code || range !== 'since') return
    if (byRange.since) return
    let cancelled = false
    setLoadingSince(true)
    setError('')
    ports.data.fetchFundHistory(code, 'since')
      .then((data) => {
        if (cancelled) return
        setByRange((prev) => ({...prev, since: data}))
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoadingSince(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, code, range, byRange.since])

  const historyData = range === 'intraday' ? null : (byRange[range] ?? null)
  const loading =
    range === 'intraday'
      ? loadingIntraday
      : range === 'since'
        ? loadingSince
        : loadingHistory

  const tabPercent = (key: TabKey): number | null => {
    if (key === 'intraday') return intradayPct
    return byRange[key]?.periodPercent ?? null
  }

  const option = useMemo(() => {
    const styles = getComputedStyle(document.documentElement)
    const muted = styles.getPropertyValue('--app-muted').trim() || '#6b7785'
    const line = styles.getPropertyValue('--app-line').trim() || '#c8d0d8'

    if (range === 'intraday') {
      const points = effectiveIntraday
      if (!points.length) return null
      const values = points.map((p) => p.value)
      const lastPct = values[values.length - 1] ?? 0
      const up = lastPct >= 0
      const color = up ? '#d7263d' : '#0f8a5f'
      const lastLabel = `${lastPct > 0 ? '+' : ''}${lastPct.toFixed(2)}%`
      return buildChartOption({
        labels: points.map((p) => p.time),
        values,
        fullDates: points.map((p) => p.time),
        extras: points.map(() => null as number | null),
        extraLabel: '',
        color,
        muted,
        line,
        lastLabel,
      })
    }

    const points = historyData?.points || []
    if (!points.length) return null
    const values = points.map((p) => p.percent ?? 0)
    const lastPct = values[values.length - 1] ?? 0
    const up = lastPct >= 0
    const color = up ? '#d7263d' : '#0f8a5f'
    const lastLabel = `${lastPct > 0 ? '+' : ''}${lastPct.toFixed(2)}%`
    return buildChartOption({
      labels: points.map((p) => p.date.slice(5)),
      values,
      fullDates: points.map((p) => p.date),
      extras: points.map((p) => p.netValue),
      extraLabel: '净值',
      color,
      muted,
      line,
      lastLabel,
    })
  }, [range, effectiveIntraday, historyData])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-2xl p-4 sm:w-[calc(100%-2rem)] sm:max-w-4xl sm:p-5 lg:max-w-5xl">
        <DialogHeader className="pr-6">
          <DialogTitle className="truncate text-base sm:text-lg">
            {name || '基金走势'}
          </DialogTitle>
        </DialogHeader>

        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible">
          {TABS.map((r) => {
            const pct = tabPercent(r.key)
            const selected = range === r.key
            const tabLoading =
              r.key !== 'intraday' &&
              pct == null &&
              (r.key === 'since' ? loadingSince : loadingHistory)
            return (
              <Button
                key={r.key}
                type="button"
                size="sm"
                variant="outline"
                className={cn(
                  'h-auto min-h-9 shrink-0 flex-col gap-0.5 px-2.5 py-1.5 text-xs sm:px-3',
                  selected
                    ? 'border-ink/40 bg-paper-deep text-ink shadow-[inset_0_0_0_1px_var(--app-ink)] hover:bg-paper-deep'
                    : 'text-ink-soft',
                )}
                onClick={() => setRange(r.key)}
              >
                <span className={selected ? 'font-semibold text-ink' : undefined}>
                  {r.label}
                </span>
                <span
                  className={cn(
                    'text-[10px] font-semibold tabular-nums leading-none',
                    tabLoading ? 'opacity-60' : pctClass(pct),
                  )}
                >
                  {tabLoading ? '…' : formatPct(pct)}
                </span>
              </Button>
            )
          })}
        </div>

        <div className="mt-2" style={{minHeight: chartHeight}}>
          {range === 'intraday' && intradayError && !option ? (
            <div
              className="flex items-center justify-center text-sm text-rise"
              style={{height: chartHeight}}
            >
              {intradayError}
            </div>
          ) : range !== 'intraday' && error && !option ? (
            <div
              className="flex items-center justify-center text-sm text-rise"
              style={{height: chartHeight}}
            >
              {error}
            </div>
          ) : loading && !option ? (
            <div
              className="flex items-center justify-center text-sm text-muted"
              style={{height: chartHeight}}
            >
              加载中...
            </div>
          ) : option ? (
            <ReactECharts
              option={option}
              style={{height: chartHeight, width: '100%'}}
              opts={{renderer: 'canvas'}}
              notMerge
            />
          ) : (
            <div
              className="flex items-center justify-center text-sm text-muted"
              style={{height: chartHeight}}
            >
              暂无该周期数据
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function buildChartOption({
  labels,
  values,
  fullDates,
  extras,
  extraLabel,
  color,
  muted,
  line,
  lastLabel,
}: {
  labels: string[]
  values: number[]
  fullDates: string[]
  extras: (number | null)[]
  extraLabel: string
  color: string
  muted: string
  line: string
  lastLabel: string
}) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = Math.max((max - min) * 0.12, 0.05)

  return {
    animation: false,
    grid: {left: 44, right: 56, top: 28, bottom: 32},
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      backgroundColor: 'rgba(21,32,43,0.92)',
      borderWidth: 0,
      padding: [6, 8],
      textStyle: {color: '#fff', fontSize: 11},
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params]
        const p = list[0] as {
          axisValue?: string
          value?: number | string
          dataIndex?: number
        }
        if (!p || p.value == null || p.value === '') return ''
        const idx = p.dataIndex ?? 0
        const fullDate = fullDates[idx] || p.axisValue || ''
        const n = Number(p.value)
        const extra = extras[idx]
        const extraText =
          extraLabel && extra != null
            ? `<br/>${extraLabel} ${Number(extra).toFixed(4)}`
            : ''
        return `${fullDate}<br/><b>${n > 0 ? '+' : ''}${n.toFixed(2)}%</b>${extraText}`
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: false,
      axisLine: {lineStyle: {color: line}},
      axisTick: {show: false},
      axisLabel: {
        color: muted,
        fontSize: 10,
        interval: Math.max(0, Math.floor(labels.length / 4) - 1),
        hideOverlap: true,
      },
    },
    yAxis: {
      type: 'value',
      scale: true,
      min: Number((min - pad).toFixed(2)),
      max: Number((max + pad).toFixed(2)),
      axisLine: {show: false},
      axisTick: {show: false},
      splitLine: {lineStyle: {color: line, type: 'dashed'}},
      axisLabel: {
        color: muted,
        fontSize: 10,
        formatter: (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`,
      },
    },
    series: [
      {
        type: 'line',
        data: values,
        showSymbol: false,
        smooth: 0.2,
        lineStyle: {width: 2, color},
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              {offset: 0, color: `${color}33`},
              {offset: 1, color: `${color}00`},
            ],
          },
        },
        endLabel: {
          show: true,
          formatter: lastLabel,
          color,
          fontSize: 12,
          fontWeight: 700,
          distance: 6,
        },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: {color: muted, type: 'dashed', width: 1},
          data: [{yAxis: 0}],
          label: {show: false},
        },
      },
    ],
  }
}
