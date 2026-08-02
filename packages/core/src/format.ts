/**
 * 紧凑数字格式化（纯函数，无 chrome / 配置依赖，可被 tauri 等任意前端复用）
 *
 * 设计原则：
 * - 只做「数字 → 短字符串」，不关心业务语义、颜色或正负号；方向交给调用方用颜色/符号表达。
 * - 默认最大长度 4 位，适配 chrome 角标、系统托盘图标等狭小空间；可通过 maxLen 调整。
 */

/** 紧凑格式化的默认最大长度 */
export const DEFAULT_SHORT_LEN = 4

/**
 * 金额类数值的简化格式：
 * - 超过 1 千 → k（thousand）
 * - 超过 1 万 → w（万）
 * - 超过 1 千万 → kw（千万）
 * 有小数时只保留 1 位；放不下时去掉小数。整体长度尽量不超过 maxLen。
 * 取绝对值，不附带正负号（符号由调用方决定）。
 */
export function formatShortAmount(value: number, maxLen: number = DEFAULT_SHORT_LEN): string {
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
    if ((s + unit).length <= maxLen) return s + unit
  }
  return Math.round(n).toString() + unit
}

/**
 * 百分比数值的简化格式：去掉方向符与百分号，仅保留数值。
 * 优先 2 位小数；超过 maxLen 时逐级降精度（1 位 / 0 位）。
 * 取绝对值，不附带正负号（符号由调用方决定）。
 */
export function formatShortPercent(value: number, maxLen: number = DEFAULT_SHORT_LEN): string {
  const abs = Math.abs(Number.isFinite(value) ? value : 0)
  for (const d of [2, 1, 0]) {
    const s = abs.toFixed(d)
    if (s.length <= maxLen) return s
  }
  return Math.round(abs).toString()
}
