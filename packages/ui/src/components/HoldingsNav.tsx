import {useCallback, useEffect, useState} from 'react'

/* ── 持仓 tab 的锚点区块 ─────────────────────────────────── */
export const HOLDINGS_NAV_ITEMS = [
  {id: 'holdings-groups', label: '持仓分组'},
  {id: 'add-fund', label: '添加持仓'},
  {id: 'edit-holdings', label: '编辑持仓'},
  {id: 'import-holdings', label: '导入持仓'},
] as const

type NavItemId = (typeof HOLDINGS_NAV_ITEMS)[number]['id']

/**
 * 设置页「持仓」tab 的顶部吸顶导航。
 * 视觉沿用设置页一级 Tab 的 Radix 设计语言（底部细线 + 激活项 2px accent 下划线），
 * 不再做侧边悬浮 / 位置切换，保持与一级 Tab 完全一致。
 * - 点击项平滑滚动到对应区块（已让出吸顶导航高度）
 * - 滚动时自动高亮当前区块（scroll-spy）
 */
export function HoldingsNav() {
  const [activeId, setActiveId] = useState<NavItemId>(HOLDINGS_NAV_ITEMS[0].id)

  const updateActive = useCallback(() => {
    // 视口顶部越过该区块头部即视为当前区块（越过 sticky 导航高度）
    const spyLine = 120
    let current: NavItemId = HOLDINGS_NAV_ITEMS[0].id
    for (const item of HOLDINGS_NAV_ITEMS) {
      const el = document.getElementById(item.id)
      if (!el) break
      if (el.getBoundingClientRect().top <= spyLine) current = item.id
      else break
    }
    // 兜底：页面已滚到最底部（无法继续下滚）时，最后一个区块即使顶部未越过
    // spyLine 也应激活——否则末尾区块（如导入持仓）永远选不中。
    const doc = document.documentElement
    if (window.innerHeight + window.scrollY >= doc.scrollHeight - 4) {
      current = HOLDINGS_NAV_ITEMS[HOLDINGS_NAV_ITEMS.length - 1].id
    }
    setActiveId(current)
  }, [])

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
    // 顶部吸顶模式：滚动目标额外让出导航高度 + 间距
    const top = el.getBoundingClientRect().top + window.scrollY - 64
    window.scrollTo({top, behavior: 'smooth'})
  }

  return (
    <nav
      aria-label="持仓区块导航"
      className="sticky top-0 z-10 -mb-px flex items-center border-b border-line/60 bg-panel/85 backdrop-blur-md"
    >
      {HOLDINGS_NAV_ITEMS.map((item) => {
        const isActive = activeId === item.id
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => jumpTo(item.id)}
            aria-current={isActive ? 'true' : undefined}
            className={`appearance-none border-0 bg-transparent px-3 py-2 text-xs font-medium transition-colors ${
              isActive ? 'text-accent' : 'text-muted hover:text-ink'
            }`}
            style={
              isActive ? {boxShadow: 'inset 0 -2px 0 var(--accent-9)'} : undefined
            }
          >
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}