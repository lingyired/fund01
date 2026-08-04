// 配置操作封装：把原 api.ts / portfolioStore.ts 中基于 localStorage + SW 消息的逻辑
// 改造为基于 ConfigPort（同步读缓存 + 异步推后端）+ DataPort（resolveFund 等）的实现。
// 业务规则（份额反推、成本反推、分组维护、归一化）与原实现保持一致。

import type {
  AppConfig,
  AppSettings,
  FundRecord,
  Ports,
  ResolveFundPayload,
} from '@fund01/core'
import {
  clampRefreshInterval,
  MAX_SELECTED_INDICES,
  normalizeConfig,
  normalizeFund,
  normalizeNetValueDate,
  todayDateStr,
} from '@fund01/core'

/** 录入金额对应哪一版确认净值市值 */
export type AmountBasis = 'prev' | 'today'

function sharesFromAmount(amount: number, netValue?: number | null): number {
  if (!(amount > 0) || !(netValue != null && netValue > 0)) return 0
  return Math.round((amount / netValue) * 10000) / 10000
}

/** 折算份额所用的基准净值及其日期 */
export type BasisNav = {nav: number; date: string}

/**
 * 选定「把金额折算成份额」所用的基准净值 —— **按净值日期锚定，而非按 hist 下标**。
 *
 * 历史教训（两次都栽在同一处）：
 * - v1.0.78 之前：'prev' 用 meta.prevNetValue(hist[1])。在「今日净值未确认」窗口
 *   （18 点 / 周末）hist[0] 才是昨收，用 hist[1] 会凭空多算一天涨幅。
 * - v1.0.79：改成恒用 meta.netValue(hist[0])。但 22 点后数据源同步了今日净值，
 *   hist[0] 变成今日，此时截图若是「今日收益未更新」的昨收口径，又会少算一天。
 *
 * 结论：hist 下标会随时间漂移，唯一稳定的锚是**净值日期**。
 * - `today`（截图显示「今日收益已更新」）→ 必须锚定日期 == 今天 的确认净值
 * - `prev` （截图未显示已更新）        → 锚定「今天之前」最近的确认净值
 * - `navDate` 显式给出时优先级最高，按日期精确匹配 hist[0] / hist[1]
 */
export function pickBasisNav(
  basis: AmountBasis,
  meta: ResolveFundPayload,
  navDate?: string,
): BasisNav {
  const latest = meta.netValue
  const latestDate = normalizeNetValueDate(meta.netValueDate)
  const prior = meta.prevNetValue
  const priorDate = normalizeNetValueDate(meta.prevNetValueDate)
  const today = todayDateStr()
  const known = `（数据源可用净值：${latestDate || '—'}、${priorDate || '—'}）`

  // ① 显式 navDate：按日期精确匹配，最可靠（跨天导入 / 数据源与 App 更新不同步时用）
  if (navDate) {
    if (navDate === latestDate && latest != null && latest > 0) {
      return {nav: latest, date: latestDate}
    }
    if (navDate === priorDate && prior != null && prior > 0) {
      return {nav: prior, date: priorDate}
    }
    throw new Error(`navDate=${navDate} 无对应确认净值${known}，请核对日期或改用 amountBasis`)
  }

  // ② today：金额已含今日收益，必须用今日确认净值折算，否则份额会偏一整天涨跌幅
  if (basis === 'today') {
    if (latest != null && latest > 0 && latestDate === today) {
      return {nav: latest, date: latestDate}
    }
    throw new Error(
      `amountBasis="today" 表示金额已含今日收益，但数据源最新确认净值不是今日 ${today}${known}。` +
        `请等今日净值同步后重新导入，或按截图实际口径改用 amountBasis="prev"。`,
    )
  }

  // ③ prev：金额是「今天之前最近一个交易日」的收盘市值
  if (latestDate && latestDate === today) {
    // 数据源已同步今日净值 → 上一交易日是 hist[1]
    if (prior != null && prior > 0) return {nav: prior, date: priorDate}
    throw new Error(`数据源已更新今日净值但缺少上一交易日净值${known}，无法按「昨日结算」折算份额`)
  }
  if (latest != null && latest > 0) return {nav: latest, date: latestDate}
  if (prior != null && prior > 0) return {nav: prior, date: priorDate}
  throw new Error('暂无确认净值，无法按金额反推份额，请稍后重试')
}

function deriveHoldShares(amount: number, picked: BasisNav): number {
  if (!(amount > 0)) return 0
  return sharesFromAmount(amount, picked.nav)
}

/**
 * 导入一致性校验（只告警、不阻断）。
 *
 * 场景：持仓截图通常只有「资产 / 昨日收益 / 持仓收益额 / 持仓收益率」，没有份额。
 * 份额只能由 amount ÷ 最新确认净值 折算，一旦 amount 的口径不对（填成了本金、
 * 拆分组后金额拆了但收益没拆、几个数字不同源），折算出的份额就是错的且**无法自证**。
 * 这两条交叉校验是该场景下唯一能自动发现问题的手段。
 */
function runImportChecks(opts: {
  code: string
  amount: number
  shares: number
  holdProfit?: number
  holdProfitRate?: number
  dailyProfit?: number
  /** 实际用于折算的基准净值日期；仅当它 == hist[0] 日期时，昨日收益校验才成立 */
  basisDate?: string
  meta: ResolveFundPayload
  onWarn: (msg: string) => void
}): void {
  const {
    code,
    amount,
    shares,
    holdProfit,
    holdProfitRate,
    dailyProfit,
    basisDate,
    meta,
    onWarn,
  } = opts
  if (!(shares > 0) || !(amount > 0)) return

  // ⚠️ 校验中的「0」一律按**无数据**处理，不当真值。
  //
  // 踩坑记录：周一导入 019924 时报「昨日收益对不上（录入 0.00，应为 23.31，偏差 100.0%）」，
  // 但数据其实是对的 —— App 在**非交易日空窗期**会把收益栏显示成 0.00：
  //   · 周末 / 节假日（昨天压根没有净值）
  //   · 周一今日净值未更新时，「昨日收益」指的是昨天（周日）= 0
  //   · 当天新买入、份额尚未确认
  // 而真实收益恰好为 0.00（净值四位小数完全不动）的概率极低。
  //
  // 更要命的是相对偏差公式 |expected − 0| / max(|expected|, 0) **在 0 处恒等于 100%**，
  // 只要基金当天有涨跌就必然告警。误报会让用户对所有告警脱敏（狼来了），
  // 代价远大于漏掉一条「收益真的填错成 0」的记录。
  const hasDaily = dailyProfit != null && Math.abs(dailyProfit) > 1e-9
  const hasHoldProfit = holdProfit != null && Math.abs(holdProfit) > 1e-9
  const hasRate = holdProfitRate != null && Math.abs(holdProfitRate) > 1e-6

  // ① 单日收益校验：理论值 = 份额 × (最新确认净值 − 前一日净值)
  //   仅当基准锚定在 hist[0] 时成立：此时截图里的「昨日/今日收益」恰好就是
  //   hist[0] 相对 hist[1] 的收益。若基准锚定 hist[1]（数据源已出今日净值、
  //   但截图是昨收口径），对应的应是 hist[1]→hist[2] 收益，我们没有 hist[2]，跳过。
  const nav = meta.netValue
  const navDate = normalizeNetValueDate(meta.netValueDate)
  const prevNav = meta.prevNetValue
  const prevDate = normalizeNetValueDate(meta.prevNetValueDate)
  const anchoredOnLatest = !basisDate || basisDate === navDate
  if (
    anchoredOnLatest &&
    hasDaily &&
    nav != null &&
    nav > 0 &&
    prevNav != null &&
    prevNav > 0
  ) {
    const reported = dailyProfit as number
    const expected = shares * (nav - prevNav)
    // 仅在最近一日波动足够大时校验，否则净值 4 位小数的舍入噪声会放大相对误差
    const scale = Math.max(Math.abs(expected), Math.abs(reported))
    if (scale > amount * 0.0005) {
      const deviation = Math.abs(expected - reported) / scale
      if (deviation > 0.05) {
        const pct = (nav / prevNav - 1) * 100
        const pctStr = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
        onWarn(
          `${code}：单日收益对不上 —— 录入 ${reported.toFixed(2)} 元，` +
            `但按 ${navDate || '最新'} 净值 ${nav}（较 ${prevDate || '上一交易日'} ${pctStr}）折算的 ${shares.toFixed(2)} 份应为 ${expected.toFixed(2)} 元，偏差 ${(deviation * 100).toFixed(1)}%。` +
            `请核对：① amount 是否为当前市值（而非本金/成本）；② 拆到多个分组时，收益是否与金额同比例拆分；③ 几个数字是否取自同一时点。` +
            `若截图的收益栏对应的不是 ${navDate || '该日'}（App 与数据源更新不同步），请用 navDate 显式指定净值日期。`,
        )
      }
    }
  }

  // ② 成本交叉校验：按收益率算的成本 应 ≈ 按金额算的成本
  //   holdProfit 为 0 时跳过：新买入当天收益为 0 是正常的，此时 costByRate 恒为 0、
  //   偏差恒为 100%，同样是必然误报。（holdProfit=0 仍会正常用于成本推导：成本=市值）
  if (hasHoldProfit && hasRate) {
    const profit = holdProfit as number
    const costByRate = profit / (holdProfitRate as number)
    const costByAmount = amount - profit
    if (costByAmount > 0) {
      const deviation = Math.abs(costByRate - costByAmount) / costByAmount
      if (deviation > 0.02) {
        onWarn(
          `${code}：收益率与收益额对不上（按收益率反推成本 ${costByRate.toFixed(2)} 元，按金额反推成本 ${costByAmount.toFixed(2)} 元，偏差 ${(deviation * 100).toFixed(1)}%）。` +
            `请确认 amount / holdProfit / holdProfitRate 取自同一屏同一时点。`,
        )
      }
    }
  }
}

/** 内部：upsert 一条基金记录（归一化后写回配置） */
async function upsertFund(
  ports: Ports,
  payload: Partial<FundRecord> & {code: string},
): Promise<FundRecord> {
  const config = ports.config.getConfig()
  const code = String(payload.code).padStart(6, '0')
  if (!/^\d{6}$/.test(code)) throw new Error('基金代码须为6位数字')
  const type: 'hold' | 'watch' = payload.type === 'hold' ? 'hold' : 'watch'
  const prev = type === 'hold' ? config.holdings[code] : config.watchlist[code]
  const next = normalizeFund({...payload, code, type}, prev, type)
  if (type === 'hold') config.holdings[code] = next
  else config.watchlist[code] = next
  // await 确保 chrome.storage.local.set 完成，避免 SW 读到旧 config
  await ports.config.saveConfig(config)
  return next
}

/** 内部：更新一条基金记录（合并 patch 后归一化写回） */
function patchFund(
  ports: Ports,
  code: string,
  patch: Partial<FundRecord>,
  type: 'hold' | 'watch',
): FundRecord {
  const config = ports.config.getConfig()
  const key = String(code).padStart(6, '0')
  const map = type === 'hold' ? config.holdings : config.watchlist
  const prev = map[key]
  if (!prev) throw new Error('基金不存在')
  const next = normalizeFund({...prev, ...patch, code: key, type}, prev, type)
  map[key] = next
  ports.config.saveConfig(config)
  return next
}

export async function createFund(
  ports: Ports,
  payload: Partial<FundRecord> & {
    code: string
    amount?: number
    amountBasis?: AmountBasis
    /** 持仓分组（仅 hold 有效；空字符串=未分组） */
    group?: string
    /** 该分组的持仓成本单价（元/份，可选） */
    cost?: number
    /** 累计收益（元，可选；用于反推成本单价） */
    holdProfit?: number
    /** 持有份额（份，可选；提供则直接作为份额，跳过金额→净值折算） */
    shares?: number
    /** 昨日收益（元，可选；不参与计算，仅用于校验 amount 口径） */
    dailyProfit?: number
    /** 持仓收益率（小数，可选；holdProfit 缺失时反推，两者都有时交叉校验） */
    holdProfitRate?: number
    /** 金额所对应的净值日期 YYYY-MM-DD（可选；优先于 amountBasis，按日期精确锚定） */
    navDate?: string
    /** 校验告警回调（不阻断导入） */
    onWarn?: (msg: string) => void
  },
): Promise<FundRecord> {
  const meta = await ports.data.resolveFund({
    code: payload.code,
    type: payload.type || 'watch',
    name: payload.name,
    sectors: payload.sectors,
  })

  // 代码 ↔ 名称核对结果（对持仓/自选都生效）。
  // AI 识别截图时基金代码常错一两位，而错误代码往往也是一只真实基金，
  // 不核对就会静默导入完全不相干的标的。
  // 约定：codeCorrected（已按名称反查出正确代码）→ 告警后照常导入；
  //      nameMismatch（对不上且无法反查）→ 直接拒绝导入，交由用户核对代码。
  if (meta.nameMismatch) {
    // 与任一平台官方名都不符，且无唯一可纠正的代码 → 视为代码错误，拒绝导入。
    const m = meta.nameMismatch
    const officials = m.officials.length ? m.officials.join(' / ') : '（数据源未返回名称）'
    throw new Error(
      `代码 ${meta.code} 与名称对不上，已拒绝导入：` +
        `代码 ${meta.code} 实际是「${officials}」，而你给的名称是「${m.input}」，按该名称也没搜到能唯一确定的基金。` +
        `请核对代码是否识别错误（AI 识图常错一两位数字）后重新导入。`,
    )
  }
  if (meta.codeCorrected && payload.onWarn) {
    const c = meta.codeCorrected
    payload.onWarn(
      `${c.from} → ${c.to}：代码与名称不符，已按名称自动纠正。` +
        `代码 ${c.from} 实际是「${c.fromName}」，而你给的名称「${payload.name}」对应 ${c.to}「${c.toName}」` +
        `${c.matchedBy === 'loose' ? '（名称为忽略「混合/股票」等类型词后匹配，请重点核对）' : ''}。` +
        `已按名称导入 ${c.to}，若不对请手动删除后重新添加。`,
    )
  }

  const amount = payload.amount ?? 0
  const basis: AmountBasis = payload.amountBasis === 'today' ? 'today' : 'prev'

  let shares = 0
  let basisDate: string | undefined
  if (payload.type === 'hold') {
    if (payload.shares != null && payload.shares > 0) {
      // 直接给了份额：完全跳过净值折算。基准净值只用于校验，取不到也不影响导入。
      shares = payload.shares
      try {
        basisDate = pickBasisNav(basis, meta, payload.navDate).date
      } catch {
        basisDate = undefined
      }
    } else {
      const picked = pickBasisNav(basis, meta, payload.navDate)
      basisDate = picked.date
      shares = deriveHoldShares(amount, picked)
    }
  }

  // 累计收益：显式 holdProfit 优先；缺失时可由收益率反推 holdProfit = amount × rate / (1 + rate)
  let holdProfit = payload.holdProfit
  if (
    (holdProfit == null || !Number.isFinite(holdProfit)) &&
    payload.holdProfitRate != null &&
    Number.isFinite(payload.holdProfitRate) &&
    payload.holdProfitRate > -1 &&
    amount > 0
  ) {
    const r = payload.holdProfitRate
    holdProfit = (amount * r) / (1 + r)
  }

  if (payload.type === 'hold' && payload.onWarn) {
    runImportChecks({
      code: meta.code,
      amount,
      shares,
      holdProfit,
      holdProfitRate: payload.holdProfitRate,
      dailyProfit: payload.dailyProfit,
      basisDate,
      meta,
      onWarn: payload.onWarn,
    })
  }

  if (payload.type === 'hold') {
    // 持仓：合并 prev 的其他分组 allocation/cost，覆盖/设置当前分组份额与成本单价
    const group = payload.group ?? ''
    const prev = ports.config.getConfig().holdings[meta.code]
    const prevAllocations = prev?.allocations || {}
    const allocations = {...prevAllocations, [group]: shares}
    // 成本单价优先级：显式 cost > holdProfit 反推 > 保留 prev
    const prevCosts = prev?.costs || {}
    let costs = prevCosts
    if (payload.cost != null && payload.cost > 0) {
      costs = {...prevCosts, [group]: Number(payload.cost) || 0}
    } else if (holdProfit != null && Number.isFinite(holdProfit) && shares > 0) {
      // 总成本 = 市值 - 累计收益；成本单价 = 总成本 / 份额
      const totalCost = amount - Number(holdProfit)
      const price = Math.round((totalCost / shares) * 1e6) / 1e6
      if (price > 0) costs = {...prevCosts, [group]: price}
    }
    return await upsertFund(ports, {
      code: meta.code,
      // 官方名优先：传入名可能来自 AI 识图，与代码不符时以数据源为准，
      // 否则会出现「显示的名字是对的、数据却是另一只基金」的隐形错配。
      name: meta.name || payload.name,
      fundKey: meta.fundKey,
      type: 'hold',
      allocations,
      costs: Object.keys(costs).length ? costs : undefined,
      sectors: payload.sectors?.length ? payload.sectors : meta.sectors,
    })
  }

  // 自选：allocations 为空对象
  return await upsertFund(ports, {
    code: meta.code,
    name: meta.name || payload.name,
    fundKey: meta.fundKey,
    type: 'watch',
    allocations: {},
    sectors: payload.sectors?.length ? payload.sectors : meta.sectors,
  })
}

export async function updateFund(
  ports: Ports,
  code: string,
  payload: Partial<FundRecord> & {
    amount?: number
    amountBasis?: AmountBasis
    group?: string
    cost?: number
    shares?: number
    navDate?: string
  },
  type: 'hold' | 'watch',
): Promise<FundRecord> {
  const {amount, amountBasis, cost, shares, navDate, ...rest} = payload
  const patch: Partial<FundRecord> = {...rest, type}

  // 仅在显式传了份额或金额时才动 allocations，否则会把该分组份额清零
  if (type === 'hold' && ((shares != null && shares > 0) || amount != null)) {
    const meta = await ports.data.resolveFund({code, type})
    const basis: AmountBasis = amountBasis === 'today' ? 'today' : 'prev'
    let nextShares = 0
    if (shares != null && shares > 0) {
      nextShares = shares
    } else if (amount != null) {
      nextShares = deriveHoldShares(Number(amount) || 0, pickBasisNav(basis, meta, navDate))
    }
    const group = payload.group ?? ''
    const prev = ports.config.getConfig().holdings[code.padStart(6, '0')]
    const prevAllocations = prev?.allocations || {}
    patch.allocations = {...prevAllocations, [group]: nextShares}
  }

  if (cost != null && type === 'hold') {
    const group = payload.group ?? ''
    const prev = ports.config.getConfig().holdings[code.padStart(6, '0')]
    const prevCosts = prev?.costs || {}
    const c = Number(cost) || 0
    if (c > 0) {
      patch.costs = {...prevCosts, [group]: c}
    } else {
      // 传 0 表示清空该分组成本单价
      const next = {...prevCosts}
      delete next[group]
      patch.costs = Object.keys(next).length ? next : undefined
    }
  }

  return patchFund(ports, code, patch, type)
}

export function removeFund(ports: Ports, code: string, type: 'hold' | 'watch'): void {
  const config = ports.config.getConfig()
  const key = String(code).padStart(6, '0')
  const map = type === 'hold' ? config.holdings : config.watchlist
  if (!map[key]) throw new Error('基金不存在')
  delete map[key]
  ports.config.saveConfig(config)
}

export function updateGoldConfig(
  ports: Ports,
  payload: {holding: number; avgPrice: number},
): {holding: number; avgPrice: number} {
  const config = ports.config.getConfig()
  config.gold = {
    holding: Number(payload.holding ?? config.gold.holding ?? 0) || 0,
    avgPrice: Number(payload.avgPrice ?? config.gold.avgPrice ?? 0) || 0,
  }
  ports.config.saveConfig(config)
  return config.gold
}

export function fetchSettings(ports: Ports): AppSettings {
  return ports.config.getConfig().settings
}

export function updateSettings(
  ports: Ports,
  patch: Partial<AppSettings>,
): AppSettings {
  const config = ports.config.getConfig()
  if (typeof patch.showGold === 'boolean') {
    config.settings.showGold = patch.showGold
  }
  if (patch.quoteSource === 'fund123' || patch.quoteSource === 'fundmnfinfo') {
    config.settings.quoteSource = patch.quoteSource
  }
  if (
    patch.theme === 'system' ||
    patch.theme === 'light' ||
    patch.theme === 'dark'
  ) {
    config.settings.theme = patch.theme
  }
  if (
    patch.badgeMode === 'percent' ||
    patch.badgeMode === 'amount' ||
    patch.badgeMode === 'hidden'
  ) {
    config.settings.badgeMode = patch.badgeMode
  }
  if (Array.isArray(patch.selectedIndices)) {
    const next = Array.from(
      new Set(
        patch.selectedIndices
          .map((c) => String(c ?? '').trim())
          .filter(Boolean),
      ),
    ).slice(0, MAX_SELECTED_INDICES)
    config.settings.selectedIndices = next
  }
  if (patch.refreshInterval) {
    config.settings.refreshInterval = clampRefreshInterval({
      ...config.settings.refreshInterval,
      ...patch.refreshInterval,
    })
  }
  if (Array.isArray(patch.holdingGroups)) {
    // 整体替换 holdingGroups（去重保序）
    const next: string[] = []
    for (const g of patch.holdingGroups) {
      const name = String(g ?? '').trim()
      if (name && !next.includes(name)) next.push(name)
    }
    config.settings.holdingGroups = next
    // 清理持仓中引用了已删除分组的 allocations（从对象中删除 key）
    const valid = new Set(next)
    for (const f of Object.values(config.holdings)) {
      if (f.allocations && typeof f.allocations === 'object') {
        let changed = false
        for (const g of Object.keys(f.allocations)) {
          // '' (未分组) 永远有效，不受 holdingGroups 影响
          if (g !== '' && !valid.has(g)) {
            delete f.allocations[g]
            changed = true
          }
        }
        if (changed) f.updatedAt = new Date().toISOString()
      }
    }
  }
  if (Array.isArray(patch.menubarHiddenGroups)) {
    // 整体替换 menubarHiddenGroups：去重保序，仅保留 ''(未分组) 或现有分组名
    const valid = new Set(config.settings.holdingGroups || [])
    const next: string[] = []
    for (const g of patch.menubarHiddenGroups) {
      const key = String(g ?? '').trim()
      if ((key === '' || valid.has(key)) && !next.includes(key)) next.push(key)
    }
    config.settings.menubarHiddenGroups = next
  }
  if (
    patch.menubarLayout === 0 ||
    patch.menubarLayout === 1 ||
    patch.menubarLayout === 2
  ) {
    config.settings.menubarLayout = patch.menubarLayout
  }
  if (
    typeof patch.menubarTopFontSize === 'number' &&
    Number.isFinite(patch.menubarTopFontSize)
  ) {
    config.settings.menubarTopFontSize = Math.min(16, Math.max(5, patch.menubarTopFontSize))
  }
  if (
    typeof patch.menubarBottomFontSize === 'number' &&
    Number.isFinite(patch.menubarBottomFontSize)
  ) {
    config.settings.menubarBottomFontSize = Math.min(16, Math.max(5, patch.menubarBottomFontSize))
  }
  ports.config.saveConfig(config)
  return config.settings
}

/** 返回所有持仓分组名称（保序） */
export function listHoldingGroups(ports: Ports): string[] {
  return ports.config.getConfig().settings.holdingGroups || []
}

/** 返回指定类型的基金记录列表（hold/watch） */
export function listFunds(
  ports: Ports,
  type?: 'hold' | 'watch',
): FundRecord[] {
  const {holdings, watchlist} = ports.config.getConfig()
  if (type === 'hold') return Object.values(holdings)
  if (type === 'watch') {
    return Object.values(watchlist).sort((a, b) => {
      const ac = a.createdAt || ''
      const bc = b.createdAt || ''
      if (ac && bc && ac !== bc) return ac < bc ? -1 : 1
      return 0
    })
  }
  return [...Object.values(holdings), ...Object.values(watchlist)]
}

/** 新增一个持仓分组（已存在则忽略），返回最新分组列表 */
export function addHoldingGroup(ports: Ports, name: string): string[] {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new Error('分组名不能为空')
  const config = ports.config.getConfig()
  const groups = config.settings.holdingGroups || []
  if (!groups.includes(trimmed)) {
    config.settings.holdingGroups = [...groups, trimmed]
    ports.config.saveConfig(config)
  }
  return config.settings.holdingGroups || []
}

/** 删除一个持仓分组，并把引用它的持仓从该分组中移除（删除对应 allocation 与 cost） */
export function removeHoldingGroup(ports: Ports, name: string): string[] {
  const trimmed = String(name || '').trim()
  const config = ports.config.getConfig()
  config.settings.holdingGroups = (config.settings.holdingGroups || []).filter(
    (g) => g !== trimmed,
  )
  if (config.settings.holdingGroupOrders) {
    delete config.settings.holdingGroupOrders[trimmed]
    if (Object.keys(config.settings.holdingGroupOrders).length === 0) {
      config.settings.holdingGroupOrders = undefined
    }
  }
  for (const f of Object.values(config.holdings)) {
    if (f.allocations && trimmed in f.allocations) {
      delete f.allocations[trimmed]
      f.updatedAt = new Date().toISOString()
    }
    if (f.costs && trimmed in f.costs) {
      delete f.costs[trimmed]
      if (Object.keys(f.costs).length === 0) f.costs = undefined
    }
  }
  // 清理 allocations 为空的基金
  for (const key of Object.keys(config.holdings)) {
    const f = config.holdings[key]
    if (!f.allocations || Object.keys(f.allocations).length === 0) {
      delete config.holdings[key]
    }
  }
  ports.config.saveConfig(config)
  return config.settings.holdingGroups
}

/**
 * 删除一个持仓分组及其内所有基金（彻底删除，含多分组基金）。
 * 用于批量编辑弹窗的"删除分组"按钮。
 */
export function removeHoldingGroupWithFunds(ports: Ports, name: string): string[] {
  const trimmed = String(name || '').trim()
  const config = ports.config.getConfig()
  config.settings.holdingGroups = (config.settings.holdingGroups || []).filter(
    (g) => g !== trimmed,
  )
  if (config.settings.holdingGroupOrders) {
    delete config.settings.holdingGroupOrders[trimmed]
    if (Object.keys(config.settings.holdingGroupOrders).length === 0) {
      config.settings.holdingGroupOrders = undefined
    }
  }
  // 删除所有在该分组有 allocation 的基金（含多分组基金）
  for (const key of Object.keys(config.holdings)) {
    const f = config.holdings[key]
    if (f.allocations && trimmed in f.allocations) {
      delete config.holdings[key]
    }
  }
  ports.config.saveConfig(config)
  return config.settings.holdingGroups
}

/** 重命名一个持仓分组，并同步更新引用它的持仓的 allocations/costs key 与排序 key */
export function renameHoldingGroup(
  ports: Ports,
  oldName: string,
  newName: string,
): string[] {
  const o = String(oldName || '').trim()
  const n = String(newName || '').trim()
  if (!n) throw new Error('分组名不能为空')
  const config = ports.config.getConfig()
  const groups = config.settings.holdingGroups || []
  if (o !== n && groups.includes(n)) throw new Error(`分组「${n}」已存在`)
  config.settings.holdingGroups = groups.map((g) => (g === o ? n : g))
  for (const f of Object.values(config.holdings)) {
    if (f.allocations && o in f.allocations) {
      const shares = f.allocations[o]
      delete f.allocations[o]
      // 若已有同名分组份额，累加（避免覆盖）
      f.allocations[n] = (f.allocations[n] || 0) + shares
      f.updatedAt = new Date().toISOString()
    }
    if (f.costs && o in f.costs) {
      const c = f.costs[o]
      delete f.costs[o]
      f.costs[n] = (f.costs[n] || 0) + c
      if (Object.keys(f.costs).length === 0) f.costs = undefined
    }
  }
  // 同步排序 key
  if (config.settings.holdingGroupOrders && o in config.settings.holdingGroupOrders) {
    const order = config.settings.holdingGroupOrders[o]
    delete config.settings.holdingGroupOrders[o]
    // 合并到新名（已有则拼接去重）
    const existing = config.settings.holdingGroupOrders[n] || []
    const merged = Array.from(new Set([...order, ...existing]))
    config.settings.holdingGroupOrders[n] = merged
  }
  ports.config.saveConfig(config)
  return config.settings.holdingGroups
}

/** 获取某分组内的基金排序（codes 有序列表），未设置则返回 [] */
export function getHoldingGroupOrder(ports: Ports, group: string): string[] {
  return ports.config.getConfig().settings.holdingGroupOrders?.[group] || []
}

/** 设置某分组内的基金排序（codes 有序列表） */
export function setHoldingGroupOrder(
  ports: Ports,
  group: string,
  codes: string[],
): void {
  const config = ports.config.getConfig()
  const cleaned = Array.from(
    new Set(
      codes
        .map((c) => String(c ?? '').padStart(6, '0'))
        .filter((c) => /^\d{6}$/.test(c)),
    ),
  )
  if (!config.settings.holdingGroupOrders) {
    config.settings.holdingGroupOrders = {}
  }
  if (cleaned.length) {
    config.settings.holdingGroupOrders[group] = cleaned
  } else {
    delete config.settings.holdingGroupOrders[group]
  }
  if (Object.keys(config.settings.holdingGroupOrders).length === 0) {
    config.settings.holdingGroupOrders = undefined
  }
  ports.config.saveConfig(config)
}

/**
 * 直接设置某基金在某分组的份额与成本（批量编辑用，绕过金额反推份额）。
 * - shares<=0 等同于删除该分组 allocation（连带 cost）
 * - cost<=0 或 undefined 表示清空该分组成本单价（保留份额）
 * - 保留其他分组的 allocation/cost
 */
export function setFundAllocation(
  ports: Ports,
  code: string,
  group: string,
  shares: number,
  cost?: number,
): void {
  const config = ports.config.getConfig()
  const key = String(code).padStart(6, '0')
  const fund = config.holdings[key]
  if (!fund) throw new Error('基金不存在')
  const allocations = {...(fund.allocations || {})}
  const costs = {...(fund.costs || {})}
  const s = Number(shares) || 0
  if (s > 0) {
    allocations[group] = s
  } else {
    delete allocations[group]
  }
  // cost 是成本单价（元/份）
  if (cost != null && cost > 0) {
    costs[group] = Number(cost) || 0
  } else {
    delete costs[group]
  }
  fund.allocations = allocations
  fund.costs = Object.keys(costs).length ? costs : undefined
  fund.updatedAt = new Date().toISOString()
  // allocations 为空则删除整个基金
  if (Object.keys(allocations).length === 0) {
    delete config.holdings[key]
  }
  ports.config.saveConfig(config)
}

export function exportConfig(ports: Ports): AppConfig {
  return ports.config.getConfig()
}

export function importConfig(ports: Ports, payload: Partial<AppConfig> & {funds?: unknown}): AppConfig {
  const hasFunds = payload?.funds && typeof payload.funds === 'object'
  const hasHoldings = payload?.holdings && typeof payload.holdings === 'object'
  const hasWatchlist = payload?.watchlist && typeof payload.watchlist === 'object'
  if (!hasFunds && !hasHoldings && !hasWatchlist) {
    throw new Error('配置缺少 holdings/watchlist')
  }
  const next = normalizeConfig(payload as any)
  ports.config.saveConfig(next)
  return next
}
