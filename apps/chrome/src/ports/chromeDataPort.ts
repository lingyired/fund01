import type {
  DataPort,
  FundHistoryPayload,
  FundHistoryRange,
  FundIntradayPayload,
  GoldPayload,
  HoldingsPayload,
  IndexHistoryPayload,
  IndexItem,
  IntradayPoint,
  MarketOverview,
  ResolveFundPayload,
  WatchlistPayload,
} from '@fund01/core'

// SW 消息协议（与 background/index.ts 的 Message 类型保持一致）
type Message =
  | { type: 'REFRESH' }
  | { type: 'FETCH_QUOTES'; funds: any[]; quoteType: 'hold' | 'watch' }
  | { type: 'FETCH_FUND_HISTORY'; code: string; range: string }
  | { type: 'FETCH_INDEX_HISTORY'; code: string; range: string }
  | { type: 'FETCH_INDICES' }
  | { type: 'FETCH_MARKET' }
  | { type: 'FETCH_GOLD'; holding: number; avgPrice: number }
  | {
      type: 'RESOLVE_FUND'
      code: string
      fundType?: 'hold' | 'watch'
      name?: string
      sectors?: string[]
    }
  | { type: 'FETCH_FUND_INTRADAY'; code: string; fundKey?: string; name?: string }

/** 发送消息到 SW，返回 data 字段 */
function sendMessage<T>(msg: Message): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: { ok: boolean; data?: T; error?: string }) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      if (res?.ok) resolve(res.data as T)
      else reject(new Error(res?.error || 'unknown error'))
    })
  })
}

/**
 * Chrome 扩展数据 Port 实现。
 * - 行情类（holdings/watchlist/indices/market/gold）直接读 chrome.storage.local 缓存（SW 已合并）
 * - 历史类（fundHistory/indexHistory/intraday/resolveFund）走 sendMessage 让 SW 拉取
 */
export class ChromeDataPort implements DataPort {
  async triggerRefresh(): Promise<void> {
    await sendMessage({ type: 'REFRESH' })
  }

  async fetchHoldings(): Promise<HoldingsPayload> {
    const r = await chrome.storage.local.get('cache-holdings')
    return r['cache-holdings'] as HoldingsPayload
  }

  async fetchWatchlist(): Promise<WatchlistPayload> {
    const r = await chrome.storage.local.get('cache-watchlist')
    return r['cache-watchlist'] as WatchlistPayload
  }

  async fetchIndices(): Promise<IndexItem[]> {
    const r = await chrome.storage.local.get('cache-indices')
    return (r['cache-indices'] as IndexItem[]) || []
  }

  async fetchMarketOverview(): Promise<MarketOverview | null> {
    const r = await chrome.storage.local.get('cache-market')
    return (r['cache-market'] as MarketOverview) || null
  }

  async fetchGold(): Promise<GoldPayload | null> {
    const r = await chrome.storage.local.get('cache-gold')
    return (r['cache-gold'] as GoldPayload) || null
  }

  async fetchFundHistory(
    code: string,
    range: FundHistoryRange = '1y',
  ): Promise<FundHistoryPayload> {
    return sendMessage({ type: 'FETCH_FUND_HISTORY', code, range })
  }

  async fetchIndexHistory(code: string, range: string = '3m'): Promise<IndexHistoryPayload> {
    return sendMessage({ type: 'FETCH_INDEX_HISTORY', code, range })
  }

  async fetchFundIntraday(fundKey: string): Promise<IntradayPoint[]> {
    const data = await sendMessage<FundIntradayPayload>({
      type: 'FETCH_FUND_INTRADAY',
      code: fundKey,
      fundKey,
    })
    return data.points
  }

  async resolveFund(code: string): Promise<ResolveFundPayload> {
    return sendMessage({ type: 'RESOLVE_FUND', code })
  }
}
