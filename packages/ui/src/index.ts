export { PortsContext, usePorts } from './context'
export { App } from './App'
// 供入口在 React 挂载前同步应用主题（写 <html data-theme> + light/dark class），
// 避免暗色偏好下首帧按亮色色阶绘制造成白闪。
export { initTheme } from './theme'
