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
 * - A 股交易日 09:15-15:30（盘中估值，FundMNFInfo 返回 GSZ）
 * - A 股交易日 15:30-20:00（空窗期，FundMNFInfo 停止返回 GSZ；用重仓股自算估值
 *   覆盖今日估算收益，并轮询检测官方净值披露）
 * - A 股交易日 20:00-23:00（晚间官方确认涨跌更新）
 */
export function shouldRefreshFund(now = new Date()): boolean {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const m = hmsToMinutes(now)
  return m >= 9 * 60 + 15 && m <= 23 * 60
}

/** A 股指数 / 大盘（涨跌家数、板块排行）：仅交易日 09:15-15:30 */
export function shouldRefreshAShareMarket(now = new Date()): boolean {
  return isAShareTradingTime(now)
}

/** 黄金 AU9999 日盘：周一至周五 09:00-15:30（归日盘循环） */
export function isGoldDaySession(now = new Date()): boolean {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const m = hmsToMinutes(now)
  return m >= 9 * 60 && m <= 15 * 60 + 30
}

/**
 * 黄金 AU9999 夜盘：周一 20:00 - 周六 03:00（归夜盘循环；周一凌晨 0-3 点按原语义保留）
 * 周日全天停；周六仅凌晨夜盘
 */
export function isGoldNightSession(now = new Date()): boolean {
  const day = now.getDay()
  const m = hmsToMinutes(now)
  if (day === 0) return false
  if (day === 6) return m <= 3 * 60
  return m >= 20 * 60 || m <= 3 * 60
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

/** 日盘市场活跃（决定日盘循环档位）：黄金日盘 09:00 或 A 股盘中 09:15 起，至 15:30 */
export function isDayMarketActive(now = new Date()): boolean {
  return isGoldDaySession(now) || isAShareTradingTime(now)
}

/** 夜盘市场活跃（决定夜盘循环档位）：黄金夜盘 20:00 或 美股 21:30 起，至次日 04:00 */
export function isNightMarketActive(now = new Date()): boolean {
  return isGoldNightSession(now) || shouldRefreshUSIndex(now)
}

/**
 * 延迟披露基金（QDII/海外）：净值 T+1/T+2 披露。判定与 isQdiiName 一致
 * （证监会强制 QDII 基金名含 "QDII"；后续可扩展 FTYPE 双通道）。
 * 识别出的基金在 `isConfirmedSessionActive` 中走「披露日窗口」（delayedDisclosure）：
 * 披露日（PDATE 下一交易日）≥ 今天 才算「今日已更新」，其他情况保持 `-`。
 */
export function isDelayedNavFund(name: string): boolean {
  return /QDII/i.test(String(name || ''))
}

/**
 * 确认会话：净值日的下一交易日尚未开盘（09:15 前）。非延迟披露基金（境内）用它：
 * PDATE=今天（当晚披露）→ next=明天 > today → 已确认；PDATE=昨天（盘中）→
 * next=今天已开盘 → 未确认（走盘中估算）。
 *
 * `delayedDisclosure=true`（QDII/海外，净值 T+1 披露）：改用「披露日窗口」——
 * QDII 的披露日 = PDATE 的下一交易日（T+1：今天披露昨天净值）。**披露日 ≥ 今天
 * 才算「今日已更新」**（今天披露或未来披露都算，如周一披露上周五净值）：
 * `nextTradingDay(PDATE) >= today`。这样 08-06 净值今天披露 → 显示；08-05 净值
 * 昨天披露（今天无更新）→ 不显示（保持 `-`）——严格匹配用户语义「只有真正的当日
 * 收益更新之后（不管净值是哪一天）才显示，否则都是 `-`」。
 */
export function isConfirmedSessionActive(
  navDayRaw: any,
  now = new Date(),
  delayedDisclosure = false,
): boolean {
  const navDay = normalizeNetValueDate(navDayRaw, now)
  if (!navDay) return false
  if (delayedDisclosure) {
    const next = nextTradingDay(navDay)
    return next >= todayDateStr(now)
  }
  const next = nextTradingDay(navDay)
  const today = todayDateStr(now)
  if (today > next) return false
  if (today < next) return true
  const minutes = now.getHours() * 60 + now.getMinutes()
  return minutes < 9 * 60 + 15
}
