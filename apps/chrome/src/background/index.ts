import {
  getFundsQuotes,
  getFundHistory,
  resolveFund,
  fetchFundIntradayForDialog,
  clearFundEstimateCaches,
} from '@fund01/services'
import {getIndices, getIndexHistory, isUsIndexCode} from '@fund01/services'
import {
  isDayMarketActive,
  isNightMarketActive,
  secondsUntilNextSwitch,
  shouldRefreshAShareMarket,
  shouldRefreshFund,
  shouldRefreshUSIndex,
  calcHoldings,
  computeBadge,
} from '@fund01/core'
import type {AppConfig} from '@fund01/core'

/** 两个独立 alarm：日盘（基金+A股指数）、夜盘（美股指数），窗口不重叠 */
const ALARM_DAY = 'refresh-day'
const ALARM_NIGHT = 'refresh-night'
const CONFIG_KEY = 'session-config'
const CACHE_KEYS = {
  holdings: 'cache-holdings',
  indices: 'cache-indices',
  time: 'cache-time',
  // 内部 meta：最近一次基金刷新使用的数据源，用于 mergeStaleEstimate 同源判断
  source: 'cache-source',
  // 自动刷新计划：供 popup 刷新按钮进度环读取
  refreshSchedule: 'cache-refresh-schedule',
} as const

/** 状态类日志开关：生产构建（rsbuild build）时 process.env.NODE_ENV='production'，常量折叠为 false，定时器日志不输出 */
const IS_DEBUG = process.env.NODE_ENV !== 'production'

/** 默认刷新间隔（秒），与 portfolioLogic 保持一致 */
const DEFAULT_REFRESH_INTERVAL = {trading: 60, nonTrading: 600}
const MIN_REFRESH_INTERVAL = {trading: 30, nonTrading: 300}

type Message =
  | {type: 'REFRESH'; resetTimer?: boolean}
  | {type: 'CLEAR_CACHE'}
  | {type: 'FETCH_QUOTES'; funds: any[]; quoteType?: 'hold'}
  | {type: 'FETCH_FUND_HISTORY'; code: string; range: string}
  | {type: 'FETCH_INDEX_HISTORY'; code: string; range: string}
  | {type: 'FETCH_INDICES'}
  | {type: 'RESOLVE_FUND'; code: string; fundType?: 'hold'; name?: string; sectors?: string[]}
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
    // QDII/海外延迟披露：盘中无估算是全天常态（provider 跳过自算估值），并非空窗期。
    // 若合并会把昨晚缓存的 confirmed 涨幅 + prevNetValue 带回盘中，冒充「今日」收益
    // （8/12 实测：Chrome 盘中显示昨日收益，Tauri 归零）。QDII 直接跳过，保持
    // percent/prevNetValue 为空，严格走披露日窗口（盘中显示「-」）。
    if (q?.isQdii) continue
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
    // percent/percentSource/time：旧估算仍有效，保留展示。
    // 排除 confirmed 旧值——confirmed 是历史确认涨幅，不是「今日估算」；只允许
    // estimate 旧值在空窗期保留（黄金 ETF 联接等无 GSZ 基金同样受益，避免昨晚
    // 确认涨幅冒充今日盘中收益）。
    if (q.percent == null && old.percent != null && old.percentSource !== 'confirmed') {
      q.percent = old.percent
      q.percentSource = old.percentSource ?? 'estimate'
    }
    if (q.time == null && old.time != null) {
      q.time = old.time
    }
    // prevNetValue：新数据若无，用旧值避免 pnl 计算失效（仅非 QDII）
    if (q.prevNetValue == null && old.prevNetValue != null) {
      q.prevNetValue = old.prevNetValue
    }
  }
}

/**
 * 按数据源的市场时段刷新；非交易时段的数据源跳过（保留旧缓存）。
 * kind 指定本次刷新哪些数据源：'day'（基金+A股指数）/ 'night'（美股指数）/ 'all'（全量，REFRESH 手动 / 导入后）。
 *
 * 调试期：所有 fallback / 重试 / 熔断全部禁用。每个任务失败即打印完整
 * 错误信息（含 stack / url / status），调通后再恢复多源 fallback。
 */
type RefreshKind = 'day' | 'night' | 'all'

/** 配置是否需要美股指数（指数看板含 NDX/SPX） */
function hasUS(config: AppConfig): boolean {
  return (config.settings?.selectedIndices || []).some((c) => isUsIndexCode(String(c)))
}

/** 指数数组按市场拆分：{a: A股, us: 美股} */
function splitIndices(list: any[] | null | undefined): {a: any[]; us: any[]} {
  const a: any[] = []
  const us: any[] = []
  for (const i of list || []) {
    if (isUsIndexCode(String(i?.code))) us.push(i)
    else a.push(i)
  }
  return {a, us}
}

/**
 * 并发刷新保护：避免 onStartup / onInstalled / alarm / REFRESH 消息在极短时间内
 * 多次并发触发 refreshAll（重复网络请求 + 缓存写竞争）。同一时刻只允许一个刷新在跑，
 * 新请求直接跳过——alarm 会按周期重排、用户也可能再点 REFRESH，跳过无副作用。
 * 注意：此标志只防「同一 SW 实例内」的并发，不跨 SW 重启（重启会丢状态，但那时本就无在跑刷新）。
 */
let refreshInFlight = false

async function refreshAll(force = false, kind: RefreshKind = 'all'): Promise<void> {
  if (refreshInFlight) {
    console.log(`[fund01] refreshAll 跳过：已有刷新在运行 force=${force} kind=${kind}`)
    return
  }
  refreshInFlight = true
  try {
    await refreshAllCore(force, kind)
  } finally {
    refreshInFlight = false
  }
}

async function refreshAllCore(force = false, kind: RefreshKind = 'all'): Promise<void> {
  // 无条件入口日志：便于在 SW 控制台确认「SW 是否在跑、跑的是不是新代码」
  // （chrome MV3 SW 按需启动，扩展卡片不打开时可能一直休眠，此日志可定位「没刷新」的原因）
  console.log(`[fund01] SW refreshAll 开始 force=${force} kind=${kind} now=${new Date().toISOString()}`)
  const config = await getSessionConfig()
  if (!config) {
    console.warn('[fund01] refreshAll: session-config 为空，跳过')
    return
  }
  const now = new Date()
  const wantDay = kind === 'all' || kind === 'day'
  const wantNight = kind === 'all' || kind === 'night'
  const usCfg = hasUS(config)
  const holdFunds = Object.values(config.holdings || {})

  // force=true 时（用户主动 REFRESH / 导入后刷新）跳过交易时段过滤，
  // 确保用户操作后立即拉取数据，不受时段限制
  const canRefreshFund = wantDay && (force || shouldRefreshFund(now))
  const canRefreshAShare = wantDay && (force || shouldRefreshAShareMarket(now))
  const canRefreshUS = wantNight && usCfg && (force || shouldRefreshUSIndex(now))
  const quoteSource =
    config.settings?.quoteSource === 'fund123'
      ? 'fund123'
      : config.settings?.quoteSource === 'xiaobei'
        ? 'xiaobei'
        : 'fundmnfinfo'

  // 手动刷新（force）时清空自算估值/股票涨跌幅缓存，强制本轮实时拉取行情，
  // 使「点击刷新 = 点击时刻的最新估算值」（与 Tauri refresh_day force=true 对齐）。
  // 否则手动刷新会命中 5min CALC_GSZZL_CACHE / 30s STOCK_PCT_CACHE，
  // 返回的是上次自动刷新（最多 5 分钟前）的旧估算值，两端缓存填充时刻不同步 → 分叉。
  if (force && canRefreshFund) {
    clearFundEstimateCaches()
  }

  type TaskKey = 'holdings' | 'indicesA' | 'indicesUs'
  const tasks: Promise<any>[] = []
  const taskKeys: TaskKey[] = []

  // 基金：持仓刷新（即使为空也必须发起任务，传入空数组，避免删除全部持仓后
  // cache-holdings 不被重写导致 popup 残留旧缓存分组数据）
  if (canRefreshFund) {
    taskKeys.push('holdings')
    tasks.push(
      holdFunds.length
        ? getFundsQuotes(holdFunds, quoteSource)
        : Promise.resolve([] as any[]),
    )
  }
  // A 股指数
  if (canRefreshAShare) {
    taskKeys.push('indicesA')
    tasks.push(getIndices('ashare'))
  }
  // 美股指数
  if (canRefreshUS) {
    taskKeys.push('indicesUs')
    tasks.push(getIndices('us'))
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
  } else if (tasks.length > 0) {
    // 全成功也打一条汇总，便于在 SW 控制台确认本轮刷新确实跑完、没有静默跳过
    console.log(`[fund01] refresh 完成：${tasks.length}/${tasks.length} 成功（无失败）`)
  }

  // 后端合并计算：把行情与配置合并成 UI 可直接渲染的 payload
  function fulfilled(key: TaskKey): any | null {
    const i = taskKeys.indexOf(key)
    if (i < 0) return null
    const r = results[i]
    return r.status === 'fulfilled' ? r.value : null
  }

  const holdingsQuotes = fulfilled('holdings')

  // FundMNFInfo 在 15:00 收盘后清空 GSZ/GZTIME（空窗期）。
  // 参考项目靠 GZTIME=null 时 substr 抛错中断回调，保留上一次有效估算。
  // 这里用显式逻辑：新 quote 无估算时，从上次缓存合并旧 estimate 字段，
  // 使空窗期 UI 仍能看到 15:00 最后估值，等 20:00 官方净值披露后自动覆盖。
  // 注意：仅当旧缓存与本次刷新同一数据源时才合并。切源后缓存是旧源口径，
  // 混入会让 percent 与净值差来自不同源（曾出现 QDII +150.53 / -0.06% 方向矛盾）。
  if (holdingsQuotes) {
    const cached = await chrome.storage.local.get([
      CACHE_KEYS.holdings,
      CACHE_KEYS.source,
    ])
    const cachedSource = cached[CACHE_KEYS.source]
    const sameSource = !cachedSource || cachedSource === quoteSource
    if (!sameSource) {
      console.warn(
        `[fund01] 缓存数据源 ${cachedSource} ≠ 当前 ${quoteSource}，跳过空窗期估算合并，避免跨源混用`,
      )
    }
    if (sameSource && holdingsQuotes) {
      mergeStaleEstimate(holdingsQuotes, cached[CACHE_KEYS.holdings]?.list)
    }
  }

  let holdingsResult: ReturnType<typeof calcHoldings> | null = null
  if (holdingsQuotes) {
    try {
      holdingsResult = calcHoldings(holdFunds, holdingsQuotes, {
        // 不纳入总览的分组：其持仓从总览汇总剔除（popup 顶部/角标），行数据保持全量
        excludedGroups: config?.settings?.overviewExcludedGroups,
      })
    } catch (e) {
      console.warn('[fund01] calcHoldings failed', e)
    }
  }

  const patch: Record<string, any> = {[CACHE_KEYS.time]: Date.now()}
  if (holdingsResult) patch[CACHE_KEYS.holdings] = holdingsResult
  // 记录本次基金刷新使用的数据源（供 mergeStaleEstimate 同源判断）
  patch[CACHE_KEYS.source] = quoteSource

  // 指数：新拉的市场部分 + 旧缓存另一市场部分合并，避免单市场刷新覆盖整份
  const indicesAValue = fulfilled('indicesA')
  const indicesUsValue = fulfilled('indicesUs')
  if (indicesAValue || indicesUsValue) {
    const cached = await chrome.storage.local.get(CACHE_KEYS.indices)
    const prev = (cached[CACHE_KEYS.indices] as any[] | undefined) || []
    const {a: prevA, us: prevUs} = splitIndices(prev)
    const {a: newA, us: newUs} = splitIndices([
      ...(indicesAValue || []),
      ...(indicesUsValue || []),
    ])
    patch[CACHE_KEYS.indices] = [
      ...(newA.length ? newA : prevA),
      ...(newUs.length ? newUs : prevUs),
    ]
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
  // 隐私模式：角标强制显示收益率百分比，不暴露收益额（忽略 badgeMode 设置）
  const mode =
    config?.settings?.privacyMode === true
      ? 'percent'
      : config?.settings?.badgeMode
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

/** 各 alarm 的真实下次触发计划（内存态），用于向 popup 发布「最近一次」 */
const alarmNext: Record<string, {intervalSeconds: number; nextRefreshAt: number}> = {}

/** 按循环盘中窗口调度 alarm：盘中用 trading 间隔，非盘中用 nonTrading */
function scheduleAlarm(name: string, config: AppConfig | null, isActive: boolean): void {
  const {trading, nonTrading} = getRefreshInterval(config)
  const delaySec = isActive ? trading : nonTrading
  // 准点切换：若下一个时段翻转点比当前档位的下一周期更近，先睡到翻转点，
  // 到点后（onAlarm 尾部）按最新时段重判档位 —— 消除「非交易档最坏滞后一个周期」。
  const switchFn = name === ALARM_DAY ? isDayMarketActive : isNightMarketActive
  const untilSwitch = secondsUntilNextSwitch(isActive, switchFn)
  const effectiveSec =
    untilSwitch != null && untilSwitch < delaySec ? Math.max(1, untilSwitch) : delaySec
  // chrome.alarms 最小 0.5 分钟，转分钟时向上取整避免被截断
  const delayMin = Math.max(0.5, effectiveSec / 60)
  chrome.alarms.create(name, {delayInMinutes: delayMin})
  // 读取 Chrome 实际排定的触发时间（scheduledTime），让进度环与真实闹钟严格对齐：
  // chrome.alarms 对短周期会做对齐/取整（例如请求 0.5min 实际约 60s 才响），
  // 若仍按请求的 30s 推算 nextRefreshAt，环会提前跑完、走满瞬间数据尚未更新
  // （「满了却不刷新」「重启时已在半程」）。以 scheduledTime 作 nextRefreshAt、
  // 以 (scheduledTime-now) 作展示周期，环走满即真实触发。
  chrome.alarms.get(name, (alarm) => {
    if (alarm?.scheduledTime) {
      const nextRefreshAt = alarm.scheduledTime
      const intervalSeconds = Math.max(1, Math.round((nextRefreshAt - Date.now()) / 1000))
      alarmNext[name] = {intervalSeconds, nextRefreshAt}
    } else {
      const effectiveSec = Math.round(delayMin * 60)
      alarmNext[name] = {intervalSeconds: effectiveSec, nextRefreshAt: Date.now() + effectiveSec * 1000}
    }
    publishRefreshSchedule()
  })
}

/**
 * 把「最近一次自动刷新」计划写入缓存，供 popup 进度环读取。
 * 手动刷新 / 配置变化 / alarm 触发后都会重排 alarm 并调用本函数，
 * 保证进度环展示的「下一次刷新」与真实定时器一致。
 */
function publishRefreshSchedule(): void {
  const entries = Object.values(alarmNext)
  if (entries.length === 0) return
  // 取下次触发时间最早的一条，作为进度环展示的「下一次刷新」
  const nearest = entries.reduce((a, b) => (a.nextRefreshAt <= b.nextRefreshAt ? a : b))
  void chrome.storage.local.set({[CACHE_KEYS.refreshSchedule]: nearest})
}

/** 夜盘是否「需要活跃」：有美股指数时夜盘窗口才高频，否则低频空转 */
function nightNeeded(config: AppConfig | null): boolean {
  return !!config && hasUS(config)
}

/** 根据当前各市场状态重排两个 alarm（配置变化 / 安装时 / 手动刷新时调用） */
function scheduleAllAlarms(config: AppConfig | null): void {
  const now = new Date()
  scheduleAlarm(ALARM_DAY, config, isDayMarketActive(now))
  scheduleAlarm(ALARM_NIGHT, config, isNightMarketActive(now) && nightNeeded(config))
}

/** alarm 名 → 日志前缀 */
const ALARM_TAGS: Record<string, string> = {
  [ALARM_DAY]: '日盘',
  [ALARM_NIGHT]: '夜盘',
}

chrome.runtime.onInstalled.addListener(() => {
  // 安装 / 版本更新 / 「扩展页 reload」都会触发 onInstalled；其中 reload 不会触发
  // onStartup。这里重排 alarm 并立即强制刷新一次，使「reload 扩展」也能像重启浏览器
  // 一样立刻刷新后台数据，无需先打开 popup（首次全新安装时 config 尚未生成，
  // refreshAll 会因无 config 自动跳过，不浪费请求）。
  scheduleAllAlarms(null)
  // 返回 promise：避免 SW 在 refreshAll 完成前被回收
  return (async () => {
    try {
      await refreshAll(true)
    } catch (e) {
      console.warn('[fund01] onInstalled refresh failed', e)
    }
  })()
})

/**
 * 浏览器启动：立即唤醒 SW 并刷新一次缓存与角标。
 *
 * 背景：MV3 的告警（chrome.alarms）虽会随浏览器重启保留、到点唤醒 SW，
 * 但其首次触发可能要等数十秒~数分钟；非交易时段 / 未配置美股指数时
 * 告警甚至不会刷新。这就造成「重启浏览器后、首次打开 popup 之前」数据一直
 * 停在旧缓存的空窗（打开 popup 时 App.tsx 会在挂载时 force 刷新，所以一旦
 * 打开就更新，反衬出此前的静止）。
 *
 * 这里在 onStartup 主动拉一次（force=true，与「打开 popup 时强制刷新」行为
 * 一致），确保浏览器一启动后台数据就自行刷新，无需先打开 popup。
 * 同时幂等重排两个 alarm，防止极端情况下 alarm 丢失导致后续不再刷新。
 */
chrome.runtime.onStartup.addListener(() => {
  // 返回 promise：MV3 中 SW 会等待事件监听器返回的 promise 完成才允许休眠，
  // 若用 void 触发则同步部分立即结束，Chrome 可能在 refreshAll 完成前杀掉 SW。
  return (async () => {
    try {
      const cfg = await getSessionConfig()
      scheduleAllAlarms(cfg)
      await refreshAll(true)
    } catch (e) {
      console.warn('[fund01] onStartup refresh failed', e)
    }
  })()
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const tag = ALARM_TAGS[alarm.name]
  if (!tag) return
  try {
    // 定时器触发日志：便于观察各 alarm 的定时情况（手动 REFRESH 不走这里；生产构建不输出）
    if (IS_DEBUG) {
      const d = new Date()
      const pad2 = (n: number) => String(n).padStart(2, '0')
      console.log(
        `[fund01] ----------------------定时器${tag} ${pad2(d.getHours())}：${pad2(d.getMinutes())}-----------------------`,
      )
    }
    if (alarm.name === ALARM_DAY) await refreshAll(false, 'day')
    else await refreshAll(false, 'night')
  } catch (e) {
    console.warn('[fund01] alarm refresh failed', e)
  }
  // 根据当前时段与最新配置重新安排本 alarm 的下一次触发
  const config = await getSessionConfig()
  const now = new Date()
  if (alarm.name === ALARM_DAY) {
    scheduleAlarm(ALARM_DAY, config, isDayMarketActive(now))
  } else {
    scheduleAlarm(ALARM_NIGHT, config, isNightMarketActive(now) && nightNeeded(config))
  }
})

// 监听配置变化：前端 ConfigPort.saveConfig 写 chrome.storage.local 后自动重排 alarm，
// 并在角标显示方式变化时立即按新配置重算角标。
// 切换数据源（quoteSource）时：清掉旧源口径的基金行情缓存并立即强制刷新，
// 避免 UI 继续展示旧源数据、也避免 mergeStaleEstimate 跨源混用（percent 与净值差来源不一致）。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[CONFIG_KEY]) {
    const oldCfg = changes[CONFIG_KEY].oldValue as AppConfig | undefined
    const newConfig = changes[CONFIG_KEY].newValue as AppConfig | undefined
    const oldSource = oldCfg?.settings?.quoteSource ?? 'fundmnfinfo'
    const newSource = newConfig?.settings?.quoteSource ?? 'fundmnfinfo'
    scheduleAllAlarms(newConfig || null)
    void applyBadge(newConfig || null)
    if (oldSource !== newSource) {
      void chrome.storage.local
        .remove([CACHE_KEYS.holdings, CACHE_KEYS.source])
        .then(() => refreshAll(true))
    }
  }
})

chrome.runtime.onMessage.addListener(
  (msg: Message, sender, sendResponse) => {
    // 只接受本扩展页面消息：sender.url 必须是本扩展的 chrome-extension:// 页面，
    // 拒绝外部网页 / 注入脚本借道触发网络请求（RESOLVE_FUND / FETCH_* 等）
    const selfPrefix = `chrome-extension://${chrome.runtime.id}/`
    if (!sender.url || !sender.url.startsWith(selfPrefix)) {
      sendResponse({ok: false, error: 'forbidden sender'})
      return
    }
    ;(async () => {
      try {
        switch (msg.type) {
          case 'REFRESH': {
            // 手动刷新入口日志（请求发出前）：带秒时间戳，便于与 Tauri 端
            // 「----------------------刷新 hh:mm:ss----------------」日志对照两端点击时刻。
            // 无条件输出（不包 IS_DEBUG），release 构建也能在 SW 控制台看到。
            const d = new Date()
            const pad2 = (n: number) => String(n).padStart(2, '0')
            console.log(
              `[fund01] ----------------------刷新 ${pad2(d.getHours())}：${pad2(d.getMinutes())}：${pad2(d.getSeconds())}----------------`,
            )
            await refreshAll(true)
            // resetTimer 默认 true（手动点击刷新）：重排两个 alarm（清除旧定时、从现在
            // 重新计时）并发布新计划，使进度环周期与实际下次刷新一致。
            // resetTimer=false：仅刷新数据、不重排定时器，进度环继续反映后台真实进度。
            // （打开 popup 已不再调用此分支，目前只有显式传 false 才会走这里。）
            if (msg.resetTimer !== false) {
              const cfg = await getSessionConfig()
              scheduleAllAlarms(cfg)
            }
            sendResponse({ok: true})
            return
          }
          case 'CLEAR_CACHE': {
            // 清除全部缓存（含持仓/指数/时间戳/数据源 meta）并强制刷新：
            // 用于「改了代码后 SW 仍在跑旧逻辑、缓存不失效」的场景，点击即清 + 重拉
            await chrome.storage.local.remove(Object.values(CACHE_KEYS))
            await refreshAll(true)
            sendResponse({ok: true})
            return
          }
          case 'FETCH_QUOTES': {
            const cfg = await getSessionConfig()
            const qSource =
              cfg?.settings?.quoteSource === 'fund123'
                ? 'fund123'
                : cfg?.settings?.quoteSource === 'xiaobei'
                  ? 'xiaobei'
                  : 'fundmnfinfo'
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
            // 读时填充的指数快照写入缓存（全量），后续 popup 打开直接读缓存；
            // 不写 cache-time（避免误触发 quote-update 的加载态结束语义）
            await chrome.storage.local.set({[CACHE_KEYS.indices]: data})
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
  },
)
