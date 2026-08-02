import type {BadgeMode} from './types'
import {formatShortAmount, formatShortPercent, DEFAULT_SHORT_LEN} from './format'

/** 角标文本最大长度（chrome 角标空间有限，尽量塞进 4 个字符） */
export const MAX_BADGE_LEN = DEFAULT_SHORT_LEN

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
 * 根据显示模式计算角标文本与背景色。
 * - hidden：返回空文本（chrome 会隐藏角标）
 * - amount：显示持仓总收益额（简化格式化）
 * - percent（默认）：显示持仓总收益率（去方向符与百分号）
 *
 * 纯格式化逻辑见 ./format（formatShortAmount / formatShortPercent），本模块只负责
 * 「模式选择 + 涨跌配色」，与 chrome 角标 API 解耦，便于其它端（如 tauri）复用格式化。
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
      text: formatShortAmount(totalPnl),
      color: totalPnl >= 0 ? BADGE_RISE : BADGE_FALL,
    }
  }
  // percent（默认）
  return {
    text: formatShortPercent(totalPnlPercent),
    color: totalPnlPercent >= 0 ? BADGE_RISE : BADGE_FALL,
  }
}
