import type { AppConfig, EventPort, QuoteUpdate, RefreshSchedule } from '@fund01/core'

// popup 本地缓存的配置 key（与 chromeConfigPort 保持一致）
const STORAGE_KEY = 'fund01-config'

// storage key → QuoteUpdate 字段映射（onChanged 增量读取用）
const CACHE_KEYS: Record<
  'cache-holdings' | 'cache-indices' | 'cache-time',
  'holdings' | 'indices' | 'time'
> = {
  'cache-holdings': 'holdings',
  'cache-indices': 'indices',
  'cache-time': 'time',
}

/**
 * Chrome 扩展事件 Port 实现。
 * - onQuoteUpdate() 监听 chrome.storage.onChanged 的 cache-time 变化，组装 QuoteUpdate
 * - onConfigChange() 监听 window storage 事件（跨窗口同步）
 *
 * 增量读取：SW 每次刷新会写入多个 cache-* key，onChanged 的 changes 已携带各 key 的新值，
 * 直接用 newValue 组装，只对未变化的字段沿用上次值（首帧用模块级 lastQuote 兜底），
 * 避免每个刷新周期都全量 get + 反序列化 6 个缓存对象。
 */
export class ChromeEventPort implements EventPort {
  private lastQuote: QuoteUpdate | null = null

  /** 前端调试日志：Chrome 端直接走 devtools console（Tauri 端走 invoke dbg_log） */
  emitDebug(msg: string): void {
    // eslint-disable-next-line no-console
    console.log('[fund01]', msg)
  }

  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local') return
      // cache-time 变化意味着 SW 刷新完成，组装 QuoteUpdate 推给 UI
      if (!changes['cache-time']) return
      const next: QuoteUpdate = this.lastQuote
        ? {...this.lastQuote}
        : {holdings: null, indices: null, time: 0}
      for (const key of Object.keys(CACHE_KEYS) as (keyof typeof CACHE_KEYS)[]) {
        const change = changes[key]
        if (!change) continue
        // 各字段类型不同，这里按 storage 原始值直接赋（undefined 表示该字段本轮未刷新）
        ;(next as Record<string, unknown>)[CACHE_KEYS[key]] = change.newValue ?? null
      }
      this.lastQuote = next
      cb(next)
    }
    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }

  onConfigChange(cb: (config: AppConfig) => void): () => void {
    // 跨窗口同步：storage 事件只在其他窗口修改 localStorage 时触发
    // 同窗口的配置变更由 ChromeConfigPort.saveConfig 的本地 listeners 处理
    const listener = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          cb(JSON.parse(e.newValue))
        } catch {
          // 忽略解析错误
        }
      }
    }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  }

  /** 订阅 Service Worker 写入的自动刷新计划，驱动刷新按钮进度环 */
  onRefreshSchedule(cb: (payload: RefreshSchedule) => void): () => void {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local') return
      const change = changes['cache-refresh-schedule']
      if (!change) return
      try {
        cb(change.newValue as RefreshSchedule)
      } catch {
        // 忽略解析或回调错误
      }
    }
    chrome.storage.onChanged.addListener(listener)
    // popup 打开瞬间若 storage 里已有计划但暂无变化，主动读一次立即生效，
    // 避免进度环要等下次 storage 写入（交易时段最快 60s、非交易 600s）才出现。
    void chrome.storage.local.get('cache-refresh-schedule').then((r) => {
      const s = r['cache-refresh-schedule'] as RefreshSchedule | undefined
      if (s && typeof s.intervalSeconds === 'number' && typeof s.nextRefreshAt === 'number') {
        cb(s)
      }
    })
    return () => chrome.storage.onChanged.removeListener(listener)
  }
}
