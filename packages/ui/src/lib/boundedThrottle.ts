/**
 * 「有界速率 + 末尾兜底」下发器。
 *
 * 用于 `<input type="color">` 这类**连续触发**的输入：原生取色面板在拖动过程中会不停发
 * `input` 事件（React 的 `onChange` 绑定的就是 input 事件），一次拖拽可产生上百次回调。
 * 如果每次回调都直接写后端，就会连带让下游把**全部实例**重新渲染一遍（Windows 任务栏：
 * 每个可见实例各一次分层窗口重绘；macOS 菜单栏：重建内容），拖动时肉眼可见卡顿。
 *
 * 这里给出的合并策略不是纯 debounce，而是「有界速率 + 末尾兜底」，两个要求都要满足：
 *
 * - **拖动过程中要有反馈**：持续拖动超过 `maxWaitMs` 必须强制下发一次，
 *   否则用户拖了 3 秒界面毫无变化（纯 debounce 的典型问题）。
 * - **停手后一定要落盘**：停手 `delayMs` 后下发最后一次，避免「选完颜色就关窗」丢值。
 *
 * 实现要点：
 * - 同 `key` 后写覆盖前写（同一输入的连续值只保留最后一个）；
 * - 不同 `key` 各自登记、一次 `flush` 全部下发，互不干扰；
 * - 定时器时长会**对齐** `maxWaitMs` 时刻（`maxWaitMs - elapsed` 变小则提前触发），
 *   而不是每次事件都把窗口整体后推——否则持续拖动会永远推不到 maxWait。
 *
 * 时钟与定时器可注入，以便用虚拟时钟做确定性验证（见 `docs` / smoke 脚本）。
 */

export interface BoundedThrottleOptions {
  /** 尾部延迟：停手后多久下发（毫秒） */
  delayMs: number
  /** 最长等待：持续触发时最长多久必须下发一次（毫秒） */
  maxWaitMs: number
}

/** 时间与定时器依赖（可注入虚拟时钟） */
export interface BoundedThrottleClock {
  now: () => number
  setTimer: (fn: () => void, ms: number) => number
  clearTimer: (id: number) => void
}

export interface BoundedThrottle {
  /** 登记一次下发（同 key 覆盖，不同 key 并存）；首次登记开启计时窗口 */
  schedule: (key: string, job: () => void) => void
  /** 立即下发全部挂起任务（卸载 / 分区切换兜底） */
  flush: () => void
  /** 当前挂起任务数（诊断用） */
  pending: () => number
}

const defaultClock: BoundedThrottleClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (id) => window.clearTimeout(id),
}

export function createBoundedThrottle(
  opts: BoundedThrottleOptions,
  clock: BoundedThrottleClock = defaultClock,
): BoundedThrottle {
  const jobs = new Map<string, () => void>()
  let timer: number | null = null
  /** 本轮连续触发窗口的起点（flush 后重置） */
  let windowStart: number | null = null

  function flush() {
    if (timer != null) {
      clock.clearTimer(timer)
      timer = null
    }
    windowStart = null
    if (jobs.size === 0) return
    // 先取出并清空再执行：任务内部若再次 schedule，应归入下一轮而不会被本次清掉
    const batch = Array.from(jobs.values())
    jobs.clear()
    for (const job of batch) job()
  }

  function schedule(key: string, job: () => void) {
    jobs.set(key, job)
    const now = clock.now()
    if (windowStart == null) windowStart = now
    if (timer != null) clock.clearTimer(timer)
    const elapsed = now - windowStart
    const wait =
      elapsed >= opts.maxWaitMs ? 0 : Math.min(opts.delayMs, opts.maxWaitMs - elapsed)
    timer = clock.setTimer(() => {
      timer = null
      flush()
    }, wait)
  }

  return {schedule, flush, pending: () => jobs.size}
}
