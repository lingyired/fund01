// 配置操作封装：把原 api.ts / portfolioStore.ts 中基于 localStorage + SW 消息的逻辑
// 改造为基于 ConfigPort（同步读缓存 + 异步推后端）+ DataPort（resolveFund 等）的实现。
// 业务规则（份额反推、成本反推、分组维护、归一化）与原实现保持一致。

import type {
  AppConfig,
  AppSettings,
  FundRecord,
  Ports,
  ResolveFundPayload,
} from '@fund01/core'
import {
  clampRefreshInterval,
  normalizeConfig,
  normalizeFund,
} from '@fund01/core'

/** 录入金额对应哪一版确认净值市值 */
export type AmountBasis = 'prev' | 'today'

function sharesFromAmount(amount: number, netValue?: number | null): number {
  if (!(amount > 0) || !(netValue != null && netValue > 0)) return 0
  return Math.round((amount / netValue) * 10000) / 10000
}

function deriveHoldShares(
  amount: number,
  basis: AmountBasis,
  meta: ResolveFundPayload,
): number {
  if (!(amount > 0)) return 0
  if (basis === 'today') {
    if (!meta.confirmedSession) {
      throw new Error('今日净值尚未确认，请改选「昨日结算」，或等确认净值出来后再试')
    }
    if (!(meta.netValue != null && meta.netValue > 0)) {
      throw new Error('暂无今日确认净值，请稍后重试')
    }
    return sharesFromAmount(amount, meta.netValue)
  }
  const nav =
    meta.prevNetValue != null && meta.prevNetValue > 0 ? meta.prevNetValue : meta.netValue
  if (!(nav != null && nav > 0)) {
    throw new Error('暂无确认净值，无法按金额反推份额，请稍后重试')
  }
  return sharesFromAmount(amount, nav)
}

/** 内部：upsert 一条基金记录（归一化后写回配置） */
function upsertFund(
  ports: Ports,
  payload: Partial<FundRecord> & {code: string},
): FundRecord {
  const config = ports.config.getConfig()
  const code = String(payload.code).padStart(6, '0')
  if (!/^\d{6}$/.test(code)) throw new Error('基金代码须为6位数字')
  const type: 'hold' | 'watch' = payload.type === 'hold' ? 'hold' : 'watch'
  const prev = type === 'hold' ? config.holdings[code] : config.watchlist[code]
  const next = normalizeFund({...payload, code, type}, prev, type)
  if (type === 'hold') config.holdings[code] = next
  else config.watchlist[code] = next
  ports.config.saveConfig(config)
  return next
}

/** 内部：更新一条基金记录（合并 patch 后归一化写回） */
function patchFund(
  ports: Ports,
  code: string,
  patch: Partial<FundRecord>,
  type: 'hold' | 'watch',
): FundRecord {
  const config = ports.config.getConfig()
  const key = String(code).padStart(6, '0')
  const map = type === 'hold' ? config.holdings : config.watchlist
  const prev = map[key]
  if (!prev) throw new Error('基金不存在')
  const next = normalizeFund({...prev, ...patch, code: key, type}, prev, type)
  map[key] = next
  ports.config.saveConfig(config)
  return next
}

export async function createFund(
  ports: Ports,
  payload: Partial<FundRecord> & {
    code: string
    amount?: number
    amountBasis?: AmountBasis
    /** 持仓分组（仅 hold 有效；空字符串=未分组） */
    group?: string
    /** 该分组的持仓成本单价（元/份，可选） */
    cost?: number
    /** 累计收益（元，可选；用于反推成本单价） */
    holdProfit?: number
  },
): Promise<FundRecord> {
  const meta = await ports.data.resolveFund(payload.code)
  const amount = payload.amount ?? 0
  const basis: AmountBasis = payload.amountBasis === 'today' ? 'today' : 'prev'

  let shares = 0
  if (payload.type === 'hold') {
    shares = deriveHoldShares(amount, basis, meta)
  }

  if (payload.type === 'hold') {
    // 持仓：合并 prev 的其他分组 allocation/cost，覆盖/设置当前分组份额与成本单价
    const group = payload.group ?? ''
    const prev = ports.config.getConfig().holdings[meta.code]
    const prevAllocations = prev?.allocations || {}
    const allocations = {...prevAllocations, [group]: shares}
    // 成本单价优先级：显式 cost > holdProfit 反推 > 保留 prev
    const prevCosts = prev?.costs || {}
    let costs = prevCosts
    if (payload.cost != null && payload.cost > 0) {
      costs = {...prevCosts, [group]: Number(payload.cost) || 0}
    } else if (
      payload.holdProfit != null &&
      Number.isFinite(payload.holdProfit) &&
      shares > 0
    ) {
      // 总成本 = 市值 - 累计收益；成本单价 = 总成本 / 份额
      const totalCost = amount - Number(payload.holdProfit)
      const price = Math.round((totalCost / shares) * 1e6) / 1e6
      if (price > 0) costs = {...prevCosts, [group]: price}
    }
    return upsertFund(ports, {
      code: meta.code,
      name: payload.name || meta.name,
      fundKey: meta.fundKey,
      type: 'hold',
      allocations,
      costs: Object.keys(costs).length ? costs : undefined,
      sectors: payload.sectors?.length ? payload.sectors : meta.sectors,
    })
  }

  // 自选：allocations 为空对象
  return upsertFund(ports, {
    code: meta.code,
    name: payload.name || meta.name,
    fundKey: meta.fundKey,
    type: 'watch',
    allocations: {},
    sectors: payload.sectors?.length ? payload.sectors : meta.sectors,
  })
}

export async function updateFund(
  ports: Ports,
  code: string,
  payload: Partial<FundRecord> & {
    amount?: number
    amountBasis?: AmountBasis
    group?: string
    cost?: number
  },
  type: 'hold' | 'watch',
): Promise<FundRecord> {
  const {amount, amountBasis, cost, ...rest} = payload
  const patch: Partial<FundRecord> = {...rest, type}

  if (amount != null && type === 'hold') {
    const meta = await ports.data.resolveFund(code)
    const basis: AmountBasis = amountBasis === 'today' ? 'today' : 'prev'
    const shares = deriveHoldShares(Number(amount) || 0, basis, meta)
    const group = payload.group ?? ''
    const prev = ports.config.getConfig().holdings[code.padStart(6, '0')]
    const prevAllocations = prev?.allocations || {}
    patch.allocations = {...prevAllocations, [group]: shares}
  }

  if (cost != null && type === 'hold') {
    const group = payload.group ?? ''
    const prev = ports.config.getConfig().holdings[code.padStart(6, '0')]
    const prevCosts = prev?.costs || {}
    const c = Number(cost) || 0
    if (c > 0) {
      patch.costs = {...prevCosts, [group]: c}
    } else {
      // 传 0 表示清空该分组成本单价
      const next = {...prevCosts}
      delete next[group]
      patch.costs = Object.keys(next).length ? next : undefined
    }
  }

  return patchFund(ports, code, patch, type)
}

export function removeFund(ports: Ports, code: string, type: 'hold' | 'watch'): void {
  const config = ports.config.getConfig()
  const key = String(code).padStart(6, '0')
  const map = type === 'hold' ? config.holdings : config.watchlist
  if (!map[key]) throw new Error('基金不存在')
  delete map[key]
  ports.config.saveConfig(config)
}

export function updateGoldConfig(
  ports: Ports,
  payload: {holding: number; avgPrice: number},
): {holding: number; avgPrice: number} {
  const config = ports.config.getConfig()
  config.gold = {
    holding: Number(payload.holding ?? config.gold.holding ?? 0) || 0,
    avgPrice: Number(payload.avgPrice ?? config.gold.avgPrice ?? 0) || 0,
  }
  ports.config.saveConfig(config)
  return config.gold
}

export function fetchSettings(ports: Ports): AppSettings {
  return ports.config.getConfig().settings
}

export function updateSettings(
  ports: Ports,
  patch: Partial<AppSettings>,
): AppSettings {
  const config = ports.config.getConfig()
  if (typeof patch.showGold === 'boolean') {
    config.settings.showGold = patch.showGold
  }
  if (patch.quoteSource === 'fund123' || patch.quoteSource === 'fundmnfinfo') {
    config.settings.quoteSource = patch.quoteSource
  }
  if (patch.refreshInterval) {
    config.settings.refreshInterval = clampRefreshInterval({
      ...config.settings.refreshInterval,
      ...patch.refreshInterval,
    })
  }
  if (Array.isArray(patch.holdingGroups)) {
    // 整体替换 holdingGroups（去重保序）
    const next: string[] = []
    for (const g of patch.holdingGroups) {
      const name = String(g ?? '').trim()
      if (name && !next.includes(name)) next.push(name)
    }
    config.settings.holdingGroups = next
    // 清理持仓中引用了已删除分组的 allocations（从对象中删除 key）
    const valid = new Set(next)
    for (const f of Object.values(config.holdings)) {
      if (f.allocations && typeof f.allocations === 'object') {
        let changed = false
        for (const g of Object.keys(f.allocations)) {
          // '' (未分组) 永远有效，不受 holdingGroups 影响
          if (g !== '' && !valid.has(g)) {
            delete f.allocations[g]
            changed = true
          }
        }
        if (changed) f.updatedAt = new Date().toISOString()
      }
    }
  }
  ports.config.saveConfig(config)
  return config.settings
}

/** 返回所有持仓分组名称（保序） */
export function listHoldingGroups(ports: Ports): string[] {
  return ports.config.getConfig().settings.holdingGroups || []
}

/** 返回指定类型的基金记录列表（hold/watch） */
export function listFunds(
  ports: Ports,
  type?: 'hold' | 'watch',
): FundRecord[] {
  const {holdings, watchlist} = ports.config.getConfig()
  if (type === 'hold') return Object.values(holdings)
  if (type === 'watch') {
    return Object.values(watchlist).sort((a, b) => {
      const ac = a.createdAt || ''
      const bc = b.createdAt || ''
      if (ac && bc && ac !== bc) return ac < bc ? -1 : 1
      return 0
    })
  }
  return [...Object.values(holdings), ...Object.values(watchlist)]
}

/** 新增一个持仓分组（已存在则忽略），返回最新分组列表 */
export function addHoldingGroup(ports: Ports, name: string): string[] {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new Error('分组名不能为空')
  const config = ports.config.getConfig()
  const groups = config.settings.holdingGroups || []
  if (!groups.includes(trimmed)) {
    config.settings.holdingGroups = [...groups, trimmed]
    ports.config.saveConfig(config)
  }
  return config.settings.holdingGroups || []
}

/** 删除一个持仓分组，并把引用它的持仓从该分组中移除（删除对应 allocation 与 cost） */
export function removeHoldingGroup(ports: Ports, name: string): string[] {
  const trimmed = String(name || '').trim()
  const config = ports.config.getConfig()
  config.settings.holdingGroups = (config.settings.holdingGroups || []).filter(
    (g) => g !== trimmed,
  )
  if (config.settings.holdingGroupOrders) {
    delete config.settings.holdingGroupOrders[trimmed]
    if (Object.keys(config.settings.holdingGroupOrders).length === 0) {
      config.settings.holdingGroupOrders = undefined
    }
  }
  for (const f of Object.values(config.holdings)) {
    if (f.allocations && trimmed in f.allocations) {
      delete f.allocations[trimmed]
      f.updatedAt = new Date().toISOString()
    }
    if (f.costs && trimmed in f.costs) {
      delete f.costs[trimmed]
      if (Object.keys(f.costs).length === 0) f.costs = undefined
    }
  }
  // 清理 allocations 为空的基金
  for (const key of Object.keys(config.holdings)) {
    const f = config.holdings[key]
    if (!f.allocations || Object.keys(f.allocations).length === 0) {
      delete config.holdings[key]
    }
  }
  ports.config.saveConfig(config)
  return config.settings.holdingGroups
}

/**
 * 删除一个持仓分组及其内所有基金（彻底删除，含多分组基金）。
 * 用于批量编辑弹窗的"删除分组"按钮。
 */
export function removeHoldingGroupWithFunds(ports: Ports, name: string): string[] {
  const trimmed = String(name || '').trim()
  const config = ports.config.getConfig()
  config.settings.holdingGroups = (config.settings.holdingGroups || []).filter(
    (g) => g !== trimmed,
  )
  if (config.settings.holdingGroupOrders) {
    delete config.settings.holdingGroupOrders[trimmed]
    if (Object.keys(config.settings.holdingGroupOrders).length === 0) {
      config.settings.holdingGroupOrders = undefined
    }
  }
  // 删除所有在该分组有 allocation 的基金（含多分组基金）
  for (const key of Object.keys(config.holdings)) {
    const f = config.holdings[key]
    if (f.allocations && trimmed in f.allocations) {
      delete config.holdings[key]
    }
  }
  ports.config.saveConfig(config)
  return config.settings.holdingGroups
}

/** 重命名一个持仓分组，并同步更新引用它的持仓的 allocations/costs key 与排序 key */
export function renameHoldingGroup(
  ports: Ports,
  oldName: string,
  newName: string,
): string[] {
  const o = String(oldName || '').trim()
  const n = String(newName || '').trim()
  if (!n) throw new Error('分组名不能为空')
  const config = ports.config.getConfig()
  const groups = config.settings.holdingGroups || []
  if (o !== n && groups.includes(n)) throw new Error(`分组「${n}」已存在`)
  config.settings.holdingGroups = groups.map((g) => (g === o ? n : g))
  for (const f of Object.values(config.holdings)) {
    if (f.allocations && o in f.allocations) {
      const shares = f.allocations[o]
      delete f.allocations[o]
      // 若已有同名分组份额，累加（避免覆盖）
      f.allocations[n] = (f.allocations[n] || 0) + shares
      f.updatedAt = new Date().toISOString()
    }
    if (f.costs && o in f.costs) {
      const c = f.costs[o]
      delete f.costs[o]
      f.costs[n] = (f.costs[n] || 0) + c
      if (Object.keys(f.costs).length === 0) f.costs = undefined
    }
  }
  // 同步排序 key
  if (config.settings.holdingGroupOrders && o in config.settings.holdingGroupOrders) {
    const order = config.settings.holdingGroupOrders[o]
    delete config.settings.holdingGroupOrders[o]
    // 合并到新名（已有则拼接去重）
    const existing = config.settings.holdingGroupOrders[n] || []
    const merged = Array.from(new Set([...order, ...existing]))
    config.settings.holdingGroupOrders[n] = merged
  }
  ports.config.saveConfig(config)
  return config.settings.holdingGroups
}

/** 获取某分组内的基金排序（codes 有序列表），未设置则返回 [] */
export function getHoldingGroupOrder(ports: Ports, group: string): string[] {
  return ports.config.getConfig().settings.holdingGroupOrders?.[group] || []
}

/** 设置某分组内的基金排序（codes 有序列表） */
export function setHoldingGroupOrder(
  ports: Ports,
  group: string,
  codes: string[],
): void {
  const config = ports.config.getConfig()
  const cleaned = Array.from(
    new Set(
      codes
        .map((c) => String(c ?? '').padStart(6, '0'))
        .filter((c) => /^\d{6}$/.test(c)),
    ),
  )
  if (!config.settings.holdingGroupOrders) {
    config.settings.holdingGroupOrders = {}
  }
  if (cleaned.length) {
    config.settings.holdingGroupOrders[group] = cleaned
  } else {
    delete config.settings.holdingGroupOrders[group]
  }
  if (Object.keys(config.settings.holdingGroupOrders).length === 0) {
    config.settings.holdingGroupOrders = undefined
  }
  ports.config.saveConfig(config)
}

/**
 * 直接设置某基金在某分组的份额与成本（批量编辑用，绕过金额反推份额）。
 * - shares<=0 等同于删除该分组 allocation（连带 cost）
 * - cost<=0 或 undefined 表示清空该分组成本单价（保留份额）
 * - 保留其他分组的 allocation/cost
 */
export function setFundAllocation(
  ports: Ports,
  code: string,
  group: string,
  shares: number,
  cost?: number,
): void {
  const config = ports.config.getConfig()
  const key = String(code).padStart(6, '0')
  const fund = config.holdings[key]
  if (!fund) throw new Error('基金不存在')
  const allocations = {...(fund.allocations || {})}
  const costs = {...(fund.costs || {})}
  const s = Number(shares) || 0
  if (s > 0) {
    allocations[group] = s
  } else {
    delete allocations[group]
  }
  // cost 是成本单价（元/份）
  if (cost != null && cost > 0) {
    costs[group] = Number(cost) || 0
  } else {
    delete costs[group]
  }
  fund.allocations = allocations
  fund.costs = Object.keys(costs).length ? costs : undefined
  fund.updatedAt = new Date().toISOString()
  // allocations 为空则删除整个基金
  if (Object.keys(allocations).length === 0) {
    delete config.holdings[key]
  }
  ports.config.saveConfig(config)
}

export function exportConfig(ports: Ports): AppConfig {
  return ports.config.getConfig()
}

export function importConfig(ports: Ports, payload: Partial<AppConfig> & {funds?: unknown}): AppConfig {
  const hasFunds = payload?.funds && typeof payload.funds === 'object'
  const hasHoldings = payload?.holdings && typeof payload.holdings === 'object'
  const hasWatchlist = payload?.watchlist && typeof payload.watchlist === 'object'
  if (!hasFunds && !hasHoldings && !hasWatchlist) {
    throw new Error('配置缺少 holdings/watchlist')
  }
  const next = normalizeConfig(payload as any)
  ports.config.saveConfig(next)
  return next
}
