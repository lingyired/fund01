import type {BadgeMode} from './types'

/** 角标文本最大长度（chrome 角标空间有限，尽量塞进 4 个字符） */
export const MAX_BADGE_LEN = 4

/** 涨红跌绿（中国习惯）：盈利/上涨用红，亏损/下跌用绿 */
const BADGE_RISE = '#dc2626'
const BADGE_FALL = '#16a34a'

export type BadgeComputed = {
  /** 角标文本；空字符串表示隐藏角标 */
  text: string
  /** 角标背景色 */
  color: string
}

/**
 * 收益额简化格式：
 * - 超过 1 千 → k（thousand）
 * - 超过 1 万 → w（万）
 * - 超过 1 千万 → kw（千万）
 * 有小数时只保留 1 位；数据量大（放不下）时去掉小数。
 * 整体长度尽量不超过 MAX_BADGE_LEN（4 位）。
 * 方向由角标颜色表达，故文本不附带正负号。
 */
export function formatBadgeAmount(value: number): string {
  const abs = Math.abs(Number.isFinite(value) ? value : 0)
  let unit = ''
  let n = abs
  if (abs >= 1e7) {
    n = abs / 1e7
    unit = 'kw'
  } else if (abs >= 1e4) {
    n = abs / 1e4
    unit = 'w'
  } else if (abs >= 1e3) {
    n = abs / 1e3
    unit = 'k'
  }
  // 整数（缩放后）直接用 0 位小数；非整数优先 1 位小数，放不下再去小数
  const isInt = Math.abs(n - Math.round(n)) < 1e-9
  const decimals = isInt ? [0] : [1, 0]
  for (const d of decimals) {
    const s = n.toFixed(d)
    if ((s + unit).length <= MAX_BADGE_LEN) return s + unit
  }
  return Math.round(n).toString() + unit
}

/**
 * 百分比格式：去掉方向符与百分号，仅保留数值。
 * 优先 2 位小数；超过 MAX_BADGE_LEN（4 位）时逐级降精度（1 位 / 0 位）。
 * 方向由角标颜色表达，故文本不附带正负号。
 */
export function formatBadgePercent(value: number): string {
  const abs = Math.abs(Number.isFinite(value) ? value : 0)
  for (const d of [2, 1, 0]) {
    const s = abs.toFixed(d)
    if (s.length <= MAX_BADGE_LEN) return s
  }
  return Math.round(abs).toString()
}

/**
 * 根据显示模式计算角标文本与背景色。
 * - hidden：返回空文本（chrome 会隐藏角标）
 * - amount：显示持仓总收益额（简化格式化）
 * - percent（默认）：显示持仓总收益率（去方向符与百分号）
 */
export function computeBadge(params: {
  mode: BadgeMode
  totalPnlPercent: number
  totalPnl: number
}): BadgeComputed {
  const {mode, totalPnlPercent, totalPnl} = params
  if (mode === 'hidden') {
    return {text: '', color: BADGE_FALL}
  }
  if (mode === 'amount') {
    return {
      text: formatBadgeAmount(totalPnl),
      color: totalPnl >= 0 ? BADGE_RISE : BADGE_FALL,
    }
  }
  // percent（默认）
  return {
    text: formatBadgePercent(totalPnlPercent),
    color: totalPnlPercent >= 0 ? BADGE_RISE : BADGE_FALL,
  }
}
