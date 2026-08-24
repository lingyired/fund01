import {useState} from 'react'
import type {IndexItem} from '@fund01/core'
import {
  AVAILABLE_INDICES,
  cn,
  formatAmount,
  formatMoney,
  formatPct,
  pctClass,
} from '@fund01/core'
import {IndexTrendDialog} from '../IndexTrendDialog'

/**
 * 指数看板：无标题，按 selected 渲染（最多 5 个），横向展示名称/价格/涨跌值/涨跌幅。
 * 看板由配置决定（App 兜底默认 5 个指数），行情数据只是填充内容：
 * 某个指数行情尚未产出（如 Tauri 非盘中启动、内存快照为空）时渲染占位卡片
 * （名称 + --），保证初始 popup 就有完整指数面板，行情到达后自动填充。
 */
export function IndexBar({
  indices,
  selected,
}: {
  indices: IndexItem[]
  selected: string[]
}) {
  const [active, setActive] = useState<IndexItem | null>(null)
  const [open, setOpen] = useState(false)

  // selected 经 App 兜底默认 5 个指数，正常不会为空；此处仅防御未来允许空勾选
  const hasSelection = selected.length > 0

  function openTrend(item: IndexItem) {
    setActive(item)
    setOpen(true)
  }

  // 每个 selected code 渲染一张卡片：indices 有行情 → 实时数据；缺失 → 占位（名称 + --）
  function renderCard(code: string) {
    const item = indices.find((i) => i.code === code)
    const name =
      item?.name ?? AVAILABLE_INDICES.find((m) => m.code === code)?.name ?? code
    const interactive = !!item
    return (
      <div
        key={code}
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={interactive ? () => openTrend(item) : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openTrend(item)
                }
              }
            : undefined
        }
        className={cn(
          'w-[124px] shrink-0 rounded-lg border px-3 py-1.5 text-left transition-colors',
          interactive && 'cursor-pointer',
          // 取消渐变：用淡透明实色（红/绿），边框同色但更淡，贴合现有 UI；持平/无数据保持原 bg-panel 普通卡片
          item?.percent != null && !Number.isNaN(item.percent)
            ? item.percent > 0
              ? 'border-rise/20 bg-rise/10 hover:bg-rise/15'
              : 'border-fall/20 bg-fall/10 hover:bg-fall/15'
            : 'border-line/60 bg-panel hover:bg-paper-deep',
        )}
      >
        <div className="truncate text-[11px] text-muted">{name}</div>
        {item?.error ? (
          <>
            {/* 行情拉取失败：数值处提示接口错误，底部显示简短错误码 */}
            <div className="mt-0.5 font-mono text-sm font-semibold leading-none text-muted">
              接口错误
            </div>
            <div className="mt-1 font-mono text-[11px] leading-none text-muted">
              {item.error}
            </div>
          </>
        ) : item ? (
          <>
            <div
              className={cn(
                'mt-0.5 font-mono text-sm font-semibold leading-none tabular-nums',
                pctClass(item.percent),
              )}
            >
              {formatAmount(item.price)}
            </div>
            <div
              className={cn(
                'mt-1 flex items-baseline gap-1 font-mono text-[11px] leading-none tabular-nums',
                pctClass(item.percent),
              )}
            >
              <span>{formatMoney(item.change)}</span>
              <span>{formatPct(item.percent)}</span>
            </div>
          </>
        ) : (
          <>
            {/* 行情尚未产出：占位 --，保持卡片尺寸与真实卡片一致 */}
            <div className="mt-0.5 font-mono text-sm font-semibold leading-none text-muted">
              --
            </div>
            <div className="mt-1 font-mono text-[11px] leading-none text-muted">--</div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="px-3 pt-2">
      <div className="scrollbar-hide flex gap-2 overflow-x-auto pb-1">
        {hasSelection ? (
          selected.map(renderCard)
        ) : (
          <div className="py-3 text-xs text-muted">未选择指数，可在设置中勾选</div>
        )}
      </div>
      <IndexTrendDialog item={active} open={open} onOpenChange={setOpen} />
    </div>
  )
}
