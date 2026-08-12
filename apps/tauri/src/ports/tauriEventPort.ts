import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppConfig, EventPort, QuoteUpdate, RefreshSchedule } from '@fund01/core'

/** Tauri 事件 Port：订阅 Rust 端 emit 的 quote-update / config-change */
export class TauriEventPort implements EventPort {
  /** 前端调试日志 → Rust dbg_log 命令打到 stdout（webview console 默认不进终端） */
  emitDebug(msg: string): void {
    void invoke('dbg_log', { msg })
  }

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

  /** 点击 menubar 分组实例 → 浮窗直达分组 tab（Rust 端 window.rs 在 show_popup 时 emit） */
  onPopupOpenGroup(cb: (tabId: string) => void): () => void {
    let unlisten: (() => void) | undefined
    listen<string>('popup-open-group', (e) => cb(e.payload)).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }

  /** 订阅后端自动刷新计划，驱动刷新按钮进度环 */
  onRefreshSchedule(cb: (payload: RefreshSchedule) => void): () => void {
    let unlisten: (() => void) | undefined
    listen<RefreshSchedule>('refresh-schedule', (e) => cb(e.payload)).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }
}
