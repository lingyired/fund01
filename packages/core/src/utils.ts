import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function pctClass(v: number | null | undefined) {
  if (v == null || Number.isNaN(v)) return 'flat';
  if (v > 0) return 'rise';
  if (v < 0) return 'fall';
  return 'flat';
}

export function formatPct(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return '--';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

/** 金额/收益：不使用千分位逗号 */
export function formatMoney(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return '--';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}`;
}

/** 持仓金额等：不使用千分位逗号 */
export function formatAmount(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return '--';
  return v.toFixed(digits);
}
