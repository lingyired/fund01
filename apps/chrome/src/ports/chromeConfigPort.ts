import type { AppConfig, ConfigPort } from '@fund01/core'
import { DEFAULT_CONFIG, normalizeConfig } from '@fund01/core'

// popup 本地缓存（同步读避免 UI 闪烁）
const STORAGE_KEY = 'wzk-fund-config'

// SW 端读取的配置 key（chrome.storage.local）
const SW_CONFIG_KEY = 'session-config'

/**
 * Chrome 扩展配置 Port 实现。
 * - getConfig() 同步读 localStorage，避免 popup 打开时 UI 闪烁
 * - saveConfig() 写 localStorage + 推 chrome.storage.local（SW 监听 onChanged 自动重排 alarm）
 */
export class ChromeConfigPort implements ConfigPort {
  private listeners = new Set<(config: AppConfig) => void>()

  getConfig(): AppConfig {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return structuredClone(DEFAULT_CONFIG)
    try {
      return normalizeConfig(JSON.parse(raw))
    } catch {
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  async saveConfig(config: AppConfig): Promise<void> {
    const next = normalizeConfig(config)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    // 同步推送给 SW（SW 通过 chrome.storage.onChanged 监听变化）
    await chrome.storage.local.set({ [SW_CONFIG_KEY]: next })
    // 通知本地监听器（同窗口）
    this.listeners.forEach((cb) => cb(next))
  }

  onChanged(cb: (config: AppConfig) => void): () => void {
    this.listeners.add(cb)
    // 监听 chrome.storage.local 变化（其他 popup 实例修改配置时同步）
    const listener = (
      _changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local') {
        // SW 不写 SW_CONFIG_KEY，这里主要处理多 popup 实例同步
        // localStorage 是每窗口独立的，跨窗口同步依赖 storage 事件（见 EventPort）
      }
    }
    chrome.storage.onChanged.addListener(listener)
    return () => {
      this.listeners.delete(cb)
      chrome.storage.onChanged.removeListener(listener)
    }
  }
}
