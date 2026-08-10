import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppConfig, ConfigPort } from '@fund01/core'
import { DEFAULT_CONFIG, normalizeConfig } from '@fund01/core'
import { LazyMemo } from './lazyMemo'

const memo = new LazyMemo<AppConfig>()

// 串行化保存队列：同一时刻最多一个 save_config invoke 在途。
// updateSettings 等写入入口都是 fire-and-forget（不 await 保存回包），快速连续操作会并发发出
// 多个「完整配置」invoke，Rust 侧乱序处理会导致后发的旧快照覆盖新快照（表现为「开关 A 却隐藏 B」
// / UI 与菜单栏不一致）。串行后写入严格有序、memo 与后端始终一致。
let saveChain: Promise<void> = Promise.resolve()

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
    // 乐观同步：先把本次 patch 后的完整配置写进内存镜像 → getConfig() 立即读到最新值。
    // 否则保存回包前 getConfig() 返回旧值：切 tab 重挂载等读取会把 hiddenRef 重置成过期列表，
    // 后续开关基于旧列表覆盖写 → 「开关 A 却影响 B」。写入已全局串行化（saveChain），乐观值即
    // 最新值；回包后再次覆盖为服务端归一化结果（同源，一致）。
    memo.set(normalizeConfig(config))
    const run = saveChain.then(async () => {
      const next = await invoke<AppConfig>('save_config', { config })
      memo.set(next)
    })
    saveChain = run.catch(() => {})
    return run
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
