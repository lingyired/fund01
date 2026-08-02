import {useState} from 'react'
import type {IndexItem} from '@fund01/core'
import {cn, formatAmount, formatMoney, formatPct, pctClass} from '@fund01/core'
import {IndexTrendDialog} from '../IndexTrendDialog'
import {Skeleton} from '@radix-ui/themes'

/** 指数看板：无标题，按 selected 过滤（最多 5 个），横向展示名称/价格/涨跌值/涨跌幅 */
export function IndexBar({
  indices,
  selected,
  loading,
}: {
  indices: IndexItem[]
  selected: string[]
  loading?: boolean
}) {
  const [active, setActive] = useState<IndexItem | null>(null)
  const [open, setOpen] = useState(false)

  const ordered = selected
    .map((code) => indices.find((i) => i.code === code))
    .filter((x): x is IndexItem => !!x)

  return (
    <div className="px-3 pt-3">
      <div className="scrollbar-hide flex gap-2 overflow-x-auto pb-1">
        {loading && !ordered.length ? (
          Array.from({length: 5}).map((_, i) => (
            <Skeleton key={i} className="h-[60px] w-[124px] shrink-0" />
          ))
        ) : ordered.length === 0 ? (
          <div className="py-3 text-xs text-muted">未选择指数，可在设置中勾选</div>
        ) : (
          ordered.map((item) => (
            <button
              key={item.code}
              type="button"
              onClick={() => {
                setActive(item)
                setOpen(true)
              }}
              className="w-[124px] shrink-0 rounded-xl border border-line/70 bg-panel px-3 py-2 text-left transition-colors hover:bg-paper-deep"
            >
              <div className="truncate text-xs text-muted">{item.name}</div>
              <div
                className={cn(
                  'mt-1 font-mono text-base font-semibold tabular-nums',
                  pctClass(item.percent),
                )}
              >
                {formatAmount(item.price)}
              </div>
              <div
                className={cn(
                  'mt-0.5 flex items-baseline gap-1 font-mono text-xs tabular-nums',
                  pctClass(item.percent),
                )}
              >
                <span>{formatMoney(item.change)}</span>
                <span>{formatPct(item.percent)}</span>
              </div>
            </button>
          ))
        )}
      </div>
      <IndexTrendDialog item={active} open={open} onOpenChange={setOpen} />
    </div>
  )
}
