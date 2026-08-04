import { invoke } from '@tauri-apps/api/core'
import type {
  DataPort,
  FundHistoryPayload,
  FundHistoryRange,
  GoldPayload,
  HoldingsPayload,
  IndexHistoryPayload,
  IndexItem,
  IntradayPoint,
  MarketOverview,
  ResolveFundPayload,
  WatchlistPayload,
} from '@fund01/core'

/**
 * Tauri 数据 Port：行情类读 Rust 内存缓存（fetch_*），
 * 历史/解析类走实时 invoke RPC。
 */
export class TauriDataPort implements DataPort {
  async triggerRefresh(): Promise<void> {
    await invoke('trigger_refresh')
  }

  async fetchHoldings(): Promise<HoldingsPayload> {
    const r = await invoke<HoldingsPayload | null>('fetch_holdings')
    return r ?? { summary: { totalAmount: 0, totalPnl: 0, totalPnlPercent: 0 }, list: [] }
  }

  async fetchWatchlist(): Promise<WatchlistPayload> {
    const r = await invoke<WatchlistPayload | null>('fetch_watchlist')
    return r ?? []
  }

  async fetchIndices(): Promise<IndexItem[]> {
    return invoke<IndexItem[]>('fetch_indices')
  }

  async fetchMarketOverview(): Promise<MarketOverview | null> {
    return invoke<MarketOverview | null>('fetch_market_overview')
  }

  async fetchGold(): Promise<GoldPayload | null> {
    return invoke<GoldPayload | null>('fetch_gold')
  }

  async fetchFundHistory(code: string, range: FundHistoryRange = '1y'): Promise<FundHistoryPayload> {
    return invoke<FundHistoryPayload>('fetch_fund_history', { code, range: range ?? null })
  }

  async fetchIndexHistory(code: string, range: string = '3m'): Promise<IndexHistoryPayload> {
    return invoke<IndexHistoryPayload>('fetch_index_history', { code, range })
  }

  async fetchFundIntraday(fundKey: string): Promise<IntradayPoint[]> {
    const data = await invoke<{ points: IntradayPoint[] }>('fetch_fund_intraday', {
      req: { code: fundKey, fundKey },
    })
    return data.points
  }

  async resolveFund(payload: {
    code: string
    type?: 'hold' | 'watch'
    name?: string
    sectors?: string[]
  }): Promise<ResolveFundPayload> {
    return invoke<ResolveFundPayload>('resolve_fund', {
      req: {
        code: payload.code,
        type: payload.type ?? null,
        name: payload.name ?? null,
        sectors: payload.sectors ?? null,
      },
    })
  }
}
