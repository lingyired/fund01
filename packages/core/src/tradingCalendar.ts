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
 * 晚间已拉到官方确认涨跌：展示「已更新」；两类基金均保留到「锚点日的下一交易日」开盘后抹去：
 * - 普通基金：锚点 = 净值日（当天披露）→ 净值日下一交易日开盘后清除（周末照常显示）。
 * - QDII（T+1 披露，净值日=昨天）：锚点 = 披露日（净值日的下一交易日，即用户看到该净值
 *   的日子），与普通基金的净值日同义 → 披露日的下一交易日开盘后清除（周末照常显示）。
 * 与 isConfirmedSessionActive 的 delayed 分支保持一致。
 */
export function shouldShowConfirmedUpdatedBadge(
  quote: {
    percentSource?: 'estimate' | 'confirmed' | null
    netValueDate?: string | null
    isQdii?: boolean
  },
  now = new Date(),
): boolean {
  if (quote.percentSource !== 'confirmed') return false
  const navDay = normalizeNetValueDate(quote.netValueDate, now)
  if (!navDay) return false
  const anchor = quote.isQdii ? nextTradingDay(navDay) : navDay
  const next = nextTradingDay(anchor)
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
 * - A 股交易日 09:00-15:30（盘中估值，FundMNFInfo 返回 GSZ；09:00 起与黄金日盘
 *   对齐，避免 09:00-09:15 定时器空转——开盘前拉到的是静态数据，无副作用）
 * - A 股交易日 15:30-20:00（空窗期，FundMNFInfo 停止返回 GSZ；用重仓股自算估值
 *   覆盖今日估算收益，并轮询检测官方净值披露）
 * - A 股交易日 20:00-23:00（晚间官方确认涨跌更新）
 */
export function shouldRefreshFund(now = new Date()): boolean {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const m = hmsToMinutes(now)
  return m >= 9 * 60 && m <= 23 * 60
}

/** A 股指数 / 大盘（涨跌家数、板块排行）：交易日 09:00-15:30（09:00 起覆盖黄金 AU9999 日盘 09:00 开盘，避免 09:00-09:15 空窗） */
export function shouldRefreshAShareMarket(now = new Date()): boolean {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const m = hmsToMinutes(now)
  return m >= 9 * 60 && m <= 15 * 60 + 30
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
 * 距下一个「时段状态翻转」的秒数（定时器准点切换用）。
 *
 * 背景：Chrome alarm / Tauri 循环都是「睡满当前档位周期 → 醒来重判档位」，
 * 非交易档（600s）最后一次触发若落在开盘前，切换会滞后近一个周期。
 * 本函数从 now 起逐分钟扫描（上限 48 小时，覆盖周末），找到第一个
 * `isActiveFn(t) != currentActive` 的时刻，返回距它的秒数；无翻转返回 null。
 * 调用方据此在「切换点比下一周期更近」时先睡到切换点，到点后重判档位。
 * 分钟粒度近似：醒来后一律按真实时间重判，误差无实际影响。
 */
export function secondsUntilNextSwitch(
  currentActive: boolean,
  isActiveFn: (d: Date) => boolean,
  now = new Date(),
): number | null {
  const stepMs = 60_000
  const limit = now.getTime() + 48 * 3_600_000
  for (let t = now.getTime() + stepMs; t <= limit; t += stepMs) {
    if (isActiveFn(new Date(t)) !== currentActive) {
      return Math.max(1, Math.round((t - now.getTime()) / 1000))
    }
  }
  return null
}

/**
 * 延迟披露基金（QDII/海外）：净值 T+1/T+2 披露。判定与 isQdiiName 一致
 * （证监会强制 QDII 基金名含 "QDII"；后续可扩展 FTYPE 双通道）。
 * 识别出的基金在 `isConfirmedSessionActive` 中走 delayed 分支：锚点从「净值日」前移
 * 到「披露日」（净值日的下一交易日），披露日与普通基金净值日同义 —— 披露后一直保留
 * 到披露日的下一交易日开盘前（周末照常显示），开盘后恢复盘中口径。
 */
export function isDelayedNavFund(name: string): boolean {
  return /QDII/i.test(String(name || ''))
}

/**
 * 确认会话：锚点日的下一交易日尚未开盘（09:15 前）。非延迟披露基金（境内）用它：
 * PDATE=今天（当晚披露）→ 锚点=今天 → next=明天 > today → 已确认；PDATE=昨天（盘中）→
 * 锚点=昨天 → next=今天已开盘 → 未确认（走盘中估算）。
 *
 * `delayedDisclosure=true`（QDII/海外，净值 T+1 披露）：锚点 = 披露日（PDATE 的下一
 * 交易日，T+1：今天披露昨天净值）——把披露日当作普通基金的「净值日」处理：披露后
 * 保留到披露日的下一交易日开盘前，周末照常显示「已更新」。如 08-06 净值 08-07 披露 →
 * 锚点 08-07 → 08-07 ~ 08-10 开盘前均确认（周末显示）；08-10 开盘后恢复盘中口径。
 */
export function isConfirmedSessionActive(
  navDayRaw: any,
  now = new Date(),
  delayedDisclosure = false,
): boolean {
  const navDay = normalizeNetValueDate(navDayRaw, now)
  if (!navDay) return false
  const anchor = delayedDisclosure ? nextTradingDay(navDay) : navDay
  const next = nextTradingDay(anchor)
  return !isTradingDayStarted(next, now)
}
