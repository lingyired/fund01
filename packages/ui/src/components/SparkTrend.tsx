import {useMemo, useState} from 'react'
import ReactECharts from 'echarts-for-react'
import {Dialog} from '@radix-ui/themes'
import {X} from 'lucide-react'
import {cn, pctClass} from '@fund01/core'
import {FundTrendDialog} from './FundTrendDialog'

export type TrendPoint = {
  time: string
  value: number
  /** 可选：金价等绝对价格，用于角标/tooltip 一并展示 */
  price?: number | null
}

function chartAxisColors() {
  const styles = getComputedStyle(document.documentElement)
  return {
    muted: styles.getPropertyValue('--app-muted').trim() || '#6b7785',
    line: styles.getPropertyValue('--app-line').trim() || '#c8d0d8',
  }
}

function buildOption(
  points: TrendPoint[],
  {
    showAxis,
    color,
    compact,
    mode = 'percent',
    showTimeAxis = false,
  }: {
    showAxis: boolean
    color: string
    compact?: boolean
    mode?: 'percent' | 'price'
    /** 迷你图也显示横坐标时间 */
    showTimeAxis?: boolean
  },
) {
  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad =
    mode === 'price'
      ? Math.max((max - min) * 0.12, 0.5)
      : Math.max((max - min) * 0.12, 0.05)
  const axisColors = chartAxisColors()
  const showPriceBadge = mode === 'price' || points.some((p) => p.price != null)
  const showX = (showAxis && !compact) || showTimeAxis
  const showY = showAxis && !compact

  return {
    animation: false,
    grid: compact
      ? {
        left: showY ? 36 : 2,
        right: 8,
        top: showPriceBadge ? 26 : 14,
        bottom: showTimeAxis ? 28 : 2,
      }
      : showAxis
        ? {left: 48, right: 16, top: 28, bottom: 36}
        : {left: 0, right: 0, top: 4, bottom: 0},
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      confine: false,
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
        const n = Number(p.value)
        if (mode === 'price') {
          return `${p.axisValue ?? ''}<br/><b>${n.toFixed(2)} 元/克</b>`
        }
        const sign = n > 0 ? '+' : ''
        const price = points[p.dataIndex ?? 0]?.price
        const priceText =
          price != null ? `<br/>金价 ${Number(price).toFixed(2)}` : ''
        return `${p.axisValue ?? ''}<br/><b>${sign}${n.toFixed(2)}%</b>${priceText}`
      },
    },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.time),
      show: showX,
      boundaryGap: false,
      axisLine: {lineStyle: {color: axisColors.line}},
      axisTick: {show: false},
      axisLabel: {
        color: axisColors.muted,
        fontSize: 11,
        interval: Math.max(0, Math.floor(points.length / 6) - 1),
        hideOverlap: true,
      },
    },
    yAxis: {
      type: 'value',
      show: showY,
      scale: true,
      min: Number((min - pad).toFixed(2)),
      max: Number((max + pad).toFixed(2)),
      splitNumber: 4,
      axisLine: {show: false},
      axisTick: {show: false},
      axisLabel: {
        color: axisColors.muted,
        fontSize: 11,
        formatter:
          mode === 'price'
            ? (v: number) => v.toFixed(1)
            : (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`,
      },
      splitLine: {
        show: showY,
        lineStyle: {color: axisColors.line, type: 'dashed'},
      },
    },
    series: [
      {
        type: 'line',
        data: values,
        showSymbol: false,
        smooth: 0.25,
        lineStyle: {width: showAxis && !compact ? 2 : 1.5, color},
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
        markLine:
          showAxis && mode === 'percent'
            ? {
              silent: true,
              symbol: 'none',
              lineStyle: {color: axisColors.muted, type: 'dashed', width: 1},
              data: [{yAxis: 0}],
              label: {show: false},
            }
            : undefined,
      },
    ],
  }
}

export function SparkTrend({
  points,
  height = 56,
  title = '分时走势',
  accentColor,
  positiveIsUp = true,
  className,
  /** 角标涨跌幅；不传则用曲线最后一个点（应与收益计算口径一致） */
  badgePercent,
  /** percent：涨跌幅曲线；price：绝对价格曲线（黄金） */
  mode = 'percent',
  /** 迷你图也显示横坐标时间 */
  showTimeAxis = false,
  /** 传入基金代码时，放大弹窗支持分时/近3月/近1年/近3年/成立以来 */
  fundCode,
}: {
  points: TrendPoint[]
  height?: number
  title?: string
  accentColor?: string
  positiveIsUp?: boolean
  className?: string
  badgePercent?: number | null
  mode?: 'percent' | 'price'
  showTimeAxis?: boolean
  fundCode?: string
}) {
  const [open, setOpen] = useState(false)

  const lastPoint = points[points.length - 1]
  const lastPct = badgePercent != null ? badgePercent : (lastPoint?.value ?? 0)
  const lastPrice =
    mode === 'price' ? lastPoint?.value ?? lastPoint?.price : lastPoint?.price
  const firstPrice = mode === 'price' ? points[0]?.value : null
  const priceUp =
    mode === 'price' && lastPrice != null && firstPrice != null
      ? lastPrice >= firstPrice
      : true
  const up = mode === 'price' ? priceUp : positiveIsUp ? lastPct >= 0 : lastPct < 0
  const color = accentColor || (up ? '#d7263d' : '#0f8a5f')

  const themeKey =
    typeof document !== 'undefined' ? document.documentElement.dataset.theme : 'light'

  const miniOption = useMemo(
    () =>
      buildOption(points, {
        showAxis: true,
        color,
        compact: true,
        mode,
        showTimeAxis,
      }),
    [points, color, themeKey, mode, showTimeAxis],
  )
  const fullOption = useMemo(
    () => buildOption(points, {showAxis: true, color, compact: false, mode}),
    [points, color, themeKey, mode],
  )

  if (!points.length) {
    return (
      <div
        className={cn(
          'flex w-2/3 items-center justify-center text-[10px] text-muted',
          className,
        )}
        style={{height}}
      >
        暂无走势
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        className={cn(
          'group relative w-2/3 cursor-zoom-in rounded-md text-left transition-opacity hover:opacity-90',
          className,
        )}
        onClick={() => setOpen(true)}
        title="点击放大查看"
      >
        <div className="pointer-events-none absolute right-0 top-0 z-10 flex flex-col items-end gap-0.5">
          {mode === 'percent' ? <MiniPct value={lastPct} /> : null}
          {mode === 'price' || lastPrice != null ? (
            <MiniPrice value={lastPrice} className={mode === 'price' ? 'text-gold' : undefined} />
          ) : null}
        </div>
        <ReactECharts
          option={miniOption}
          style={{height, width: '100%'}}
          opts={{renderer: 'canvas'}}
          notMerge
        />
      </button>

      {fundCode ? (
        <FundTrendDialog
          open={open}
          onOpenChange={setOpen}
          code={fundCode}
          name={title}
          intradayPoints={points}
          badgePercent={badgePercent}
        />
      ) : (
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Content className="rt-popup-dialog max-w-2xl">
            <div className="mb-4 flex flex-col gap-1">
              <Dialog.Title size="4" mb="0" className="font-display flex items-center justify-between gap-3 pr-6 leading-none">
                <span className="truncate">{title}</span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  {mode === 'percent' ? <MiniPct value={lastPct} /> : null}
                  {mode === 'price' || lastPrice != null ? (
                    <MiniPrice
                      value={lastPrice}
                      className={mode === 'price' ? 'text-gold' : undefined}
                    />
                  ) : null}
                </span>
              </Dialog.Title>
            </div>
            <ReactECharts
              option={fullOption}
              style={{height: 320, width: '100%'}}
              opts={{renderer: 'canvas'}}
              notMerge
            />
            <Dialog.Close className="rt-dialog-close" aria-label="关闭">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Root>
      )}
    </>
  )
}

export function MiniPct({value}: {value: number | null | undefined}) {
  const cls = pctClass(value)
  if (value == null) return <span className="font-mono text-muted">--</span>
  const sign = value > 0 ? '+' : ''
  return (
    <span className={`font-mono text-xs font-semibold tabular-nums ${cls}`}>
      {sign}
      {value.toFixed(2)}%
    </span>
  )
}

function MiniPrice({
  value,
  className,
}: {
  value: number | null | undefined
  className?: string
}) {
  if (value == null) return null
  return (
    <span
      className={cn(
        'font-mono text-[10px] font-semibold tabular-nums text-ink-soft sm:text-xs',
        className,
      )}
    >
      {value.toFixed(2)}
    </span>
  )
}
