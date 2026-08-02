export type ClassValue = string | number | null | false | undefined | ClassValue[] | Record<string, boolean | null | undefined>;

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === 'string' || typeof input === 'number') {
      out.push(String(input));
    } else if (Array.isArray(input)) {
      const s = cn(...input);
      if (s) out.push(s);
    } else if (typeof input === 'object') {
      for (const key of Object.keys(input)) {
        if ((input as Record<string, boolean | null | undefined>)[key]) out.push(key);
      }
    }
  }
  return out.join(' ');
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
