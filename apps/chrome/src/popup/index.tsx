import React from 'react'
import { createRoot } from 'react-dom/client'
import { App, PortsContext } from '@fund01/ui'
import type { Ports } from '@fund01/core'
import { ChromeDataPort } from '../ports/chromeDataPort'
import { ChromeConfigPort } from '../ports/chromeConfigPort'
import { ChromeEventPort } from '../ports/chromeEventPort'

// 注入三个 Port 实现，UI 通过 PortsContext 拿到运行时能力
const ports: Ports = {
  data: new ChromeDataPort(),
  config: new ChromeConfigPort(),
  event: new ChromeEventPort(),
}

// 读取版本号注入 App
const version = chrome.runtime.getManifest().version

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PortsContext.Provider value={ports}>
      <App version={version} />
    </PortsContext.Provider>
  </React.StrictMode>,
)
