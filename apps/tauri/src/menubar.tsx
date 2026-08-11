// menubar 浮窗入口 + popup 独立页面（popup-tab）共用：挂载 @fund01/ui 的 App
// （与 Chrome popup 同一组件，UI 零改动）。
// - menubar 浮窗：窗口固定 680×600（window.rs 创建），index.html 内联样式即最终样式，无需覆盖；
// - popup-tab 独立窗口：URL 带 ?tab=1（对齐 Chrome 标签页模式标记），运行时按窗口实际视口
//   （window.innerHeight）铺满，窗口缩放时实时跟随；必须清掉 index.html 内联的
//   max-width:680px / max-height:600px 上限，否则内容被锁死在 680×600 左上角。

import React from 'react'
import { createRoot } from 'react-dom/client'
import { App, PortsContext, initTheme } from '@fund01/ui'
import type { Ports } from '@fund01/core'
import { TauriDataPort } from './ports/tauriDataPort'
import { TauriConfigPort } from './ports/tauriConfigPort'
import { TauriEventPort } from './ports/tauriEventPort'
import { TauriWindowPort } from './ports/tauriWindowPort'

// popup-tab 独立窗口（?tab=1）视口适配：铺满窗口视口并跟随 resize。
// menubar 浮窗（无参数）保持 index.html 内联的 680×600，不动。
;(function applyViewportMode() {
  const isTab = new URLSearchParams(location.search).get('tab') === '1'
  if (!isTab) return
  const style = document.createElement('style')
  style.id = 'popup-viewport-mode'
  const applyTabHeight = () => {
    const h = window.innerHeight || 600
    style.textContent =
      `html,body,#root{height:${h}px !important;min-height:600px !important;max-height:none !important;max-width:none !important;width:auto !important;overflow:hidden !important;}`
  }
  applyTabHeight()
  window.addEventListener('resize', applyTabHeight)
  document.head.appendChild(style)
})()

// 主题必须在 createRoot().render() 之前同步应用，避免暗色首帧白闪
initTheme()

async function bootstrap() {
  const configPort = new TauriConfigPort()
  await configPort.init()

  const ports: Ports = {
    data: new TauriDataPort(),
    config: configPort,
    event: new TauriEventPort(),
    window: new TauriWindowPort(),
  }

  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <PortsContext.Provider value={ports}>
        <App />
      </PortsContext.Provider>
    </React.StrictMode>,
  )
}

void bootstrap()
