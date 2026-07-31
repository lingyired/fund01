import {useEffect, useState} from 'react'
import {ExternalLink, FolderSync, Moon, RefreshCw, Sun} from 'lucide-react'
import type {
  GoldPayload,
  HoldingsPayload,
  IndexItem,
  MarketOverview,
} from '@fund01/core'
import {applyTheme, getStoredTheme, type AppTheme} from './theme'
import {useMarketData} from './hooks'
import {usePorts} from './context'
import {Button} from './components/ui/button'
import {HoldingsModule} from './components/HoldingsModule'
import {WatchlistModule} from './components/WatchlistModule'
import {IndicesModule, MarketModule} from './components/MarketModules'
import {ConfigDialog} from './components/ConfigDialog'
import './index.css'

export function App({version, openAsTab}: {version?: string; openAsTab?: () => void}) {
  const {config} = usePorts()
  const {holdings, watchlist, indices, market, gold, lastUpdate, loading, refresh} =
    useMarketData()
  const [showGold, setShowGold] = useState(
    () => config.getConfig().settings.showGold !== false,
  )
  const [togglingGold, setTogglingGold] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [theme, setTheme] = useState<AppTheme>(() => getStoredTheme())

  // 订阅后端行情更新由 useMarketData 内部完成；首次拉取也由其触发
  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const updatedAt = lastUpdate
    ? new Date(lastUpdate).toLocaleTimeString('zh-CN', {hour12: false})
    : ''

  function toggleTheme() {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'))
  }

  async function toggleGold() {
    const next = !showGold
    setTogglingGold(true)
    try {
      const cfg = config.getConfig()
      cfg.settings.showGold = next
      await config.saveConfig(cfg)
      setShowGold(next)
    } finally {
      setTogglingGold(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  // 配置变更后（增删基金/导入配置）通知后端刷新
  function onConfigChanged() {
    void refresh()
  }

  return (
    <div className="min-h-screen w-full">
      <header className="sticky top-0 z-40 w-full border-b border-line/80 bg-panel/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between gap-3 px-3 py-3 sm:px-5 lg:px-8">
          <div className="min-w-0">
            <div className="font-display text-xl font-extrabold tracking-tight text-ink sm:text-2xl lg:text-3xl">
              Fund01
              {version ? (
                <span className="ml-2 align-middle font-mono text-xs font-normal text-muted">
                  v{version}
                </span>
              ) : null}
            </div>
            <p className="truncate text-[11px] text-muted sm:text-xs lg:text-sm">
              持仓 / 黄金 / 指数 / 大盘 / 自选
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden font-mono text-xs text-muted md:inline">
              {updatedAt ? `更新 ${updatedAt}` : ''}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void toggleGold()}
              disabled={togglingGold}
              title={showGold ? '隐藏黄金板块' : '显示黄金板块'}
            >
              <span className="sm:hidden">{showGold ? '金开' : '金关'}</span>
              <span className="hidden sm:inline">{showGold ? '关闭黄金板块' : '打开黄金板块'}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleTheme}
              title={theme === 'light' ? '切换暗色' : '切换亮色'}
            >
              {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              <span className="hidden sm:inline">{theme === 'light' ? '暗色' : '亮色'}</span>
            </Button>
            {openAsTab ? (
              <Button
                variant="outline"
                size="sm"
                onClick={openAsTab}
                title="在新标签页中打开"
              >
                <ExternalLink className="h-4 w-4" />
                <span className="hidden sm:inline">新标签页</span>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setConfigOpen(true)}>
              <FolderSync className="h-4 w-4" />
              <span className="hidden sm:inline">配置</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">刷新</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex w-full flex-col gap-4 px-3 py-4 sm:gap-5 sm:px-5 sm:py-6 lg:px-8">
        <IndicesModule list={indices} loading={loading} />

        <HoldingsModule
          data={holdings}
          gold={gold}
          showGold={showGold}
          loading={loading}
          onChanged={onConfigChanged}
        />

        {/* 后续再放回更合适的位置
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start lg:gap-5">
          <MarketModule data={market} loading={loading} />
          <WatchlistModule list={watchlist} loading={loading} onChanged={onConfigChanged} />
        </div>
        */}

        <footer className="mx-auto max-w-3xl space-y-1 pb-6 pt-1 text-center text-[11px] leading-relaxed text-muted sm:text-xs">
          <p>数据来自第三方公开接口，可能延迟或不准确，仅供个人展示参考，不构成投资建议。</p>
          <p>持仓等个人配置保存在本机浏览器；请以官方披露为准。</p>
        </footer>
      </main>

      <ConfigDialog open={configOpen} onOpenChange={setConfigOpen} onImported={onConfigChanged} />
    </div>
  )
}
