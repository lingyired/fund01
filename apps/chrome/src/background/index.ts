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
  computeBadge,
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
 * FundMNFInfo 在 15:00 收盘后会清空 GSZ/GZTIME（空窗期直到 ~20:00 官方净值披露）。
 * 当新 quote 无盘中估算时，从上次缓存合并旧 estimate 字段，使空窗期 UI 仍能看到
 * 15:00 最后估值。合并字段：estimateNetValue / estimateGrowth / percent / percentSource /
 * time / prevNetValue。netValue / dayGrowth / netValueDate 仍用新数据（确认净值更准）。
 *
 * 注意：只在新 quote 确实无估算（estimateNetValue==null 且 estimateGrowth==null）时合并，
 * 避免覆盖盘中实时估算或 20:00 后的官方确认数据。
 */
function mergeStaleEstimate(
  newQuotes: any[],
  cachedList: any[] | null | undefined,
): void {
  if (!Array.isArray(cachedList) || !cachedList.length) return
  const cacheMap = new Map<string, any>()
  for (const row of cachedList) {
    if (row?.code) cacheMap.set(String(row.code), row)
  }
  for (const q of newQuotes) {
    const hasNewEstimate =
      q?.estimateNetValue != null || q?.estimateGrowth != null
    if (hasNewEstimate) continue
    const old = cacheMap.get(String(q?.code))
    if (!old) continue
    // 只合并估算相关字段，不覆盖净值/涨幅（新数据更准）
    if (q.estimateNetValue == null && old.estimateNetValue != null) {
      q.estimateNetValue = old.estimateNetValue
    }
    if (q.estimateGrowth == null && old.estimateGrowth != null) {
      q.estimateGrowth = old.estimateGrowth
    }
    // percent/percentSource/time：旧估算仍有效，保留展示
    if (q.percent == null && old.percent != null) {
      q.percent = old.percent
      q.percentSource = old.percentSource ?? 'estimate'
    }
    if (q.time == null && old.time != null) {
      q.time = old.time
    }
    // prevNetValue：新数据若无（QDII 等），用旧值避免 pnl 计算失效
    if (q.prevNetValue == null && old.prevNetValue != null) {
      q.prevNetValue = old.prevNetValue
    }
  }
}

/**
 * 按各数据源的市场时段刷新；非交易时段的数据源跳过（保留旧缓存）。
 *
 * 调试期：所有 fallback / 重试 / 熔断全部禁用。每个任务失败即打印完整
 * 错误信息（含 stack / url / status），调通后再恢复多源 fallback。
 */
async function refreshAll(force = false): Promise<void> {
  const config = await getSessionConfig()
  if (!config) {
    console.warn('[fund01] refreshAll: session-config 为空，跳过')
    return
  }
  const now = new Date()
  const holdFunds = Object.values(config.holdings || {})
  const watchFunds = Object.values(config.watchlist || {})

  // force=true 时（用户主动 REFRESH / 导入后刷新）跳过交易时段过滤，
  // 确保用户操作后立即拉取数据，不受时段限制
  const canRefreshFund = force || shouldRefreshFund(now)
  const canRefreshAShare = force || shouldRefreshAShareMarket(now)
  const canRefreshGold = force || shouldRefreshGold(now)

  const quoteSource =
    config.settings?.quoteSource === 'fund123' ? 'fund123' : 'fundmnfinfo'

  type TaskKey = 'holdings' | 'watchlist' | 'indices' | 'market' | 'gold'
  const tasks: Promise<any>[] = []
  const taskKeys: TaskKey[] = []

  // 基金：持仓 + 自选共享同一时段
  // 注意：即使持仓/自选为空也必须发起刷新任务（传入空数组）。否则 holdingsResult
  // 为 null，下面的 cache-holdings 不会被重写，导致删除全部持仓/分组后，popup 仍残留
  // 旧的缓存分组数据（编辑弹窗已空、持仓列表却还有一个分组）。
  if (canRefreshFund) {
    taskKeys.push('holdings')
    tasks.push(
      holdFunds.length
        ? getFundsQuotes(holdFunds, quoteSource)
        : Promise.resolve([] as any[]),
    )
    taskKeys.push('watchlist')
    tasks.push(
      watchFunds.length
        ? getFundsQuotes(watchFunds, quoteSource)
        : Promise.resolve([] as any[]),
    )
  }
  // A 股指数 + 大盘
  if (canRefreshAShare) {
    taskKeys.push('indices')
    tasks.push(getIndices())
    taskKeys.push('market')
    tasks.push(getMarketOverview())
  }
  // 黄金
  if (canRefreshGold) {
    taskKeys.push('gold')
    tasks.push(
      getGoldRealtime({holding: config.gold.holding, avgPrice: config.gold.avgPrice}),
    )
  }

  if (tasks.length === 0) {
    return // 所有数据源都在非交易时段，跳过
  }

  const results = await Promise.allSettled(tasks)

  // 每个失败任务打印完整错误（含 stack），便于在 SW console 定位根因
  let failedCount = 0
  results.forEach((r, i) => {
    const key = taskKeys[i] || 'unknown'
    if (r.status === 'fulfilled') return
    failedCount++
    const err = r.reason
    console.warn(`[fund01] refresh 失败 source=${key} index=${i}/${tasks.length}`, {
      message: err instanceof Error ? err.message : String(err),
      name: err?.name,
      stack: err instanceof Error ? err.stack : undefined,
      error: err,
    })
  })
  if (failedCount > 0) {
    console.warn(
      `[fund01] refresh 完成：${tasks.length - failedCount}/${tasks.length} 成功，${failedCount} 失败`,
    )
  }

  // 后端合并计算：把行情与配置合并成 UI 可直接渲染的 payload
  function fulfilled(key: TaskKey): any | null {
    const i = taskKeys.indexOf(key)
    if (i < 0) return null
    const r = results[i]
    return r.status === 'fulfilled' ? r.value : null
  }

  const holdingsQuotes = fulfilled('holdings')
  const watchlistQuotes = fulfilled('watchlist')

  // FundMNFInfo 在 15:00 收盘后清空 GSZ/GZTIME（空窗期）。
  // 参考项目靠 GZTIME=null 时 substr 抛错中断回调，保留上一次有效估算。
  // 这里用显式逻辑：新 quote 无估算时，从上次缓存合并旧 estimate 字段，
  // 使空窗期 UI 仍能看到 15:00 最后估值，等 20:00 官方净值披露后自动覆盖。
  if (holdingsQuotes || watchlistQuotes) {
    const cached = await chrome.storage.local.get([
      CACHE_KEYS.holdings,
      CACHE_KEYS.watchlist,
    ])
    if (holdingsQuotes) mergeStaleEstimate(holdingsQuotes, cached[CACHE_KEYS.holdings]?.list)
    if (watchlistQuotes) mergeStaleEstimate(watchlistQuotes, cached[CACHE_KEYS.watchlist])
  }

  let holdingsResult: ReturnType<typeof calcHoldings> | null = null
  let watchlistResult: ReturnType<typeof mergeWatchlist> | null = null
  if (holdingsQuotes) {
    try {
      holdingsResult = calcHoldings(holdFunds, holdingsQuotes)
    } catch (e) {
      console.warn('[fund01] calcHoldings failed', e)
    }
  }
  if (watchlistQuotes) {
    try {
      watchlistResult = mergeWatchlist(watchFunds, watchlistQuotes)
    } catch (e) {
      console.warn('[fund01] mergeWatchlist failed', e)
    }
  }

  const patch: Record<string, any> = {[CACHE_KEYS.time]: Date.now()}
  if (holdingsResult) patch[CACHE_KEYS.holdings] = holdingsResult
  if (watchlistResult) patch[CACHE_KEYS.watchlist] = watchlistResult.list
  if (canRefreshAShare) {
    const indicesValue = fulfilled('indices')
    const marketValue = fulfilled('market')
    if (indicesValue) patch[CACHE_KEYS.indices] = indicesValue
    if (marketValue) patch[CACHE_KEYS.market] = marketValue
  }
  if (canRefreshGold) {
    const goldValue = fulfilled('gold')
    if (goldValue) patch[CACHE_KEYS.gold] = goldValue
  }

  await chrome.storage.local.set(patch)

  // 更新 badge：按设置中的显示方式渲染（百分比 / 收益额 / 隐藏）
  if (holdingsResult) {
    await applyBadge(config)
  }
}

/**
 * 根据配置中的 badgeMode 计算并写入扩展角标。
 * 读取最近一次 refresh 缓存的持仓汇总，因此既可在刷新后调用，
 * 也可在用户切换显示方式（配置变化）时立即重算，无需等待下次刷新。
 */
async function applyBadge(config: AppConfig | null): Promise<void> {
  const mode = config?.settings?.badgeMode
  const cached = await chrome.storage.local.get(CACHE_KEYS.holdings)
  const holdings = cached[CACHE_KEYS.holdings] as
    | ReturnType<typeof calcHoldings>
    | undefined
  const summary = holdings?.summary
  const {text, color} = computeBadge({
    mode: mode === 'amount' || mode === 'hidden' ? mode : 'percent',
    totalPnlPercent: summary?.totalPnlPercent ?? 0,
    totalPnl: summary?.totalPnl ?? 0,
  })
  chrome.action.setBadgeText({text})
  chrome.action.setBadgeBackgroundColor({color})
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
    console.warn('[fund01] alarm refresh failed', e)
  }
  // 根据当前时段与最新配置安排下一次
  const config = await getSessionConfig()
  scheduleNextAlarm(config)
})

// 监听配置变化：前端 ConfigPort.saveConfig 写 chrome.storage.local 后自动重排 alarm，
// 并在角标显示方式变化时立即按新配置重算角标
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[CONFIG_KEY]) {
    const newConfig = changes[CONFIG_KEY].newValue as AppConfig | undefined
    scheduleNextAlarm(newConfig || null)
    void applyBadge(newConfig || null)
  }
})

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  ;(async () => {
    try {
      switch (msg.type) {
        case 'REFRESH': {
          await refreshAll(true)
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
