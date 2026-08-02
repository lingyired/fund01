// 共享类型定义

export type FundRecord = {
  code: string
  name: string
  fundKey?: string
  type: 'hold' | 'watch'
  /**
   * 该基金在各分组下的份额分配（仅持仓使用）。
   * key 是分组名（'' 表示未分组），value 是该分组下的份额。
   * 一个基金可在多个分组下有独立份额，总份额 = 各 value 之和。
   * 自选列表不用此字段（空对象）。
   */
  allocations: Record<string, number>
  /**
   * 该基金在各分组的持仓成本单价（仅持仓使用，与 allocations 同 key）。
   * value 是该分组买入时的单位成本价（元/份），用于计算累计收益。
   * 总成本 = Σ(单价[g] × 份额[g])。缺失或 0 表示未录入，累计收益显示为 --。
   */
  costs?: Record<string, number>
  sectors: string[]
  /** @deprecated 旧版字段，已由 allocations 替代，保留仅用于兼容旧配置 */
  shares?: number
  /** @deprecated 旧版字段 */
  group?: string
  /** @deprecated 旧版字段 */
  groups?: string[]
  createdAt?: string
  updatedAt?: string
}

export type FundQuoteRow = FundRecord & {
  amount: number
  percent: number | null
  percentSource?: 'estimate' | 'confirmed' | null
  estimateGrowth?: number | null
  dayGrowth?: number | null
  netValueDate?: string
  netValue?: number | null
  estimateNetValue?: number | null
  prevNetValue?: number | null
  time?: string | null
  trend: {time: string; growth: number | null; netValue?: number | null}[]
  liveAmount?: number
  pnl?: number
  weight?: number
  confirmedUpdated?: boolean
  /** 累计投入成本合计（各分组 cost 之和）；为 0 表示未录入 */
  totalCost?: number
  /** 累计收益 = 当前市值 - 总成本；null 表示未录入成本 */
  totalCumPnl?: number | null
  /** 累计收益率(%) = 累计收益 / 总成本 × 100；null 表示未录入成本 */
  totalCumPnlPercent?: number | null
}

export type HoldingsPayload = {
  summary: {
    totalAmount: number
    bodTotal?: number
    totalPnl: number
    totalPnlPercent: number
    /** 累计投入成本合计（仅含录入成本的持仓） */
    totalCost?: number
    /** 累计收益合计（基于当前市值与录入成本） */
    totalCumPnl?: number | null
    /** 累计收益率合计(%) */
    totalCumPnlPercent?: number | null
  }
  list: FundQuoteRow[]
}

export type IndexItem = {
  code: string
  name: string
  percent: number | null
  price?: number | null
  change?: number | null
}

export type SectorItem = {
  code: string
  name: string
  percent: number | null
}

export type MarketOverview = {
  upDown: {up: number; down: number; flat: number; time: string | null}
  topGainers: SectorItem[]
  topLosers: SectorItem[]
}

export type GoldPayload = {
  code: string
  name: string
  price: number | null
  prevClose?: number | null
  percent: number | null
  change: number | null
  time: string
  holding: number
  avgPrice: number
  pnl: number | null
  pnlPercent: number | null
  costPnl?: number | null
  costPnlPercent?: number | null
  show?: boolean
  trend: {time: string; price: number; percent: number | null}[]
}

export type RefreshInterval = {
  /** 任一市场开盘时的刷新间隔（秒），默认 60，最低 30（chrome.alarms 限制） */
  trading: number
  /** 所有市场均非交易时段时的刷新间隔（秒），默认 600，最低 300 */
  nonTrading: number
}

/**
 * 基金当日行情数据源。
 * - fundmnfinfo：东方财富 FundMNFInfo 批量接口（净值/估值/涨跌幅），默认；分时走势仍走 fund123
 * - fund123：蚂蚁基金（fund123.cn）+ 东方财富历史净值，盘中估值走势走 fund123
 */
export type QuoteSource = 'fund123' | 'fundmnfinfo'

/** 主题偏好：跟随系统 / 亮色 / 暗色，默认 system */
export type AppThemePref = 'system' | 'light' | 'dark'

/** 指数看板默认显示的指数 code（最多 5 个） */
export const DEFAULT_SELECTED_INDICES: string[] = [
  '000001', // 上证指数
  '399001', // 深证成指
  '399006', // 创业板指
  '000300', // 沪深300
  'NDX', // 纳斯达克100
]

export const MAX_SELECTED_INDICES = 5

export type AppSettings = {
  showGold: boolean
  /** 定时刷新间隔配置（秒） */
  refreshInterval?: RefreshInterval
  /** 基金当日行情数据源，默认 fundmnfinfo */
  quoteSource?: QuoteSource
  /** 持仓分组名称列表（按顺序展示，未在此列表的 groups 视为未分组） */
  holdingGroups?: string[]
  /**
   * 各分组内基金的排序（key=分组名，value=基金 code 有序列表）。
   * 未在列表中的基金按默认（金额降序）排在已排序基金之后。
   * 批量编辑弹窗中可调整。
   */
  holdingGroupOrders?: Record<string, string[]>
  /** 主题偏好，默认 system（跟随系统） */
  theme?: AppThemePref
  /** 指数看板显示的指数 code 列表（最多 5 个），默认见 DEFAULT_SELECTED_INDICES */
  selectedIndices?: string[]
}

export type AppConfig = {
  settings: AppSettings
  /** 持仓列表（与 watchlist 互相独立，同一基金可同时存在两边） */
  holdings: Record<string, FundRecord>
  /** 自选列表（与 holdings 互相独立） */
  watchlist: Record<string, FundRecord>
  gold: {holding: number; avgPrice: number}
}

export type IndexHistoryRange = '1m' | '3m' | '6m' | '1y' | '3y'

export type IndexHistoryPayload = {
  code: string
  name: string
  range: IndexHistoryRange
  periodPercent: number | null
  points: {date: string; close: number; percent: number | null}[]
}

export type FundHistoryRange = '3m' | '1y' | '3y' | 'since'

export type FundHistoryPayload = {
  code: string
  range: FundHistoryRange
  periodPercent: number | null
  points: {date: string; netValue: number; percent: number | null}[]
}

export type ResolveFundResult = {
  code: string
  name: string
  fundKey: string
  sectors: string[]
  netValue?: number | null
  prevNetValue?: number | null
  prevNetValueDate?: string
  netValueDate?: string
  confirmedSession?: boolean
}

/** 盘中分时走势（FundTrendDialog 懒加载） */
export type FundIntradayPayload = {
  points: {time: string; growth: number | null; netValue?: number | null}[]
  latest: {time: string; growth: number | null; netValue?: number | null} | null
  fundKey: string
  name: string
}

export type ResolveFundPayload = ResolveFundResult

export type IntradayPoint = { time: string; growth: number | null; netValue?: number | null }

export type WatchlistPayload = FundQuoteRow[]

export type QuoteUpdate = {
  holdings: HoldingsPayload | null
  watchlist: WatchlistPayload | null
  indices: IndexItem[] | null
  market: MarketOverview | null
  gold: GoldPayload | null
  time: number
}
