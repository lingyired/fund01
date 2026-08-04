import type { SettingsTabId, WindowPort } from '@fund01/core'

/**
 * Chrome 扩展窗口 Port 实现。
 * - openSettings()：不带 tab 走 chrome.runtime.openOptionsPage()（自动复用已打开的 options 标签页）；
 *   带 tab 用 chrome.tabs.create 显式携带 ?tab=，options 页入口读到参数后直达对应 tab
 *   （openOptionsPage 无法带参数；tabs.create 无需 "tabs" 权限）
 * - openInNewWindow()：把 popup.html 作为普通网页在新标签页打开（?tab=1 进入「标签页模式」铺满视口）
 * - getVersion()：读 manifest 版本号
 * - 不实现 supportsMenubar()（菜单栏是 tauri/macOS 能力，chrome 设置页不显示「菜单栏」tab）
 */
export class ChromeWindowPort implements WindowPort {
  async openSettings(tab?: SettingsTabId): Promise<void> {
    if (tab) {
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`options.html?tab=${tab}`),
      })
    } else {
      await chrome.runtime.openOptionsPage()
    }
  }

  async openInNewWindow(): Promise<void> {
    window.open(chrome.runtime.getURL('popup.html?tab=1'), '_blank')
  }

  getVersion(): string {
    return chrome.runtime.getManifest().version
  }
}
