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
  MENUBAR_OVERVIEW_KEY,
  normalizeConfig,
  normalizeFund,
  normalizeNetValueDate,
  todayDateStr,
} from '@fund01/core'

/** 录入金额对应哪一版确认净值市值；'auto' = 自动取当前最新可用确认净值（默认） */
export type AmountBasis = 'prev' | 'today' | 'auto'

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

  // ①½ auto：自动取「当前最新可用确认净值」——今日已确认净值优先，否则用最新确认
  // 净值（盘中今日未确认 → 即昨日净值）。这是默认口径：用户录入的「持有金额」就是此刻
  // 看到的当前市值，无需在昨日/今日间手动抉择。
  if (basis === 'auto') {
    if (latest != null && latest > 0) return {nav: latest, date: latestDate}
    if (prior != null && prior > 0) return {nav: prior, date: priorDate}
    throw new Error('暂无确认净值，无法按金额反推份额，请稍后重试')
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

/**
 * 代码↔名称校验不通过（nameMismatch）时抛出的专用错误。
 * UI 层据此识别「名称对不上」类失败，可提供「确认并导入」入口
 * （用户核实代码正确、仅平台命名差异时，带 forceImport 重新导入）。
 */
export class NameMismatchError extends Error {
  readonly input: string
  readonly officials: string[]
  constructor(message: string, input: string, officials: string[]) {
    super(message)
    this.name = 'NameMismatchError'
    this.input = input
    this.officials = officials
  }
}

/** 内部：upsert 一条持仓记录（归一化后写回配置） */
async function upsertFund(
  ports: Ports,
  payload: Partial<FundRecord> & {code: string},
): Promise<FundRecord> {
  const config = ports.config.getConfig()
  const code = String(payload.code).padStart(6, '0')
  if (!/^\d{6}$/.test(code)) throw new Error('基金代码须为6位数字')
  const prev = config.holdings[code]
  const next = normalizeFund({...payload, code, type: 'hold'}, prev, 'hold')
  config.holdings[code] = next
  // await 确保 chrome.storage.local.set 完成，避免 SW 读到旧 config
  await ports.config.saveConfig(config)
  return next
}

/** 内部：更新一条持仓记录（合并 patch 后归一化写回） */
function patchFund(
  ports: Ports,
  code: string,
  patch: Partial<FundRecord>,
): FundRecord {
  const config = ports.config.getConfig()
  const key = String(code).padStart(6, '0')
  const prev = config.holdings[key]
  if (!prev) throw new Error('基金不存在')
  const next = normalizeFund({...prev, ...patch, code: key, type: 'hold'}, prev, 'hold')
  config.holdings[key] = next
  ports.config.saveConfig(config)
  return next
}

export async function createFund(
  ports: Ports,
  payload: Partial<FundRecord> & {
    code: string
    amount?: number
    amountBasis?: AmountBasis
    /** 持仓分组（空字符串=未分组） */
    group?: string
    /** 该分组的持仓成本单价（元/份，可选） */
    cost?: number
    /** 持有收益（元，可选；用于反推成本单价） */
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
    /**
     * 强制导入：跳过「代码↔名称对不上」的拒绝（用户已人工确认代码正确，
     * 仅不同平台命名差异）。导入后的名称仍以数据源官方名为准。
     */
    forceImport?: boolean
  },
): Promise<FundRecord> {
  const meta = await ports.data.resolveFund({
    code: payload.code,
    type: 'hold',
    name: payload.name,
    sectors: payload.sectors,
  })

  // 代码 ↔ 名称核对结果（对持仓生效）。
  // AI 识别截图时基金代码常错一两位，而错误代码往往也是一只真实基金，
  // 不核对就会静默导入完全不相干的标的。
  // 约定：codeCorrected（已按名称反查出正确代码）→ 告警后照常导入；
  //      nameMismatch（对不上且无法反查）→ 默认拒绝导入；forceImport（用户
  //      已确认代码正确，仅平台命名差异）时放行，名称仍用数据源官方名。
  if (meta.nameMismatch && !payload.forceImport) {
    // 与任一平台官方名都不符，且无唯一可纠正的代码 → 视为代码错误，拒绝导入。
    const m = meta.nameMismatch
    const officials = m.officials.length ? m.officials.join(' / ') : '（数据源未返回名称）'
    throw new NameMismatchError(
      `代码 ${meta.code} 与名称对不上，已拒绝导入：` +
        `代码 ${meta.code} 实际是「${officials}」，而你给的名称是「${m.input}」，按该名称也没搜到能唯一确定的基金。` +
        `请核对代码是否识别错误（AI 识图常错一两位数字）后重新导入。`,
      m.input,
      m.officials,
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
  const basis: AmountBasis =
    payload.amountBasis === 'today' ? 'today' : payload.amountBasis === 'prev' ? 'prev' : 'auto'

  let shares = 0
  let basisDate: string | undefined
  if (payload.shares != null && payload.shares > 0) {
    // 直接给了份额：完全跳过净值折算。基准净值只用于校验，取不到也不影响导入。
    shares = payload.shares
    try {
      basisDate = pickBasisNav(basis, meta, payload.navDate).date
    } catch {
      basisDate = undefined
    }
  } else if (amount > 0) {
    const picked = pickBasisNav(basis, meta, payload.navDate)
    basisDate = picked.date
    shares = deriveHoldShares(amount, picked)
  }
  // amount <= 0（0 金额 = 关注/待加仓）：份额恒 0，无需净值折算，
  // 也不依赖数据源是否有确认净值（否则净值缺失时 0 金额导入会失败）

  // 持有收益：显式 holdProfit 优先；缺失时可由收益率反推 holdProfit = amount × rate / (1 + rate)
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

  if (payload.onWarn) {
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
    // 总成本 = 市值 - 持有收益；成本单价 = 总成本 / 份额
    const totalCost = amount - Number(holdProfit)
    const price = Math.round((totalCost / shares) * 1e6) / 1e6
    if (price > 0) {
      costs = {...prevCosts, [group]: price}
    } else if (payload.onWarn) {
      // 持有收益 ≥ 持有金额：成本单价反推 ≤0，未写入；提示用户核对数据口径
      //（常见于金额是某口径市值、收益是另一口径收益，或录错）。持有成本显示 -- 是数据
      // 层语义正确的体现，不是 bug；用户在导入「数据校验提醒」框可看到本条警告。
      const gp = group || '未分组'
      payload.onWarn(
        `${meta.code}（${gp}）：持有收益（${holdProfit}）≥ 持有金额（${amount}），` +
          `成本单价反推 ${price.toFixed(6)} 元/份 ≤0，未写入；` +
          `请检查金额与收益口径是否一致（今日/昨日结算）。`,
      )
    }
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
): Promise<FundRecord> {
  const {amount, amountBasis, cost, shares, navDate, ...rest} = payload
  const patch: Partial<FundRecord> = {...rest, type: 'hold'}

  // 仅在显式传了份额或金额时才动 allocations，否则会把该分组份额清零
  if ((shares != null && shares > 0) || amount != null) {
    let nextShares = 0
    if (shares != null && shares > 0) {
      nextShares = shares
    } else if (amount != null && Number(amount) > 0) {
      // 仅正金额需要净值折算；0 金额（关注/待加仓）份额恒 0，不依赖数据源是否有净值
      const meta = await ports.data.resolveFund({code, type: 'hold'})
      const basis: AmountBasis = amountBasis === 'today' ? 'today' : amountBasis === 'prev' ? 'prev' : 'auto'
      nextShares = deriveHoldShares(Number(amount) || 0, pickBasisNav(basis, meta, navDate))
    }
    const group = payload.group ?? ''
    const prev = ports.config.getConfig().holdings[code.padStart(6, '0')]
    const prevAllocations = prev?.allocations || {}
    patch.allocations = {...prevAllocations, [group]: nextShares}
  }

  if (cost != null) {
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

  return patchFund(ports, code, patch)
}

export function removeFund(ports: Ports, code: string): void {
  const config = ports.config.getConfig()
  const key = String(code).padStart(6, '0')
  if (!config.holdings[key]) throw new Error('基金不存在')
  delete config.holdings[key]
  ports.config.saveConfig(config)
}

/**
 * 写持仓（新增/编辑/导入）成功后刷新展示缓存，让 popup 等读 SW 缓存的端立即反映新数据。
 *
 * 背景：popup 持仓列表读 SW 算好的 `cache-holdings`（非实时读 config）；写 config 不会自动
 * 触发 SW 重算缓存（仅切换 quoteSource 才自动 refreshAll）。叠加非交易时段（周末/节假日）
 * alarm 定时刷新被跳过，旧快照会残留到下一交易时段 —— 表现为「导入后持有成本/收益显示 --」。
 *
 * - chrome：`clearCache` = 清全部 cache-* + `refreshAll(true)`（force 跳过非交易时段过滤，立即重算）
 * - tauri：无 SW 缓存概念，`clearCache` 未实现 → 回退普通 `triggerRefresh`
 * - 失败不阻断：数据已落库，下一轮交易时段 alarm 会自然重算
 */
export async function refreshHoldingsCache(ports: Ports): Promise<void> {
  try {
    if (ports.data.clearCache) {
      await ports.data.clearCache()
    } else {
      await ports.data.triggerRefresh()
    }
  } catch {
    /* 忽略：刷新失败不影响已落库的数据 */
  }
}

export function fetchSettings(ports: Ports): AppSettings {
  return ports.config.getConfig().settings
}

export async function updateSettings(
  ports: Ports,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const config = ports.config.getConfig()
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
  if (patch.holdingsNavPosition === 'top' || patch.holdingsNavPosition === 'side') {
    config.settings.holdingsNavPosition = patch.holdingsNavPosition
  }
  if (typeof patch.groupTabShowDetail === 'boolean') {
    config.settings.groupTabShowDetail = patch.groupTabShowDetail
  }
  if (
    patch.groupTabDetailMode === 'percent' ||
    patch.groupTabDetailMode === 'amount'
  ) {
    config.settings.groupTabDetailMode = patch.groupTabDetailMode
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
  if (Array.isArray(patch.overviewExcludedGroups)) {
    // 整体替换 overviewExcludedGroups：去重保序，仅保留 ''(未分组) 或现有分组名
    const valid = new Set(config.settings.holdingGroups || [])
    const next: string[] = []
    for (const g of patch.overviewExcludedGroups) {
      const key = String(g ?? '').trim()
      if ((key === '' || valid.has(key)) && !next.includes(key)) next.push(key)
    }
    config.settings.overviewExcludedGroups = next
  }
  if (patch.menubarLayout === 0 || patch.menubarLayout === 2) {
    config.settings.menubarLayout = patch.menubarLayout
  }
  if (
    typeof patch.menubarTopFontSize === 'number' &&
    Number.isFinite(patch.menubarTopFontSize)
  ) {
    config.settings.menubarTopFontSize = Math.min(10, Math.max(7, patch.menubarTopFontSize))
  }
  if (
    typeof patch.menubarBottomFontSize === 'number' &&
    Number.isFinite(patch.menubarBottomFontSize)
  ) {
    config.settings.menubarBottomFontSize = Math.min(14, Math.max(10, patch.menubarBottomFontSize))
  }
  if (
    typeof patch.menubarEqualFontSize === 'number' &&
    Number.isFinite(patch.menubarEqualFontSize)
  ) {
    config.settings.menubarEqualFontSize = Math.min(11, Math.max(8, patch.menubarEqualFontSize))
  }
  if (typeof patch.menubarShowAmount === 'boolean') {
    config.settings.menubarShowAmount = patch.menubarShowAmount
  }
  // 静默启动（仅 tauri）：启动不打开设置界面，仅常驻菜单栏
  if (typeof patch.silentStart === 'boolean') {
    config.settings.silentStart = patch.silentStart
  }
  if (typeof patch.menubarTopFont === 'string') {
    config.settings.menubarTopFont = patch.menubarTopFont.trim()
  }
  if (typeof patch.menubarBottomFont === 'string') {
    config.settings.menubarBottomFont = patch.menubarBottomFont.trim()
  }
  if (typeof patch.menubarTopBold === 'boolean') {
    config.settings.menubarTopBold = patch.menubarTopBold
  }
  if (typeof patch.menubarBottomBold === 'boolean') {
    config.settings.menubarBottomBold = patch.menubarBottomBold
  }
  if (patch.menubarTopAlign === 0 || patch.menubarTopAlign === 1 || patch.menubarTopAlign === 2) {
    config.settings.menubarTopAlign = patch.menubarTopAlign
  }
  if (patch.menubarBottomAlign === 0 || patch.menubarBottomAlign === 1 || patch.menubarBottomAlign === 2) {
    config.settings.menubarBottomAlign = patch.menubarBottomAlign
  }
  if (typeof patch.menubarTopColor === 'string') {
    config.settings.menubarTopColor = patch.menubarTopColor
  }
  if (patch.menubarGroupColors && typeof patch.menubarGroupColors === 'object') {
    // 整体替换 menubarGroupColors：仅保留 ''(未分组)、总览或现有分组名，value 校验 hex
    const valid = new Set(config.settings.holdingGroups || [])
    const next: Record<string, string> = {}
    for (const [g, color] of Object.entries(patch.menubarGroupColors)) {
      const key = String(g ?? '').trim()
      if (typeof color !== 'string') continue
      const hex = color.trim()
      if (
        (key === '' || key === MENUBAR_OVERVIEW_KEY || valid.has(key)) &&
        /^#[0-9a-fA-F]{6}$/.test(hex)
      ) {
        next[key] = hex
      }
    }
    config.settings.menubarGroupColors = next
  }
  if (typeof patch.menubarRiseColor === 'string') {
    config.settings.menubarRiseColor = patch.menubarRiseColor
  }
  if (typeof patch.menubarFallColor === 'string') {
    config.settings.menubarFallColor = patch.menubarFallColor
  }
  if (typeof patch.menubarFlatColor === 'string') {
    config.settings.menubarFlatColor = patch.menubarFlatColor
  }
  await ports.config.saveConfig(config)
  // 回读服务端归一化后的最新设置（ConfigPort 已乐观同步镜像 + 回包覆盖），保证返回值与后端一致
  return ports.config.getConfig().settings
}

/** 返回所有持仓分组名称（保序） */
export function listHoldingGroups(ports: Ports): string[] {
  return ports.config.getConfig().settings.holdingGroups || []
}

/** 不纳入总览的持仓分组名列表（'' 表示未分组） */
export function listOverviewExcludedGroups(ports: Ports): string[] {
  return ports.config.getConfig().settings.overviewExcludedGroups || []
}

/** 某分组是否不纳入总览（默认全部纳入） */
export function isGroupOverviewExcluded(ports: Ports, group: string): boolean {
  return listOverviewExcludedGroups(ports).includes(group)
}

/** 设置某分组是否纳入总览（true = 不纳入）。默认全部分组纳入总览。 */
export async function toggleGroupOverviewExcluded(
  ports: Ports,
  group: string,
  excluded: boolean,
): Promise<void> {
  const config = ports.config.getConfig()
  const list = config.settings.overviewExcludedGroups || []
  const next = excluded
    ? list.includes(group)
      ? list
      : [...list, group]
    : list.filter((g) => g !== group)
  config.settings.overviewExcludedGroups = next
  await ports.config.saveConfig(config)
}

/** 是否存在未分组持仓：allocations 里有份额 >0 且分组名不在 holdingGroups 中。
 *  口径与 Rust `has_ungrouped`（apps/tauri/src-tauri/src/menubar.rs）保持一致。 */
export function hasUngroupedHoldings(cfg: AppConfig): boolean {
  const groups = new Set(cfg.settings.holdingGroups || [])
  return Object.values(cfg.holdings || {}).some((fund) =>
    Object.entries(fund.allocations || {}).some(([g, sh]) => sh > 0 && !groups.has(g)),
  )
}

/** menubar 是否全空（所有菜单栏实例都被隐藏，用户把每个状态项都移出了菜单栏）：
 *  总览 __overview__ 被拖出 ∧ 全部分组在 menubarHiddenGroups ∧（存在未分组持仓时 '' 也在其中）。
 *  ⚠️ 判定口径与 Rust `menubar_all_hidden`（apps/tauri/src-tauri/src/menubar.rs）保持一致（两端 1:1 铁律）。
 *  仅 Tauri 有意义；Chrome 端由 useMenubarEmpty 在 supportsMenubar 为假时短路，不走到这里。 */
export function isMenubarEmpty(cfg: AppConfig): boolean {
  const hidden = new Set(cfg.settings.menubarHiddenGroups || [])
  if (!hidden.has(MENUBAR_OVERVIEW_KEY)) return false
  for (const g of cfg.settings.holdingGroups || []) {
    if (!hidden.has(g)) return false
  }
  if (hasUngroupedHoldings(cfg) && !hidden.has('')) return false
  return true
}

/** 返回持仓基金记录列表 */
export function listFunds(ports: Ports, _type?: 'hold'): FundRecord[] {
  return Object.values(ports.config.getConfig().holdings)
}

/** 新增一个持仓分组（已存在则忽略），返回最新分组列表。
 *  async：保存完成（持久化 + 内存镜像更新）后才 resolve，保证调用方随后读取/重载到的配置是最新的。 */
export async function addHoldingGroup(ports: Ports, name: string): Promise<string[]> {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new Error('分组名不能为空')
  const config = ports.config.getConfig()
  const groups = config.settings.holdingGroups || []
  if (!groups.includes(trimmed)) {
    config.settings.holdingGroups = [...groups, trimmed]
    await ports.config.saveConfig(config)
  }
  return config.settings.holdingGroups || []
}

/** 删除一个持仓分组，并把引用它的持仓从该分组中移除（删除对应 allocation 与 cost） */
export async function removeHoldingGroup(ports: Ports, name: string): Promise<string[]> {
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
  // 删除分组时同步从「不纳入总览」列表移除（分组已不存在，保留无意义）
  config.settings.overviewExcludedGroups = (config.settings.overviewExcludedGroups || []).filter(
    (g) => g !== trimmed,
  )
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
  await ports.config.saveConfig(config)
  return config.settings.holdingGroups
}

/**
 * 删除一个持仓分组及其内基金：仅移除该分组的份额/成本，
 * 同时属于其他分组的基金保留在其他分组（不再整删多分组基金）；
 * 仅属于该分组的基金（删除后 allocation 为空）才会被彻底删除。
 * 用于批量编辑弹窗的"删除分组"按钮。
 */
export async function removeHoldingGroupWithFunds(ports: Ports, name: string): Promise<string[]> {
  // 与 removeHoldingGroup 同语义（删除分组引用 + 清空该分组份额 + 清理空基金），
  // 修复：删除一个分组不得影响其他分组中的同名基金。
  return removeHoldingGroup(ports, name)
}

/** 重命名一个持仓分组，并同步更新引用它的持仓的 allocations/costs key 与排序 key */
export async function renameHoldingGroup(
  ports: Ports,
  oldName: string,
  newName: string,
): Promise<string[]> {
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
  // 同步「不纳入总览」列表：旧名替换为新名（去重）
  if (config.settings.overviewExcludedGroups?.includes(o)) {
    const list = config.settings.overviewExcludedGroups.filter((g) => g !== o)
    if (n && !list.includes(n)) list.push(n)
    config.settings.overviewExcludedGroups = list
  }
  await ports.config.saveConfig(config)
  return config.settings.holdingGroups
}

/** 获取某分组内的基金排序（codes 有序列表），未设置则返回 [] */
export function getHoldingGroupOrder(ports: Ports, group: string): string[] {
  return ports.config.getConfig().settings.holdingGroupOrders?.[group] || []
}

/** 设置某分组内的基金排序（codes 有序列表） */
export async function setHoldingGroupOrder(
  ports: Ports,
  group: string,
  codes: string[],
): Promise<void> {
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
  await ports.config.saveConfig(config)
}

/**
 * 直接设置某基金在某分组的份额与成本（批量编辑用，绕过金额反推份额）。
 * - shares<=0 默认等同于删除该分组 allocation（连带 cost）
 * - shares===0 且 opts.keepZero 时保留 0 份额分组（0 金额基金 = 关注/待加仓，不删）
 * - cost<=0 或 undefined 表示清空该分组成本单价（保留份额）
 * - 保留其他分组的 allocation/cost
 */
export async function setFundAllocation(
  ports: Ports,
  code: string,
  group: string,
  shares: number,
  cost?: number,
  opts?: {keepZero?: boolean},
): Promise<void> {
  const config = ports.config.getConfig()
  const key = String(code).padStart(6, '0')
  const fund = config.holdings[key]
  if (!fund) throw new Error('基金不存在')
  const allocations = {...(fund.allocations || {})}
  const costs = {...(fund.costs || {})}
  const s = Number(shares) || 0
  if (s > 0) {
    allocations[group] = s
  } else if (s === 0 && opts?.keepZero) {
    allocations[group] = 0
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
  await ports.config.saveConfig(config)
}

export function exportConfig(ports: Ports): AppConfig {
  return ports.config.getConfig()
}

export function importConfig(ports: Ports, payload: Partial<AppConfig> & {funds?: unknown}): AppConfig {
  const hasFunds = payload?.funds && typeof payload.funds === 'object'
  const hasHoldings = payload?.holdings && typeof payload.holdings === 'object'
  if (!hasFunds && !hasHoldings) {
    throw new Error('配置缺少 holdings 字段')
  }
  const next = normalizeConfig(payload as any)
  ports.config.saveConfig(next)
  return next
}

/**
 * 重置为出厂默认：清空全部持仓，恢复默认设置（不可撤销，请先导出备份）。
 * await 保存完成后才 resolve，保证调用方随后重载到的配置是最新的。
 */
export async function resetConfig(ports: Ports): Promise<AppConfig> {
  const next = normalizeConfig(null)
  await ports.config.saveConfig(next)
  return next
}
