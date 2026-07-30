/** A 股简易交易日：仅跳过周末（不含法定节假日） */

export function todayDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 统一成 YYYY-MM-DD（兼容 MM-DD） */
export function normalizeNetValueDate(raw: string | null | undefined, now = new Date()) {
  const s = String(raw || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const md = s.match(/^(\d{1,2})-(\d{1,2})$/)
  if (!md) return ''
  const month = Number(md[1])
  const day = Number(md[2])
  if (!month || !day) return ''
  let year = now.getFullYear()
  const candidate = new Date(year, month - 1, day)
  const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (candidate > todayOnly) year -= 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseDateStr(s: string): Date {
  const [y, m, day] = s.split('-').map(Number)
  return new Date(y, m - 1, day)
}

/** 给定交易日之后的下一个交易日（周末顺延） */
export function nextTradingDay(dateStr: string): string {
  const normalized = normalizeNetValueDate(dateStr) || dateStr
  const d = parseDateStr(normalized)
  do {
    d.setDate(d.getDate() + 1)
  } while (d.getDay() === 0 || d.getDay() === 6)
  return todayDateStr(d)
}

/**
 * 「下一交易日是否已开始」：日历到达该日，且本地时间 ≥ 09:15
 */
export function isTradingDayStarted(dateStr: string, now = new Date()): boolean {
  const day = normalizeNetValueDate(dateStr, now) || dateStr
  const today = todayDateStr(now)
  if (today > day) return true
  if (today < day) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  return minutes >= 9 * 60 + 15
}

/**
 * 晚间已拉到官方确认涨跌：展示「已更新」；
 * 该净值日的下一交易日开盘后抹去。
 */
export function shouldShowConfirmedUpdatedBadge(
  quote: {
    percentSource?: 'estimate' | 'confirmed' | null
    netValueDate?: string | null
  },
  now = new Date(),
): boolean {
  if (quote.percentSource !== 'confirmed') return false
  const navDay = normalizeNetValueDate(quote.netValueDate, now)
  if (!navDay) return false
  const next = nextTradingDay(navDay)
  return !isTradingDayStarted(next, now)
}

/* ============================================================ *
 * 市场时段判断 —— 用于 SW 定时刷新时跳过非交易时段的数据源
 * 仅按"周一到周五"判断，不识别法定节假日（节假日时刷新到的是
 * 静态数据，不会出错，只是浪费少量请求）。
 * ============================================================ */

function hmsToMinutes(now: Date): number {
  return now.getHours() * 60 + now.getMinutes()
}

/** A 股交易日（周一到周五）的盘中时段：09:15 - 15:30 */
export function isAShareTradingTime(now = new Date()): boolean {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const m = hmsToMinutes(now)
  return m >= 9 * 60 + 15 && m <= 15 * 60 + 30
}

/**
 * 基金是否需要刷新：
 * - A 股交易日 09:15-15:30（盘中估值）
 * - A 股交易日 20:00-23:00（晚间官方确认涨跌更新）
 */
export function shouldRefreshFund(now = new Date()): boolean {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const m = hmsToMinutes(now)
  return (m >= 9 * 60 + 15 && m <= 15 * 60 + 30) || (m >= 20 * 60 && m <= 23 * 60)
}

/** A 股指数 / 大盘（涨跌家数、板块排行）：仅交易日 09:15-15:30 */
export function shouldRefreshAShareMarket(now = new Date()): boolean {
  return isAShareTradingTime(now)
}

/**
 * 黄金 AU9999（上金所）：周一 09:00 - 周六 03:00
 * 日盘 09:00-15:30 + 夜盘 20:00 - 次日 02:30（这里放宽到 03:00 容错）
 */
export function shouldRefreshGold(now = new Date()): boolean {
  const day = now.getDay()
  const m = hmsToMinutes(now)
  if (day === 0) return false // 周日全天停
  if (day === 6) return m <= 3 * 60 // 周六仅凌晨夜盘
  // 周一到周五
  return (m >= 9 * 60 && m <= 15 * 60 + 30) || m >= 20 * 60 || m <= 3 * 60
}

/**
 * 美股指数（NDX/SPX）：周一 21:30 - 周六 04:00（夏令时近似）
 * 冬令时会顺延 1 小时，这里取夏令时；非交易时段刷新到的是静态值，无副作用。
 */
export function shouldRefreshUSIndex(now = new Date()): boolean {
  const day = now.getDay()
  const m = hmsToMinutes(now)
  if (day === 0) return false
  if (day === 6) return m <= 4 * 60
  return m >= 21 * 60 + 30 || m <= 4 * 60
}

/** 当前是否有任一数据源处于可刷新时段（决定 alarm 用 trading 还是 nonTrading 间隔） */
export function isAnyMarketActive(now = new Date()): boolean {
  return (
    shouldRefreshFund(now) ||
    shouldRefreshAShareMarket(now) ||
    shouldRefreshGold(now) ||
    shouldRefreshUSIndex(now)
  )
}
