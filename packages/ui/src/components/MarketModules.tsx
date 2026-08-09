import {useState} from 'react'
import type {IndexItem, MarketOverview} from '@fund01/core'
import {formatAmount, formatMoney, formatPct, pctClass} from '@fund01/core'
import {Card} from '@radix-ui/themes'
import {IndexTrendDialog} from './IndexTrendDialog'

export function IndicesModule({
  list,
  loading,
}: {
  list: IndexItem[]
  loading?: boolean
}) {
  const [active, setActive] = useState<IndexItem | null>(null)
  const [open, setOpen] = useState(false)

  return (
    <Card className="rt-panel w-full min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line/70 px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h2 className="shrink-0 font-display text-base font-bold tracking-tight">指数看板</h2>
          <p className="min-w-0 truncate text-xs text-muted">点击查看历史趋势</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 px-3 py-3 sm:grid-cols-3 sm:px-4 sm:py-4 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-10">
        {loading && !list.length
          ? Array.from({length: 10}).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-paper-deep/80 sm:h-24" />
          ))
          : list.map((item) => {
            const open = () => {
              setActive(item)
              setOpen(true)
            }
            return (
              <div
                key={item.code}
                role="button"
                tabIndex={0}
                className="cursor-pointer rounded-xl border border-line/70 bg-paper/50 px-3 py-2.5 text-left transition-transform duration-300 hover:-translate-y-0.5 active:scale-[0.98]"
                onClick={open}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    open()
                  }
                }}
              >
                <div className="truncate text-xs text-muted">{item.name}</div>
                {item.error ? (
                  <>
                    {/* 行情拉取失败：数值处提示接口错误，底部显示简短错误码 */}
                    <div className="mt-1.5 font-mono text-base font-semibold text-muted sm:text-lg">
                      接口错误
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-muted">{item.error}</div>
                  </>
                ) : (
                  <>
                    {/* 指数值单独一行（随涨跌着色） */}
                    <div
                      className={`mt-1.5 font-mono text-base font-semibold tabular-nums sm:text-lg ${pctClass(item.percent)}`}
                    >
                      {formatAmount(item.price)}
                    </div>
                    {/* 涨跌额 + 百分比 一行 */}
                    <div
                      className={`mt-0.5 flex items-baseline gap-1.5 font-mono text-xs tabular-nums sm:text-sm ${pctClass(item.percent)}`}
                    >
                      <span>{formatMoney(item.change)}</span>
                      <span>{formatPct(item.percent)}</span>
                    </div>
                  </>
                )}
              </div>
            )
          })}
      </div>

      <IndexTrendDialog item={active} open={open} onOpenChange={setOpen} />
    </Card>
  )
}

export function MarketModule({
  data,
  loading,
}: {
  data: MarketOverview | null
  loading?: boolean
}) {
  const up = data?.upDown.up ?? 0
  const down = data?.upDown.down ?? 0
  const flat = data?.upDown.flat ?? 0
  const total = Math.max(up + down + flat, 1)
  const upPct = (up / total) * 100
  const downPct = (down / total) * 100
  const barPct = up + down > 0 ? (up / (up + down)) * 100 : 50

  return (
    <Card className="rt-panel h-full min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line/70 px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h2 className="shrink-0 font-display text-base font-bold tracking-tight">A股大盘</h2>
          <p className="min-w-0 truncate text-xs text-muted">涨跌家数占比 · 板块指数涨跌前十</p>
        </div>
      </div>
      <div className="space-y-3 px-3 py-3 sm:space-y-4 sm:px-5 sm:py-4">
        <div className="rounded-xl border border-line/70 bg-paper/50 p-3 sm:p-4">
          <div className="text-xs text-muted">今日涨跌家数</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-3 font-mono text-lg font-semibold sm:gap-4 sm:text-xl">
            <span className="rise">
              涨 {loading ? '...' : up}
              <span className="ml-1 text-sm font-medium">
                ({loading ? '--' : `${upPct.toFixed(1)}%`})
              </span>
            </span>
            <span className="fall">
              跌 {loading ? '...' : down}
              <span className="ml-1 text-sm font-medium">
                ({loading ? '--' : `${downPct.toFixed(1)}%`})
              </span>
            </span>
          </div>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-fall/20">
            <div className="bg-rise transition-all duration-700" style={{width: `${barPct}%`}} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SectorList title="涨幅前十板块" items={data?.topGainers || []} tone="rise" />
          <SectorList title="跌幅前十板块" items={data?.topLosers || []} tone="fall" />
        </div>
      </div>
    </Card>
  )
}

function SectorList({
  title,
  items,
  tone,
}: {
  title: string
  items: {code: string; name: string; percent: number | null}[]
  tone: 'rise' | 'fall'
}) {
  return (
    <div className="rounded-xl border border-line/70 bg-panel p-3">
      <div className={`mb-2 text-sm font-medium ${tone === 'rise' ? 'rise' : 'fall'}`}>
        {title}
      </div>
      <div className="space-y-1">
        {items.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted">暂无数据</div>
        ) : (
          items.map((item, idx) => (
            <div
              key={item.code}
              className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-paper/70"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="w-5 font-mono text-xs text-muted">{idx + 1}</span>
                <span className="truncate text-sm">{item.name}</span>
              </div>
              <span className={`shrink-0 font-mono text-sm tabular-nums ${pctClass(item.percent)}`}>
                {formatPct(item.percent)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
