import {useEffect, useRef, useState} from 'react'
import type {TabInfo} from '../../lib/groupStats'
import {cn} from '@fund01/core'

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

/** 分组 Tab 栏：全部 + 各分组，显示基金数；组内涨多于跌点红点，跌多于涨点绿点。
 *  分组过多时横向滚动：隐藏原生滚动条，左/右出现可点击的箭头图标，
 *  边缘渐隐提示还有更多内容（canLeft / canRight 由滚动位置与容器宽度动态计算）。 */
export function GroupTabs({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: TabInfo[]
  activeTab: string
  onChange: (id: string) => void
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
          const dot =
            t.up > t.down ? 'bg-rise' : t.down > t.up ? 'bg-fall' : ''
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
                'relative flex cursor-pointer items-center whitespace-nowrap px-3 py-2 text-sm transition-colors',
                active ? 'font-medium text-ink' : 'text-muted hover:text-ink-soft',
              )}
            >
              {dot ? (
                <span className={cn('mr-1 inline-block h-1.5 w-1.5 rounded-full', dot)} />
              ) : null}
              {t.label}
              <span className="ml-1 text-xs text-muted">{t.count}</span>
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
