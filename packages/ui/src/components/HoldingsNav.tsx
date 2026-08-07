import {useCallback, useEffect, useState} from 'react'
import {PanelRight, PanelTop} from 'lucide-react'
import {Button, SegmentedControl} from '@radix-ui/themes'
import type {HoldingsNavPosition} from '@fund01/core'

/* ── 持仓 tab 的锚点区块 ─────────────────────────────────── */
export const HOLDINGS_NAV_ITEMS = [
  {id: 'holdings-groups', label: '持仓分组'},
  {id: 'add-fund', label: '添加持仓'},
  {id: 'edit-holdings', label: '编辑持仓'},
  {id: 'import-holdings', label: '导入持仓'},
] as const

type NavItemId = (typeof HOLDINGS_NAV_ITEMS)[number]['id']

/**
 * 设置页「持仓」tab 的浮动导航：顶部吸顶横向 / 右侧悬浮竖向。
 * 视觉跟随 Radix Themes 组件语言（Button soft/ghost + SegmentedControl），
 * 不再使用手写胶囊/毛玻璃，避免与页面其他 Radix 控件割裂。
 * - 点击项平滑滚动到对应区块（顶部模式额外补偿吸顶导航高度）
 * - 滚动时自动高亮当前区块（scroll-spy）
 * - 自带位置切换控件（顶部/侧边），持久化走 settings.holdingsNavPosition
 */
export function HoldingsNav({
  position,
  onPositionChange,
}: {
  position: HoldingsNavPosition
  onPositionChange: (p: HoldingsNavPosition) => void
}) {
  const [activeId, setActiveId] = useState<NavItemId>(HOLDINGS_NAV_ITEMS[0].id)

  // 顶部吸顶模式：滚动目标要额外让出导航高度 + 间距；侧边悬浮不占位，偏移小
  const offset = position === 'top' ? 64 : 16

  const updateActive = useCallback(() => {
    // 视口顶部越过该区块头部即视为当前区块（越过 sticky 导航高度）
    const spyLine = position === 'top' ? 120 : 40
    let current: NavItemId = HOLDINGS_NAV_ITEMS[0].id
    for (const item of HOLDINGS_NAV_ITEMS) {
      const el = document.getElementById(item.id)
      if (!el) break
      if (el.getBoundingClientRect().top <= spyLine) current = item.id
      else break
    }
    setActiveId(current)
  }, [position])

  useEffect(() => {
    updateActive()
    window.addEventListener('scroll', updateActive, {passive: true})
    window.addEventListener('resize', updateActive)
    return () => {
      window.removeEventListener('scroll', updateActive)
      window.removeEventListener('resize', updateActive)
    }
  }, [updateActive])

  function jumpTo(id: NavItemId) {
    const el = document.getElementById(id)
    if (!el) return
    const top = el.getBoundingClientRect().top + window.scrollY - offset
    window.scrollTo({top, behavior: 'smooth'})
  }

  const navButtons = HOLDINGS_NAV_ITEMS.map((item) => (
    <Button
      key={item.id}
      type="button"
      size="1"
      variant={activeId === item.id ? 'soft' : 'ghost'}
      color={activeId === item.id ? 'blue' : 'gray'}
      onClick={() => jumpTo(item.id)}
      aria-current={activeId === item.id ? 'true' : undefined}
      className="whitespace-nowrap"
    >
      {item.label}
    </Button>
  ))

  const switchControl = (
    <SegmentedControl.Root
      size="1"
      value={position}
      onValueChange={(v) => onPositionChange(v as HoldingsNavPosition)}
      aria-label="浮动导航位置"
      title="切换浮动导航位置"
    >
      <SegmentedControl.Item value="top" aria-label="顶部吸顶">
        <PanelTop className="h-3.5 w-3.5" />
      </SegmentedControl.Item>
      <SegmentedControl.Item value="side" aria-label="右侧悬浮">
        <PanelRight className="h-3.5 w-3.5" />
      </SegmentedControl.Item>
    </SegmentedControl.Root>
  )

  if (position === 'side') {
    return (
      <nav
        aria-label="持仓区块导航"
        className="fixed right-4 top-1/2 z-50 flex -translate-y-1/2 flex-col items-start gap-1 rounded-md border border-line/60 bg-panel/85 p-1 shadow-card"
      >
        {navButtons}
        <div className="w-full border-t border-line/40" />
        <div className="flex justify-center self-center">{switchControl}</div>
      </nav>
    )
  }

  return (
    <nav
      aria-label="持仓区块导航"
      className="sticky top-0 z-10 mb-4 flex items-center gap-1 rounded-md border border-line/60 bg-panel/85 p-1 shadow-sm"
    >
      {navButtons}
      <span className="ml-auto">{switchControl}</span>
    </nav>
  )
}
