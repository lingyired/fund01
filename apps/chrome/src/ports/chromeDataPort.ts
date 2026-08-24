import type {
  DataPort,
  FundHistoryPayload,
  FundHistoryRange,
  FundIntradayPayload,
  HoldingsPayload,
  IndexHistoryPayload,
  IndexItem,
  IntradayPoint,
  ResolveFundPayload,
} from '@fund01/core'

// SW 消息协议（与 background/index.ts 的 Message 类型保持一致）
type Message =
  | { type: 'REFRESH'; resetTimer?: boolean }
  | { type: 'CLEAR_CACHE' }
  | { type: 'FETCH_QUOTES'; funds: any[]; quoteType?: 'hold' }
  | { type: 'FETCH_FUND_HISTORY'; code: string; range: string }
  | { type: 'FETCH_INDEX_HISTORY'; code: string; range: string }
  | { type: 'FETCH_INDICES' }
  | {
      type: 'RESOLVE_FUND'
      code: string
      fundType?: 'hold'
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
 * - 行情类（holdings/indices）直接读 chrome.storage.local 缓存（SW 已合并）
 * - 历史类（fundHistory/indexHistory/intraday/resolveFund）走 sendMessage 让 SW 拉取
 */
export class ChromeDataPort implements DataPort {
  async triggerRefresh(resetTimer = true): Promise<void> {
    await sendMessage({ type: 'REFRESH', resetTimer })
  }

  /** 清空全部缓存（cache-*）并强制刷新 —— 改代码后缓存不失效时一键重置 */
  async clearCache(): Promise<void> {
    await sendMessage({ type: 'CLEAR_CACHE' })
  }

  async fetchHoldings(): Promise<HoldingsPayload | null> {
    const r = await chrome.storage.local.get('cache-holdings')
    // 缓存未就绪（SW 尚未完成首轮刷新）返回 null，与 Tauri 端「数据在途」语义统一：
    // 前端保持加载态等事件推送，不把「数据在途」误显示为「暂无持仓」
    return (r['cache-holdings'] as HoldingsPayload | undefined) ?? null
  }

  async fetchIndices(): Promise<IndexItem[]> {
    const r = await chrome.storage.local.get('cache-indices')
    const cached = (r['cache-indices'] as IndexItem[]) || []
    if (cached.length) return cached
    // 读时填充：指数快照缺失（非盘中 SW 不刷新）→ 让 SW 实时拉一次全量指数并写缓存，
    // 保证 popup 初始即有默认 5 个指数的行情，不依赖刷新循环的时段窗口（指数面板独立于持仓）。
    return sendMessage<IndexItem[]>({type: 'FETCH_INDICES'}).catch(() => [])
  }

  /** 最近一次后台刷新时间：读 SW 写入的 cache-time（后台静默刷新也持续更新） */
  async fetchLastUpdate(): Promise<number> {
    const r = await chrome.storage.local.get('cache-time')
    return (r['cache-time'] as number) || 0
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

  async resolveFund(payload: {
    code: string
    type?: 'hold'
    name?: string
    sectors?: string[]
  }): Promise<ResolveFundPayload> {
    return sendMessage({
      type: 'RESOLVE_FUND',
      code: payload.code,
      fundType: payload.type,
      name: payload.name,
      sectors: payload.sectors,
    })
  }
}
