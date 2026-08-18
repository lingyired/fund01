import { invoke } from '@tauri-apps/api/core'
import type {
  DataPort,
  FundHistoryPayload,
  FundHistoryRange,
  HoldingsPayload,
  IndexHistoryPayload,
  IndexItem,
  IntradayPoint,
  RefreshSchedule,
  ResolveFundPayload,
} from '@fund01/core'

/**
 * Tauri 数据 Port：行情类读 Rust 内存缓存（fetch_*），
 * 历史/解析类走实时 invoke RPC。
 */
export class TauriDataPort implements DataPort {
  async triggerRefresh(resetTimer = true): Promise<void> {
    await invoke('trigger_refresh', {resetTimer})
  }

  /**
   * Rust 内存缓存可能尚未就绪（app 启动首轮刷新进行中 / 切源清空待刷）→ 返回 null。
   * 前端 useMarketData 据此保持加载态（等 quote-update 推来第一份数据），
   * 避免把「数据在途」误显示为「暂无持仓」。
   */
  async fetchHoldings(): Promise<HoldingsPayload | null> {
    return invoke<HoldingsPayload | null>('fetch_holdings')
  }

  async fetchIndices(): Promise<IndexItem[]> {
    return invoke<IndexItem[]>('fetch_indices')
  }

  /** 最近一次后台刷新时间：读 Rust 内存缓存 quote.time（后台静默刷新也持续更新） */
  async fetchLastUpdate(): Promise<number> {
    return invoke<number>('fetch_last_update')
  }

  /** 当前自动刷新计划：读 Rust 依据当前市场档位算出的权威 nextRefreshAt */
  async fetchRefreshSchedule(): Promise<RefreshSchedule> {
    return invoke<RefreshSchedule>('get_refresh_schedule')
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
