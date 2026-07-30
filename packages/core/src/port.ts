import type {
  AppConfig,
  FundHistoryPayload,
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
  fetchFundHistory(code: string, count?: number): Promise<FundHistoryPayload>
  fetchIndexHistory(code: string, range: string): Promise<IndexHistoryPayload>
  fetchFundIntraday(fundKey: string): Promise<IntradayPoint[]>
  resolveFund(code: string): Promise<ResolveFundPayload>
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

/** UI 与具体 app 之间注入的 Port 集合 */
export interface Ports {
  data: DataPort
  config: ConfigPort
  event: EventPort
}
