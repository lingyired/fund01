import type {TabInfo} from '../../lib/groupStats'
import {cn} from '@fund01/core'

/** 分组 Tab 栏：全部 + 各分组，显示基金数；组内涨多于跌点红点，跌多于涨点绿点 */
export function GroupTabs({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: TabInfo[]
  activeTab: string
  onChange: (id: string) => void
}) {
  if (tabs.length <= 1) return null
  return (
    <div className="scrollbar-hide flex gap-1 overflow-x-auto border-b border-line/70 px-3">
      {tabs.map((t) => {
        const active = t.id === activeTab
        const dot =
          t.up > t.down ? 'bg-rise' : t.down > t.up ? 'bg-fall' : ''
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              'relative flex items-center whitespace-nowrap px-3 py-2 text-sm transition-colors',
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
          </button>
        )
      })}
    </div>
  )
}
