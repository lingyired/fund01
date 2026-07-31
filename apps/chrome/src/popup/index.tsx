import React from 'react'
import { createRoot } from 'react-dom/client'
import { App, PortsContext } from '@fund01/ui'
import type { Ports } from '@fund01/core'
import { ChromeDataPort } from '../ports/chromeDataPort'
import { ChromeConfigPort } from '../ports/chromeConfigPort'
import { ChromeEventPort } from '../ports/chromeEventPort'

// popup 视口适配：popup.html 内联 <style> 为 popup 模式设定了固定 666x900 尺寸。
// 当 popup.html 作为普通标签页打开（URL 带 ?tab=1）时，移除这些固定尺寸约束，
// 让内容自然铺满浏览器视口。
// 仅 popup 模式下注入「高度兜底」避免超出屏幕；标签页模式由浏览器视口决定。
// （MV3 CSP 禁止内联 script，所以兜底逻辑必须放在打包的 popup.js 中执行）
// 注意：不能用 window.opener 判断 tab 模式——扩展环境 CSP 经常把 opener 置为 null，
// 用显式 URL 参数更可靠。
;(function applyViewportMode() {
  const isTab = new URLSearchParams(location.search).get('tab') === '1'
  try {
    const s = document.createElement('style')
    s.id = 'popup-viewport-mode'
    if (isTab) {
      // 标签页模式：移除 popup.html 强制的 666px 宽度与 900px 最小高度
      s.textContent =
        'html,body,#root{width:auto !important;max-width:none !important;min-height:0 !important;}'
    } else {
      // popup 模式：高度兜底，min(900, 屏幕可用高度)
      const avail = window.screen.availHeight || window.screen.height || 900
      const h = Math.min(900, avail)
      s.textContent = `html,body,#root{height:${h}px !important;max-height:${h}px !important;}`
    }
    document.head.appendChild(s)
  } catch {
    // 忽略：保留 popup.html 里的默认样式
  }
})()

// 注入三个 Port 实现，UI 通过 PortsContext 拿到运行时能力
const ports: Ports = {
  data: new ChromeDataPort(),
  config: new ChromeConfigPort(),
  event: new ChromeEventPort(),
}

// 读取版本号注入 App
const version = chrome.runtime.getManifest().version

// 点击「新标签页」按钮时，把 popup.html 作为普通网页在新标签页打开，
// URL 带 ?tab=1 让 popup.js 进入「标签页模式」（移除 666x900 固定尺寸）。
function openAsTab() {
  window.open(chrome.runtime.getURL('popup.html?tab=1'), '_blank')
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PortsContext.Provider value={ports}>
      <App version={version} openAsTab={openAsTab} />
    </PortsContext.Provider>
  </React.StrictMode>,
)
