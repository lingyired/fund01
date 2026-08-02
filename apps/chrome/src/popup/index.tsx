import React from 'react'
import { createRoot } from 'react-dom/client'
import { App, PortsContext, initTheme } from '@fund01/ui'
import type { Ports } from '@fund01/core'
import { ChromeDataPort } from '../ports/chromeDataPort'
import { ChromeConfigPort } from '../ports/chromeConfigPort'
import { ChromeEventPort } from '../ports/chromeEventPort'

// popup 视口适配：popup.html 内联 <style> 给 popup 模式设了保守默认高度（680x600）。
// 当 popup.html 作为普通标签页打开（URL 带 ?tab=1）时，高度直接等于浏览器窗口高度
// （window.innerHeight），最低高度保持与 popup 现状一致（600px）。
// popup 模式下，运行时按 popup 窗口实际高度精确覆盖，避免整窗滚动条。
// （MV3 CSP 禁止内联 script，所以兜底逻辑必须放在打包的 popup.js 中执行）
// 注意：不能用 window.opener 判断 tab 模式——扩展环境 CSP 经常把 opener 置为 null，
// 用显式 URL 参数更可靠。
;(function applyViewportMode() {
  const isTab = new URLSearchParams(location.search).get('tab') === '1'
  const style = document.createElement('style')
  style.id = 'popup-viewport-mode'

  if (isTab) {
    // 标签页模式：高度直接等于浏览器窗口高度 window.innerHeight，窗口缩放时实时跟随；
    // 最低高度保持与 popup 现状一致（600px）；必须清掉 popup.html 内联的
    // max-height:600px 上限，否则 tab 高度会被锁死在 600px；禁止 body 滚动，只让内容区滚动。
    const applyTabHeight = () => {
      const h = window.innerHeight || 600
      style.textContent =
        `html,body,#root{height:${h}px !important;min-height:600px !important;max-height:none !important;max-width:none !important;width:auto !important;overflow:hidden !important;}`
    }
    applyTabHeight()
    window.addEventListener('resize', applyTabHeight)
  } else {
    // popup 模式：Chrome popup 窗口高度被浏览器限制（多数环境约 600px），
    // 直接取 popup 窗口实际高度 window.innerHeight 作为 body 高度，
    // 使 body 恰好填满窗口、不产生整窗滚动条；内容溢出由内部持仓列表滚动区处理。
    const h = window.innerHeight || 600
    style.textContent = `html,body,#root{height:${h}px !important;max-height:${h}px !important;min-height:0 !important;overflow:hidden !important;}`
  }

  document.head.appendChild(style)
})()

// 主题必须在 createRoot().render() 之前同步应用：Radix Themes 依赖 <html> 上的
// light/dark class 决定色阶，若等到 React 的 useEffect 才写入，暗色偏好下会先按
// 亮色绘制一帧，每次打开 popup 都白闪。
initTheme()

// 注入三个 Port 实现，UI 通过 PortsContext 拿到运行时能力
const ports: Ports = {
  data: new ChromeDataPort(),
  config: new ChromeConfigPort(),
  event: new ChromeEventPort(),
}

// 读取版本号注入 App
const version = chrome.runtime.getManifest().version

// 点击「新标签页」按钮时，把 popup.html 作为普通网页在新标签页打开，
// URL 带 ?tab=1 让 popup.js 进入「标签页模式」（高度等于窗口高度、铺满视口）。
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
