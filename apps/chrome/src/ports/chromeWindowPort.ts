import type { SettingsAnchorId, SettingsTabId, WindowPort } from '@fund01/core'

/**
 * Chrome 扩展窗口 Port 实现。
 * - openSettings()：不带 tab 走 chrome.runtime.openOptionsPage()（自动复用已打开的 options 标签页）；
 *   带 tab 用 chrome.tabs.create 显式携带 ?tab=，options 页入口读到参数后直达对应 tab
 *   （openOptionsPage 无法带参数；tabs.create 无需 "tabs" 权限）
 * - openSettings(tab, anchor)：anchor 仅对 holdings tab 有意义，拼进 URL hash（options.html?tab=holdings#add-fund），
 *   options 入口读到后滚动定位到对应区块
 * - openInNewWindow()：把 popup.html 作为普通网页在新标签页打开（?tab=1 进入「标签页模式」铺满视口）
 * - getVersion()：读 manifest 版本号
 * - 不实现 supportsMenubar()（菜单栏是 tauri/macOS 能力，chrome 设置页不显示「菜单栏」tab）
 * - supportsBadge()：返回 true（扩展角标是 chrome 能力）
 */
export class ChromeWindowPort implements WindowPort {
  async openSettings(tab?: SettingsTabId, anchor?: SettingsAnchorId): Promise<void> {
    if (tab) {
      const hash = anchor && tab === 'holdings' ? `#${anchor}` : ''
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`options.html?tab=${tab}${hash}`),
      })
    } else {
      await chrome.runtime.openOptionsPage()
    }
  }

  async openInNewWindow(): Promise<void> {
    window.open(chrome.runtime.getURL('popup.html?tab=1'), '_blank')
  }

  /** 扩展角标是 Chrome 扩展能力 */
  supportsBadge(): boolean {
    return true
  }

  /** 外部链接：chrome.tabs.create 新标签页打开（扩展页 CSP 拦截 window.open，必须走 tabs API） */
  async openExternal(url: string): Promise<void> {
    await chrome.tabs.create({url})
  }

  getVersion(): string {
    return chrome.runtime.getManifest().version
  }
}
