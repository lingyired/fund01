import { invoke } from '@tauri-apps/api/core'
import type { WindowPort } from '@fund01/core'

let versionCache = ''

/** Tauri 窗口 Port：打开设置窗口（Rust 创建/聚焦 settings 窗口） */
export class TauriWindowPort implements WindowPort {
  async openSettings(tab?: 'general' | 'holdings' | 'data'): Promise<void> {
    await invoke('open_settings_window', { tab: tab ?? null })
  }

  getVersion(): string {
    if (!versionCache) {
      invoke<string>('get_version').then((v) => {
        versionCache = v
      })
    }
    return versionCache || '1.0.0'
  }
}
