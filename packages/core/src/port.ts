import type {
  AppConfig,
  FundHistoryPayload,
  FundHistoryRange,
  FundIntradayPayload,
  HoldingsPayload,
  IndexHistoryPayload,
  IndexItem,
  IntradayPoint,
  QuoteUpdate,
  ResolveFundPayload,
} from './types'

/** UI 数据访问抽象 —— 各 app 必须提供实现 */
export interface DataPort {
  /** 触发后端立即刷新（异步，不等待结果） */
  triggerRefresh(): Promise<void>
  /**
   * 清除缓存并重新加载（Chrome：清 chrome.storage.local 全部 cache-* + 强制刷新；
   * 用于「改动代码后缓存不失效」场景）。Tauri 无 SW 缓存概念，可不实现（UI 回退 triggerRefresh）。
   */
  clearCache?(): Promise<void>
  /** 持仓汇总（后端已合并行情 + 配置） */
  fetchHoldings(): Promise<HoldingsPayload>
  fetchIndices(): Promise<IndexItem[]>
  fetchFundHistory(code: string, range?: FundHistoryRange): Promise<FundHistoryPayload>
  fetchIndexHistory(code: string, range: string): Promise<IndexHistoryPayload>
  fetchFundIntraday(fundKey: string): Promise<IntradayPoint[]>
  resolveFund(payload: {
    code: string
    type?: 'hold'
    name?: string
    sectors?: string[]
  }): Promise<ResolveFundPayload>
}

/** UI 配置访问抽象（同步读避免闪烁 + 异步推后端） */
export interface ConfigPort {
  /** 同步读本地缓存（UI 不闪） */
  getConfig(): AppConfig
  /** 写本地缓存 + 异步推后端 */
  saveConfig(config: AppConfig): Promise<void>
  /** 订阅配置变更（多窗口同步） */
  onChanged(cb: (config: AppConfig) => void): () => void
}

/** 后端 → 前端事件订阅抽象 */
export interface EventPort {
  /** 订阅后端推送的行情更新事件 */
  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void
  /** 订阅配置变更（多窗口同步） */
  onConfigChange(cb: (config: AppConfig) => void): () => void
  /**
   * 订阅「点击 menubar 分组实例 → 浮窗直达分组 tab」事件（Tauri 实现；Chrome 不实现 → undefined → UI 跳过）。
   * payload 即 popup 分组 tab id：'all' / 分组名 / '__ungrouped__'
   */
  onPopupOpenGroup?(cb: (tabId: string) => void): () => void
  /**
   * 前端调试日志转发（可选）：Tauri 实现 → invoke dbg_log 打到终端 stdout；Chrome 实现 → console.log。
   * webview 的 console 在 Tauri 默认不进终端，UI 交互链路（开关点击等）用它对齐 Rust 侧日志排查。
   */
  emitDebug?(msg: string): void
}

/** 设置页一级 tab 标识（OptionsApp 与 openSettings 共用） */
export type SettingsTabId = 'general' | 'holdings' | 'data' | 'menubar' | 'docs' | 'about'

/**
 * 设置页「持仓」tab 内的区块锚点 id（与 OptionsApp 的 SectionCard id / HoldingsNav 一致）。
 * 仅对 tab='holdings' 有意义；用于 popup 空状态等场景直达「添加持仓」「导入持仓」区块。
 */
export type SettingsAnchorId =
  | 'holdings-groups'
  | 'add-fund'
  | 'edit-holdings'
  | 'import-holdings'

/** 窗口 / 导航操作抽象 —— 各 app 必须提供实现（Chrome 扩展 API / Tauri 窗口 API） */
export interface WindowPort {
  /**
   * 打开设置页；tab 省略 = 通用页，可指定直达 tab（Chrome: openOptionsPage / tabs.create；Tauri: 打开设置窗口）。
   * anchor 仅对 tab='holdings' 有意义：打开后滚动到对应区块（Chrome: 通过 URL hash 传递；
   * Tauri: 创建窗口时拼入 URL。设置窗口已存在时仅聚焦，不重新导航）。
   */
  openSettings(tab?: SettingsTabId, anchor?: SettingsAnchorId): Promise<void>
  /** 新窗口 / 新标签页打开主视图（Chrome: window.open(popup.html?tab=1)；Tauri 无此概念可不实现，UI 自动隐藏按钮） */
  openInNewWindow?(): Promise<void>
  /** 是否支持菜单栏（Tauri 实现返回 true；Chrome 不实现 → undefined → UI 自动隐藏「菜单栏」设置 tab） */
  supportsMenubar?(): boolean
  /** 是否支持扩展角标（Chrome 实现返回 true；Tauri 实现返回 false → UI 自动隐藏「扩展角标」设置项） */
  supportsBadge?(): boolean
  /** 应用版本号（Chrome: getManifest().version；Tauri: invoke 或构建注入） */
  getVersion(): string
  /**
   * 用系统默认方式打开外部链接（Chrome: chrome.tabs.create 新标签页；Tauri: 系统浏览器）。
   * 不实现时 UI 回退 window.open（Chrome 扩展 CSP 会拦截外部跳转，因此 Chrome 端必须实现）。
   */
  openExternal?(url: string): Promise<void>
}

/** UI 与具体 app 之间注入的 Port 集合 */
export interface Ports {
  data: DataPort
  config: ConfigPort
  event: EventPort
  window: WindowPort
}
