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
    urlTab === 'holdings' || urlTab === 'data' || urlTab === 'menubar' || urlTab === 'about'
      ? urlTab
      : 'general'
  // URL hash 锚点（options.html?tab=holdings#add-fund）：popup 空状态直达「添加/导入持仓」区块
  const initialAnchor = window.location.hash.replace(/^#/, '') || undefined

  const windowPort = new TauriWindowPort()
  const ports: Ports = {
    data: new TauriDataPort(),
    config: configPort,
    event: new TauriEventPort(),
    window: windowPort,
  }
  // 版本号先 await 再渲染：getVersion() 同步接口首次调用会回落 1.0.0（invoke 未返回），
  // 必须等 preloadVersion 拿到真实版本，否则设置页版本号永远显示 1.0.0。
  const version = await windowPort.preloadVersion()

  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <PortsContext.Provider value={ports}>
        <OptionsApp initialTab={initialTab} initialAnchor={initialAnchor} version={version} />
      </PortsContext.Provider>
    </React.StrictMode>,
  )
}

void bootstrap()
