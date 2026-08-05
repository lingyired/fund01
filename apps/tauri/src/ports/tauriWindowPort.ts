import { invoke } from '@tauri-apps/api/core'
import type { SettingsTabId, WindowPort } from '@fund01/core'

let versionCache = ''

/** Tauri 窗口 Port：打开设置窗口（Rust 创建/聚焦 settings 窗口） */
export class TauriWindowPort implements WindowPort {
  async openSettings(tab?: SettingsTabId): Promise<void> {
    await invoke('open_settings_window', { tab: tab ?? null })
  }

  /** 桌面版支持 macOS 菜单栏 → 设置页显示「菜单栏」tab */
  supportsMenubar(): boolean {
    return true
  }

  /** 扩展角标是 Chrome 扩展能力，桌面版不显示该设置项 */
  supportsBadge(): boolean {
    return false
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
