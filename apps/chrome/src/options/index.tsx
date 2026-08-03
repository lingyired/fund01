import React from 'react'
import { createRoot } from 'react-dom/client'
import { OptionsApp, PortsContext, initTheme } from '@fund01/ui'
import type { Ports } from '@fund01/core'
import { ChromeDataPort } from '../ports/chromeDataPort'
import { ChromeConfigPort } from '../ports/chromeConfigPort'
import { ChromeEventPort } from '../ports/chromeEventPort'

// 主题必须在 createRoot().render() 之前同步应用：Radix Themes 依赖 <html> 上的
// light/dark class 决定色阶，若等到 React 的 useEffect 才写入，暗色偏好下会先按
// 亮色绘制一帧，每次打开设置页都白闪。
initTheme()

// 注入三个 Port 实现，UI 通过 PortsContext 拿到运行时能力
const ports: Ports = {
  data: new ChromeDataPort(),
  config: new ChromeConfigPort(),
  event: new ChromeEventPort(),
}

// OptionsApp 自身已用 <Theme> 包裹（Radix 组件需要 ThemeContext），这里只负责注入 Port。
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PortsContext.Provider value={ports}>
      <OptionsApp />
    </PortsContext.Provider>
  </React.StrictMode>,
)
