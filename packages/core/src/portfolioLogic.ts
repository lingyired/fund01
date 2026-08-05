import type {AppConfig, AppSettings, FundRecord, MenubarLayout, RefreshInterval} from './types'
import {
  DEFAULT_SELECTED_INDICES,
  MAX_SELECTED_INDICES,
} from './types'

/** 刷新间隔默认值（秒）与下限（chrome.alarms 最小 30s） */
export const DEFAULT_REFRESH_INTERVAL: RefreshInterval = {trading: 60, nonTrading: 600}
export const MIN_REFRESH_INTERVAL: RefreshInterval = {trading: 30, nonTrading: 300}

export const DEFAULT_CONFIG: AppConfig = {
  settings: {
    showGold: true,
    refreshInterval: {...DEFAULT_REFRESH_INTERVAL},
    quoteSource: 'fundmnfinfo',
    badgeMode: 'percent',
    holdingGroups: [],
    theme: 'system',
    selectedIndices: [...DEFAULT_SELECTED_INDICES],
    menubarHiddenGroups: [],
    menubarLayout: 0,
    menubarTopFontSize: 7,
    menubarBottomFontSize: 12,
    menubarEqualFontSize: 9,
  },
  holdings: {},
  watchlist: {},
  gold: {holding: 0, avgPrice: 0},
}

/** 把用户配置的刷新间隔夹到合法区间 */
export function clampRefreshInterval(raw: any): RefreshInterval {
  const trading = Math.max(
    MIN_REFRESH_INTERVAL.trading,
    Math.floor(Number(raw?.trading)) || DEFAULT_REFRESH_INTERVAL.trading,
  )
  const nonTrading = Math.max(
    MIN_REFRESH_INTERVAL.nonTrading,
    Math.floor(Number(raw?.nonTrading)) || DEFAULT_REFRESH_INTERVAL.nonTrading,
  )
  return {trading, nonTrading}
}

export function normalizeFund(
  raw: Partial<FundRecord> & {code: string},
  prev: FundRecord | undefined,
  fallbackType: 'hold' | 'watch',
): FundRecord {
  const code = String(raw.code || '').padStart(6, '0')
  const now = new Date().toISOString()
  // allocations 仅对持仓有意义；自选强制为空对象
  // 兼容旧版字段：shares+group / shares+groups → allocations
  let allocations: Record<string, number> | undefined
  if (fallbackType === 'hold') {
    if (raw.allocations && typeof raw.allocations === 'object') {
      // 直接用 allocations，但需清理 NaN/负数
      allocations = {}
      for (const [g, s] of Object.entries(raw.allocations)) {
        const shares = Number(s) || 0
        if (shares > 0) allocations[g] = shares
      }
    } else if (prev?.allocations && Object.keys(prev.allocations).length) {
      allocations = {...prev.allocations}
    } else {
      // 旧版兼容：shares + group/groups
      const oldShares = Number(raw.shares ?? prev?.shares ?? 0) || 0
      if (oldShares > 0) {
        const groups =
          (Array.isArray(raw.groups) ? raw.groups : undefined) ||
          (typeof raw.group === 'string' ? (raw.group ? [raw.group] : ['']) : undefined) ||
          (Array.isArray(prev?.groups) ? prev!.groups : undefined) ||
          (prev?.group != null ? [prev.group] : [''])
        allocations = {}
        // 旧模型份额是一份，放到第一个分组（或未分组）
        const g = String(groups[0] ?? '').trim()
        allocations[g] = oldShares
      }
    }
  } else {
    allocations = {}
  }
  if (!allocations) allocations = {}
  // costs：与 allocations 同 key 的持仓成本；清理无效值 + 清理已无 allocation 的 key
  let costs: Record<string, number> | undefined
  if (fallbackType === 'hold') {
    const rawCosts =
      raw.costs && typeof raw.costs === 'object'
        ? (raw.costs as Record<string, number>)
        : prev?.costs
    if (rawCosts && typeof rawCosts === 'object') {
      const cleaned: Record<string, number> = {}
      for (const [g, c] of Object.entries(rawCosts)) {
        // 仅保留对应 allocation 仍存在且 cost>0 的项
        if (allocations[g] != null && Number(c) > 0) {
          cleaned[g] = Number(c) || 0
        }
      }
      if (Object.keys(cleaned).length) costs = cleaned
    }
  }
  return {
    code,
    name: raw.name ?? prev?.name ?? code,
    fundKey: raw.fundKey ?? prev?.fundKey ?? '',
    type:
      raw.type === 'hold' || raw.type === 'watch'
        ? raw.type
        : prev?.type || fallbackType,
    allocations,
    costs,
    sectors: Array.isArray(raw.sectors) ? raw.sectors : prev?.sectors || [],
    createdAt: prev?.createdAt || raw.createdAt || now,
    updatedAt: now,
  }
}

type FundMap = Record<string, FundRecord>

/** 把一个基金 map 归一化，强制指定 type（用于 holdings/watchlist 两个独立集合） */
export function normalizeFundMap(
  source: any,
  fallbackType: 'hold' | 'watch',
): FundMap {
  const out: FundMap = {}
  if (!source || typeof source !== 'object') return out
  for (const [key, raw] of Object.entries(source) as [string, any][]) {
    const code = String(raw?.code || key).padStart(6, '0')
    if (!/^\d{6}$/.test(code)) continue
    out[code] = normalizeFund({...raw, code, type: fallbackType}, undefined, fallbackType)
  }
  return out
}

/** 兼容旧版含 funds 字段的配置（导入旧导出文件时使用） */
export type LegacyAppConfig = Partial<AppConfig> & {funds?: Record<string, FundRecord>}

/** 菜单栏各布局模式的字号范围（pt，位置语义）：0=下大上小 上7-10/下10-14；2=等大 8-11
 *  （等大上限 11 受插件 v1.2.0 原生 equal clamp 限制，勿改插件） */
export const MENUBAR_FONT_RANGES: Record<
  MenubarLayout,
  {top: readonly [number, number]; bottom: readonly [number, number]}
> = {
  0: {top: [7, 10], bottom: [10, 14]},
  2: {top: [8, 11], bottom: [8, 11]},
}

/** 菜单栏布局默认字号（pt，位置语义）：0=上7/下12，2=等大9/9（与插件原生默认一致） */
const DEFAULT_MENUBAR_FONT: Record<MenubarLayout, readonly [number, number]> = {
  0: [7, 12],
  2: [9, 9],
}

/** 归一化菜单栏布局模式：仅 0|2 合法（1=上大下小已移除，回落 0） */
export function normalizeMenubarLayout(v: unknown): MenubarLayout {
  return v === 2 ? 2 : 0
}

/** 归一化菜单栏字号：clamp 到布局对应范围，非法值回落 fallback */
export function normalizeMenubarFontSize(
  v: unknown,
  fallback: number,
  range: readonly [number, number],
): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0
    ? Math.min(range[1], Math.max(range[0], n))
    : fallback
}

/** 归一化菜单栏隐藏分组：去重保序，仅保留 ''(未分组) 或存在于 holdingGroups 的名字 */
export function normalizeMenubarHiddenGroups(
  v: unknown,
  groups: string[],
): string[] {
  if (!Array.isArray(v)) return []
  const valid = new Set(groups)
  const next: string[] = []
  for (const g of v) {
    const key = String(g ?? '').trim()
    if ((key === '' || valid.has(key)) && !next.includes(key)) next.push(key)
  }
  return next
}

export function normalizeConfig(payload: LegacyAppConfig | null | undefined): AppConfig {
  // 兼容旧格式：单一 funds map（按 type 字段拆分到 holdings / watchlist）
  const holdings: FundMap = {}
  const watchlist: FundMap = {}

  const legacyFunds =
    payload?.funds && typeof payload.funds === 'object' ? (payload.funds as FundMap) : null
  if (legacyFunds) {
    for (const [key, raw] of Object.entries(legacyFunds)) {
      const code = String(raw?.code || key).padStart(6, '0')
      if (!/^\d{6}$/.test(code)) continue
      const type: 'hold' | 'watch' = raw?.type === 'hold' ? 'hold' : 'watch'
      ;(type === 'hold' ? holdings : watchlist)[code] = normalizeFund(
        {...raw, code, type},
        undefined,
        type,
      )
    }
  }

  // 新格式：holdings / watchlist 两个独立集合（覆盖旧格式同名条目）
  Object.assign(holdings, normalizeFundMap(payload?.holdings, 'hold'))
  Object.assign(watchlist, normalizeFundMap(payload?.watchlist, 'watch'))

  // 归一化 holdingGroups：去重 + 去空白 + 保序
  const holdingGroups: string[] = []
  if (Array.isArray(payload?.settings?.holdingGroups)) {
    for (const g of payload!.settings!.holdingGroups) {
      const name = String(g ?? '').trim()
      if (name && !holdingGroups.includes(name)) holdingGroups.push(name)
    }
  }

  // 归一化 holdingGroupOrders：仅保留有效分组 + 6 位 code
  const holdingGroupOrders: Record<string, string[]> = {}
  const rawOrders = (payload?.settings?.holdingGroupOrders || {}) as Record<
    string,
    unknown
  >
  for (const [g, list] of Object.entries(rawOrders)) {
    if (!Array.isArray(list)) continue
    const cleaned = list
      .map((c) => String(c ?? '').padStart(6, '0'))
      .filter((c) => /^\d{6}$/.test(c))
    if (cleaned.length) holdingGroupOrders[g] = Array.from(new Set(cleaned))
  }

  return {
    settings: {
      showGold:
        typeof payload?.settings?.showGold === 'boolean'
          ? payload.settings.showGold
          : DEFAULT_CONFIG.settings.showGold,
      refreshInterval: clampRefreshInterval(payload?.settings?.refreshInterval),
      quoteSource:
        payload?.settings?.quoteSource === 'fund123' ? 'fund123' : 'fundmnfinfo',
      badgeMode:
        payload?.settings?.badgeMode === 'amount' ||
        payload?.settings?.badgeMode === 'hidden'
          ? payload.settings.badgeMode
          : DEFAULT_CONFIG.settings.badgeMode,
      holdingGroups,
      holdingGroupOrders,
      theme:
        payload?.settings?.theme === 'light' ||
        payload?.settings?.theme === 'dark' ||
        payload?.settings?.theme === 'system'
          ? payload.settings.theme
          : DEFAULT_CONFIG.settings.theme,
      selectedIndices:
        Array.isArray(payload?.settings?.selectedIndices) &&
        payload!.settings!.selectedIndices!.length > 0
          ? Array.from(
              new Set(
                payload!.settings!.selectedIndices!
                  .map((c) => String(c ?? '').trim())
                  .filter(Boolean),
              ),
            ).slice(0, MAX_SELECTED_INDICES)
          : [...DEFAULT_CONFIG.settings.selectedIndices!],
      menubarHiddenGroups: normalizeMenubarHiddenGroups(
        payload?.settings?.menubarHiddenGroups,
        holdingGroups,
      ),
      menubarLayout: normalizeMenubarLayout(payload?.settings?.menubarLayout),
      menubarTopFontSize: normalizeMenubarFontSize(
        payload?.settings?.menubarTopFontSize,
        DEFAULT_MENUBAR_FONT[normalizeMenubarLayout(payload?.settings?.menubarLayout)][0],
        MENUBAR_FONT_RANGES[normalizeMenubarLayout(payload?.settings?.menubarLayout)].top,
      ),
      menubarBottomFontSize: normalizeMenubarFontSize(
        payload?.settings?.menubarBottomFontSize,
        DEFAULT_MENUBAR_FONT[normalizeMenubarLayout(payload?.settings?.menubarLayout)][1],
        MENUBAR_FONT_RANGES[normalizeMenubarLayout(payload?.settings?.menubarLayout)].bottom,
      ),
      menubarEqualFontSize: normalizeMenubarFontSize(
        payload?.settings?.menubarEqualFontSize,
        DEFAULT_MENUBAR_FONT[2][0],
        MENUBAR_FONT_RANGES[2].top,
      ),
    },
    holdings,
    watchlist,
    gold: {
      holding: Number(payload?.gold?.holding ?? 0) || 0,
      avgPrice: Number(payload?.gold?.avgPrice ?? 0) || 0,
    },
  }
}
