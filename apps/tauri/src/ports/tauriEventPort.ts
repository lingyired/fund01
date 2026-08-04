import { listen } from '@tauri-apps/api/event'
import type { AppConfig, EventPort, QuoteUpdate } from '@fund01/core'

/** Tauri 事件 Port：订阅 Rust 端 emit 的 quote-update / config-change */
export class TauriEventPort implements EventPort {
  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void {
    let unlisten: (() => void) | undefined
    listen<QuoteUpdate>('quote-update', (e) => cb(e.payload)).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }

  onConfigChange(cb: (config: AppConfig) => void): () => void {
    let unlisten: (() => void) | undefined
    listen<AppConfig>('config-change', (e) => cb(e.payload)).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }
}
