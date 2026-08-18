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

  useEffect(() => {
    // 后端数据未就绪（首轮刷新进行中 / 切源清空待刷）时的超时兜底：
    // 若迟迟等不到 quote-update 推送（如后端刷新失败），结束加载态，避免永久转圈。
    const READY_TIMEOUT_MS = 20_000
    let readyTimer: ReturnType<typeof setTimeout> | undefined

    // 1. 首次拉缓存：持仓 + 指数 + 最近一次后台刷新时间（SW 静默刷新也在写 cache-time，
    //    因此打开 popup 无需等待下一次事件推送即可直接显示更新时间）
    //    + 权威刷新计划（避免用交易时段间隔瞎猜 nextRefreshAt，进度环首帧即准确）
    Promise.all([
      data.fetchHoldings(),
      data.fetchIndices(),
      data.fetchLastUpdate?.(),
      data.fetchRefreshSchedule?.(),
    ])
      .then(([h, i, t, sched]) => {
        setHoldings(h)
        setIndices(i)
        if (typeof t === 'number' && t > 0) setLastUpdate(t)
        if (sched && typeof sched.nextRefreshAt === 'number') setRefreshSchedule(sched)
        if (h) {
          // 数据已就绪（含后端显式广播的空快照）：结束加载，正常展示（空态/列表）
          setLoading(false)
        } else {
          // 后端尚未产出数据（首轮刷新进行中）：保持加载态，
          // 等 quote-update 推来第一份数据再结束；超时兜底防永久转圈
          readyTimer = setTimeout(() => setLoading(false), READY_TIMEOUT_MS)
        }
      })
      .catch(() => setLoading(false))

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
      if (readyTimer) clearTimeout(readyTimer)
    }
  }, [data, event])

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
