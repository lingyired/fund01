import {
  getFundsQuotes,
  getFundHistory,
  resolveFund,
  fetchFundIntradayForDialog,
} from '@fund01/services'
import {getIndices, getIndexHistory, getMarketOverview} from '@fund01/services'
import {getGoldRealtime} from '@fund01/services'
import {
  isAnyMarketActive,
  shouldRefreshAShareMarket,
  shouldRefreshFund,
  shouldRefreshGold,
  calcHoldings,
  mergeWatchlist,
} from '@fund01/core'
import type {AppConfig} from '@fund01/core'

const REFRESH_ALARM = 'refresh-quotes'
const CONFIG_KEY = 'session-config'
const CACHE_KEYS = {
  holdings: 'cache-holdings',
  watchlist: 'cache-watchlist',
  indices: 'cache-indices',
  market: 'cache-market',
  gold: 'cache-gold',
  time: 'cache-time',
} as const

/** 默认刷新间隔（秒），与 portfolioLogic 保持一致 */
const DEFAULT_REFRESH_INTERVAL = {trading: 60, nonTrading: 600}
const MIN_REFRESH_INTERVAL = {trading: 30, nonTrading: 300}

type Message =
  | {type: 'REFRESH'}
  | {type: 'FETCH_QUOTES'; funds: any[]; quoteType: 'hold' | 'watch'}
  | {type: 'FETCH_FUND_HISTORY'; code: string; range: string}
  | {type: 'FETCH_INDEX_HISTORY'; code: string; range: string}
  | {type: 'FETCH_INDICES'}
  | {type: 'FETCH_MARKET'}
  | {type: 'FETCH_GOLD'; holding: number; avgPrice: number}
  | {type: 'RESOLVE_FUND'; code: string; fundType?: 'hold' | 'watch'; name?: string; sectors?: string[]}
  | {type: 'FETCH_FUND_INTRADAY'; code: string; fundKey?: string; name?: string}

/** 从 chrome.storage.local 读取前端推送的配置（ConfigPort.saveConfig 写入） */
async function getSessionConfig(): Promise<AppConfig | null> {
  const r = await chrome.storage.local.get(CONFIG_KEY)
  return (r[CONFIG_KEY] as AppConfig) || null
}

/** 读取配置中的刷新间隔，夹到合法区间 */
function getRefreshInterval(config: AppConfig | null) {
  const ri = config?.settings?.refreshInterval
  const trading = Math.max(
    MIN_REFRESH_INTERVAL.trading,
    Number(ri?.trading) || DEFAULT_REFRESH_INTERVAL.trading,
  )
  const nonTrading = Math.max(
    MIN_REFRESH_INTERVAL.nonTrading,
    Number(ri?.nonTrading) || DEFAULT_REFRESH_INTERVAL.nonTrading,
  )
  return {trading, nonTrading}
}

/**
 * 按各数据源的市场时段刷新；非交易时段的数据源跳过（保留旧缓存）。
 * 仅当至少刷新了一个数据源时才写 cache-time，避免 UI 无谓重载。
 * 后端权威：合并计算（calcHoldings/mergeWatchlist）在 SW 完成，UI 被动订阅。
 */
async function refreshAll(): Promise<void> {
  const config = await getSessionConfig()
  if (!config) return
  const now = new Date()
  const holdFunds = Object.values(config.holdings || {})
  const watchFunds = Object.values(config.watchlist || {})

  const canRefreshFund = shouldRefreshFund(now)
  const canRefreshAShare = shouldRefreshAShareMarket(now)
  const canRefreshGold = shouldRefreshGold(now)

  const quoteSource =
    config.settings?.quoteSource === 'fund123' ? 'fund123' : 'fundmnfinfo'

  const tasks: Promise<any>[] = []
  // 基金：持仓 + 自选共享同一时段
  if (canRefreshFund && holdFunds.length) tasks.push(getFundsQuotes(holdFunds, quoteSource).then((v) => ['holdings', v]))
  if (canRefreshFund && watchFunds.length) tasks.push(getFundsQuotes(watchFunds, quoteSource).then((v) => ['watchlist', v]))
  // A 股指数 + 大盘
  if (canRefreshAShare) {
    tasks.push(getIndices().then((v) => ['indices', v]))
    tasks.push(getMarketOverview().then((v) => ['market', v]))
  }
  // 黄金
  if (canRefreshGold) {
    tasks.push(
      getGoldRealtime({holding: config.gold.holding, avgPrice: config.gold.avgPrice}).then(
        (v) => ['gold', v],
      ),
    )
  }

  if (tasks.length === 0) return // 所有数据源都在非交易时段，跳过

  const results = await Promise.allSettled(tasks)

  // 后端合并计算：把行情与配置合并成 UI 可直接渲染的 payload
  const holdingsEntry = results.find(
    (r): r is PromiseFulfilledResult<[string, any]> =>
      r.status === 'fulfilled' && (r.value as [string, any])[0] === 'holdings',
  )
  const watchlistEntry = results.find(
    (r): r is PromiseFulfilledResult<[string, any]> =>
      r.status === 'fulfilled' && (r.value as [string, any])[0] === 'watchlist',
  )
  const holdingsQuotes = holdingsEntry ? holdingsEntry.value[1] : null
  const watchlistQuotes = watchlistEntry ? watchlistEntry.value[1] : null

  let holdingsResult: ReturnType<typeof calcHoldings> | null = null
  let watchlistResult: ReturnType<typeof mergeWatchlist> | null = null
  if (holdingsQuotes) {
    try {
      holdingsResult = calcHoldings(holdFunds, holdingsQuotes)
    } catch (e) {
      console.warn('[wzk-fund] calcHoldings failed', e)
    }
  }
  if (watchlistQuotes) {
    try {
      watchlistResult = mergeWatchlist(watchFunds, watchlistQuotes)
    } catch (e) {
      console.warn('[wzk-fund] mergeWatchlist failed', e)
    }
  }

  const patch: Record<string, any> = {[CACHE_KEYS.time]: Date.now()}
  if (holdingsResult) patch[CACHE_KEYS.holdings] = holdingsResult
  if (watchlistResult) patch[CACHE_KEYS.watchlist] = watchlistResult.list
  if (canRefreshAShare) {
    const indicesEntry = results.find(
      (r): r is PromiseFulfilledResult<[string, any]> =>
        r.status === 'fulfilled' && (r.value as [string, any])[0] === 'indices',
    )
    const marketEntry = results.find(
      (r): r is PromiseFulfilledResult<[string, any]> =>
        r.status === 'fulfilled' && (r.value as [string, any])[0] === 'market',
    )
    if (indicesEntry) patch[CACHE_KEYS.indices] = indicesEntry.value[1]
    if (marketEntry) patch[CACHE_KEYS.market] = marketEntry.value[1]
  }
  if (canRefreshGold) {
    const goldEntry = results.find(
      (r): r is PromiseFulfilledResult<[string, any]> =>
        r.status === 'fulfilled' && (r.value as [string, any])[0] === 'gold',
    )
    if (goldEntry) patch[CACHE_KEYS.gold] = goldEntry.value[1]
  }

  await chrome.storage.local.set(patch)

  // 更新 badge：显示持仓总收益率
  if (holdingsResult) {
    const totalPnlPct = holdingsResult.summary?.totalPnlPercent ?? 0
    const text = totalPnlPct > 0
      ? `↑${totalPnlPct.toFixed(2)}%`
      : `${totalPnlPct.toFixed(2)}%`
    chrome.action.setBadgeText({text})
    chrome.action.setBadgeBackgroundColor({
      color: totalPnlPct >= 0 ? '#dc2626' : '#16a34a',
    })
  }
}

/** 根据当前是否有任一市场开盘，重新设置下一次 alarm 的延迟 */
function scheduleNextAlarm(config: AppConfig | null): void {
  const {trading, nonTrading} = getRefreshInterval(config)
  const active = isAnyMarketActive(new Date())
  const delaySec = active ? trading : nonTrading
  // chrome.alarms 最小 0.5 分钟，转分钟时向上取整避免被截断
  const delayMin = Math.max(0.5, delaySec / 60)
  chrome.alarms.create(REFRESH_ALARM, {delayInMinutes: delayMin})
}

chrome.runtime.onInstalled.addListener(() => {
  // 首次安装：用默认间隔启动一次
  scheduleNextAlarm(null)
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== REFRESH_ALARM) return
  try {
    await refreshAll()
  } catch (e) {
    console.warn('[wzk-fund] alarm refresh failed', e)
  }
  // 根据当前时段与最新配置安排下一次
  const config = await getSessionConfig()
  scheduleNextAlarm(config)
})

// 监听配置变化：前端 ConfigPort.saveConfig 写 chrome.storage.local 后自动重排 alarm
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[CONFIG_KEY]) {
    const newConfig = changes[CONFIG_KEY].newValue as AppConfig | undefined
    scheduleNextAlarm(newConfig || null)
  }
})

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  ;(async () => {
    try {
      switch (msg.type) {
        case 'REFRESH': {
          await refreshAll()
          sendResponse({ok: true})
          return
        }
        case 'FETCH_QUOTES': {
          const cfg = await getSessionConfig()
          const qSource =
            cfg?.settings?.quoteSource === 'fund123' ? 'fund123' : 'fundmnfinfo'
          const quotes = await getFundsQuotes(msg.funds, qSource)
          sendResponse({ok: true, data: quotes})
          return
        }
        case 'FETCH_FUND_HISTORY': {
          const data = await getFundHistory(msg.code, msg.range as any)
          sendResponse({ok: true, data})
          return
        }
        case 'FETCH_INDEX_HISTORY': {
          const data = await getIndexHistory(msg.code, msg.range as any)
          sendResponse({ok: true, data})
          return
        }
        case 'FETCH_INDICES': {
          const data = await getIndices()
          sendResponse({ok: true, data})
          return
        }
        case 'FETCH_MARKET': {
          const data = await getMarketOverview()
          sendResponse({ok: true, data})
          return
        }
        case 'FETCH_GOLD': {
          const data = await getGoldRealtime({holding: msg.holding, avgPrice: msg.avgPrice})
          sendResponse({ok: true, data})
          return
        }
        case 'RESOLVE_FUND': {
          const data = await resolveFund({
            code: msg.code,
            type: msg.fundType,
            name: msg.name,
            sectors: msg.sectors,
          })
          sendResponse({ok: true, data})
          return
        }
        case 'FETCH_FUND_INTRADAY': {
          const data = await fetchFundIntradayForDialog(msg.code, msg.fundKey, msg.name)
          sendResponse({ok: true, data})
          return
        }
        default:
          sendResponse({ok: false, error: 'unknown message type'})
      }
    } catch (e: any) {
      sendResponse({ok: false, error: e?.message || String(e)})
    }
  })()
  return true
})
