import React from 'react'
import { createRoot } from 'react-dom/client'
import { OptionsApp, PortsContext, initTheme } from '@fund01/ui'
import type { Ports } from '@fund01/core'
import { ChromeDataPort } from '../ports/chromeDataPort'
import { ChromeConfigPort } from '../ports/chromeConfigPort'
import { ChromeEventPort } from '../ports/chromeEventPort'
import { ChromeWindowPort } from '../ports/chromeWindowPort'

// 主题必须在 createRoot().render() 之前同步应用：Radix Themes 依赖 <html> 上的
// light/dark class 决定色阶，若等到 React 的 useEffect 才写入，暗色偏好下会先按
// 亮色绘制一帧，每次打开设置页都白闪。
initTheme()

// 支持从 popup footer「修改持仓」按钮以 options.html?tab=holdings 打开，直达「持仓」tab；
// 非法/缺失参数一律回落「通用」。anchor 来自 URL hash（popup 空状态「添加持仓/批量导入」按钮
// 打开 options.html?tab=holdings#add-fund），仅 holdings tab 下生效。
const urlTab = new URLSearchParams(location.search).get('tab')
const initialTab = urlTab === 'holdings' || urlTab === 'data' ? urlTab : 'general'
const initialAnchor = location.hash.replace(/^#/, '') || undefined

// 注入四个 Port 实现，UI 通过 PortsContext 拿到运行时能力（含窗口/导航操作）
const ports: Ports = {
  data: new ChromeDataPort(),
  config: new ChromeConfigPort(),
  event: new ChromeEventPort(),
  window: new ChromeWindowPort(),
}

// 版本号（品牌名右侧显示）统一走 WindowPort，不直接读 chrome API
const version = ports.window.getVersion()

// OptionsApp 自身已用 <Theme> 包裹（Radix 组件需要 ThemeContext），这里只负责注入 Port。
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PortsContext.Provider value={ports}>
      <OptionsApp initialTab={initialTab} initialAnchor={initialAnchor} version={version} />
    </PortsContext.Provider>
  </React.StrictMode>,
)
