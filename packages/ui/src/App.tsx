import {useEffect, useState} from 'react'
import {ExternalLink, Moon, RefreshCw, Settings2, Sun} from 'lucide-react'
import type {AppThemePref} from '@fund01/core'
import {DEFAULT_SELECTED_INDICES} from '@fund01/core'
import {
  applyTheme,
  getStoredThemePref,
  getSystemTheme,
  onSystemThemeChange,
  resolveTheme,
} from './theme'
import {useMarketData} from './hooks'
import {usePorts} from './context'
import {IndexBar} from './components/popup/IndexBar'
import {PopupLayout} from './components/popup/PopupLayout'
import {IconButton, Theme} from '@radix-ui/themes'
// 注意：Radix 的 styles.css 不在这里 import —— 它已在 index.css 里以
// `@import '@radix-ui/themes/styles.css' layer(radix-themes)` 的方式引入，
// 以便和 Tailwind 建立正确的 CSS 层级顺序（详见 index.css 顶部注释）。
import './index.css'

export function App({
  version,
  openAsTab,
  onOpenSettings,
}: {
  version?: string
  openAsTab?: () => void
  /** 打开设置页（popup 中齿轮按钮触发；Chrome 端走 chrome.runtime.openOptionsPage，Tauri 端打开设置窗口） */
  onOpenSettings?: () => void
}) {
  const ports = usePorts()
  const {config} = ports
  const {holdings, indices, lastUpdate, loading, refresh} = useMarketData()
  const [refreshing, setRefreshing] = useState(false)
  const [cfgTick, setCfgTick] = useState(0)

  // 主题：偏好 + 实际生效（system 跟随系统）
  const [themePref, setThemePref] = useState<AppThemePref>(() =>
    getStoredThemePref(),
  )
  useEffect(() => {
    applyTheme(themePref)
  }, [themePref])
  // 配置变化（设置里改了主题/指数）后重新读取偏好
  useEffect(() => {
    setThemePref(getStoredThemePref())
  }, [cfgTick])
  // 跟随系统时订阅系统配色变化：重新 applyTheme（写 data-theme + light/dark class），
  // 并触发一次重渲染让主题切换按钮的图标同步。
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(() =>
    getSystemTheme(),
  )
  useEffect(() => {
    if (themePref !== 'system') return
    return onSystemThemeChange((t) => {
      applyTheme('system')
      setSystemTheme(t)
    })
  }, [themePref])

  // 实际生效的亮/暗（system 时取系统值）
  const resolved: 'light' | 'dark' =
    themePref === 'system' ? systemTheme : themePref

  // 首次拉取
  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  const settings = config.getConfig().settings
  const selectedIndices =
    settings.selectedIndices && settings.selectedIndices.length > 0
      ? settings.selectedIndices
      : DEFAULT_SELECTED_INDICES

  const updatedAt = lastUpdate
    ? new Date(lastUpdate).toLocaleTimeString('zh-CN', {hour12: false})
    : ''

  function toggleTheme() {
    setThemePref((p) => (resolveTheme(p) === 'dark' ? 'light' : 'dark'))
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  function onConfigChanged() {
    setCfgTick((t) => t + 1)
    void refresh()
  }

  // 刻意不传 appearance：Radix 官方建议依赖祖先 class 切换（applyTheme 写在 <html> 上），
  // 这样配色在 React 挂载前就已就位，不会闪烁。默认 appearance="inherit" 不会输出
  // light/dark class，因此不会阻断 <html class="dark"> 的级联。
  return (
    <Theme accentColor="blue" grayColor="gray" radius="small">
      <div
        className="flex h-full min-h-0 flex-col overflow-hidden"
        style={{background: 'var(--app-bg)'}}
      >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line/70 bg-panel/85 px-3 py-1.5 backdrop-blur-md">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="font-display text-base font-extrabold tracking-tight text-ink">
            Fund01
          </span>
          {version ? (
            <span className="font-mono text-[11px] font-normal text-muted">
              v{version}
            </span>
          ) : null}
          <span className="hidden font-mono text-[11px] text-muted sm:inline">
            {updatedAt ? `更新 ${updatedAt}` : ''}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton
            variant="outline"
            onClick={handleRefresh}
            disabled={refreshing}
            title="刷新"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </IconButton>
          <IconButton
            variant="outline"
            onClick={toggleTheme}
            title={resolved === 'light' ? '切换暗色' : '切换亮色'}
          >
            {resolved === 'light' ? (
              <Moon className="h-4 w-4" />
            ) : (
              <Sun className="h-4 w-4" />
            )}
          </IconButton>
          {openAsTab ? (
            <IconButton
              variant="outline"
              onClick={openAsTab}
              title="在新标签页中打开"
            >
              <ExternalLink className="h-4 w-4" />
            </IconButton>
          ) : null}
          <IconButton
            variant="outline"
            onClick={() => onOpenSettings?.()}
            title="设置"
          >
            <Settings2 className="h-4 w-4" />
          </IconButton>
        </div>
      </header>

      <IndexBar indices={indices} selected={selectedIndices} loading={loading} />

      <PopupLayout data={holdings} loading={loading} />
      </div>
    </Theme>
  )
}
