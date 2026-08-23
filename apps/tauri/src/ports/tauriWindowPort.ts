import { invoke } from '@tauri-apps/api/core'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { save } from '@tauri-apps/plugin-dialog'
import type { CheckUpdateResult, SettingsAnchorId, SettingsTabId, WindowPort } from '@fund01/core'

let versionCache = ''

/** Tauri 窗口 Port：打开设置窗口 / popup 独立页面（Rust 创建/聚焦对应窗口） */
export class TauriWindowPort implements WindowPort {
  async openSettings(tab?: SettingsTabId, anchor?: SettingsAnchorId): Promise<void> {
    await invoke('open_settings_window', {
      tab: tab ?? null,
      // anchor 仅对 holdings tab 有意义；非 holdings 场景 Rust 侧忽略
      anchor: tab === 'holdings' ? (anchor ?? null) : null,
    })
  }

  /** 打开 popup 独立页面窗口（对齐 Chrome popup.html?tab=1 标签页模式） */
  async openInNewWindow(): Promise<void> {
    await invoke('open_popup_tab_window')
  }

  /** 桌面端打开的是独立窗口，按钮文案与 Chrome 标签页区分 */
  openInNewWindowTitle(): string {
    return '在新窗口中打开'
  }

  /** 桌面版支持 macOS 菜单栏 → 设置页显示「菜单栏」tab */
  supportsMenubar(): boolean {
    return true
  }

  /** 扩展角标是 Chrome 扩展能力，桌面版不显示该设置项 */
  supportsBadge(): boolean {
    return false
  }

  /** 桌面版支持开机自启动（macOS 登录项）→ 设置页显示「App 设置」card */
  supportsAutostart(): boolean {
    return true
  }

  /** 当前是否已注册开机自启动（autostart 插件读系统登录项状态） */
  async getAutostartEnabled(): Promise<boolean> {
    return isEnabled()
  }

  /** 设置开机自启动开关 */
  async setAutostartEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      await enable()
    } else {
      await disable()
    }
  }

  /**
   * 导出配置保存：弹系统 NSSavePanel（tauri-plugin-dialog save）让用户选目录 + 文件名，
   * 再把内容经 Rust command 写盘。取消返回 null（UI 静默返回）。
   */
  async saveTextFileDialog(defaultName: string, content: string): Promise<string | null> {
    const path = await save({ defaultPath: defaultName })
    if (!path || Array.isArray(path)) return null
    await invoke('export_config_file', { path, content })
    return path
  }

  /** 外部链接：Rust 侧用系统默认浏览器打开（macOS `open`） */
  async openExternal(url: string): Promise<void> {
    await invoke('open_external', {url})
  }

  getVersion(): string {
    if (!versionCache) {
      invoke<string>('get_version').then((v) => {
        versionCache = v
      })
    }
    return versionCache || '1.0.0'
  }

  /**
   * 预热版本号缓存并返回真实版本。
   * getVersion() 是同步接口，首次调用时 invoke 未返回会回落 '1.0.0'（设置页版本号
   * 显示 bug 的根源）；options 入口 bootstrap 先 await 这里再渲染即可拿到真实版本。
   */
  async preloadVersion(): Promise<string> {
    const v = await invoke<string>('get_version')
    versionCache = v
    return v
  }

  /**
   * 检查更新：Rust 侧拉远端静态 JSON 比较版本（结果内存缓存 1h）；null = 已最新。
   * force=true（「关于」页手动点击）时绕过缓存真正请求远端一次。
   */
  async checkUpdate(force?: boolean): Promise<CheckUpdateResult | null> {
    return invoke<CheckUpdateResult | null>('check_update', {force: !!force})
  }
}
