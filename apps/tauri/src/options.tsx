// 设置窗口入口：挂载 OptionsApp（1200×800 普通窗口，?tab= 直达与 Chrome options 一致）。

import React from 'react'
import { createRoot } from 'react-dom/client'
import { OptionsApp, PortsContext, initTheme } from '@fund01/ui'
import type { Ports } from '@fund01/core'
import { TauriDataPort } from './ports/tauriDataPort'
import { TauriConfigPort } from './ports/tauriConfigPort'
import { TauriEventPort } from './ports/tauriEventPort'
import { TauriWindowPort } from './ports/tauriWindowPort'

initTheme()

async function bootstrap() {
  const configPort = new TauriConfigPort()
  await configPort.init()

  // 与 Chrome 端一致的 ?tab= 解析（Tauri webview 的 location.search 同样可用）
  const urlTab = new URLSearchParams(window.location.search).get('tab')
  const initialTab =
    urlTab === 'holdings' || urlTab === 'data' || urlTab === 'menubar' ? urlTab : 'general'
  // URL hash 锚点（options.html?tab=holdings#add-fund）：popup 空状态直达「添加/导入持仓」区块
  const initialAnchor = window.location.hash.replace(/^#/, '') || undefined

  const windowPort = new TauriWindowPort()
  const ports: Ports = {
    data: new TauriDataPort(),
    config: configPort,
    event: new TauriEventPort(),
    window: windowPort,
  }

  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <PortsContext.Provider value={ports}>
        <OptionsApp initialTab={initialTab} initialAnchor={initialAnchor} version={windowPort.getVersion()} />
      </PortsContext.Provider>
    </React.StrictMode>,
  )
}

void bootstrap()
