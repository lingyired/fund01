import {useCallback, useEffect, useRef, useState} from 'react'
import {usePorts} from './context'
import type {
  HoldingsPayload,
  IndexItem,
  QuoteUpdate,
  RefreshSchedule,
} from '@fund01/core'
import {DEFAULT_REFRESH_INTERVAL} from '@fund01/core'
import {isMenubarEmpty} from './lib/fundOps'

/** 订阅后端行情更新 + 首次主动拉取 */
export function useMarketData() {
  const {data, event, config} = usePorts()
  const [holdings, setHoldings] = useState<HoldingsPayload | null>(null)
  const [indices, setIndices] = useState<IndexItem[]>([])
  const [lastUpdate, setLastUpdate] = useState<number>(0)
  const [loading, setLoading] = useState(true)

  // 自动刷新计划：后端推送的周期与下次触发时间，用于刷新按钮进度环
  const ri = config.getConfig().settings.refreshInterval ?? DEFAULT_REFRESH_INTERVAL
  const [refreshSchedule, setRefreshSchedule] = useState<RefreshSchedule>(() => ({
    intervalSeconds: ri.trading,
    nextRefreshAt: Date.now() + ri.trading * 1000,
  }))

  // 是否配置了基金持仓（本地配置同步可读，不依赖任何行情请求）：
  // 无持仓 → popup 直接展示「暂无基金持仓」，无需等后端快照/指数请求。
  // 有持仓 → 才需要等行情快照（fetchHoldings / quote-update）。
  const hasHoldings = Object.keys(config.getConfig().holdings ?? {}).length > 0

  useEffect(() => {
    // 后端数据未就绪（首轮刷新进行中 / 切源清空待刷）时的超时兜底：
    // 若迟迟等不到 quote-update 推送（如后端刷新失败），结束加载态，避免永久转圈。
    const READY_TIMEOUT_MS = 20_000
    // 兜底定时器在 effect 顶层立即启动（与 fetch 并行）：
    // 若把它放在 .then 内部，一旦某个 fetch 长时间不 settle（如 Tauri webview
    // 初始化期 invoke 挂起），.then 永不执行 → 兜底失效 → 初始无数据时
    // 「正在加载数据…」永久显示。顶层启动保证任何情况下 20s 内必结束加载态。
    const readyTimer = setTimeout(() => setLoading(false), READY_TIMEOUT_MS)

    // 本地配置即确认无持仓：立即结束加载态，展示「暂无基金持仓」。
    // 指数看板仍独立拉取（下方），与持仓无关。
    if (!hasHoldings) setLoading(false)

    // 1. 持仓 + 最近刷新时间：仅决定基金列表的加载态。
    //    与指数请求拆开（Promise.all 会等最慢的 promise 才执行 then，
    //    若混在一起，指数慢会拖住持仓的「确认空」判定）。
    Promise.all([data.fetchHoldings(), data.fetchLastUpdate?.()])
      .then(([h, t]) => {
        if (typeof t === 'number' && t > 0) setLastUpdate(t)
        // 仅当配置有持仓时才采纳快照/结束加载：无持仓时保持空态，
        // 即使 fetch 返回残留缓存也不覆盖（避免旧数据冒充「有持仓」）。
        if (hasHoldings) {
          // 仅当 h 非 null 时写入 holdings：fetch（invoke 响应可能慢）晚于
          // quote-update 到达且返回 null 时，不能把事件已带来的有效数据
          // 覆盖回 null（数据竞态），否则有持仓的 popup 会闪成「暂无基金持仓」。
          if (h) setHoldings(h)
          if (h) {
            // 数据已就绪（含后端显式广播的空快照）：结束加载，正常展示（空态/列表）
            setLoading(false)
          } else if (typeof t === 'number' && t > 0) {
            // 后端已产出过快照（cache-time / 广播时间戳存在）但无持仓数据：
            // 即「确认无持仓」，无需等 quote-update，直接结束加载。
            setLoading(false)
          }
          // else：后端尚未产出任何快照（首轮刷新进行中）：保持加载态，
          // 等 quote-update 推来第一份数据再结束；超时兜底已在顶层启动
        }
      })
      .catch(() => setLoading(false))

    // 2. 指数 + 刷新计划：独立于持仓加载态（指数看板无论有无基金持仓都要加载）。
    //    指数行情未产出时 IndexBar 用占位卡片兜底（名称 + --），无需就绪信号。
    Promise.all([data.fetchIndices(), data.fetchRefreshSchedule?.()])
      .then(([i, sched]) => {
        // 仅当非空时写入：fetch（invoke 响应可能慢）晚于 quote-update 到达且返回
        // 空数组（缓存/内存尚无指数快照）时，不能覆盖事件已带来的指数数据。
        if (i.length) setIndices(i)
        if (sched && typeof sched.nextRefreshAt === 'number') setRefreshSchedule(sched)
      })
      .catch(() => {
        /* 指数拉取失败不阻塞基金列表的加载态判定 */
      })

    // 2. 订阅事件增量更新
    const off = event.onQuoteUpdate((q: QuoteUpdate) => {
      if (q.holdings) setHoldings(q.holdings)
      if (q.indices) setIndices(q.indices)
      setLastUpdate(q.time)
      // 后端广播 = 「本周期快照已产出」（无论空/非空）→ 结束加载态。
      // 与 fetch 的未就绪语义配套：app 刚启动首轮刷新进行中时 fetch 返回 null，
      // 靠第一份广播让位给真实内容（数据或空态）。注意空持仓（list 空）也是
      // 合法快照：Chrome 端 SW 空持仓只写 cache-time 不写 cache-holdings，
      // 事件 holdings 为 null，此时同样应结束加载，展示「暂无持仓」。
      setLoading(false)
    })

    return () => {
      off()
      clearTimeout(readyTimer)
    }
  }, [data, event, hasHoldings])

  // 订阅后端自动刷新计划
  useEffect(() => {
    if (!event.onRefreshSchedule) return
    return event.onRefreshSchedule((s) => setRefreshSchedule(s))
  }, [event])

  // 始终持有最新周期（供 refresh 乐观重置用，且不破坏 refresh 的稳定性）
  const intervalRef = useRef(refreshSchedule.intervalSeconds)
  useEffect(() => {
    intervalRef.current = refreshSchedule.intervalSeconds
  }, [refreshSchedule.intervalSeconds])

  // refresh 引用必须稳定：App.tsx 的 useEffect 依赖 [refresh]，
  // 若每次 render 返回新箭头函数会触发无限循环
  // （refresh → SW 写 cache-time → storage.onChanged → setState → re-render → refresh 变 → 再 refresh...）
  const refresh = useCallback(() => {
    // 乐观重置进度环：点击即视为新周期起点，不等后端回推，保证点击瞬间视觉立即归零。
    // 手动刷新传 resetTimer=true：后端（Chrome 重排 alarm / Tauri 唤醒循环）随后
    // 把真实的新计划推回来，与这里的计算一致，仅作即时反馈之用。
    setRefreshSchedule((s) => ({
      ...s,
      nextRefreshAt: Date.now() + intervalRef.current * 1000,
    }))
    return data.triggerRefresh(true)
  }, [data])

  return {holdings, indices, lastUpdate, loading, refresh, refreshSchedule}
}

/** menubar 是否全空（仅 Tauri；Chrome 无 menubar，supportsMenubar 未实现 → 恒 false）。
 *  订阅 ConfigPort.onChanged：⌘-拖出（Rust 写入 menubarHiddenGroups 并广播）或设置页关闭分组后实时刷新。
 *  全空时 App.tsx / OptionsApp.tsx 的 header 替换为「菜单栏已全部关闭」banner。 */
export function useMenubarEmpty(): boolean {
  const {config, window: windowPort} = usePorts()
  const [empty, setEmpty] = useState(() =>
    windowPort.supportsMenubar?.() ? isMenubarEmpty(config.getConfig()) : false,
  )
  useEffect(() => {
    if (!windowPort.supportsMenubar?.()) return
    return config.onChanged(() => setEmpty(isMenubarEmpty(config.getConfig())))
  }, [config, windowPort])
  return empty
}
