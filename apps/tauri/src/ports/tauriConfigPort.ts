import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppConfig, ConfigPort } from '@fund01/core'
import { DEFAULT_CONFIG, normalizeConfig } from '@fund01/core'
import { LazyMemo } from './lazyMemo'

const memo = new LazyMemo<AppConfig>()

/**
 * Tauri 配置 Port：启动时从 Rust 拉取一次到内存镜像（保持 getConfig() 同步语义），
 * saveConfig 走 invoke（Rust 侧归一化 + store 持久化 + 广播）。
 */
export class TauriConfigPort implements ConfigPort {
  /** 入口渲染前调用一次 */
  async init(): Promise<void> {
    const raw = await invoke<AppConfig>('get_config')
    memo.set(normalizeConfig(raw))
  }

  getConfig(): AppConfig {
    const v = memo.get()
    return v ? normalizeConfig(v) : DEFAULT_CONFIG
  }

  async saveConfig(config: AppConfig): Promise<void> {
    const next = await invoke<AppConfig>('save_config', { config })
    memo.set(next)
  }

  onChanged(cb: (config: AppConfig) => void): () => void {
    let unlisten: (() => void) | undefined
    listen<AppConfig>('config-change', (e) => {
      memo.set(e.payload)
      cb(e.payload)
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }
}
