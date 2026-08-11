import {useEffect, useRef, useState} from 'react'
import type {TabInfo} from '../../lib/groupStats'
import {cn, formatPct, formatShortAmount} from '@fund01/core'

/** popup 分组 Tab 收益详情的显示方式（由设置页「分组 Tab 收益详情」控制） */
export type GroupTabDetailMode = 'percent' | 'amount'

function ChevronLeft() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

function ChevronRight() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** 分组 Tab 栏：全部 + 各分组，显示基金数；分组当日收益额 >0 点红点、<0 点绿点，
 *  收益额 =0（或全是 QDII 盘中 pnl 为空）不画点。点的语义是「收益额方向」而非涨跌家数，
 *  更贴合「这个分组今天整体赚/亏」的直觉。
 *  showDetail 开启时每个 Tab 显示两行：第一行 名称 + 基金数（字号缩小），
 *  第二行 当日收益详情（收益率百分比或收益额简写，红涨绿跌、0/无数据显示「-」）。
 *  分组过多时横向滚动：隐藏原生滚动条，左/右出现可点击的箭头图标，
 *  边缘渐隐提示还有更多内容（canLeft / canRight 由滚动位置与容器宽度动态计算）。 */
export function GroupTabs({
  tabs,
  activeTab,
  onChange,
  showDetail = false,
  detailMode = 'percent',
}: {
  tabs: TabInfo[]
  activeTab: string
  onChange: (id: string) => void
  /** 是否显示两行（分组名下方增加当日收益详情行），由设置页控制 */
  showDetail?: boolean
  /** 收益详情显示方式：percent=收益率百分比（默认） amount=收益额（k/w/kw 简写） */
  detailMode?: GroupTabDetailMode
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  // 根据当前 scrollLeft 与可滚动宽度，计算左右是否还有内容可滚
  const updateArrows = () => {
    const el = scrollerRef.current
    if (!el) return
    const maxScroll = el.scrollWidth - el.clientWidth
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft < maxScroll - 1)
  }

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    updateArrows()
    el.addEventListener('scroll', updateArrows, {passive: true})
    // 鼠标悬停 tab 条时，垂直滚轮映射为横向滚动：
    // 仅在还有空间朝滚动方向走时拦截并 preventDefault，到边界则放行，
    // 让下方列表正常纵向滚动；触控板横向滑移（deltaX）交给浏览器原生处理，不重复拦截。
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0) return
      const max = el.scrollWidth - el.clientWidth
      if (max <= 0) return
      const delta = e.deltaY
      if (delta === 0) return
      const atStart = el.scrollLeft <= 0
      const atEnd = el.scrollLeft >= max
      if ((delta < 0 && !atStart) || (delta > 0 && !atEnd)) {
        el.scrollLeft += delta
        e.preventDefault()
      }
    }
    el.addEventListener('wheel', onWheel, {passive: false})
    const ro = new ResizeObserver(updateArrows)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateArrows)
      el.removeEventListener('wheel', onWheel)
      ro.disconnect()
    }
    // tabs.length 变化（分组增删）时重新绑定并校准箭头
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length])

  // 激活分组变化（含从 menubar 外部请求切换）时，把对应 Tab 横向滚进可视区，
  // 保证高亮项始终可见。仅在 activeTab 变化时触发；用户手动横向滚动不会回弹，
  // 不与操作打架。手动算 scrollLeft 而非 scrollIntoView，避免连带滚动外层 popup。
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const active = el.querySelector(
      '[data-tab-id="' + CSS.escape(activeTab) + '"]',
    ) as HTMLElement | null
    if (!active) return
    const elLeft = active.offsetLeft
    const elRight = elLeft + active.offsetWidth
    const viewLeft = el.scrollLeft
    const viewRight = viewLeft + el.clientWidth
    const pad = 8
    if (elLeft < viewLeft + pad) {
      el.scrollLeft = Math.max(0, elLeft - pad)
    } else if (elRight > viewRight - pad) {
      el.scrollLeft = elRight - el.clientWidth + pad
    }
  }, [activeTab])

  if (tabs.length <= 1) return null

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollerRef.current
    if (!el) return
    const amount = Math.max(el.clientWidth * 0.6, 120)
    el.scrollBy({left: dir * amount, behavior: 'smooth'})
  }

  const activate = (id: string) => onChange(id)

  return (
    <div className="relative">
      <div
        ref={scrollerRef}
        className="scrollbar-hide flex gap-1 overflow-x-auto border-b border-line/70 px-3"
        role="tablist"
      >
        {tabs.map((t) => {
          const active = t.id === activeTab
          // 点反映分组当日收益额方向：赚=红、亏=绿；收益额 0 或全 nil 不画点
          const dot =
            t.pnl > 0 ? 'bg-rise' : t.pnl < 0 ? 'bg-fall' : ''
          // 第二行收益详情：百分比模式用 formatPct（自带 +/- 与 %，null → '--'）；
          // 金额模式用 formatShortAmount 简写（k/w/kw，取绝对值）再手动补符号
          const detailText =
            detailMode === 'amount'
              ? `${t.pnl > 0 ? '+' : t.pnl < 0 ? '-' : ''}${formatShortAmount(t.pnl)}`
              : formatPct(t.pnlPercent)
          const detailCls =
            detailMode === 'amount'
              ? t.pnl > 0
                ? 'text-rise'
                : t.pnl < 0
                  ? 'text-fall'
                  : 'text-muted'
              : t.pnlPercent == null
                ? 'text-muted'
                : t.pnlPercent > 0
                  ? 'text-rise'
                  : t.pnlPercent < 0
                    ? 'text-fall'
                    : 'text-muted'
          return (
            <div
              key={t.id}
              data-tab-id={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => activate(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  activate(t.id)
                }
              }}
              className={cn(
                'relative flex cursor-pointer flex-col whitespace-nowrap px-3 transition-colors',
                showDetail ? 'py-1.5' : 'items-center py-2',
                active ? 'font-medium text-ink' : 'text-muted hover:text-ink-soft',
              )}
            >
              {/* 第一行：红绿点 + 分组名 + 基金数；两行模式下整体缩小一档 */}
              <span
                className={cn(
                  'flex items-center',
                  showDetail ? 'text-xs' : 'text-sm',
                )}
              >
                {dot ? (
                  <span className={cn('mr-1 inline-block h-1.5 w-1.5 rounded-full', dot)} />
                ) : null}
                {t.label}
                <span
                  className={cn(
                    'ml-1 text-muted',
                    showDetail ? 'text-[10px]' : 'text-xs',
                  )}
                >
                  {t.count}
                </span>
              </span>
              {/* 第二行：当日收益详情（仅 showDetail 时显示） */}
              {showDetail ? (
                <span
                  className={cn(
                    'font-mono text-[10px] leading-tight tabular-nums',
                    detailCls,
                  )}
                >
                  {detailText}
                </span>
              ) : null}
              {active ? (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
              ) : null}
            </div>
          )
        })}
      </div>

      {/* 左滚动箭头 + 边缘渐隐（仅在可向左滚时显示） */}
      {canLeft ? (
        <>
          <div className="gt-fade gt-fade--left" aria-hidden="true" />
          <button
            type="button"
            aria-label="向左滚动分组"
            onClick={() => scrollBy(-1)}
            className="gt-nav gt-nav--left"
          >
            <ChevronLeft />
          </button>
        </>
      ) : null}

      {/* 右滚动箭头 + 边缘渐隐（仅在可向右滚时显示） */}
      {canRight ? (
        <>
          <div className="gt-fade gt-fade--right" aria-hidden="true" />
          <button
            type="button"
            aria-label="向右滚动分组"
            onClick={() => scrollBy(1)}
            className="gt-nav gt-nav--right"
          >
            <ChevronRight />
          </button>
        </>
      ) : null}
    </div>
  )
}
