// menubar 浮窗入口：挂载 @fund01/ui 的 App（与 Chrome popup 同一组件，UI 零改动）。
// 窗口固定 680×600（tauri.conf / window.rs 创建），无需 viewport 适配脚本。

import React from 'react'
import { createRoot } from 'react-dom/client'
import { App, PortsContext, initTheme } from '@fund01/ui'
import type { Ports } from '@fund01/core'
import { TauriDataPort } from './ports/tauriDataPort'
import { TauriConfigPort } from './ports/tauriConfigPort'
import { TauriEventPort } from './ports/tauriEventPort'
import { TauriWindowPort } from './ports/tauriWindowPort'

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
