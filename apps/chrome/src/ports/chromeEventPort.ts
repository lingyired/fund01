import type { AppConfig, EventPort, QuoteUpdate } from '@fund01/core'

// popup 本地缓存的配置 key（与 chromeConfigPort 保持一致）
const STORAGE_KEY = 'wzk-fund-config'

/**
 * Chrome 扩展事件 Port 实现。
 * - onQuoteUpdate() 监听 chrome.storage.onChanged 的 cache-time 变化，组装 QuoteUpdate
 * - onConfigChange() 监听 window storage 事件（跨窗口同步）
 */
export class ChromeEventPort implements EventPort {
  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local') return
      // cache-time 变化意味着 SW 刷新完成，组装 QuoteUpdate 推给 UI
      if (!changes['cache-time']) return
      chrome.storage.local
        .get([
          'cache-holdings',
          'cache-watchlist',
          'cache-indices',
          'cache-market',
          'cache-gold',
          'cache-time',
        ])
        .then((cached) => {
          const payload: QuoteUpdate = {
            holdings: (cached['cache-holdings'] as QuoteUpdate['holdings']) || null,
            watchlist: (cached['cache-watchlist'] as QuoteUpdate['watchlist']) || null,
            indices: (cached['cache-indices'] as QuoteUpdate['indices']) || null,
            market: (cached['cache-market'] as QuoteUpdate['market']) || null,
            gold: (cached['cache-gold'] as QuoteUpdate['gold']) || null,
            time: (cached['cache-time'] as number) || Date.now(),
          }
          cb(payload)
        })
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
}
