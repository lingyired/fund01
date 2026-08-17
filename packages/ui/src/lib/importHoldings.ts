/**
 * 导入持仓的纯解析逻辑（与具体 UI 解耦）。
 * 原 ImportHoldingsDialog 依赖 Dialog，这里把解析单独抽出来，
 * 供 OptionsApp 的内联「导入持仓」区块复用。
 */

/** 一条导入记录：一个 (基金, 分组, 金额[, 成本]) 元组 */
export type ImportEntry = {
  code: string
  amount: number
  /**
   * amount 对应哪一版确认净值的市值 —— 直接对应持仓截图上的「今日收益已更新」字样：
   * - `'today'`：截图显示「今日收益已更新 / 今日收益更新」→ amount 已含今日收益，
   *   按**今日确认净值**折算份额。
   * - `'prev'`（默认）：截图无该字样（盘中估算 / 尚未更新）→ amount 是上一交易日
   *   收盘市值，按**今天之前最近一个交易日的确认净值**折算。
   *
   * 注意：两者不是"随便填哪个都行"。填错会让份额整体偏一天的涨跌幅。
   */
  amountBasis: 'prev' | 'today'
  /**
   * amount 对应的净值日期 YYYY-MM-DD（可选，优先级高于 amountBasis）。
   * 截图能读到「净值更新至 08-01」这类日期时填它最稳——它不依赖"导入时刻"，
   * 因此隔夜导入、或数据源与 App 更新节奏不同步时也不会错位。
   */
  navDate?: string
  name?: string
  /** 该条记录指定的分组（'' = 使用默认分组；空字符串=未分组由 defaultGroup 决定） */
  group: string
  /** 该分组的持仓成本单价（元/份，可选；用于累计收益）。undefined=不传，保留原值/无成本 */
  cost?: number
  /** 累计收益（元，可选；用于反推成本单价）。与 cost 二选一，cost 优先 */
  holdProfit?: number
  /**
   * 持有份额（份，可选）。若提供则直接作为该分组份额，**跳过金额→净值折算**，
   * 最精确、无任何净值基准歧义。优先级：shares > amount(折算)。
   * 与 cost 搭配可同时锁定份额与成本单价，完全不经净值换算。
   */
  shares?: number
  /**
   * 昨日收益（元，可选）。**不参与任何计算**，仅用于导入时的一致性校验：
   * 理论昨日收益 = 份额 × (最新确认净值 − 前一日净值)。若与录入值偏差过大，
   * 说明 amount 的口径与最新确认净值不匹配（例如填的是盘中估算市值，
   * 或截图时点跨越了净值更新），届时会给出警告而不阻断导入。
   * 这是「持仓截图只有金额没有份额」场景下唯一能自动发现口径错位的信号。
   */
  dailyProfit?: number
  /**
   * 持仓收益率（小数，可选；如 9.95% 记为 0.0995）。用途有二：
   * 1) holdProfit 缺失时反推：holdProfit = amount × rate / (1 + rate)
   * 2) 两者都有时做成本交叉校验：holdProfit / rate 应 ≈ amount − holdProfit
   */
  holdProfitRate?: number
}

/**
 * 归一化收益率输入为小数。
 * 支持 "9.95%" / "-1.91%" 字符串，以及数字 9.95（视为百分数）/ 0.0995（视为小数）。
 * 判定规则：带 % 一律除以 100；纯数字 |v| >= 1 视为百分数（收益率绝对值超过 100% 极罕见）。
 */
function normalizeRate(raw: unknown): number | undefined {
  if (raw == null) return undefined
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return undefined
    const hasPercent = s.includes('%')
    const n = Number(s.replace(/%/g, '').replace(/,/g, ''))
    if (!Number.isFinite(n)) return undefined
    return hasPercent ? n / 100 : Math.abs(n) >= 1 ? n / 100 : n
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  return Math.abs(n) >= 1 ? n / 100 : n
}

/**
 * 归一化净值日期为 YYYY-MM-DD。
 * 支持 "2026-08-01" / "2026/08/01" / "08-01"（补当前年份，若晚于今天则退一年）。
 */
function normalizeNavDate(raw: unknown, now = new Date()): string | undefined {
  const s = String(raw ?? '').trim().replace(/\//g, '-')
  if (!s) return undefined
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  const md = s.match(/^(\d{1,2})-(\d{1,2})$/)
  if (!md) return undefined
  const month = Number(md[1])
  const day = Number(md[2])
  if (!month || !day) return undefined
  let year = now.getFullYear()
  const candidate = new Date(year, month - 1, day)
  const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (candidate > todayOnly) year -= 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** 解析用户输入的 JSON 字符串为导入条目数组 */
export function parseImport(input: string): ImportEntry[] {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('内容为空')

  // 容错：容忍 markdown 代码块包裹、以及头部/尾部非 JSON 文字
  // （如 AI 在 JSON 数组之后附的「待确认：<名称>」清单）。
  // 提取首个 [...] 段，忽略其前后的多余内容。
  const m = trimmed.match(/\[[\s\S]*\]/)
  if (!m) throw new Error('未找到 JSON 数组')
  let data: unknown
  try {
    data = JSON.parse(m[0])
  } catch (e) {
    throw new Error('JSON 格式错误：' + (e as Error).message)
  }

  if (!Array.isArray(data)) throw new Error('JSON 必须是数组')
  if (data.length === 0) throw new Error('数组为空')

  return data.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`第 ${i + 1} 项不是对象`)
    }
    const obj = item as Record<string, unknown>
    const rawCode = String(obj.code ?? obj.fundCode ?? '').replace(/\D/g, '')
    const code = rawCode.padStart(6, '0').slice(0, 6)
    if (!/^\d{6}$/.test(code)) {
      throw new Error(`第 ${i + 1} 项基金代码无效`)
    }
    const rawAmount = Number(obj.amount ?? obj.money ?? 0)
    if (!Number.isFinite(rawAmount) || rawAmount < 0) {
      throw new Error(`第 ${i + 1} 项金额无效`)
    }
    const rawBasis = String(obj.amountBasis ?? obj.basis ?? 'prev').toLowerCase()
    const amountBasis: 'prev' | 'today' = rawBasis === 'today' ? 'today' : 'prev'
    // 净值日期（可选，优先于 amountBasis）：支持 navDate / netValueDate / 净值日期
    const navDate = normalizeNavDate(obj.navDate ?? obj.netValueDate ?? obj.净值日期)
    const name = obj.name != null ? String(obj.name) : undefined
    // 优先 group(字符串)；兼容旧版 groups(数组) 取第一个非空
    let group = ''
    if (typeof obj.group === 'string') {
      group = obj.group.trim()
    } else if (Array.isArray(obj.groups)) {
      for (const g of obj.groups) {
        const n = String(g ?? '').trim()
        if (n) {
          group = n
          break
        }
      }
    }
    // 成本单价（可选）：支持 cost / costPrice / costBasis 字段名
    let cost: number | undefined
    const rawCost = obj.cost ?? obj.costPrice ?? obj.costBasis
    if (rawCost != null) {
      const c = Number(rawCost)
      if (Number.isFinite(c) && c >= 0) cost = c
    }
    // 累计收益（可选）：支持 holdProfit / totalProfit / cumProfit 字段名
    let holdProfit: number | undefined
    const rawHoldProfit = obj.holdProfit ?? obj.totalProfit ?? obj.cumProfit
    if (rawHoldProfit != null) {
      const h = Number(rawHoldProfit)
      if (Number.isFinite(h)) holdProfit = h
    }
    // 持有份额（可选，优先级高于 amount 折算）：支持 shares / share / 份额 字段名
    let shares: number | undefined
    const rawShares = obj.shares ?? obj.share ?? obj.份额
    if (rawShares != null) {
      const s = Number(rawShares)
      if (Number.isFinite(s) && s > 0) shares = s
    }
    // 昨日收益（可选，仅用于一致性校验）：支持 dailyProfit / dayProfit / yesterdayProfit
    let dailyProfit: number | undefined
    const rawDaily = obj.dailyProfit ?? obj.dayProfit ?? obj.yesterdayProfit
    if (rawDaily != null) {
      const d = Number(rawDaily)
      if (Number.isFinite(d)) dailyProfit = d
    }
    // 持仓收益率（可选）：支持 holdProfitRate / profitRate / totalProfitRate
    const holdProfitRate = normalizeRate(
      obj.holdProfitRate ?? obj.profitRate ?? obj.totalProfitRate,
    )
    return {
      code,
      amount: rawAmount,
      amountBasis,
      navDate,
      name,
      group,
      cost,
      holdProfit,
      shares,
      dailyProfit,
      holdProfitRate,
    }
  })
}

/** 导入 JSON 格式示例（用于占位与说明） */
export const IMPORT_SAMPLE = `请将 AI 生成的 JSON 粘贴到此处，格式如下：\n[\n  { "code": "012697", "name": "广发中证白酒指数C", "amount": 12890.12, "amountBasis": "prev", "shares": 12345.67, "cost": 1.0234 },\n  { "code": "025687", "name": "国泰半导体制造精选混合发起C", "amount": 27538.49, "amountBasis": "today", "group": "人工智能", "holdProfit": 2401.57, "holdProfitRate": "9.95%", "dailyProfit": 768.29 },\n  { "code": "025687", "name": "国泰半导体制造精选混合发起C", "amount": 3000, "amountBasis": "prev", "navDate": "2026-08-01", "group": "核心" }\n]`
