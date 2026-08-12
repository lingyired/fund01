import {useCallback, useEffect, useRef, useState} from 'react'
import {usePorts} from './context'
import type {
  HoldingsPayload,
  IndexItem,
  QuoteUpdate,
  RefreshSchedule,
} from '@fund01/core'
import {DEFAULT_REFRESH_INTERVAL} from '@fund01/core'

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
    // 1. 首次拉缓存
    Promise.all([
      data.fetchHoldings(),
      data.fetchIndices(),
    ])
      .then(([h, i]) => {
        setHoldings(h)
        setIndices(i)
        setLoading(false)
      })
      .catch(() => setLoading(false))

    // 2. 订阅事件增量更新
    const off = event.onQuoteUpdate((q: QuoteUpdate) => {
      if (q.holdings) setHoldings(q.holdings)
      if (q.indices) setIndices(q.indices)
      setLastUpdate(q.time)
    })

    return off
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
