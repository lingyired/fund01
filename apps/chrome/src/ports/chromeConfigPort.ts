import type { AppConfig, ConfigPort } from '@fund01/core'
import { DEFAULT_CONFIG, normalizeConfig } from '@fund01/core'

// popup 本地缓存（同步读避免 UI 闪烁）
const STORAGE_KEY = 'fund01-config'

// SW 端读取的配置 key（chrome.storage.local）
const SW_CONFIG_KEY = 'session-config'

// 串行化保存队列：同一时刻最多一个写配置任务在途（同 Tauri 端）。快速连续操作（如快速连点
// 分组显示开关）会并发发出多个「完整配置」写入，旧快照后写会覆盖新快照 → 开关 A 却隐藏 B。
let saveChain: Promise<void> = Promise.resolve()

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
    const run = saveChain.then(async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      // 同步推送给 SW（SW 通过 chrome.storage.onChanged 监听变化）
      await chrome.storage.local.set({ [SW_CONFIG_KEY]: next })
      // 通知本地监听器（同窗口）
      this.listeners.forEach((cb) => cb(next))
    })
    saveChain = run.catch(() => {})
    return run
  }

  onChanged(cb: (config: AppConfig) => void): () => void {
    this.listeners.add(cb)
    // 跨窗口同步：storage 事件只在其他窗口修改 localStorage 时触发（本窗口写入不触发，与本地 listeners 无重叠）；
    // 同窗口变更由 saveConfig 直接通知本地 listeners。合并后 onChanged 覆盖「任何窗口」的配置变更。
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          cb(JSON.parse(e.newValue))
        } catch {
          // 忽略解析错误
        }
      }
    }
    window.addEventListener('storage', onStorage)
    return () => {
      this.listeners.delete(cb)
      window.removeEventListener('storage', onStorage)
    }
  }
}
