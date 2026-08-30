import {useCallback, useEffect, useMemo, useState} from 'react'
import {ExternalLink, Moon, Settings2, Sun} from 'lucide-react'
import type {AppThemePref, QuoteSource} from '@fund01/core'
import {DEFAULT_SELECTED_INDICES, isNightMarketActive} from '@fund01/core'
import {
  applyTheme,
  getStoredThemePref,
  getSystemTheme,
  onSystemThemeChange,
  resolveTheme,
} from './theme'
import {useMarketData, useMenubarEmpty} from './hooks'
import {usePorts} from './context'
import {IndexBar} from './components/popup/IndexBar'
import {PopupLayout} from './components/popup/PopupLayout'
import {AutoRefreshButton} from './components/AutoRefreshButton'
import {MenubarEmptyBanner} from './components/MenubarEmptyBanner'
import {buildPendingHoldings, updateSettings} from './lib/fundOps'
import {IconButton, Theme, Tooltip} from '@radix-ui/themes'
// 注意：Radix 的 styles.css 不在这里 import —— 它已在 index.css 里以
// `@import '@radix-ui/themes/styles.css' layer(radix-themes)` 的方式引入，
// 以便和 Tailwind 建立正确的 CSS 层级顺序（详见 index.css 顶部注释）。
import './index.css'

export function App() {
  const ports = usePorts()
  const {config, window: windowPort} = ports
  const {holdings, indices, lastUpdate, loading, refresh, refreshSchedule} =
    useMarketData()
  const [refreshing, setRefreshing] = useState(false)
  const [cfgTick, setCfgTick] = useState(0)
  // menubar 全空（Tauri 端用户移除了所有菜单栏状态项）→ header 替换为恢复 banner
  const menubarEmpty = useMenubarEmpty()
  const restoreMenubar = useCallback(async () => {
    try {
      // 清空隐藏列表（含 __overview__）→ Rust 侧 rebuild 全部实例原位复活
      await updateSettings(ports, {menubarHiddenGroups: []})
    } catch {
      /* 恢复失败不阻塞；下次打开 app 也会自动恢复默认菜单栏 */
    }
  }, [ports])

  // 手动刷新入口：拉数据期间图标持续旋转，结束后复原。
  // resetTimer=true 会重置后台定时器与进度环，并广播新计划让其他已打开的标签页 / Tauri 独立窗口同步。
  // 注意：打开 popup 不再触发刷新（避免频繁网络请求，尤其非盘中期），数据靠挂载时的初始拉取 + 后台定时刷新。
  const doRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refresh])

  // 美股指数 code（与 @fund01/services isUsIndexCode 保持一致：INDEX_LIST 中 sinaUs 项）
  const US_INDEX_CODES = ['NDX', 'SPX']
  // 非盘中却显示盘中间隔：通常是勾选了美股指数、当前处于夜盘（20:00–次日 04:00），
  // 后台据此用 trading 间隔只刷美股行情；其余数据仍按各自市场时段更新。
  const refreshDetail = useMemo(() => {
    const sel = (config.getConfig()?.settings?.selectedIndices as string[] | undefined) || []
    const hasUs = sel.some((c) => US_INDEX_CODES.includes(String(c)))
    if (hasUs && isNightMarketActive(new Date())) {
      return '因已勾选美股指数，夜盘按 60 秒获取美股行情；其余数据沿用盘中窗口'
    }
    return undefined
  }, [config, cfgTick])

  // 主题：偏好 + 实际生效（system 跟随系统）
  const [themePref, setThemePref] = useState<AppThemePref>(() =>
    getStoredThemePref(),
  )
  useEffect(() => {
    applyTheme(themePref)
  }, [themePref])
  // 配置变化（设置里改了指数看板/主题等）后重读配置：popup 常驻时保持同步，
  // 否则 selectedIndices 等只在首次渲染读取一次，修改后 popup 仍显示旧配置。
  // ConfigPort.onChanged 各平台实现已覆盖「任何窗口」的变更：
  // tauri 监听 config-change 广播；chrome 合并同窗口本地 listeners + 跨窗口 storage 事件
  useEffect(() => {
    const off = config.onChanged(() => setCfgTick((t) => t + 1))
    return off
  }, [config])
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

  // 版本号（header 品牌名右侧）统一走 WindowPort，跨端一致
  const version = windowPort.getVersion()
  // 新窗口/新标签页打开能力为可选：Port 不实现时按钮自动隐藏
  const openInNewWindow = windowPort.openInNewWindow
  const openInNewWindowTitle =
    windowPort.openInNewWindowTitle?.() ?? '在新标签页中打开'

  // 外部直达分组 tab（Tauri）：
  // 1) 初次创建浮窗时 URL 带 ?tab=xxx（window.rs ensure_popup_window 创建时拼入）；
  // 2) 浮窗已存在时点击 menubar 实例 → popup-open-group 事件（EventPort 可选，Chrome 不实现）。
  // 统一为 {id} 对象传给 PopupLayout：每次事件都产生新对象（对象身份触发 effect），
  // 保证「浮窗开着时重复点击同一分组」也能重新定位；null = 不干预。
  const [requestedTab, setRequestedTab] = useState<{id: string} | null>(() => {
    try {
      const id = new URLSearchParams(window.location.search).get('tab')
      return id ? {id} : null
    } catch {
      return null
    }
  })
  const popupOpenGroup = ports.event.onPopupOpenGroup
  useEffect(() => {
    if (!popupOpenGroup) return
    return popupOpenGroup((tabId) => setRequestedTab({id: tabId}))
  }, [popupOpenGroup])

  const settings = config.getConfig().settings
  // 数据源标识：fundmnfinfo=东方财富→「东」，fund123=蚂蚁基金→「蚁」，xiaobei=小倍养基→「倍」
  const quoteSource: QuoteSource = settings.quoteSource ?? 'fundmnfinfo'
  const quoteSourceBadge =
    quoteSource === 'fund123' ? '蚁' : quoteSource === 'xiaobei' ? '倍' : '东'
  const quoteSourceTitle =
    quoteSource === 'fund123'
      ? '数据源：蚂蚁基金（fund123）'
      : quoteSource === 'xiaobei'
        ? '数据源：小倍养基（盘中估值）'
        : '数据源：东方财富（FundMNFInfo）'
  const selectedIndices =
    settings.selectedIndices && settings.selectedIndices.length > 0
      ? settings.selectedIndices
      : DEFAULT_SELECTED_INDICES

  const updatedAt = lastUpdate
    ? new Date(lastUpdate).toLocaleTimeString('zh-CN', {hour12: false})
    : ''

  // 行情快照未就绪（后端首轮刷新进行中 / 切源清空待刷）时，用本地配置合成持仓骨架
  // 立即渲染列表结构；quotePending=true 时行情数值列显示 -- 并附「正在加载行情」提示。
  const displayHoldings = holdings ?? buildPendingHoldings(config.getConfig())
  const quotePending = holdings == null && displayHoldings != null

  function toggleTheme() {
    setThemePref((p) => (resolveTheme(p) === 'dark' ? 'light' : 'dark'))
  }

  function onConfigChanged() {
    setCfgTick((t) => t + 1)
    void doRefresh()
  }

  // 刻意不传 appearance：Radix 官方建议依赖祖先 class 切换（applyTheme 写在 <html> 上），
  // 这样配色在 React 挂载前就已就位，不会闪烁。默认 appearance="inherit" 不会输出
  // light/dark class，因此不会阻断 <html class="dark"> 的级联。
  return (
    <Theme accentColor="blue" grayColor="mauve" radius="small">
      <div
        className="flex h-full min-h-0 flex-col overflow-hidden"
        style={{background: 'var(--app-bg)'}}
      >
      {menubarEmpty ? (
        <MenubarEmptyBanner
          onRestore={() => void restoreMenubar()}
          onRefresh={() => void doRefresh()}
          onOpenSettings={() => void windowPort.openSettings()}
        />
      ) : (
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
          <span
            title={quoteSourceTitle}
            className="rounded bg-accent/10 px-1 text-[10px] font-semibold leading-4 text-accent"
          >
            {quoteSourceBadge}
          </span>
          <span className="hidden font-mono text-[11px] text-muted sm:inline">
            {updatedAt ? `更新 ${updatedAt}` : ''}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <AutoRefreshButton
            intervalSeconds={refreshSchedule.intervalSeconds}
            nextRefreshAt={refreshSchedule.nextRefreshAt}
            onClick={doRefresh}
            disabled={refreshing}
            loading={refreshing}
            title="刷新"
            detail={refreshDetail}
          />
          <Tooltip content={resolved === 'light' ? '切换暗色' : '切换亮色'}>
            <IconButton
              variant="outline"
              onClick={toggleTheme}
              aria-label={resolved === 'light' ? '切换暗色' : '切换亮色'}
            >
              {resolved === 'light' ? (
                <Moon className="h-4 w-4" />
              ) : (
                <Sun className="h-4 w-4" />
              )}
            </IconButton>
          </Tooltip>
          {openInNewWindow ? (
            <Tooltip content={openInNewWindowTitle}>
              <IconButton
                variant="outline"
                onClick={() => void openInNewWindow()}
                aria-label={openInNewWindowTitle}
              >
                <ExternalLink className="h-4 w-4" />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip content="设置">
            <IconButton
              variant="outline"
              onClick={() => void windowPort.openSettings()}
              aria-label="设置"
            >
              <Settings2 className="h-4 w-4" />
            </IconButton>
          </Tooltip>
        </div>
      </header>
      )}

      {/* 指数看板由 selected（默认 5 个）驱动渲染，行情缺失时显示占位卡片，无需 loading */}
      <IndexBar indices={indices} selected={selectedIndices} />

      {/* 持仓结构（分组/基金列表，本地配置）与行情数值（数据源请求）解耦：
          行情快照未就绪时用配置合成骨架 payload 立即渲染列表，数值列显示 --，
          待首份 quote-update 推来真实数据后填充（quotePending 驱动占位与提示）。 */}
      <PopupLayout
        data={displayHoldings}
        quotePending={quotePending}
        loading={loading}
        onEditHoldings={() => void windowPort.openSettings('holdings')}
        requestedTab={requestedTab}
      />
      </div>
    </Theme>
  )
}
