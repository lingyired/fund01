import type {
  AppConfig,
  FundHistoryPayload,
  FundHistoryRange,
  FundIntradayPayload,
  GoldPayload,
  HoldingsPayload,
  IndexHistoryPayload,
  IndexItem,
  IntradayPoint,
  MarketOverview,
  QuoteUpdate,
  ResolveFundPayload,
  WatchlistPayload,
} from './types'

/** UI 数据访问抽象 —— 各 app 必须提供实现 */
export interface DataPort {
  /** 触发后端立即刷新（异步，不等待结果） */
  triggerRefresh(): Promise<void>
  /** 持仓汇总（后端已合并行情 + 配置） */
  fetchHoldings(): Promise<HoldingsPayload>
  fetchWatchlist(): Promise<WatchlistPayload>
  fetchIndices(): Promise<IndexItem[]>
  fetchMarketOverview(): Promise<MarketOverview | null>
  fetchGold(): Promise<GoldPayload | null>
  fetchFundHistory(code: string, range?: FundHistoryRange): Promise<FundHistoryPayload>
  fetchIndexHistory(code: string, range: string): Promise<IndexHistoryPayload>
  fetchFundIntraday(fundKey: string): Promise<IntradayPoint[]>
  resolveFund(payload: {
    code: string
    type?: 'hold' | 'watch'
    name?: string
    sectors?: string[]
  }): Promise<ResolveFundPayload>
}

/** UI 配置访问抽象（同步读避免闪烁 + 异步推后端） */
export interface ConfigPort {
  /** 同步读本地缓存（UI 不闪） */
  getConfig(): AppConfig
  /** 写本地缓存 + 异步推后端 */
  saveConfig(config: AppConfig): Promise<void>
  /** 订阅配置变更（多窗口同步） */
  onChanged(cb: (config: AppConfig) => void): () => void
}

/** 后端 → 前端事件订阅抽象 */
export interface EventPort {
  /** 订阅后端推送的行情更新事件 */
  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void
  /** 订阅配置变更（多窗口同步） */
  onConfigChange(cb: (config: AppConfig) => void): () => void
}

/** 设置页一级 tab 标识（OptionsApp 与 openSettings 共用） */
export type SettingsTabId = 'general' | 'holdings' | 'data' | 'menubar'

/** 窗口 / 导航操作抽象 —— 各 app 必须提供实现（Chrome 扩展 API / Tauri 窗口 API） */
export interface WindowPort {
  /** 打开设置页；tab 省略 = 通用页，可指定直达 tab（Chrome: openOptionsPage / tabs.create；Tauri: 打开设置窗口） */
  openSettings(tab?: SettingsTabId): Promise<void>
  /** 新窗口 / 新标签页打开主视图（Chrome: window.open(popup.html?tab=1)；Tauri 无此概念可不实现，UI 自动隐藏按钮） */
  openInNewWindow?(): Promise<void>
  /** 是否支持菜单栏（Tauri 实现返回 true；Chrome 不实现 → undefined → UI 自动隐藏「菜单栏」设置 tab） */
  supportsMenubar?(): boolean
  /** 应用版本号（Chrome: getManifest().version；Tauri: invoke 或构建注入） */
  getVersion(): string
}

/** UI 与具体 app 之间注入的 Port 集合 */
export interface Ports {
  data: DataPort
  config: ConfigPort
  event: EventPort
  window: WindowPort
}
