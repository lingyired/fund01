import type {AppConfig, AppSettings, FundRecord, MenubarAlign, MenubarLayout, MenubarGroupSide, MenubarGlobalSide, RefreshInterval} from './types'
import {
  DEFAULT_SELECTED_INDICES,
  MAX_SELECTED_INDICES,
} from './types'

/** 刷新间隔默认值（秒）与下限（chrome.alarms 最小 30s） */
export const DEFAULT_REFRESH_INTERVAL: RefreshInterval = {trading: 60, nonTrading: 600}
export const MIN_REFRESH_INTERVAL: RefreshInterval = {trading: 30, nonTrading: 300}

/** 菜单栏展示自定义项默认值（core 导出，UI 与 normalize 共用）：
 * 上行/下行默认系统字体（留空=系统字体）；上行色默认 #ffffff（=未自定义，
 * 桌面端跟随系统菜单栏/任务栏文字色，深浅色自适应）且不加粗，下行默认加粗，
 * 下行涨色 #FF4F44 / 跌色 #34C759 / 平色 #8e8e93。 */
export const MENUBAR_DEFAULTS: {
  topFont: string
  bottomFont: string
  topBold: boolean
  bottomBold: boolean
  topColor: string
  riseColor: string
  fallColor: string
  flatColor: string
  /** 上下行文字水平对齐：0=左对齐(默认) 1=居中 2=右对齐 */
  topAlign: MenubarAlign
  bottomAlign: MenubarAlign
} = {
  topFont: '',
  bottomFont: '',
  topBold: false,
  bottomBold: true,
  topColor: '#ffffff',
  riseColor: '#FF4F44',
  fallColor: '#34C759',
  flatColor: '#8e8e93',
  topAlign: 0,
  bottomAlign: 0,
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

/** 总览实例在 menubarGroupColors 中的固定 key（下划线前缀避免与用户分组名冲突） */
export const MENUBAR_OVERVIEW_KEY = '__overview__'

/** 任务栏外边距默认值（物理像素，仅 tauri Windows 生效；与插件 set_edge_margins 默认一致） */
export const MENUBAR_EDGE_MARGINS_DEFAULT: {left: number; right: number} = {
  left: 0,
  right: 0,
}
/** 任务栏外边距合法区间（物理像素）：上限防误输入撑爆任务栏 */
export const MENUBAR_EDGE_MARGINS_MAX = 2000
/** 任务栏相邻实例间距默认值（物理像素，仅 tauri Windows 生效；与插件 set_margin 默认一致） */
export const MENUBAR_ITEM_MARGIN_DEFAULT = 4
/** 任务栏相邻实例间距合法区间（物理像素）：上限防误输入（间距过大会把分组推出可视区） */
export const MENUBAR_ITEM_MARGIN_MAX = 100

/** 归一化 hex 颜色：仅接受 #rrggbb，非法回落 fallback */
export function normalizeHexColor(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim() : fallback
}

/** 归一化字体族名：trim 后返回（空串=系统字体），非字符串回落 fallback */
export function normalizeFontFamily(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.trim() : fallback
}

export const DEFAULT_CONFIG: AppConfig = {
  settings: {
    refreshInterval: {...DEFAULT_REFRESH_INTERVAL},
    quoteSource: 'fundmnfinfo',
    badgeMode: 'percent',
    holdingsNavPosition: 'top',
    holdingGroups: [],
    holdingGroupOrders: {},
    // 默认全部分组纳入总览（空数组 = 无排除）
    overviewExcludedGroups: [],
    theme: 'system',
    // 隐私模式：popup 金额打码 + 角标/菜单栏/分组详情强制百分比
    privacyMode: false,
    // 静默启动（仅 tauri）：启动不打开设置界面，仅常驻菜单栏
    silentStart: false,
    selectedIndices: [...DEFAULT_SELECTED_INDICES],
    menubarHiddenGroups: [],
    menubarLayout: 0,
    menubarTopFontSize: 7,
    menubarBottomFontSize: 11,
    menubarEqualFontSize: 9,
    menubarShowAmount: false,
    menubarTopFont: MENUBAR_DEFAULTS.topFont,
    menubarBottomFont: MENUBAR_DEFAULTS.bottomFont,
    menubarTopBold: MENUBAR_DEFAULTS.topBold,
    menubarBottomBold: MENUBAR_DEFAULTS.bottomBold,
    menubarTopAlign: MENUBAR_DEFAULTS.topAlign,
    menubarBottomAlign: MENUBAR_DEFAULTS.bottomAlign,
    menubarTopColor: MENUBAR_DEFAULTS.topColor,
    menubarGroupColors: {},
    menubarRiseColor: MENUBAR_DEFAULTS.riseColor,
    menubarFallColor: MENUBAR_DEFAULTS.fallColor,
    menubarFlatColor: MENUBAR_DEFAULTS.flatColor,
    // 任务栏（仅 tauri Windows）：分组默认全部停靠右侧；外边距默认 0；间距默认 4（插件默认）
    menubarGroupSides: {},
    menubarGlobalSide: 'follow',
    menubarItemMargin: MENUBAR_ITEM_MARGIN_DEFAULT,
    menubarEdgeMargins: {...MENUBAR_EDGE_MARGINS_DEFAULT},
    // popup 分组 Tab 收益详情默认开启（两行：分组名 + 当日收益）
    groupTabShowDetail: true,
    groupTabDetailMode: 'percent',
  },
  holdings: {},
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
      // 直接用 allocations，但需清理 NaN/负数；0 份额分组保留
      //（0 金额基金 = 关注/待加仓，视为正常持仓记录，编辑表格可见可加仓，而非幽灵）
      allocations = {}
      for (const [g, s] of Object.entries(raw.allocations)) {
        const shares = Number(s) || 0
        if (shares > 0) allocations[g] = shares
        else if (shares === 0) allocations[g] = 0
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

/** 把一个基金 map 归一化，强制指定 type（用于 holdings 集合） */
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

/** 菜单栏布局默认字号（pt，位置语义）：0=上7/下11，2=等大9/9（与插件原生默认一致） */
const DEFAULT_MENUBAR_FONT: Record<MenubarLayout, readonly [number, number]> = {
  0: [7, 11],
  2: [9, 9],
}

/** 归一化菜单栏布局模式：仅 0|2 合法（1=上大下小已移除，回落 0） */
export function normalizeMenubarLayout(v: unknown): MenubarLayout {
  return v === 2 ? 2 : 0
}

/** 归一化菜单栏文字水平对齐：仅 0|1|2 合法（0=左 1=中 2=右），非法回落 0 */
export function normalizeMenubarAlign(v: unknown): MenubarAlign {
  return v === 1 || v === 2 ? v : 0
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
    // 允许 ''(未分组)、__overview__(总览被 ⌘-拖出) 与有效分组
    if ((key === '' || key === MENUBAR_OVERVIEW_KEY || valid.has(key)) && !next.includes(key)) {
      next.push(key)
    }
  }
  return next
}

/** 归一化不纳入总览的分组：去重保序，仅保留 ''(未分组) 或存在于 holdingGroups 的名字。
 *  默认空数组 = 全部分组纳入总览。 */
export function normalizeOverviewExcludedGroups(
  v: unknown,
  groups: string[],
): string[] {
  if (!Array.isArray(v)) return []
  const valid = new Set(groups)
  const next: string[] = []
  for (const g of v) {
    const key = String(g ?? '').trim()
    if ((key === '' || valid.has(key)) && !next.includes(key)) {
      next.push(key)
    }
  }
  return next
}

/** 归一化各分组自定义上行颜色：仅保留 ''(未分组)、总览或存在于 holdingGroups 的 key，value 校验 hex */
export function normalizeMenubarGroupColors(
  v: unknown,
  groups: string[],
  fallback: string,
): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const valid = new Set(groups)
  const next: Record<string, string> = {}
  for (const [g, color] of Object.entries(v)) {
    const key = String(g ?? '').trim()
    if (key === '' || key === MENUBAR_OVERVIEW_KEY || valid.has(key)) {
      const hex = normalizeHexColor(color, fallback)
      // 只保留合法 hex（normalizeHexColor 非法会回落 fallback，此时视同未配置，跳过）
      if (typeof color === 'string' && hex === color.trim()) next[key] = hex
    }
  }
  return next
}

/** 归一化各任务栏分组停靠侧（仅 tauri Windows）：仅保留 ''(未分组)、总览或存在于
 *  holdingGroups 的 key，value 仅接受 'left'|'right'（非法条目直接丢弃=回落右侧默认） */
export function normalizeMenubarGroupSides(
  v: unknown,
  groups: string[],
): Record<string, MenubarGroupSide> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const valid = new Set(groups)
  const next: Record<string, MenubarGroupSide> = {}
  for (const [g, side] of Object.entries(v as Record<string, unknown>)) {
    const key = String(g ?? '').trim()
    if (key === '' || key === MENUBAR_OVERVIEW_KEY || valid.has(key)) {
      if (side === 'left' || side === 'right') next[key] = side
    }
  }
  return next
}

/** 归一化任务栏外边距（仅 tauri Windows，物理像素）：非负整数，clamp 到 [0, MENUBAR_EDGE_MARGINS_MAX]，
 *  非法回落 0（与插件 set_edge_margins 的 clamp>=0 语义对齐） */
export function normalizeMenubarEdgeMargins(v: unknown): {left: number; right: number} {
  const clamp = (raw: unknown): number => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return 0
    return Math.min(MENUBAR_EDGE_MARGINS_MAX, Math.max(0, Math.floor(n)))
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {...MENUBAR_EDGE_MARGINS_DEFAULT}
  const rec = v as Record<string, unknown>
  return {left: clamp(rec.left), right: clamp(rec.right)}
}

/** 归一化任务栏分组全局停靠覆盖（仅 tauri Windows）：仅接受 'follow'|'left'|'right'，
 *  非法/缺省回落 'follow'（= 跟随各分组停靠侧设置，与 Rust normalize_config 口径一致） */
export function normalizeMenubarGlobalSide(v: unknown): MenubarGlobalSide {
  return v === 'left' || v === 'right' || v === 'follow' ? v : 'follow'
}

/** 归一化任务栏相邻实例间距（仅 tauri Windows，物理像素，默认 4）：非负整数，
 *  clamp 到 [0, MENUBAR_ITEM_MARGIN_MAX]；缺失/非法回落插件默认 4（显式 0 = 贴紧合法） */
export function normalizeMenubarItemMargin(v: unknown): number {
  if (v === undefined || v === null || v === '') return MENUBAR_ITEM_MARGIN_DEFAULT
  const n = Number(v)
  if (!Number.isFinite(n)) return MENUBAR_ITEM_MARGIN_DEFAULT
  return Math.min(MENUBAR_ITEM_MARGIN_MAX, Math.max(0, Math.floor(n)))
}

export function normalizeConfig(payload: LegacyAppConfig | null | undefined): AppConfig {
  // 兼容旧格式：单一 funds map（仅纳入 type='hold' 的持仓；旧自选条目不再迁移）
  const holdings: FundMap = {}

  const legacyFunds =
    payload?.funds && typeof payload.funds === 'object' ? (payload.funds as FundMap) : null
  if (legacyFunds) {
    for (const [key, raw] of Object.entries(legacyFunds)) {
      const code = String(raw?.code || key).padStart(6, '0')
      if (!/^\d{6}$/.test(code)) continue
      if (raw?.type === 'hold') {
        holdings[code] = normalizeFund(
          {...raw, code, type: 'hold'},
          undefined,
          'hold',
        )
      }
    }
  }

  // 新格式：holdings 集合
  Object.assign(holdings, normalizeFundMap(payload?.holdings, 'hold'))

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
      refreshInterval: clampRefreshInterval(payload?.settings?.refreshInterval),
      quoteSource:
        payload?.settings?.quoteSource === 'fund123'
          ? 'fund123'
          : payload?.settings?.quoteSource === 'xiaobei'
            ? 'xiaobei'
            : 'fundmnfinfo',
      badgeMode:
        payload?.settings?.badgeMode === 'amount' ||
        payload?.settings?.badgeMode === 'hidden'
          ? payload.settings.badgeMode
          : DEFAULT_CONFIG.settings.badgeMode,
      holdingsNavPosition:
        payload?.settings?.holdingsNavPosition === 'side'
          ? 'side'
          : DEFAULT_CONFIG.settings.holdingsNavPosition,
      holdingGroups,
      holdingGroupOrders,
      overviewExcludedGroups: normalizeOverviewExcludedGroups(
        payload?.settings?.overviewExcludedGroups,
        holdingGroups,
      ),
      theme:
        payload?.settings?.theme === 'light' ||
        payload?.settings?.theme === 'dark' ||
        payload?.settings?.theme === 'system'
          ? payload.settings.theme
          : DEFAULT_CONFIG.settings.theme,
      privacyMode:
        typeof payload?.settings?.privacyMode === 'boolean'
          ? payload.settings.privacyMode
          : DEFAULT_CONFIG.settings.privacyMode,
      silentStart:
        typeof payload?.settings?.silentStart === 'boolean'
          ? payload.settings.silentStart
          : DEFAULT_CONFIG.settings.silentStart,
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
      menubarShowAmount:
        typeof payload?.settings?.menubarShowAmount === 'boolean'
          ? payload.settings.menubarShowAmount
          : DEFAULT_CONFIG.settings.menubarShowAmount,
      menubarTopFont: normalizeFontFamily(
        payload?.settings?.menubarTopFont,
        MENUBAR_DEFAULTS.topFont,
      ),
      menubarBottomFont: normalizeFontFamily(
        payload?.settings?.menubarBottomFont,
        MENUBAR_DEFAULTS.bottomFont,
      ),
      menubarTopBold:
        typeof payload?.settings?.menubarTopBold === 'boolean'
          ? payload.settings.menubarTopBold
          : MENUBAR_DEFAULTS.topBold,
      menubarBottomBold:
        typeof payload?.settings?.menubarBottomBold === 'boolean'
          ? payload.settings.menubarBottomBold
          : MENUBAR_DEFAULTS.bottomBold,
      menubarTopAlign: normalizeMenubarAlign(payload?.settings?.menubarTopAlign),
      menubarBottomAlign: normalizeMenubarAlign(payload?.settings?.menubarBottomAlign),
      menubarTopColor: normalizeHexColor(
        payload?.settings?.menubarTopColor,
        MENUBAR_DEFAULTS.topColor,
      ),
      menubarGroupColors: normalizeMenubarGroupColors(
        payload?.settings?.menubarGroupColors,
        holdingGroups,
        MENUBAR_DEFAULTS.topColor,
      ),
      menubarRiseColor: normalizeHexColor(
        payload?.settings?.menubarRiseColor,
        MENUBAR_DEFAULTS.riseColor,
      ),
      menubarFallColor: normalizeHexColor(
        payload?.settings?.menubarFallColor,
        MENUBAR_DEFAULTS.fallColor,
      ),
      menubarFlatColor: normalizeHexColor(
        payload?.settings?.menubarFlatColor,
        MENUBAR_DEFAULTS.flatColor,
      ),
      // 任务栏（仅 tauri Windows）：停靠侧与外边距；其他平台忽略
      menubarGroupSides: normalizeMenubarGroupSides(
        payload?.settings?.menubarGroupSides,
        holdingGroups,
      ),
      menubarEdgeMargins: normalizeMenubarEdgeMargins(
        payload?.settings?.menubarEdgeMargins,
      ),
      // popup 分组 Tab 收益详情：默认开启（true）；旧配置缺失时回落默认
      groupTabShowDetail:
        typeof payload?.settings?.groupTabShowDetail === 'boolean'
          ? payload.settings.groupTabShowDetail
          : DEFAULT_CONFIG.settings.groupTabShowDetail,
      groupTabDetailMode:
        payload?.settings?.groupTabDetailMode === 'amount'
          ? 'amount'
          : DEFAULT_CONFIG.settings.groupTabDetailMode,
    },
    holdings,
  }
}
