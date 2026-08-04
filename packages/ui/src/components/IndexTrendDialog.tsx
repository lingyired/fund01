import {useEffect, useMemo, useState} from 'react'
import ReactECharts from 'echarts-for-react'
import type {IndexHistoryPayload, IndexHistoryRange, IndexItem} from '@fund01/core'
import {usePorts} from '../context'
import {Button, Dialog} from '@radix-ui/themes'
import {X} from 'lucide-react'
import {cn, formatPct, pctClass} from '@fund01/core'

const RANGES: {key: IndexHistoryRange; label: string}[] = [
  {key: '1m', label: '近一月'},
  {key: '3m', label: '近3月'},
  {key: '6m', label: '近6月'},
  {key: '1y', label: '近1年'},
  {key: '3y', label: '近3年'},
]

export function IndexTrendDialog({
  item,
  open,
  onOpenChange,
}: {
  item: IndexItem | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const ports = usePorts()
  const [range, setRange] = useState<IndexHistoryRange>('1m')
  const [byRange, setByRange] = useState<
    Partial<Record<IndexHistoryRange, IndexHistoryPayload>>
  >({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [chartHeight, setChartHeight] = useState(220)

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    const apply = () => setChartHeight(mq.matches ? 300 : 220)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    if (!open) return
    setRange('1m')
  }, [open, item?.code])

  useEffect(() => {
    if (!open || !item) return
    let cancelled = false
    setLoading(true)
    setError('')
    setByRange({})

    Promise.allSettled(
      RANGES.map((r) => ports.data.fetchIndexHistory(item.code, r.key)),
    )
      .then((results) => {
        if (cancelled) return
        const next: Partial<Record<IndexHistoryRange, IndexHistoryPayload>> = {}
        results.forEach((res, i) => {
          if (res.status === 'fulfilled') next[RANGES[i].key] = res.value
        })
        setByRange(next)
        if (!Object.keys(next).length) {
          const firstFail = results.find((r) => r.status === 'rejected') as
            | PromiseRejectedResult
            | undefined
          setError(
            (firstFail?.reason as Error)?.message || '加载失败',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, item?.code])

  const data = byRange[range] ?? null

  const option = useMemo(() => {
    const points = data?.points || []
    if (!points.length) return null

    const styles = getComputedStyle(document.documentElement)
    const muted = styles.getPropertyValue('--app-muted').trim() || '#6b7785'
    const line = styles.getPropertyValue('--app-line').trim() || '#c8d0d8'
    const values = points.map((p) => p.percent ?? 0)
    const lastPct = values[values.length - 1] ?? 0
    const up = lastPct >= 0
    const color = up ? '#d7263d' : '#0f8a5f'
    const lastLabel = `${lastPct > 0 ? '+' : ''}${lastPct.toFixed(2)}%`

    return {
      animation: false,
      // 右侧留白给末端涨跌幅标签
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
          const fullDate = points[idx]?.date || p.axisValue || ''
          const close = points[idx]?.close
          const n = Number(p.value)
          const closeText =
            close == null ? '' : `<br/>收盘 ${Number(close).toFixed(2)}`
          return `${fullDate}<br/><b>${n > 0 ? '+' : ''}${n.toFixed(2)}%</b>${closeText}`
        },
      },
      xAxis: {
        type: 'category',
        data: points.map((p) => p.date.slice(5)),
        boundaryGap: false,
        axisLine: {lineStyle: {color: line}},
        axisTick: {show: false},
        axisLabel: {
          color: muted,
          fontSize: 10,
          interval: Math.max(0, Math.floor(points.length / 4) - 1),
        },
      },
      yAxis: {
        type: 'value',
        scale: true,
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
  }, [data])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="rt-popup-dialog w-[calc(100%-1rem)] max-w-2xl p-4 sm:w-[calc(100%-2rem)] sm:max-w-4xl sm:p-5 lg:max-w-5xl">
        <div className="mb-4 flex flex-col gap-1 pr-6">
          <Dialog.Title size="4" mb="0" className="font-display truncate text-base leading-none sm:text-lg">
            {item?.name || '指数趋势'}
          </Dialog.Title>
        </div>

        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-hide sm:flex-wrap sm:overflow-visible">
          {RANGES.map((r) => {
            const pct = byRange[r.key]?.periodPercent
            const selected = range === r.key
            return (
              <Button
                key={r.key}
                type="button"
                size="1"
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
                    pct == null && loading ? 'opacity-60' : pctClass(pct),
                  )}
                >
                  {loading && pct == null ? '…' : formatPct(pct)}
                </span>
              </Button>
            )
          })}
        </div>

        <div className="mt-2" style={{minHeight: chartHeight}}>
          {error ? (
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
        <Dialog.Close className="rt-dialog-close" aria-label="关闭">
          <X className="h-4 w-4" />
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Root>
  )
}
