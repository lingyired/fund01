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

/** 指数的简档（仅 code + name），用于看板候选列表等静态场景。 */
export type IndexMeta = {code: string; name: string}

/** 指数候选目录（看板可勾选的全部指数，带名称）。最多选中 MAX_SELECTED_INDICES 个。 */
export const AVAILABLE_INDICES: IndexMeta[] = [
  {code: '000001', name: '上证指数'},
  {code: '399001', name: '深证成指'},
  {code: '399006', name: '创业板指'},
  {code: '899050', name: '北证50'},
  {code: '000688', name: '科创50'},
  {code: '000016', name: '上证50'},
  {code: '000300', name: '沪深300'},
  {code: '000905', name: '中证500'},
  {code: 'NDX', name: '纳斯达克100'},
  {code: 'SPX', name: '标普500'},
]

/** 扩展程序角标（badge）显示方式 */
export type BadgeMode = 'percent' | 'amount' | 'hidden'

export type AppSettings = {
  showGold: boolean
  /** 定时刷新间隔配置（秒） */
  refreshInterval?: RefreshInterval
  /** 基金当日行情数据源，默认 fundmnfinfo */
  quoteSource?: QuoteSource
  /** 扩展角标显示方式：收益率百分比 / 收益额 / 隐藏。默认 percent */
  badgeMode?: BadgeMode
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
  /**
   * 菜单栏中隐藏的持仓分组名列表（仅 tauri 生效；'' 表示未分组）。
   * 不在列表中的分组默认显示；「总览」恒显示。
   */
  menubarHiddenGroups?: string[]
  /** 菜单栏布局模式：0=上小下大(默认) 1=上大下小 2=等大。仅 tauri 生效 */
  menubarLayout?: 0 | 1 | 2
  /** 菜单栏上行字体大小（pt，位置语义，由 Rust 侧按当前布局 clamp） */
  menubarTopFontSize?: number
  /** 菜单栏下行字体大小（pt，位置语义，由 Rust 侧按当前布局 clamp） */
  menubarBottomFontSize?: number
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
  /**
   * 数据源返回的官方基金名，不受调用方传入 name 影响。
   * 用于校验「代码 ↔ 名称」是否指向同一只基金。
   */
  officialName?: string
  /**
   * 传入 name 与任一平台官方名都不符，且按名称反查也没能确定正确代码。
   * 此时 code 保持调用方传入值。调用方应据此**拒绝导入**（AI 识图常错代码）。
   */
  nameMismatch?: {input: string; officials: string[]}
  /**
   * 按名称反查后纠正了基金代码（传入代码指向的是另一只基金）。
   * `matchedBy: 'exact'` 为名称完全一致，`'loose'` 为忽略基金类型词后一致。
   */
  codeCorrected?: {
    from: string
    to: string
    fromName: string
    toName: string
    matchedBy: 'exact' | 'loose'
  }
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
