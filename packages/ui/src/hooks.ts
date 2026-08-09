import {useCallback, useEffect, useState} from 'react'
import {usePorts} from './context'
import type {
  HoldingsPayload,
  IndexItem,
  QuoteUpdate,
} from '@fund01/core'

/** 订阅后端行情更新 + 首次主动拉取 */
export function useMarketData() {
  const {data, event} = usePorts()
  const [holdings, setHoldings] = useState<HoldingsPayload | null>(null)
  const [indices, setIndices] = useState<IndexItem[]>([])
  const [lastUpdate, setLastUpdate] = useState<number>(0)
  const [loading, setLoading] = useState(true)

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

  // refresh 引用必须稳定：App.tsx 的 useEffect 依赖 [refresh]，
  // 若每次 render 返回新箭头函数会触发无限循环
  // （refresh → SW 写 cache-time → storage.onChanged → setState → re-render → refresh 变 → 再 refresh...）
  const refresh = useCallback(() => data.triggerRefresh(), [data])

  return {holdings, indices, lastUpdate, loading, refresh}
}
