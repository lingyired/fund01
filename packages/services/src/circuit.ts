/**
 * 简易熔断器：单个数据源连续失败 N 次后冷却一段时间，避免持续宕机的接口
 * 被反复重试（如东财 push2his 系列全挂时，每分钟产生大量无效请求 + 刷屏日志）。
 *
 * 状态机：
 *   closed（正常）→ 失败累计到 max → tripped（冷却 cooldownMs）
 *   tripped 过期 → half-open（放一次请求试探）
 *     half-open 成功 → closed（清零）
 *     half-open 失败 → 重新 tripped（再冷却 cooldownMs）
 *
 * 持久化：模块级 Map 在 SW 重启时丢失（MV3 SW ~30s 休眠）。为让熔断状态跨
 * SW 重启保留，调用方（SW）可通过 restoreCircuits() 注入恢复的状态，并
 * 通过 onCircuitChange 回调在状态变更时持久化到 chrome.storage.session。
 */

export interface CircuitState {
  failures: number
  trippedUntil: number
}

const circuits = new Map<string, CircuitState>()

export interface CircuitOptions {
  /** 触发熔断的连续失败次数 */
  maxFailures: number
  /** 熔断后冷却时长（ms） */
  cooldownMs: number
  /** 日志前缀，便于定位 */
  label: string
}

/** 状态变更回调（SW 用来持久化到 chrome.storage.session） */
let onCircuitChange: (() => void) | null = null

/** 设置状态变更回调，每次 recordSuccess/recordFailure 后触发 */
export function setCircuitChangeCallback(cb: (() => void) | null): void {
  onCircuitChange = cb
}

/** 恢复熔断状态（SW 启动时从 chrome.storage.session 注入） */
export function restoreCircuits(states: Record<string, CircuitState>): void {
  for (const [key, state] of Object.entries(states)) {
    circuits.set(key, {failures: state.failures, trippedUntil: state.trippedUntil})
  }
}

/** 导出当前所有熔断状态（用于持久化） */
export function snapshotCircuits(): Record<string, CircuitState> {
  const out: Record<string, CircuitState> = {}
  for (const [key, state] of circuits) {
    out[key] = {failures: state.failures, trippedUntil: state.trippedUntil}
  }
  return out
}

/** 是否已熔断（冷却期内，应跳过请求） */
export function isTripped(key: string): boolean {
  const s = circuits.get(key)
  if (!s) return false
  return Date.now() < s.trippedUntil
}

/** 记录成功：清零状态回到 closed */
export function recordSuccess(key: string): void {
  if (circuits.has(key)) {
    circuits.delete(key)
    onCircuitChange?.()
  }
}

/** 记录失败：累计计数，达到阈值或 half-open 重试失败时熔断 */
export function recordFailure(key: string, opts: CircuitOptions): void {
  const s = circuits.get(key) || {failures: 0, trippedUntil: 0}
  const now = Date.now()
  const cooldownExpired = s.trippedUntil > 0 && now >= s.trippedUntil
  s.failures++
  if (cooldownExpired) {
    // half-open 重试失败：立即重新 tripped
    s.trippedUntil = now + opts.cooldownMs
    console.warn(
      `[fund01] 熔断 ${opts.label}：冷却后重试仍失败，重新冷却 ${opts.cooldownMs / 1000}s`,
    )
  } else if (s.trippedUntil === 0 && s.failures >= opts.maxFailures) {
    // closed → tripped：累计失败达到阈值
    s.trippedUntil = now + opts.cooldownMs
    console.warn(
      `[fund01] 熔断 ${opts.label}：连续失败 ${s.failures} 次，冷却 ${opts.cooldownMs / 1000}s`,
    )
  }
  circuits.set(key, s)
  onCircuitChange?.()
}
