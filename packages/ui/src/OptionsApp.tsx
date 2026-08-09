import {useEffect, useMemo, useRef, useState} from 'react'
import {
  Check,
  Copy,
  Database,
  Download,
  FolderTree,
  GripVertical,
  Info,
  Menu,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  AlertDialog,
  Button,
  IconButton,
  ScrollArea,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  Tabs,
  TextArea,
  TextField,
  Theme,
} from '@radix-ui/themes'
import type {
  AppConfig,
  AppThemePref,
  BadgeMode,
  MenubarLayout,
  ResolveFundResult,
  SettingsTabId,
} from '@fund01/core'
import {
  AVAILABLE_INDICES,
  DEFAULT_SELECTED_INDICES,
  MAX_SELECTED_INDICES,
  MENUBAR_DEFAULTS,
  MENUBAR_FONT_RANGES,
  MENUBAR_OVERVIEW_KEY,
  MIN_REFRESH_INTERVAL,
  normalizeHexColor,
  todayDateStr,
} from '@fund01/core'
import {cn} from '@fund01/core'
import {
  addHoldingGroup,
  createFund,
  exportConfig,
  fetchSettings,
  importConfig,
  listHoldingGroups,
  pickBasisNav,
  refreshHoldingsCache,
  removeHoldingGroup,
  removeHoldingGroupWithFunds,
  renameHoldingGroup,
  resetConfig,
  setFundAllocation,
  setHoldingGroupOrder,
  updateSettings,
  type AmountBasis,
} from './lib/fundOps'
import {
  deriveRowReadonly,
  loadEditRows,
  type EditRow,
} from './lib/batchEdit'
import {parseImport, IMPORT_SAMPLE, type ImportEntry} from './lib/importHoldings'
import {FundFormBody} from './components/FundFormDialog'
import {HOLD_PROFIT_TERMS_NOTE} from './components/fundBits'
import {HoldingsNav, HOLDINGS_NAV_ITEMS} from './components/HoldingsNav'
import {applyTheme} from './theme'
import {usePorts} from './context'
import importPromptMd from '../../../docs/import-prompt.md?raw'
import './index.css'

/* ── Tab 定义 ─────────────────────────────────────────────── */
type TabId = SettingsTabId

const TABS: {id: TabId; label: string; icon: typeof Settings2}[] = [
  {id: 'general', label: '通用', icon: Settings2},
  {id: 'holdings', label: '持仓', icon: FolderTree},
  {id: 'menubar', label: '菜单栏', icon: Menu},
  {id: 'data', label: '备份', icon: Database},
  {id: 'docs', label: '数据说明', icon: Info},
]

const THEME_OPTIONS: {value: AppThemePref; label: string}[] = [
  {value: 'system', label: '跟随系统'},
  {value: 'light', label: '亮色'},
  {value: 'dark', label: '暗色'},
]

const BADGE_OPTIONS: {value: BadgeMode; label: string}[] = [
  {value: 'percent', label: '收益率%'},
  {value: 'amount', label: '收益额'},
  {value: 'hidden', label: '隐藏'},
]

export function OptionsApp({
  initialTab,
  initialAnchor,
  version,
}: {
  initialTab?: TabId
  /**
   * 打开后要滚动定位的「持仓」tab 区块锚点 id（来自 URL hash，如 options.html?tab=holdings#add-fund）。
   * 仅 initialTab='holdings' 时有意义；区块渲染完成后平滑滚动到对应 SectionCard。
   */
  initialAnchor?: string
  /** 扩展版本号，渲染在品牌名右侧（vX.Y.Z） */
  version?: string
}) {
  const ports = usePorts()
  const [tab, setTab] = useState<TabId>(() => {
    const t = initialTab ?? 'general'
    // 平台能力防御：不支持菜单栏的端（chrome）即使被 ?tab=menubar 直达也回落通用页
    if (t === 'menubar' && !ports.window.supportsMenubar?.()) return 'general'
    return t
  })
  // 仅保留当前平台可用的 tab（menubar 只在 tauri 显示）
  const visibleTabs = useMemo(
    () => TABS.filter((t) => t.id !== 'menubar' || !!ports.window.supportsMenubar?.()),
    [ports],
  )
  // 导入持仓成功后会自增，用来触发「编辑持仓」实时刷新
  const [holdingsReload, setHoldingsReload] = useState(0)
  // 分组列表变更（持仓分组增删改、导入自动建组）后自增，让持仓/添加/编辑/导入分区同步分组列表
  const [groupsReload, setGroupsReload] = useState(0)

  // 外部直达区块（popup 空状态「添加持仓/批量导入」按钮 → options.html?tab=holdings#add-fund）：
  // 仅当落在 holdings tab 且锚点 id 已知时生效；等 Tabs.Content 渲染后平滑滚动到对应 SectionCard
  //（SectionCard 自带 scroll-mt-20，滚动时自动让出吸顶 HoldingsNav 高度）。
  const anchorIds = useMemo(
    () => new Set<string>(HOLDINGS_NAV_ITEMS.map((i) => i.id)),
    [],
  )
  const pendingAnchor = useMemo(
    () =>
      initialAnchor && tab === 'holdings' && anchorIds.has(initialAnchor)
        ? initialAnchor
        : null,
    [initialAnchor, tab, anchorIds],
  )
  useEffect(() => {
    if (!pendingAnchor) return
    // 等 holdings tab 内容挂载（首次渲染 + StrictMode 双挂载都覆盖）
    const t = window.setTimeout(() => {
      const el = document.getElementById(pendingAnchor)
      if (el) el.scrollIntoView({behavior: 'smooth', block: 'start'})
    }, 60)
    return () => window.clearTimeout(t)
  }, [pendingAnchor])

  return (
    <Theme accentColor="blue" grayColor="gray" radius="small">
      <Tabs.Root
        value={tab}
        onValueChange={(v) => setTab(v as TabId)}
        className="flex min-h-screen flex-col bg-app text-ink"
      >
        {/* 顶部：品牌 + 一级 Tab 导航（激活态颜色由 Radix 主题变量驱动，暗色模式自动正确） */}
        <header className="shrink-0 border-b border-line/70 bg-panel/85">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
            <div className="flex items-center gap-2">
              <span className="font-display text-lg font-extrabold tracking-tight">
                Fund01
              </span>
              {version ? (
                <span className="font-mono text-[11px] text-muted">
                  v{version}
                </span>
              ) : null}
              <span className="font-mono text-[11px] text-muted">设置</span>
            </div>
            <span className="text-[11px] text-muted">修改即时保存到本机浏览器。</span>
          </div>
          <div className="mx-auto max-w-5xl px-6">
            <Tabs.List>
              {visibleTabs.map((t) => {
                const Icon = t.icon
                return (
                  <Tabs.Trigger key={t.id} value={t.id} className="gap-1.5">
                    <Icon className="h-4 w-4" />
                    {t.label}
                  </Tabs.Trigger>
                )
              })}
            </Tabs.List>
          </div>
        </header>

        {/* 内容区：每个 tab 只渲染自己的内容 */}
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-6">
          <Tabs.Content value="general">
            <GeneralSection onNavigate={setTab} />
          </Tabs.Content>

          <Tabs.Content value="holdings">
            <HoldingsNav />
            <div className="space-y-8">
              <HoldingGroupsSection
                groupsReload={groupsReload}
                onGroupsChanged={() => setGroupsReload((t) => t + 1)}
              />
              <AddFundSection
                groupsReload={groupsReload}
                onAdded={() => setHoldingsReload((t) => t + 1)}
              />
              <EditHoldingsSection
                reloadSignal={holdingsReload}
                groupsReload={groupsReload}
                onGroupsChanged={() => setGroupsReload((t) => t + 1)}
              />
              <ImportSection
                groupsReload={groupsReload}
                onGroupsChanged={() => setGroupsReload((t) => t + 1)}
                onImported={() => setHoldingsReload((t) => t + 1)}
              />
              <TermsNoteSection />
            </div>
          </Tabs.Content>

          <Tabs.Content value="data">
            <DataBackupSection />
          </Tabs.Content>

          <Tabs.Content value="docs">
            <DataDocsSection />
          </Tabs.Content>

          <Tabs.Content value="menubar">
            <MenubarSection />
          </Tabs.Content>
        </main>
      </Tabs.Root>
    </Theme>
  )
}

/* ── 通用卡片外壳 ─────────────────────────────────────────── */
function SectionCard({
  id,
  title,
  children,
}: {
  /** 滚动锚点 id（浮动导航跳转目标） */
  id?: string
  title?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-20">
      {title ? (
        <h1 className="mb-3 font-display text-xl font-bold tracking-tight text-ink">
          {title}
        </h1>
      ) : null}
      <div className="space-y-3 rounded-xl border border-line/70 bg-paper p-4 shadow-card">
        {children}
      </div>
    </section>
  )
}

/* ── 通用（个人设置） ─────────────────────────────────────── */
function GeneralSection({
  onNavigate,
}: {
  onNavigate: (tab: TabId) => void
}) {
  const ports = usePorts()
  const [badgeMode, setBadgeMode] = useState<BadgeMode>('percent')
  const [themePref, setThemePref] = useState<AppThemePref>('system')
  const [selectedIndices, setSelectedIndices] = useState<string[]>(
    DEFAULT_SELECTED_INDICES,
  )
  // 指数拖拽排序：Pointer Events 实现（Chrome / Tauri WKWebView 行为一致，不依赖
  // 浏览器原生 HTML5 DnD —— WKWebView 的 dragstart/dragover/drop 支持与 Chromium 差异大）。
  // 拖动中按指针位置实时交换行（只改 UI），松开时把最终顺序一次性持久化。
  const dragState = useRef<{
    from: number // 拖起时的行 index
    index: number // 当前所在行 index（实时交换后更新）
    pointerId: number
    startY: number
    active: boolean // 移动超过阈值后进入拖拽
  } | null>(null)
  const dragOrder = useRef<string[] | null>(null) // 拖拽中的最新顺序（避免 state 渲染滞后）
  const rowEls = useRef<(HTMLDivElement | null)[]>([])
  const [dragIndex, setDragIndex] = useState<number | null>(null) // 仅驱动样式（拖起行半透明）
  const [quoteSource, setQuoteSource] = useState<'fund123' | 'fundmnfinfo'>(
    'fundmnfinfo',
  )
  const [trading, setTrading] = useState('')
  const [nonTrading, setNonTrading] = useState('')
  const [savingInterval, setSavingInterval] = useState(false)
  const [savingSource, setSavingSource] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const s = fetchSettings(ports)
    setBadgeMode(
      s.badgeMode === 'amount' || s.badgeMode === 'hidden' ? s.badgeMode : 'percent',
    )
    setThemePref(s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system')
    setSelectedIndices(
      s.selectedIndices && s.selectedIndices.length > 0
        ? s.selectedIndices
        : DEFAULT_SELECTED_INDICES,
    )
    setQuoteSource(s.quoteSource === 'fund123' ? 'fund123' : 'fundmnfinfo')
    setTrading(String(s.refreshInterval?.trading ?? ''))
    setNonTrading(String(s.refreshInterval?.nonTrading ?? ''))
  }, [ports])

  async function handleThemeChange(next: AppThemePref) {
    setThemePref(next)
    applyTheme(next)
    try {
      await updateSettings(ports, {theme: next})
    } catch {
      /* ignore */
    }
  }

  async function handleBadgeModeChange(next: BadgeMode) {
    if (next === badgeMode) return
    setBadgeMode(next)
    setError('')
    setMessage('')
    try {
      await updateSettings(ports, {badgeMode: next})
      setMessage(
        `角标显示方式已切换为 ${
          next === 'percent' ? '收益率' : next === 'amount' ? '收益额' : '隐藏'
        }`,
      )
    } catch (e: unknown) {
      setError((e as Error)?.message || '保存角标设置失败')
    }
  }

  async function toggleIndex(code: string) {
    const has = selectedIndices.includes(code)
    let next: string[]
    if (has) {
      next = selectedIndices.filter((c) => c !== code)
    } else {
      if (selectedIndices.length >= MAX_SELECTED_INDICES) return
      next = [...selectedIndices, code]
    }
    setSelectedIndices(next)
    try {
      await updateSettings(ports, {selectedIndices: next})
    } catch {
      /* ignore */
    }
  }

  /** 持久化指数顺序（popup 看板按 selectedIndices 顺序展示） */
  async function persistIndices(list: string[]) {
    try {
      await updateSettings(ports, {selectedIndices: list})
    } catch {
      /* ignore */
    }
  }

  /** 按指针 Y 坐标命中的行 index（用实时布局 rect，交换后自动更新） */
  function findRowIndex(y: number): number | null {
    const els = rowEls.current
    for (let i = 0; i < els.length; i++) {
      const el = els[i]
      // 已卸载/未挂载的行跳过（交换后 ref 数组可能短暂持有旧 DOM）
      if (!el || !el.isConnected) continue
      const r = el.getBoundingClientRect()
      if (y >= r.top && y <= r.bottom) return i
    }
    return null
  }

  /** 拖动中实时交换：把当前行移到指针命中行，并更新工作数组 */
  function swapRowTo(d: NonNullable<typeof dragState.current>, target: number) {
    if (target === d.index) return
    const base = dragOrder.current ?? selectedIndices
    const next = [...base]
    const [moved] = next.splice(d.index, 1)
    next.splice(target, 0, moved)
    d.index = target
    dragOrder.current = next
    setSelectedIndices(next)
  }

  async function handleQuoteSourceChange(next: 'fund123' | 'fundmnfinfo') {
    if (next === quoteSource) return
    setQuoteSource(next)
    setSavingSource(true)
    setError('')
    setMessage('')
    try {
      await updateSettings(ports, {quoteSource: next})
      setMessage(
        `数据源已切换为 ${next === 'fundmnfinfo' ? 'FundMNFInfo' : 'fund123'}`,
      )
    } catch (e: unknown) {
      setError((e as Error)?.message || '切换数据源失败')
    } finally {
      setSavingSource(false)
    }
  }

  async function saveRefreshInterval() {
    setSavingInterval(true)
    setError('')
    setMessage('')
    try {
      const next = await updateSettings(ports, {
        refreshInterval: {
          trading: Number(trading) || MIN_REFRESH_INTERVAL.trading,
          nonTrading: Number(nonTrading) || MIN_REFRESH_INTERVAL.nonTrading,
        },
      })
      setTrading(String(next.refreshInterval?.trading ?? ''))
      setNonTrading(String(next.refreshInterval?.nonTrading ?? ''))
      setMessage('刷新间隔已保存')
    } catch (e: unknown) {
      setError((e as Error)?.message || '保存失败')
    } finally {
      setSavingInterval(false)
    }
  }

  // 已选指数（按 selectedIndices 顺序，含不在目录里的 code 以保留既有选择）+ 候选目录
  const indexByCode = useMemo(
    () => new Map(AVAILABLE_INDICES.map((i) => [i.code, i])),
    [],
  )
  const selectedMeta = useMemo(
    () =>
      selectedIndices.map((code) => indexByCode.get(code) ?? {code, name: code}),
    [selectedIndices, indexByCode],
  )
  const candidates = useMemo(
    () => AVAILABLE_INDICES.filter((i) => !selectedIndices.includes(i.code)),
    [selectedIndices],
  )

  return (
    <SectionCard title="个人设置">
      {/* 主题 */}
      <div className="space-y-2">
        <div className="text-sm font-medium text-ink">主题</div>
        <p className="text-xs text-muted">默认跟随系统，可在亮色 / 暗色间切换。</p>
        <SegmentedControl.Root
          value={themePref}
          onValueChange={(v) => void handleThemeChange(v as AppThemePref)}
          className="pt-1"
        >
          {THEME_OPTIONS.map((opt) => (
            <SegmentedControl.Item key={opt.value} value={opt.value}>
              {opt.label}
            </SegmentedControl.Item>
          ))}
        </SegmentedControl.Root>
      </div>

      {/* 扩展角标（仅 chrome 扩展支持） */}
      {ports.window.supportsBadge?.() !== false ? (
        <div className="space-y-2 border-t border-line/50 pt-3">
          <div className="text-sm font-medium text-ink">扩展角标</div>
          <p className="text-xs text-muted">
            工具栏图标右下角的角标内容。收益额会用 k(千)/w(万)/kw(千万) 简写，文本最长 4 位；方向由角标颜色（红涨绿跌）表达。
          </p>
          <SegmentedControl.Root
            value={badgeMode}
            onValueChange={(v) => void handleBadgeModeChange(v as BadgeMode)}
            className="pt-1"
          >
            {BADGE_OPTIONS.map((opt) => (
              <SegmentedControl.Item key={opt.value} value={opt.value}>
                {opt.label}
              </SegmentedControl.Item>
            ))}
          </SegmentedControl.Root>
        </div>
      ) : null}

      {/* 指数看板 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-ink">指数看板</div>
          <span className="font-mono text-xs text-muted">
            {selectedIndices.length}/{MAX_SELECTED_INDICES}
          </span>
        </div>
        <p className="text-xs text-muted">
          勾选要在看板显示的指数（最多 5 个）。已选指数可拖动调整顺序，看板按此顺序展示。
        </p>

        {/* 已选指数：拖动排序（Pointer Events，Chrome / Tauri 通用） */}
        {selectedMeta.length > 0 ? (
          <div className="space-y-1 pt-1">
            {selectedMeta.map((item, idx) => (
              <div
                key={item.code}
                ref={(el) => {
                  rowEls.current[idx] = el
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  try {
                    ;(e.currentTarget as HTMLDivElement).setPointerCapture(
                      e.pointerId,
                    )
                  } catch {
                    /* ignore */
                  }
                  dragState.current = {
                    from: idx,
                    index: idx,
                    pointerId: e.pointerId,
                    startY: e.clientY,
                    active: false,
                  }
                  dragOrder.current = null
                  setDragIndex(idx)
                }}
                onPointerMove={(e) => {
                  const d = dragState.current
                  if (!d || e.pointerId !== d.pointerId) return
                  if (!d.active) {
                    if (Math.abs(e.clientY - d.startY) < 6) return
                    d.active = true
                  }
                  const target = findRowIndex(e.clientY)
                  if (target != null) swapRowTo(d, target)
                }}
                onPointerUp={(e) => {
                  const d = dragState.current
                  if (!d || e.pointerId !== d.pointerId) return
                  dragState.current = null
                  setDragIndex(null)
                  const order = dragOrder.current
                  dragOrder.current = null
                  if (d.active && order && d.index !== d.from) {
                    void persistIndices(order)
                  }
                }}
                onPointerCancel={() => {
                  dragState.current = null
                  dragOrder.current = null
                  setDragIndex(null)
                }}
                className={cn(
                  'flex items-center gap-2 rounded-md border border-line/50 bg-panel/60 px-2 py-1.5',
                  dragIndex === idx && 'opacity-60',
                )}
                style={{
                  cursor: dragIndex === idx ? 'grabbing' : 'grab',
                  userSelect: 'none',
                  WebkitUserSelect: 'none',
                  touchAction: 'none',
                }}
                title="按住拖动调整看板顺序"
              >
                <GripVertical className="h-4 w-4 shrink-0 text-muted" />
                <span className="flex-1 truncate text-sm text-ink">{item.name}</span>
                <span className="font-mono text-[11px] text-muted">{item.code}</span>
                <IconButton
                  type="button"
                  variant="ghost"
                  className="h-7 w-7"
                  // 阻止 pointerdown 冒泡到行启动拖拽：否则 setPointerCapture 后按钮收不到 click
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => void toggleIndex(item.code)}
                  title="从看板移除"
                >
                  <X className="h-3.5 w-3.5 text-rise" />
                </IconButton>
              </div>
            ))}
          </div>
        ) : (
          <div className="pt-1 text-xs text-muted">未选择指数</div>
        )}

        {/* 候选指数：点击添加 */}
        {candidates.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {candidates.map((item) => {
              const disabled = selectedIndices.length >= MAX_SELECTED_INDICES
              return (
                <button
                  key={item.code}
                  type="button"
                  disabled={disabled}
                  onClick={() => void toggleIndex(item.code)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    disabled
                      ? 'cursor-not-allowed border-line bg-panel text-muted/50'
                      : 'border-line bg-panel text-ink-soft hover:border-accent/50',
                  )}
                >
                  + {item.name}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      {/* 数据源 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="text-sm font-medium text-ink">数据源</div>
        <p className="text-xs text-muted">
          基金当日净值/估值/涨跌幅的来源。两种数据源的盘中分时走势均走 fund123。
        </p>
        <div className="space-y-1 pt-1">
          <Select.Root
            value={quoteSource}
            onValueChange={(v) =>
              void handleQuoteSourceChange(v as 'fund123' | 'fundmnfinfo')
            }
            disabled={savingSource}
            size="2"
          >
            <Select.Trigger id="quote-source" className="w-full" placeholder="选择数据源" />
            <Select.Content position="popper">
              <Select.Item value="fundmnfinfo">
                FundMNFInfo（东方财富批量接口，默认）
              </Select.Item>
              <Select.Item value="fund123">fund123（蚂蚁基金）</Select.Item>
            </Select.Content>
          </Select.Root>
          <p className="text-[11px] text-muted">
            FundMNFInfo：批量请求东方财富接口（最多 200 只/次），速度更快；fund123：逐只请求蚂蚁基金 + 东方财富历史净值。
          </p>
          <p className="text-[11px] text-muted">
            估值兜底规则 · FundMNFInfo 源：盘中无估值时先用重仓股当日涨跌幅自算；自算失败时，非 QDII（黄金/商品 ETF 联接等）自动改用该基金的 fund123 官方分时估值。QDII 按「披露日」对齐普通基金口径（披露日 = 净值日的下一交易日，净值 T+1 披露）：净值披露后保留到披露日的下一交易日开盘前，周末照常显示「已更新」与当日收益；开盘后恢复盘中估算，未更新时段显示「-」（灰色）。净值日期恒标注在基金名下，便于知晓滞后性。
          </p>
          <p className="text-[11px] text-muted">
            估值兜底规则 · fund123 源：QDII 不显示昨日涨幅冒充今日（净值 T+1 披露），只认当日分时估值；该数据源下 QDII 同样按「披露日」对齐普通基金口径（净值披露后保留到披露日的下一交易日开盘前，周末照常显示；开盘后未更新显示「-」灰色），不认 fund123 `matiaria.dayOfGrowth` 与东财 hist 滞后日涨幅。
          </p>
          <p className="text-[11px] text-muted">
            说明：不同数据源的预估收益计算方式不同，实际当日收益可能存在差异；一般当日 20:00 后开始更新真实净值，以官方净值为准。
          </p>
        </div>
      </div>

      {/* 刷新间隔 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="text-sm font-medium text-ink">定时刷新间隔</div>
        <p className="text-xs text-muted">
          任一市场开盘时用「盘中」间隔，所有市场休市时用「非开市」间隔。非交易时段对应数据源会自动跳过刷新。
        </p>
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div className="space-y-1">
            <label
              htmlFor="ri-trading"
              className="text-sm font-medium text-ink-soft leading-none"
            >
              盘中（秒）
            </label>
            <TextField.Root
              id="ri-trading"
              type="number"
              min={MIN_REFRESH_INTERVAL.trading}
              step="10"
              value={trading}
              onChange={(e) => setTrading(e.target.value)}
              disabled={savingInterval}
            />
            <p className="text-[11px] text-muted">最低 {MIN_REFRESH_INTERVAL.trading}s</p>
          </div>
          <div className="space-y-1">
            <label
              htmlFor="ri-nontrading"
              className="text-sm font-medium text-ink-soft leading-none"
            >
              非开市（秒）
            </label>
            <TextField.Root
              id="ri-nontrading"
              type="number"
              min={MIN_REFRESH_INTERVAL.nonTrading}
              step="60"
              value={nonTrading}
              onChange={(e) => setNonTrading(e.target.value)}
              disabled={savingInterval}
            />
            <p className="text-[11px] text-muted">最低 {MIN_REFRESH_INTERVAL.nonTrading}s</p>
          </div>
        </div>
        <div className="flex justify-end pt-1">
          <Button
            type="button"
            size="1"
            disabled={savingInterval}
            onClick={saveRefreshInterval}
          >
            {savingInterval ? '保存中...' : '保存间隔'}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-line/50 pt-3">
        <Button
          type="button"
          variant="soft"
          size="1"
          onClick={() => onNavigate('data')}
        >
          <Database className="h-4 w-4" />
          去「数据备份」导出 / 导入配置
        </Button>
      </div>

      {message ? <p className="text-sm text-fall">{message}</p> : null}
      {error ? <p className="text-sm text-rise">{error}</p> : null}
    </SectionCard>
  )
}

/* ── 持仓分组 ─────────────────────────────────────────────── */
function HoldingGroupsSection({
  groupsReload,
  onGroupsChanged,
}: {
  groupsReload: number
  onGroupsChanged: () => void
}) {
  const ports = usePorts()
  const [groups, setGroups] = useState<string[]>([])
  const [newGroupName, setNewGroupName] = useState('')
  const [addingGroup, setAddingGroup] = useState(false)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')
  const [groupError, setGroupError] = useState('')

  useEffect(() => {
    setGroups(listHoldingGroups(ports))
    setNewGroupName('')
    setAddingGroup(false)
    setEditingIdx(null)
    setGroupError('')
  }, [ports, groupsReload])

  async function handleAddGroup() {
    const name = newGroupName.trim()
    if (!name) return
    setAddingGroup(true)
    setGroupError('')
    try {
      const next = await addHoldingGroup(ports, name)
      setGroups(next)
      setNewGroupName('')
      onGroupsChanged()
    } catch (e: unknown) {
      setGroupError((e as Error)?.message || '新增分组失败')
    } finally {
      setAddingGroup(false)
    }
  }

  async function handleRenameGroup(idx: number) {
    const oldName = groups[idx]
    const newName = editingName.trim()
    if (!newName || newName === oldName) {
      setEditingIdx(null)
      return
    }
    setGroupError('')
    try {
      const next = await renameHoldingGroup(ports, oldName, newName)
      setGroups(next)
      setEditingIdx(null)
      onGroupsChanged()
      // 重命名会同步改 allocations/costs key，popup 缓存需强制重算
      await refreshHoldingsCache(ports)
    } catch (e: unknown) {
      setGroupError((e as Error)?.message || '重命名失败')
    }
  }

  async function handleRemoveGroup(name: string) {
    if (!confirm(`删除分组「${name}」？该分组下的持仓将变成未分组。`)) return
    setGroupError('')
    try {
      const next = await removeHoldingGroup(ports, name)
      setGroups(next)
      onGroupsChanged()
      // 删除分组会清掉引用它的份额（空基金一并删除），popup 缓存需强制重算
      await refreshHoldingsCache(ports)
    } catch (e: unknown) {
      setGroupError((e as Error)?.message || '删除失败')
    }
  }

  return (
    <SectionCard id="holdings-groups" title="持仓分组">
      <p className="text-xs text-muted">
        管理持仓的分组。删除分组后，该分组下的持仓会变成未分组（不会被删除）。
      </p>
      <div className="space-y-1 pt-1">
        {groups.length === 0 ? (
          <div className="text-xs text-muted">暂无分组</div>
        ) : (
          groups.map((g, idx) => (
            <div
              key={g}
              className="flex items-center gap-2 rounded-md border border-line/50 bg-panel/60 px-2 py-1.5"
            >
              {editingIdx === idx ? (
                <>
                  <TextField.Root
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    autoFocus
                    className="h-7 flex-1 text-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameGroup(idx)
                      if (e.key === 'Escape') setEditingIdx(null)
                    }}
                  />
                  <IconButton
                    type="button"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => handleRenameGroup(idx)}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    type="button"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setEditingIdx(null)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </IconButton>
                </>
              ) : (
                <>
                  <span className="flex-1 truncate text-sm text-ink">{g}</span>
                  <IconButton
                    type="button"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => {
                      setEditingIdx(idx)
                      setEditingName(g)
                    }}
                  >
                    <Plus className="hidden" />
                    <span className="text-xs">重命名</span>
                  </IconButton>
                  <IconButton
                    type="button"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => handleRemoveGroup(g)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-rise" />
                  </IconButton>
                </>
              )}
            </div>
          ))
        )}
      </div>
      <div className="flex gap-2 pt-1">
        <TextField.Root
          type="text"
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          placeholder="新分组名称"
          disabled={addingGroup}
          className="flex-1"
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddGroup()
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="1"
          disabled={addingGroup || !newGroupName.trim()}
          onClick={handleAddGroup}
        >
          <Plus className="h-4 w-4" />
          新增
        </Button>
      </div>
      {groupError ? <p className="text-xs text-rise">{groupError}</p> : null}
    </SectionCard>
  )
}

/* ── 添加持仓 ─────────────────────────────────────────────── */
function AddFundSection({
  groupsReload,
  onAdded,
}: {
  groupsReload: number
  /** 添加成功回调（触发下方「编辑持仓」列表实时刷新） */
  onAdded?: () => void
}) {
  const ports = usePorts()
  const [groups, setGroups] = useState<string[]>([])
  const [message, setMessage] = useState('')

  useEffect(() => {
    setGroups(listHoldingGroups(ports))
  }, [ports, groupsReload])

  return (
    <SectionCard id="add-fund" title="添加持仓">
      <p className="text-xs text-muted">
        录入基金代码与持有金额即可添加；持有收益可选填（与基金列表/截图一致）。同一基金可在多个分组各持有独立份额；添加后表单自动清空，方便连续录入。
      </p>
      <FundFormBody
        mode="hold"
        initial={null}
        groups={groups}
        onGroupsChanged={() => setGroups(listHoldingGroups(ports))}
        onSubmit={async (payload) => {
          setMessage('')
          // 错误不在此 catch 显示（也不 rethrow 后由下方再显）：直接上抛，
          // 由 FundFormBody 表单内统一显示一次，避免同文案重复提示
          await createFund(ports, {
            code: payload.code,
            amount: payload.amount,
            amountBasis: payload.amountBasis,
            group: payload.group,
            holdProfit: payload.holdProfit,
            type: 'hold',
          })
          setGroups(listHoldingGroups(ports))
          setMessage(`已添加 ${payload.code}`)
          onAdded?.()
          // 让 popup 等读 SW 缓存的端立即看到新持仓（周末也会强制重算）
          await refreshHoldingsCache(ports)
        }}
      />
      {message ? <p className="text-sm text-fall">{message}</p> : null}
    </SectionCard>
  )
}

/* ── 编辑持仓 ─────────────────────────────────────────────── */
const ALL_TAB = 'all'
const UNGROUPED_TAB = '__ungrouped__'

function EditHoldingsSection({
  reloadSignal,
  groupsReload,
  onGroupsChanged,
}: {
  reloadSignal: number
  groupsReload: number
  onGroupsChanged: () => void
}) {
  const ports = usePorts()
  const [rows, setRows] = useState<EditRow[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string>(ALL_TAB)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  // 净值缓存（code → resolveFund 完整结果，含今/昨净值与日期），供折算份额与只读派生用
  const [navMeta, setNavMeta] = useState<Record<string, ResolveFundResult>>({})
  /**
   * 金额口径（spec §6.1，与单只弹层对齐）：prev=金额是昨收市值 / today=金额是今日确认市值。
   * null = 尚未显式选择 → navMeta 就绪后按「数据源是否已出今日净值」智能默认；
   * 用户手动切换后不再自动覆盖。
   */
  const [basis, setBasis] = useState<AmountBasis | null>(null)

  useEffect(() => {
    setError('')
    setMessage('')
    loadEditRows(ports)
      .then(({rows, groups}) => {
        setRows(rows)
        setGroups(groups)
        setActiveTab(ALL_TAB)
      })
      .catch((e) => setError((e as Error)?.message || '加载失败'))
  }, [ports, reloadSignal, groupsReload])

  // 行集合的 code 指纹：编辑份额/成本不触发重拉，删除行或重载时才重新拉净值
  const navCodes = useMemo(
    () => Array.from(new Set(rows.map((r) => r.code))).sort().join(','),
    [rows],
  )
  useEffect(() => {
    const codes = navCodes ? navCodes.split(',') : []
    if (!codes.length) {
      setNavMeta({})
      return
    }
    let cancelled = false
    Promise.all(
      codes.map(async (code) => {
        try {
          const meta = await ports.data.resolveFund({code, type: 'hold'})
          return [code, meta] as const
        } catch {
          return [code, null] as const
        }
      }),
    ).then((results) => {
      if (cancelled) return
      const m: Record<string, ResolveFundResult> = {}
      for (const [code, meta] of results) {
        if (meta && meta.netValue != null && meta.netValue > 0) m[code] = meta
      }
      setNavMeta(m)
    })
    return () => {
      cancelled = true
    }
  }, [ports, navCodes])

  /** 按当前口径取折算净值（口径取不到时 undefined；保存时同样会抛错提示） */
  function pickNav(meta: ResolveFundResult | undefined): number | undefined {
    if (!meta) return undefined
    try {
      return pickBasisNav(basis ?? 'prev', meta).nav
    } catch {
      return undefined
    }
  }

  // navMeta 就绪后，若用户未手动选择口径，按「数据源是否已出今日净值」智能默认
  //（与单只弹层编辑模式的 percentSource 推断一致：已确认 → today，否则 prev）
  useEffect(() => {
    if (basis !== null || !Object.keys(navMeta).length) return
    const hasToday = Object.values(navMeta).some(
      (m) => m.netValueDate && m.netValueDate === todayDateStr(),
    )
    setBasis(hasToday ? 'today' : 'prev')
  }, [navMeta, basis])

  // 净值就绪 + 口径确定后，为未初始化的行回填「持有金额 / 持有收益」预填值：
  // 金额 = 份额 × 口径基准净值；收益 = 金额 − 份额 × 成本单价。
  // initialized 标记防重载覆盖；用户已动手（金额/收益非空）的行不覆盖；
  // 当前口径取不到净值（如 today 但今日未确认）时保持未初始化，等待切换口径后重试。
  useEffect(() => {
    if (!Object.keys(navMeta).length || basis == null) return
    setRows((cur) =>
      cur.map((r) => {
        if (r.initialized) return r
        if (r.amount.trim() !== '' || r.holdProfit.trim() !== '') return r
        const sh = Number(r.shares) || 0
        const meta = navMeta[r.code]
        if (!meta) {
          // 无净值（新基金/取数失败）：保持空白，标记已尝试避免反复计算
          return {...r, initialized: true}
        }
        if (sh <= 0) {
          // 0 份额（0 金额关注基金）：金额 = 0（份额 0 × 净值），收益留空（无成本），
          // 显示「0」而非空白；后续加仓直接改金额保存即可
          return {...r, initialized: true, amount: '0', holdProfit: ''}
        }
        let nav: number
        try {
          nav = pickBasisNav(basis, meta).nav
        } catch {
          // 当前口径取不到基准净值（如 today 但数据源尚无今日净值）：
          // 不标记，用户切换口径后本 effect 重跑再试
          return r
        }
        const amount = Math.round(sh * nav * 100) / 100
        const cost = Number(r.cost) || 0
        const holdProfit =
          cost > 0 ? Math.round((amount - sh * cost) * 100) / 100 : ''
        return {
          ...r,
          initialized: true,
          amount: String(amount),
          holdProfit: holdProfit === '' ? '' : String(holdProfit),
        }
      }),
    )
  }, [navMeta, basis])

  /**
   * 用户手动切换金额口径：未手动编辑过的行重置为待预填，按新口径基准重新折算
   *「持有金额 = 份额 × 新基准」，保证「不改即保存份额不变」；touched 行保留用户输入。
   *
   * ⚠️ 必须是「手动切换」时才重置，不能用监听 basis 的 effect：
   * 挂载时 basis 由 null → 智能默认（prev/today）也是一次变化，effect 会误触发，
   * 把预填 effect 刚填好的金额/收益全部清空（重置后全新导入「金额/收益都空」的根因）。
   */
  function handleBasisChange(next: AmountBasis) {
    setBasis(next)
    setRows((cur) =>
      cur.map((r) => (r.touched ? r : {...r, initialized: false, amount: '', holdProfit: ''})),
    )
  }

  function updateRow(index: number, patch: Partial<EditRow>) {
    setRows((cur) => cur.map((r, i) => (i === index ? {...r, ...patch, touched: true} : r)))
  }

  function removeRow(index: number) {
    setRows((cur) => cur.filter((_, i) => i !== index))
  }

  /** 修改某行份额所属分组；目标分组已有同一基金时先确认再合并累加（金额/收益相加） */
  function handleGroupChange(index: number, next: string) {
    const cur = rows[index]
    if (next === cur.group) return
    const targetIdx = rows.findIndex(
      (r, i) => i !== index && r.code === cur.code && r.group === next,
    )
    if (targetIdx !== -1) {
      const target = rows[targetIdx]
      const label = next || '未分组'
      const msg = `「${cur.name}」在分组「${label}」已有持仓，确定合并累加吗？\n合并后：持有金额与持有收益相加，成本单价按合并结果自动派生。`
      if (!confirm(msg)) return
      const a1 = Number(cur.amount) || 0
      const a2 = Number(target.amount) || 0
      const p1 = cur.holdProfit.trim() === '' ? Number.NaN : Number(cur.holdProfit)
      const p2 = target.holdProfit.trim() === '' ? Number.NaN : Number(target.holdProfit)
      const mergedProfit =
        Number.isFinite(p1) && Number.isFinite(p2)
          ? String(Math.round((p1 + p2) * 100) / 100)
          : Number.isFinite(p1)
            ? String(Math.round(p1 * 100) / 100)
            : Number.isFinite(p2)
              ? String(Math.round(p2 * 100) / 100)
              : ''
      setRows((curRows) =>
        curRows
          .map((r, i) =>
            i === targetIdx
              ? {
                  ...r,
                  amount: String(Math.round((a1 + a2) * 100) / 100),
                  holdProfit: mergedProfit,
                  initialized: true,
                  touched: true,
                }
              : r,
          )
          .filter((_, i) => i !== index),
      )
      setMessage(`已合并到「${label}」，保存后生效`)
    } else {
      updateRow(index, {group: next})
      setMessage(`已移到「${next || '未分组'}」，保存后生效`)
    }
  }

  async function deleteGroup(group: string) {
    const label = group || '未分组'
    if (!confirm(`删除分组「${label}」及其内所有基金？此操作不可撤销。`)) return
    setSaving(true)
    setError('')
    try {
      await removeHoldingGroupWithFunds(ports, group)
      const {rows: newRows, groups: newGroups} = await loadEditRows(ports)
      setRows(newRows)
      setGroups(newGroups)
      setActiveTab(ALL_TAB)
      setMessage(`已删除分组「${label}」`)
      onGroupsChanged()
      // 删除分组连带删除基金，popup 缓存需强制重算
      await refreshHoldingsCache(ports)
    } catch (e) {
      setError((e as Error)?.message || '删除分组失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      // 以「编辑后的行集合」为准重建每个基金的分组份额：
      // 1) 逐行写入当前 group 的份额/成本；2) 原 config 中存在但行集合不再覆盖的分组 → 清掉
      // （覆盖「移动/删除行」后旧分组份额残留的问题）
      const rowsByCode = new Map<string, EditRow[]>()
      for (const r of rows) {
        const list = rowsByCode.get(r.code) || []
        list.push(r)
        rowsByCode.set(r.code, list)
      }
      const funds = ports.config.getConfig().holdings
      for (const code of Object.keys(funds)) {
        const key = code.padStart(6, '0')
        const list = rowsByCode.get(key)
        if (!list) {
          // 该基金所有行都被删除 → 清空其全部分组（allocations 清空后自动删除基金）。
          // setFundAllocation 删空 allocations 会连带删除基金，之后再删会抛「基金不存在」，需逐次容错
          const prevGroups = Object.keys(funds[key]?.allocations || {})
          for (const g of prevGroups) {
            if (!ports.config.getConfig().holdings[key]) break
            await setFundAllocation(ports, key, g, 0)
          }
          continue
        }
        const rowGroups = new Set(list.map((r) => r.group))
        for (const r of list) {
          // 统一录入口径：金额 + 收益 → 份额 = 金额 ÷ 口径基准净值；成本单价 = (金额−收益) ÷ 份额（派生）
          const amount = Number(r.amount)
          const meta = navMeta[r.code]
          if (!meta) {
            throw new Error(
              `「${r.name}」在「${r.group || '未分组'}」缺少确认净值，无法折算份额，请核对后重试`,
            )
          }
          if (!(amount > 0)) {
            // 0 金额 = 关注/待加仓：保留该分组 0 份额（不是删除、不是报错），后续在表格/弹层填金额即可加仓
            if (amount === 0) {
              await setFundAllocation(ports, key, r.group, 0, undefined, {keepZero: true})
              continue
            }
            throw new Error(
              `「${r.name}」在「${r.group || '未分组'}」持有金额无效（${amount}），请填写大于 0 的金额`,
            )
          }
          const picked = pickBasisNav(basis ?? 'prev', meta)
          const shares = Math.round((amount / picked.nav) * 10000) / 10000
          const hpRaw = r.holdProfit.trim()
          const holdProfit = hpRaw === '' ? undefined : Number(hpRaw)
          let cost: number | undefined
          if (
            holdProfit != null &&
            Number.isFinite(holdProfit) &&
            shares > 0 &&
            holdProfit < amount
          ) {
            cost = Math.round(((amount - holdProfit) / shares) * 1e6) / 1e6
          }
          // 收益留空（未录入）→ 保留原成本单价，避免误清空
          if (cost == null) {
            const prevCost = ports.config.getConfig().holdings[key]?.costs?.[r.group]
            if (prevCost != null && prevCost > 0) cost = prevCost
          }
          await setFundAllocation(ports, key, r.group, shares, cost)
        }
        const prevGroups = Object.keys(funds[key]?.allocations || {})
        for (const g of prevGroups) {
          if (!rowGroups.has(g)) {
            if (!ports.config.getConfig().holdings[key]) break
            await setFundAllocation(ports, key, g, 0)
          }
        }
      }
      for (const g of groups) {
        const codes = rows.filter((r) => r.group === g).map((r) => r.code)
        await setHoldingGroupOrder(ports, g, codes)
      }
      // 保存后同步展示缓存（popup 等端立即看到新份额/成本，周末也强制重算）
      await refreshHoldingsCache(ports)
      setMessage('已保存')
    } catch (e) {
      setError((e as Error)?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const tabs: {id: string; label: string}[] = useMemo(() => {
    const t: {id: string; label: string}[] = [{id: ALL_TAB, label: '全部'}]
    for (const g of groups) {
      t.push({id: g || UNGROUPED_TAB, label: g || '未分组'})
    }
    return t
  }, [groups])

  const isAllTab = activeTab === ALL_TAB
  const activeGroupKey =
    activeTab === ALL_TAB ? null : activeTab === UNGROUPED_TAB ? '' : activeTab

  const visibleItems = useMemo(
    () =>
      rows
        .map((r, i) => ({r, i}))
        .filter(({r}) => (isAllTab ? true : r.group === activeGroupKey)),
    [rows, isAllTab, activeGroupKey],
  )

  return (
    <SectionCard id="edit-holdings" title="编辑持仓">
      <p className="text-xs text-muted">
        可编辑「持有金额」与「持有收益」（当前市值 − 成本本金）；「持有份额 / 成本单价 / 持有成本」由金额与收益自动派生、只读展示，无需手填。删除分组会连带删除组内所有基金。记得点保存。
      </p>
      {error ? <p className="text-sm text-rise">{error}</p> : null}
      {message ? <p className="text-sm text-fall">{message}</p> : null}

      {/* 金额口径（spec §6.1，与单只弹层对齐）：决定持有金额按哪一版净值折算份额 */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink-soft">金额口径</span>
        <SegmentedControl.Root
          value={basis ?? 'prev'}
          onValueChange={(v) => handleBasisChange(v as AmountBasis)}
          size="1"
        >
          <SegmentedControl.Item value="prev">昨日结算</SegmentedControl.Item>
          <SegmentedControl.Item value="today">今日结算</SegmentedControl.Item>
        </SegmentedControl.Root>
        <span className="text-[11px] leading-tight text-muted">
          持有金额按「今日结算」用今日确认净值折算份额；「昨日结算」用上一交易日净值。默认已按数据源状态自动选择，金额与列表/截图口径一致时无需切换。
        </span>
      </div>

      <Tabs.Root
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-col"
      >
        <Tabs.List className="flex-wrap gap-1" wrap="wrap">
          {tabs.map((t) => {
            const count =
              t.id === ALL_TAB
                ? rows.length
                : rows.filter((r) => (t.id === UNGROUPED_TAB ? r.group === '' : r.group === t.id))
                    .length
            return (
              <Tabs.Trigger key={t.id} value={t.id} disabled={saving}>
                {t.label}
                <span className="ml-1 text-xs text-muted">{count}</span>
              </Tabs.Trigger>
            )
          })}
        </Tabs.List>

        {tabs.map((t) => {
          const isAll = t.id === ALL_TAB
          const groupKey = isAll ? null : t.id === UNGROUPED_TAB ? '' : t.id
          const items = isAll
            ? rows.map((r, i) => ({r, i}))
            : rows.map((r, i) => ({r, i})).filter(({r}) => r.group === groupKey)
          return (
            <Tabs.Content
              key={t.id}
              value={t.id}
              className="mt-2 flex min-h-0 flex-1 flex-col"
            >
              {!isAll ? (
                <div className="mb-2 flex items-center justify-between rounded-md bg-paper-deep/40 px-3 py-1.5">
                  <div className="text-sm font-medium text-ink">
                    {groupKey || '未分组'}
                    <span className="ml-1.5 text-xs text-muted">{items.length} 只</span>
                  </div>
                  <Button
                    type="button"
                    size="1"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => deleteGroup(groupKey ?? '')}
                    className="h-7 text-rise hover:bg-rise/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除分组
                  </Button>
                </div>
              ) : null}

              {items.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted">该分组暂无基金</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full table-fixed text-left text-xs">
                    <colgroup>
                      <col className="w-auto" />
                      <col className="w-[130px]" />
                      <col className="w-[110px]" />
                      <col className="w-[90px]" />
                      <col className="w-[90px]" />
                      <col className="w-[90px]" />
                      <col className="w-[140px]" />
                      <col className="w-[44px]" />
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-paper-deep/40 text-muted">
                      <tr className="border-b border-line/40">
                        <th className="px-2 py-1.5 font-medium">基金</th>
                        <th className="px-2 py-1.5 text-right font-medium">持有金额</th>
                        <th className="px-2 py-1.5 text-right font-medium">持有收益</th>
                        <th className="px-2 py-1.5 text-right font-medium">持有份额</th>
                        <th className="px-2 py-1.5 text-right font-medium">成本单价</th>
                        <th className="px-2 py-1.5 text-right font-medium">持有成本</th>
                        <th className="px-2 py-1.5 text-center font-medium">分组</th>
                        <th className="px-1 py-1.5 text-center font-medium">删</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(({r, i}) => {
                        const nav = pickNav(navMeta[r.code])
                        const derived = deriveRowReadonly(r, nav)
                        return (
                          <tr key={`${r.code}-${r.group}`} className="border-b border-line/30">
                            <td className="px-2 py-1.5 align-middle">
                              <div className="truncate font-medium text-ink" title={r.name}>
                                {r.name}
                              </div>
                              <div className="font-mono text-[11px] text-muted">
                                {r.code}
                                {isAll ? (
                                  <span className="ml-1 text-muted/80">
                                    · {r.group || '未分组'}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td className="px-2 py-1.5 align-middle">
                              <TextField.Root
                                type="number"
                                step="0.01"
                                min="0"
                                value={r.amount}
                                onChange={(e) => updateRow(i, {amount: e.target.value})}
                                disabled={saving}
                                className="h-8 text-right font-mono text-xs"
                                placeholder="当前市值"
                              />
                            </td>
                            <td className="px-2 py-1.5 align-middle">
                              <TextField.Root
                                type="number"
                                step="0.01"
                                value={r.holdProfit}
                                onChange={(e) => updateRow(i, {holdProfit: e.target.value})}
                                disabled={saving}
                                className="h-8 text-right font-mono text-xs"
                                placeholder="如 123.45"
                              />
                            </td>
                            <td
                              className="px-2 py-1.5 text-right align-middle font-mono tabular-nums text-ink-soft"
                              title={derived.shares != null ? String(derived.shares) : undefined}
                            >
                              {derived.shares != null
                                ? derived.shares.toFixed(4)
                                : r.shares || '—'}
                            </td>
                            <td
                              className="px-2 py-1.5 text-right align-middle font-mono tabular-nums text-ink-soft"
                              title={
                                derived.costPrice != null ? String(derived.costPrice) : undefined
                              }
                            >
                              {derived.costPrice != null
                                ? derived.costPrice.toFixed(4)
                                : r.cost || '—'}
                            </td>
                            <td
                              className="px-2 py-1.5 text-right align-middle font-mono tabular-nums text-ink-soft"
                              title={
                                derived.holdingCost != null
                                  ? String(derived.holdingCost)
                                  : '未录入成本：导入时收益≥金额反推≤0 未写入，或新基金未录；可在「持有收益」栏填入有效数值后保存自动反推成本单价'
                              }
                            >
                              {derived.holdingCost != null
                                ? `¥${derived.holdingCost.toFixed(2)}`
                                : '—'}
                            </td>
                            <td className="px-2 py-1.5 align-middle">
                              <Select.Root
                                value={r.group || UNGROUPED_VALUE}
                                onValueChange={(v) =>
                                  handleGroupChange(i, v === UNGROUPED_VALUE ? '' : v)
                                }
                                disabled={saving}
                                size="1"
                              >
                                <Select.Trigger
                                  className="w-full"
                                  style={{width: '100%'}}
                                  placeholder="未分组"
                                />
                                <Select.Content position="popper">
                                  <Select.Item value={UNGROUPED_VALUE}>未分组</Select.Item>
                                  {groups
                                    .filter((g) => g !== '')
                                    .map((g) => (
                                      <Select.Item key={g} value={g}>
                                        {g}
                                      </Select.Item>
                                    ))}
                                </Select.Content>
                              </Select.Root>
                            </td>
                            <td className="px-1 py-1.5 align-middle">
                              <div className="flex justify-center">
                                <IconButton
                                  type="button"
                                  variant="ghost"
                                  className="h-7 w-7 text-rise hover:bg-rise/10"
                                  disabled={saving}
                                  onClick={() => removeRow(i)}
                                  title="移除该分组份额"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </IconButton>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Tabs.Content>
          )
        })}
      </Tabs.Root>

      <div className="flex justify-end pt-1">
        <Button type="button" disabled={saving} onClick={handleSave}>
          {saving ? '保存中...' : '保存'}
        </Button>
      </div>
    </SectionCard>
  )
}

/* ── 导入持仓 ─────────────────────────────────────────────── */
const UNGROUPED_VALUE = '__ungrouped__'

function ImportSection({
  onImported,
  onGroupsChanged,
  groupsReload,
}: {
  onImported: () => void
  onGroupsChanged: () => void
  groupsReload: number
}) {
  const ports = usePorts()
  const [mode, setMode] = useState<'file' | 'paste'>('paste')
  const [text, setText] = useState('')
  const [entries, setEntries] = useState<ImportEntry[]>([])
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{done: number; total: number; failed: string[]}>({
    done: 0,
    total: 0,
    failed: [],
  })
  const [warnings, setWarnings] = useState<string[]>([])
  const [defaultGroup, setDefaultGroup] = useState('')
  const [groups, setGroups] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
  const [message, setMessage] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // 挂载/换 ports 时重置表单（不清 groups）
  useEffect(() => {
    setMode('paste')
    setText('')
    setEntries([])
    setError('')
    setMessage('')
    setProgress({done: 0, total: 0, failed: []})
    setWarnings([])
    setDefaultGroup('')
    setCopied(false)
  }, [ports])

  // 分组列表跟随外部信号（持仓分组增删改、导入建组后同步）
  useEffect(() => {
    setGroups(listHoldingGroups(ports))
  }, [ports, groupsReload])

  useEffect(() => {
    if (!text.trim()) {
      setEntries([])
      setError('')
      return
    }
    try {
      setEntries(parseImport(text))
      setError('')
    } catch (e) {
      setEntries([])
      setError((e as Error).message)
    }
  }, [text])

  const unknownGroups = Array.from(
    new Set(
      entries
        .map((e) => e.group)
        .filter((g) => g && !groups.includes(g)),
    ),
  )

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(importPromptMd)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('复制失败，请手动选中复制')
    }
  }

  async function handleFile(file: File) {
    try {
      const content = await file.text()
      setText(content)
    } catch {
      setError('读取文件失败')
    }
  }

  async function runImport() {
    if (!entries.length) return
    setRunning(true)
    setProgress({done: 0, total: entries.length, failed: []})
    setWarnings([])
    setError('')
    setMessage('')

    const allGroups = new Set(groups)
    for (const g of unknownGroups) allGroups.add(g)
    if (defaultGroup) allGroups.add(defaultGroup)
    for (const g of allGroups) {
      if (!groups.includes(g)) {
        try {
          await addHoldingGroup(ports, g)
        } catch {
          /* 已存在则忽略 */
        }
      }
    }

    const failed: string[] = []
    const warns: string[] = []
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      try {
        const group = e.group || defaultGroup
        await createFund(ports, {
          code: e.code,
          amount: e.amount,
          amountBasis: e.amountBasis,
          navDate: e.navDate,
          name: e.name,
          type: 'hold',
          group,
          cost: e.cost,
          holdProfit: e.holdProfit,
          shares: e.shares,
          dailyProfit: e.dailyProfit,
          holdProfitRate: e.holdProfitRate,
          onWarn: (msg) => warns.push(msg),
        })
      } catch (err) {
        failed.push(`${e.code}：${(err as Error)?.message || '失败'}`)
      }
      setProgress({done: i + 1, total: entries.length, failed: [...failed]})
      setWarnings([...warns])
    }
    setRunning(false)
    // 无论成败都广播：未知分组在导入循环前已创建，持仓也可能部分写入；
    // 若不广播，部分失败时各分区列表会停留在旧数据
    onGroupsChanged()
    onImported()
    // 清缓存并强制刷新：popup 等读 SW 缓存的端立即重算，否则要等交易时段 alarm
    // 才会看到新写入的成本/份额（周末会残留一整天旧快照，详见 docs/导入后持有成本显示横杠-诊断.md）
    await refreshHoldingsCache(ports)
    if (failed.length === 0) {
      setMessage(`成功导入 ${entries.length} 条`)
      // 重置，便于再次导入
      setText('')
      setEntries([])
      setGroups(listHoldingGroups(ports))
    } else {
      setError(`导入完成，但有 ${failed.length} 条失败`)
    }
  }

  return (
    <SectionCard id="import-holdings" title="导入持仓">
      {/* 用 AI 助手生成 JSON（教程） */}
      <div className="rounded-lg border border-line/70 bg-paper-deep/40 text-xs text-muted">
        <div className="flex items-center gap-1.5 border-b border-line/30 px-3 py-2">
          <Sparkles className="h-3.5 w-3.5 text-gold" />
          <span className="font-medium text-ink-soft">用 AI 助手生成 JSON（推荐）</span>
        </div>
        <div className="space-y-1.5 px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
          <div>
            <b className="mr-1 text-gold">1.</b>
            在基金 App 里用<b>手机长截图</b>截取完整的持仓列表（包含每只基金的金额、收益、净值日期等）。
          </div>
          <div>
            <b className="mr-1 text-gold">2.</b>
            把截图和下方提示词一起交给<b>豆包、千问</b>等支持读取图片的 AI 助手，
            <b>尽量选择专家模式</b>，识别更准。
          </div>
          <div>
            <b className="mr-1 text-gold">3.</b>
            把 AI 返回的 JSON 粘贴到上方输入框（或存成文件走「选择文件」导入）。
          </div>
        </div>
        <div className="px-3 pb-2">
          <ScrollArea
            type="auto"
            scrollbars="vertical"
            style={{height: 120}}
            className="rounded-md border border-line/40 bg-panel/60"
          >
            <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-soft">
              {importPromptMd}
            </pre>
          </ScrollArea>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-muted">
              共 {importPromptMd.split('\n').length} 行，可滚动查看；点击按钮复制完整提示词
            </span>
            <Button
              type="button"
              size="1"
              variant="outline"
              disabled={running}
              onClick={copyPrompt}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? '已复制' : '拷贝提示词'}
            </Button>
          </div>
        </div>
      </div>

      {/* 默认分组 */}
      <div className="space-y-1.5">
        <label
          htmlFor="default-group"
          className="text-sm font-medium text-ink-soft leading-none"
        >
          默认分组（JSON 未指定 group 时应用）
        </label>
        <Select.Root
          value={defaultGroup || UNGROUPED_VALUE}
          onValueChange={(v) => setDefaultGroup(v === UNGROUPED_VALUE ? '' : v)}
          disabled={running}
          size="2"
        >
          <Select.Trigger id="default-group" className="w-full" placeholder="选择默认分组" />
          <Select.Content position="popper">
            <Select.Item value={UNGROUPED_VALUE}>未分组</Select.Item>
            {groups.map((g) => (
              <Select.Item key={g} value={g}>
                {g}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        {unknownGroups.length > 0 ? (
          <p className="text-[11px] text-muted">
            JSON 中出现新分组：{unknownGroups.join('、')}（导入时会自动创建）
          </p>
        ) : null}
      </div>

      {/* 模式切换 */}
      <div className="flex gap-2">
        <Button
          type="button"
          size="1"
          variant={mode === 'paste' ? 'solid' : 'outline'}
          onClick={() => setMode('paste')}
          disabled={running}
        >
          粘贴 JSON
        </Button>
        <Button
          type="button"
          size="1"
          variant={mode === 'file' ? 'solid' : 'outline'}
          onClick={() => setMode('file')}
          disabled={running}
        >
          选择文件
        </Button>
      </div>

      {mode === 'file' ? (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-ink-soft leading-none">JSON 文件</label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="1"
              disabled={running}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
              选择文件
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              disabled={running}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFile(f)
              }}
              className="hidden"
            />
            <span className="text-sm text-muted">
              {text ? '已加载文件，预览见下方' : '未选择文件'}
            </span>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <label
            htmlFor="import-text"
            className="text-sm font-medium text-ink-soft leading-none"
          >
            粘贴 JSON 数组
          </label>
          <TextArea
            id="import-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={IMPORT_SAMPLE}
            rows={6}
            disabled={running}
            className="w-full font-mono text-xs"
          />
        </div>
      )}

      {error ? <p className="text-sm text-rise">{error}</p> : null}
      {message ? <p className="text-sm text-fall">{message}</p> : null}

      {entries.length > 0 ? (
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line/60 bg-paper-deep/30 p-2">
          <div className="text-xs text-muted">
            共 {entries.length} 条
            {running ? `（${progress.done}/${progress.total}）` : null}
          </div>
          <table className="w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="px-1.5 py-1 font-medium">代码</th>
                <th className="px-1.5 py-1 font-medium">名称</th>
                <th className="px-1.5 py-1 text-right font-medium">金额</th>
                <th className="px-1.5 py-1 text-right font-medium">成本/累计</th>
                <th className="px-1.5 py-1 font-medium">口径</th>
                <th className="px-1.5 py-1 font-medium">分组</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const displayGroup = e.group || defaultGroup || '—'
                const costText = e.cost != null
                  ? `${e.cost.toFixed(4)}`
                  : e.holdProfit != null
                    ? `累${e.holdProfit >= 0 ? '+' : ''}${e.holdProfit.toFixed(2)}`
                    : '--'
                return (
                  <tr key={`${e.code}-${i}`} className="border-t border-line/40">
                    <td className="px-1.5 py-1 font-mono">{e.code}</td>
                    <td className="px-1.5 py-1 text-muted">{e.name || '--'}</td>
                    <td className="px-1.5 py-1 text-right font-mono tabular-nums">
                      {e.amount.toFixed(2)}
                    </td>
                    <td className="px-1.5 py-1 text-right font-mono tabular-nums text-muted">
                      {costText}
                    </td>
                    <td className="px-1.5 py-1 text-muted">
                      {e.navDate ? e.navDate.slice(5) : e.amountBasis === 'today' ? '今' : '昨'}
                    </td>
                    <td className="px-1.5 py-1 text-muted">{displayGroup}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {progress.failed.length > 0 ? (
        <div className="rounded-lg border border-rise/30 bg-rise/5 p-2 text-xs text-rise">
          <div className="mb-1 font-medium">导入失败 {progress.failed.length} 条</div>
          {progress.failed.map((f, i) => (
            <div key={i} className="mt-0.5 break-words">
              {f}
            </div>
          ))}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="rounded-lg border border-gold/20 bg-gold/10 p-2 text-xs text-gold">
          <div className="mb-1 font-medium">数据校验提醒（已导入，但建议核对）</div>
          {warnings.map((w, i) => (
            <div key={i} className="mt-0.5 break-words">
              {w}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          disabled={running || entries.length === 0 || !!error}
          onClick={runImport}
        >
          {running ? `导入中 ${progress.done}/${progress.total}` : `导入 ${entries.length} 条`}
        </Button>
      </div>
    </SectionCard>
  )
}

/* ── 名词说明（持仓收益口径，D4） ────────────────────────── */
function TermsNoteSection() {
  return (
    <SectionCard id="terms-note" title="名词说明">
      <div className="space-y-3 text-sm leading-relaxed text-muted">
        <div className="rounded-lg border border-line/60 bg-paper-deep/40 p-3 text-[13px] leading-relaxed">
          {HOLD_PROFIT_TERMS_NOTE}
        </div>
        <p>
          我们的「持有收益」= 当前市值 − 成本本金（不追已实现收益），与支付宝「持有收益」、
          天天基金「持仓收益」同一口径；因此不单列「累计收益」（恒等于持有收益）。
        </p>
        <p>
          录入时只需填「持有金额（当前市值）」与「持有收益」两个数；「持有成本 = 持有金额 − 持有收益」，
          「成本单价」为派生值仅供查看。
        </p>
      </div>
    </SectionCard>
  )
}

/* ── 数据说明 ─────────────────────────────────────────────── */
function DocItem({
  q,
  children,
}: {
  q: string
  children: React.ReactNode
}) {
  return (
    <details className="rounded-lg border border-line/70 bg-paper">
      <summary
        className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-ink"
        style={{cursor: 'pointer', listStyle: 'none'}}
      >
        <span>{q}</span>
        <span className="text-xs text-muted">展开 / 收起</span>
      </summary>
      <div className="space-y-2 border-t border-line/60 px-4 py-3 text-sm leading-relaxed text-muted">
        {children}
      </div>
    </details>
  )
}

function DataDocsSection() {
  return (
    <SectionCard title="数据说明">
      <div className="space-y-3">
        <DocItem q="数据来源与口径">
          <p>
            基金净值、估值、涨跌幅来自两个数据源：<b className="text-ink">FundMNFInfo</b>（天天基金移动接口）与 <b className="text-ink">fund123</b>（蚂蚁基金）。
          </p>
          <p>两种数据源的<b className="text-ink">盘中分时走势</b>均走 fund123。</p>
          <p>
            「预估收益」与「实际收益」计算方式不同，同一基金在两个源下可能不同；<b className="text-ink">实际当日收益以官方披露净值为准</b>（一般当日 20:00 后开始更新）。
          </p>
        </DocItem>

        <DocItem q="盘中估值 vs 官方净值">
          <p>境内偏股基金通常有两条口径：</p>
          <p>
            <b className="text-ink">盘中估值</b>：交易时段根据持仓估算，数字随行情变动，不是最终官方净值。
          </p>
          <p>
            <b className="text-ink">官方确认净值</b>：收盘后由管理人公布，才是「确认」口径。
          </p>
          <p>
            时间线：09:30–15:00 看估算；当晚起官方净值陆续披露，切换为确认口径；确认会话保留到下一交易日 09:15 前。
          </p>
        </DocItem>

        <DocItem q="估值兜底规则">
          <p>
            <b className="text-ink">FundMNFInfo 源</b>：盘中无估值时先用重仓股当日涨跌幅自算；自算失败时，非 QDII（黄金/商品 ETF 联接等）自动改用该基金 fund123 官方分时估值。
          </p>
          <p>
            <b className="text-ink">QDII</b>：无重仓股也无 fund123 分时估值，盘中与未更新期间当日收益均显示「-」（灰色）；按「披露日」对齐普通基金口径（披露日 = 净值日的下一交易日，净值 T+1 披露）——净值披露后保留到披露日的下一交易日开盘前，周末照常显示「已更新」徽标与当日收益；开盘后恢复盘中口径，未更新时段保持「-」。净值日期恒标注在基金名下。官方净值更新后显示「已更新」徽标（与当日收益同步，下一交易日开盘后自动清除）。
          </p>
          <p>
            <b className="text-ink">fund123 源</b>：QDII 同样按「披露日」对齐普通基金口径，不认 fund123 `matiaria.dayOfGrowth` 与东财 hist 滞后日涨幅。
          </p>
        </DocItem>

        <DocItem q="QDII 为什么慢一天">
          <p>
            「QDII·海外」指投向海外、净值延迟披露的品种。净值日 T 的官方净值通常要到 <b className="text-ink">T+1（有的接近 T+2）晚上</b> 才披露，白天往往没有可靠「今估值」，只能等官方数。
          </p>
          <p>
            QDII 用「披露日窗口」判断：净值日的<b className="text-ink">下一交易日还没过</b> = 该净值是今天（或最近）披露的 → 显示当日收益；否则（净值是昨天更早披露的，今天还没更新）保持「-」。示例：周五下午看到净值日 08-05 是「周四披露的旧数」→ 显示「-」；周五晚东财披露 08-06 净值 → 立即显示。
          </p>
        </DocItem>

        <DocItem q="QDII 当日收益怎么算">
          <p>
            与支付宝一致：有份额时按相邻两期<b className="text-ink">官方净值差</b>计算，不是盘中实时估。
          </p>
          <p>
            公式：<b className="text-ink">当日收益 ≈ 份额 ×（最新净值 − 上一净值）</b>
          </p>
          <p>
            对 QDII，「当日」= <b className="text-ink">今天披露的那一跳</b>（净值日通常是昨天，T+1 披露）——今天披露才显示；昨天披露的旧净值一律「-」，不把跨日涨幅累计到「当日」标签。
          </p>
          <p>示例：持有 1000 份，周一晚东财披露周一净值 1.28→1.30 → 显示当日收益 +20；周二若东财未更新（净值日仍为周一），周二全天保持「-」，直到周三东财披露周二净值才显示新一日的收益。</p>
        </DocItem>

        <DocItem q="分组收益额怎么算">
          <p>
            组合「当日收益额」≈ <b className="text-ink">Σ 每只各自的当日收益</b>。
          </p>
          <p>
            聚合时<b className="text-ink">跳过当日收益为空的成员</b>（如 QDII 今日未更新），避免把缺失计成 0；QDII 今日披露后自动计入。
          </p>
          <p>
            多只基金净值日可能不同，加总是一个数，但是各基金「最新已披露那一跳」的拼合——不是同一个海外交易日的收益（支付宝持仓汇总同理）。
          </p>
        </DocItem>

        <DocItem q="刷新与更新时间">
          <p>
            刷新间隔按交易时段切换：任一市场开盘用「盘中」间隔，所有市场休市用「非开市」间隔，非交易时段对应数据源自动跳过刷新。
          </p>
          <p>
            官方净值一般当日 <b className="text-ink">20:00 后</b> 开始更新；美股 QDII 多为美东交易日行情 → 净值日多为该日 → 常见北京时间次日晚约 20:00 后陆续看到（非固定钟点，港股/亚太往往更早）。
          </p>
        </DocItem>
      </div>
    </SectionCard>
  )
}

/* ── 数据备份 ─────────────────────────────────────────────── */
function DataBackupSection() {
  const ports = usePorts()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [resetOpen, setResetOpen] = useState(false)

  async function handleExport() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const config = await exportConfig(ports)
      const blob = new Blob([JSON.stringify(config, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 10)
      a.href = url
      a.download = `fund01-config-${stamp}.json`
      a.click()
      URL.revokeObjectURL(url)
      setMessage('配置已导出')
    } catch (e: unknown) {
      setError((e as Error)?.message || '导出失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleImportFile(file: File) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as AppConfig & {funds?: unknown}
      const hasFunds = parsed?.funds && typeof parsed.funds === 'object'
      const hasHoldings = parsed?.holdings && typeof parsed.holdings === 'object'
      const hasWatchlist = parsed?.watchlist && typeof parsed.watchlist === 'object'
      if (!hasFunds && !hasHoldings && !hasWatchlist) {
        throw new Error('文件缺少 holdings/watchlist 字段')
      }
      await importConfig(ports, parsed)
      setMessage('配置已导入（覆盖了本机配置）')
    } catch (e: unknown) {
      setError((e as Error)?.message || '导入失败，请检查 JSON 文件')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleClearCache() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      // Chrome：清 chrome.storage.local 全部 cache-* + 强制刷新（改代码后缓存不失效时用）；
      // Tauri 无 SW 缓存概念 → 回退仅强制刷新
      if (ports.data.clearCache) await ports.data.clearCache()
      else await ports.data.triggerRefresh()
      setMessage('缓存已清除，正在重新加载…')
    } catch (e: unknown) {
      setError((e as Error)?.message || '清除缓存失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleReset() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      // 重置为出厂默认：持仓/自选/黄金/设置全清（saveConfig 已 await，落库完成才继续）
      await resetConfig(ports)
      // 清行情缓存并强制刷新：popup 的持仓/自选来自 SW 按旧 config 写入的 cache-* 缓存，
      // 必须清掉并按新 config 重建，否则 popup 仍显示旧持仓（非交易时段 alarm 不会自动刷新）。
      // Tauri 无缓存概念（fetchHoldings 实时按 config 算）→ 回退仅强制刷新。
      // 此处失败不阻断重置：cache-* 已先被移除，即使网络拉取失败，popup 也会读到空数据。
      try {
        if (ports.data.clearCache) await ports.data.clearCache()
        else await ports.data.triggerRefresh()
      } catch {
        // 忽略：config 已重置成功，缓存已移除，仅网络重建失败
      }
      // 持仓、设置、主题全部变化 → 重载页面，保证各区块从默认配置重新渲染
      window.location.reload()
    } catch (e: unknown) {
      setError((e as Error)?.message || '重置失败')
      setBusy(false)
      // 重置失败时保持确认框打开，便于重试
      setResetOpen(true)
    }
  }

  return (
    <SectionCard title="数据备份">
      <p className="text-xs text-muted">
        持仓、自选、黄金与开关保存在本机浏览器（localStorage）。导出可备份或换设备导入；导入将覆盖当前本机配置。清浏览器数据会丢失，请定期导出。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出配置
        </Button>
        <Button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="h-4 w-4" />
          导入配置
        </Button>
        <Button
          type="button"
          variant="outline"
          color="red"
          disabled={busy}
          onClick={handleClearCache}
          title="清除扩展的行情缓存并强制重新拉取（改动代码后界面仍是旧数据时使用）"
        >
          <Trash2 className="h-4 w-4" />
          清除缓存并重新加载
        </Button>
        <AlertDialog.Root open={resetOpen} onOpenChange={setResetOpen}>
          <AlertDialog.Trigger>
            <Button
              type="button"
              variant="solid"
              color="red"
              disabled={busy}
              title="清空全部持仓与设置，恢复出厂默认"
            >
              <RotateCcw className="h-4 w-4" />
              重置全部数据
            </Button>
          </AlertDialog.Trigger>
          <AlertDialog.Content maxWidth="420px">
            <AlertDialog.Title>重置全部数据？</AlertDialog.Title>
            <AlertDialog.Description>
              <p>将清空以下内容，且无法撤销：</p>
              <ul className="mt-1 list-inside list-disc text-sm text-ink">
                <li>全部持仓与自选基金</li>
                <li>黄金持仓与平均成本</li>
                <li>所有设置（主题、菜单栏、角标、刷新频率等）</li>
              </ul>
              <p className="mt-2">如有需要，请先在上方「导出配置」备份。</p>
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-3">
              <AlertDialog.Cancel>
                <Button variant="soft" color="gray" disabled={busy}>
                  取消
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button
                  color="red"
                  disabled={busy}
                  onClick={() => void handleReset()}
                >
                  确认重置
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Root>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleImportFile(file)
          }}
        />
      </div>
      {message ? <p className="text-sm text-fall">{message}</p> : null}
      {error ? <p className="text-sm text-rise">{error}</p> : null}
    </SectionCard>
  )
}

/* ── 菜单栏（仅 tauri 显示） ───────────────────────────────── */
const MENUBAR_LAYOUTS: {value: string; label: string}[] = [
  {value: '0', label: '下大上小'},
  {value: '2', label: '等大'},
]

function clampToRange(
  v: number | undefined,
  range: readonly [number, number],
  fallback: number,
): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(range[1], Math.max(range[0], v))
}

function MenubarSection() {
  const ports = usePorts()
  const [groups, setGroups] = useState<string[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const [layout, setLayout] = useState<MenubarLayout>(0)
  const [top, setTop] = useState(7)
  const [bottom, setBottom] = useState(12)
  const [equal, setEqual] = useState(9)
  const [showAmount, setShowAmount] = useState(false)
  const [hasUngrouped, setHasUngrouped] = useState(false)
  const [topFont, setTopFont] = useState(MENUBAR_DEFAULTS.topFont)
  const [bottomFont, setBottomFont] = useState(MENUBAR_DEFAULTS.bottomFont)
  const [topBold, setTopBold] = useState(MENUBAR_DEFAULTS.topBold)
  const [bottomBold, setBottomBold] = useState(MENUBAR_DEFAULTS.bottomBold)
  const [topColor, setTopColor] = useState(MENUBAR_DEFAULTS.topColor)
  const [groupColors, setGroupColors] = useState<Record<string, string>>({})
  const [riseColor, setRiseColor] = useState(MENUBAR_DEFAULTS.riseColor)
  const [fallColor, setFallColor] = useState(MENUBAR_DEFAULTS.fallColor)

  // Radix Tabs 切走会卸载内容，切回时重新挂载 → 每次进入都读最新配置
  useEffect(() => {
    const s = fetchSettings(ports)
    const l: MenubarLayout = s.menubarLayout === 2 ? 2 : 0
    setLayout(l)
    setHidden(s.menubarHiddenGroups ?? [])
    // 每种布局的字号独立存储：布局 0 用 top/bottom，布局 2 用 equal
    setTop(clampToRange(s.menubarTopFontSize, MENUBAR_FONT_RANGES[0].top, 7))
    setBottom(clampToRange(s.menubarBottomFontSize, MENUBAR_FONT_RANGES[0].bottom, 11))
    setEqual(clampToRange(s.menubarEqualFontSize, MENUBAR_FONT_RANGES[2].top, 9))
    setShowAmount(s.menubarShowAmount === true)
    setTopFont(s.menubarTopFont ?? MENUBAR_DEFAULTS.topFont)
    setBottomFont(s.menubarBottomFont ?? MENUBAR_DEFAULTS.bottomFont)
    setTopBold(s.menubarTopBold ?? MENUBAR_DEFAULTS.topBold)
    setBottomBold(s.menubarBottomBold ?? MENUBAR_DEFAULTS.bottomBold)
    setTopColor(normalizeHexColor(s.menubarTopColor, MENUBAR_DEFAULTS.topColor))
    setGroupColors(s.menubarGroupColors ?? {})
    setRiseColor(normalizeHexColor(s.menubarRiseColor, MENUBAR_DEFAULTS.riseColor))
    setFallColor(normalizeHexColor(s.menubarFallColor, MENUBAR_DEFAULTS.fallColor))
    const gs = listHoldingGroups(ports)
    setGroups(gs)
    // 未分组 = 存在份额落在非 holdingGroups 分组的基金（与 Rust 侧 has_ungrouped 口径一致）
    const known = new Set(gs)
    setHasUngrouped(
      Object.values(ports.config.getConfig().holdings).some((f) =>
        Object.entries(f.allocations || {}).some(([g, sh]) => Number(sh) > 0 && !known.has(g)),
      ),
    )
  }, [ports])

  /** 分组显示开关：即时保存（低频操作） */
  async function toggleGroup(g: string, show: boolean) {
    const next = show
      ? hidden.filter((x) => x !== g)
      : Array.from(new Set([...hidden, g]))
    setHidden(next)
    try {
      await updateSettings(ports, {menubarHiddenGroups: next})
    } catch {
      /* ignore */
    }
  }

  /** 布局模式：每种布局的字号独立存储，切换布局只保存布局本身、不动字号 */
  async function handleLayoutChange(v: string) {
    const l = Number(v) as MenubarLayout
    setLayout(l)
    try {
      await updateSettings(ports, {menubarLayout: l})
    } catch {
      /* ignore */
    }
  }

  /** 数值显示方式：收益率 / 收益额 */
  async function handleShowAmountChange(v: string) {
    const next = v === 'amount'
    setShowAmount(next)
    try {
      await updateSettings(ports, {menubarShowAmount: next})
    } catch {
      /* ignore */
    }
  }

  /** 字号 Slider：拖动仅本地预览，松手才保存（避免连续触发后端刷新） */
  async function commitFont(side: 'top' | 'bottom' | 'equal', v: number) {
    try {
      if (side === 'equal') {
        setEqual(v)
        await updateSettings(ports, {menubarEqualFontSize: v})
      } else if (side === 'top') {
        setTop(v)
        await updateSettings(ports, {menubarTopFontSize: v})
      } else {
        setBottom(v)
        await updateSettings(ports, {menubarBottomFontSize: v})
      }
    } catch {
      /* ignore */
    }
  }

  const range = MENUBAR_FONT_RANGES[layout]

  /** 字体族：失焦/回车才保存（避免每按键触发后端刷新） */
  async function commitFontFamily(side: 'top' | 'bottom', v: string) {
    try {
      if (side === 'top') {
        setTopFont(v.trim())
        await updateSettings(ports, {menubarTopFont: v.trim()})
      } else {
        setBottomFont(v.trim())
        await updateSettings(ports, {menubarBottomFont: v.trim()})
      }
    } catch {
      /* ignore */
    }
  }

  /** 加粗 Switch：即时保存 */
  async function handleBoldChange(side: 'top' | 'bottom', next: boolean) {
    try {
      if (side === 'top') {
        setTopBold(next)
        await updateSettings(ports, {menubarTopBold: next})
      } else {
        setBottomBold(next)
        await updateSettings(ports, {menubarBottomBold: next})
      }
    } catch {
      /* ignore */
    }
  }

  /** 颜色：input[type=color] 选择即保存（低频操作） */
  async function commitColor(
    key: 'top' | 'rise' | 'fall',
    v: string,
  ) {
    const hex = normalizeHexColor(v, MENUBAR_DEFAULTS[key === 'top' ? 'topColor' : key === 'rise' ? 'riseColor' : 'fallColor'])
    try {
      if (key === 'top') {
        setTopColor(hex)
        await updateSettings(ports, {menubarTopColor: hex})
      } else if (key === 'rise') {
        setRiseColor(hex)
        await updateSettings(ports, {menubarRiseColor: hex})
      } else {
        setFallColor(hex)
        await updateSettings(ports, {menubarFallColor: hex})
      }
    } catch {
      /* ignore */
    }
  }

  /** 分组自定义上行颜色：开启时若无值则先取全局色作为初始，关闭则删除该分组颜色（回落全局） */
  async function toggleGroupColor(g: string, on: boolean) {
    const next = {...groupColors}
    if (on) {
      if (!next[g]) next[g] = topColor
    } else {
      delete next[g]
    }
    setGroupColors(next)
    try {
      await updateSettings(ports, {menubarGroupColors: next})
    } catch {
      /* ignore */
    }
  }

  /** 分组自定义上行颜色：选色即保存 */
  async function commitGroupColor(g: string, v: string) {
    const hex = normalizeHexColor(v, topColor)
    const next = {...groupColors, [g]: hex}
    setGroupColors(next)
    try {
      await updateSettings(ports, {menubarGroupColors: next})
    } catch {
      /* ignore */
    }
  }

  return (
    <SectionCard title="菜单栏">
      <p className="text-xs text-muted">
        菜单栏显示在 macOS 顶部状态栏，两行展示基金涨跌（红涨绿跌）。以下设置仅桌面版生效。
      </p>

      {/* 数值显示 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="text-sm font-medium text-ink">数值显示</div>
        <p className="text-xs text-muted">
          菜单栏第二行显示收益率百分比或收益额；收益额用 k(千)/w(万)/kw(千万) 简写。
        </p>
        <SegmentedControl.Root
          value={showAmount ? 'amount' : 'percent'}
          onValueChange={(v) => void handleShowAmountChange(v)}
          className="pt-1"
        >
          <SegmentedControl.Item value="percent">收益率</SegmentedControl.Item>
          <SegmentedControl.Item value="amount">收益额</SegmentedControl.Item>
        </SegmentedControl.Root>
      </div>

      {/* 分组显示 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="text-sm font-medium text-ink">分组显示</div>
        <p className="text-xs text-muted">
          开启「自定义颜色」可为该分组单独设置上行文字颜色，未开启则跟随全局上行颜色；「显示」控制分组实例是否出现在菜单栏。「总览」始终显示。
        </p>
        <table className="w-full pt-1 text-sm">
          <thead>
            <tr className="text-xs text-muted">
              <th className="pb-1 text-left font-normal">分组</th>
              <th className="pb-1 text-right font-normal">自定义颜色</th>
              <th className="pb-1 pl-3 text-right font-normal">显示</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-line/50">
              <td className="py-2 pr-2 text-ink">总览</td>
              <td className="py-2">
                <div className="flex items-center justify-end gap-1.5" title="自定义总览上行颜色">
                  <input
                    type="color"
                    value={groupColors[MENUBAR_OVERVIEW_KEY] ?? topColor}
                    disabled={!groupColors[MENUBAR_OVERVIEW_KEY]}
                    onChange={(e) => void commitGroupColor(MENUBAR_OVERVIEW_KEY, e.target.value)}
                    aria-label="总览 上行颜色"
                    className="h-6 w-8 cursor-pointer rounded border border-line/50 bg-transparent p-0"
                    style={{opacity: groupColors[MENUBAR_OVERVIEW_KEY] ? 1 : 0.3}}
                  />
                  <Switch
                    checked={!!groupColors[MENUBAR_OVERVIEW_KEY]}
                    onCheckedChange={(c) => void toggleGroupColor(MENUBAR_OVERVIEW_KEY, c)}
                    aria-label="总览 自定义颜色"
                  />
                </div>
              </td>
              <td className="py-2 pl-3">
                <div className="flex justify-end">
                  <Switch checked disabled aria-label="总览固定显示" />
                </div>
              </td>
            </tr>
            {groups.map((g) => (
              <tr key={g} className="border-t border-line/50">
                <td className="py-2 pr-2 text-ink">{g}</td>
                <td className="py-2">
                  <div className="flex items-center justify-end gap-1.5" title="自定义该分组上行颜色">
                    <input
                      type="color"
                      value={groupColors[g] ?? topColor}
                      disabled={!groupColors[g]}
                      onChange={(e) => void commitGroupColor(g, e.target.value)}
                      aria-label={`${g} 上行颜色`}
                      className="h-6 w-8 cursor-pointer rounded border border-line/50 bg-transparent p-0"
                      style={{opacity: groupColors[g] ? 1 : 0.3}}
                    />
                    <Switch
                      checked={!!groupColors[g]}
                      onCheckedChange={(c) => void toggleGroupColor(g, c)}
                      aria-label={`${g} 自定义颜色`}
                    />
                  </div>
                </td>
                <td className="py-2 pl-3">
                  <div className="flex justify-end">
                    <Switch
                      checked={!hidden.includes(g)}
                      onCheckedChange={(c) => void toggleGroup(g, c)}
                      aria-label={`显示/隐藏分组 ${g}`}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {hasUngrouped ? (
              <tr className="border-t border-line/50">
                <td className="py-2 pr-2 text-ink">未分组</td>
                <td className="py-2">
                  <div className="flex items-center justify-end gap-1.5" title="自定义未分组上行颜色">
                    <input
                      type="color"
                      value={groupColors[''] ?? topColor}
                      disabled={!groupColors['']}
                      onChange={(e) => void commitGroupColor('', e.target.value)}
                      aria-label="未分组 上行颜色"
                      className="h-6 w-8 cursor-pointer rounded border border-line/50 bg-transparent p-0"
                      style={{opacity: groupColors[''] ? 1 : 0.3}}
                    />
                    <Switch
                      checked={!!groupColors['']}
                      onCheckedChange={(c) => void toggleGroupColor('', c)}
                      aria-label="未分组 自定义颜色"
                    />
                  </div>
                </td>
                <td className="py-2 pl-3">
                  <div className="flex justify-end">
                    <Switch
                      checked={!hidden.includes('')}
                      onCheckedChange={(c) => void toggleGroup('', c)}
                      aria-label="显示/隐藏未分组"
                    />
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* 布局模式 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="text-sm font-medium text-ink">布局模式</div>
        <p className="text-xs text-muted">
          下行大字/上行小字（默认）、两行等大。每种布局的字号独立记忆，切换布局互不影响。
        </p>
        <SegmentedControl.Root
          value={String(layout)}
          onValueChange={(v) => void handleLayoutChange(v)}
          className="pt-1"
        >
          {MENUBAR_LAYOUTS.map((opt) => (
            <SegmentedControl.Item key={opt.value} value={opt.value}>
              {opt.label}
            </SegmentedControl.Item>
          ))}
        </SegmentedControl.Root>
      </div>

      {/* 字号 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="text-sm font-medium text-ink">字号</div>
        <p className="text-xs text-muted">
          单位 pt。拖动实时预览，松开后保存并立即应用到菜单栏；范围随当前布局模式变化。
        </p>
        {layout === 2 ? (
          <div className="space-y-1 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-sm text-ink-soft leading-none">等大字号</span>
              <span className="font-mono text-xs text-muted">{equal}pt</span>
            </div>
            <Slider
              value={[equal]}
              min={range.top[0]}
              max={range.top[1]}
              step={1}
              onValueChange={([v]) => setEqual(v)}
              onValueCommit={([v]) => void commitFont('equal', v)}
              aria-label="等大字号"
            />
            <p className="text-[11px] text-muted">
              范围 {range.top[0]}–{range.top[1]}pt（两行同步）
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm text-ink-soft leading-none">上行字号</span>
                <span className="font-mono text-xs text-muted">{top}pt</span>
              </div>
              <Slider
                value={[top]}
                min={range.top[0]}
                max={range.top[1]}
                step={1}
                onValueChange={([v]) => setTop(v)}
                onValueCommit={([v]) => void commitFont('top', v)}
                aria-label="上行字号"
              />
              <p className="text-[11px] text-muted">
                范围 {range.top[0]}–{range.top[1]}pt
              </p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm text-ink-soft leading-none">下行字号</span>
                <span className="font-mono text-xs text-muted">{bottom}pt</span>
              </div>
              <Slider
                value={[bottom]}
                min={range.bottom[0]}
                max={range.bottom[1]}
                step={1}
                onValueChange={([v]) => setBottom(v)}
                onValueCommit={([v]) => void commitFont('bottom', v)}
                aria-label="下行字号"
              />
              <p className="text-[11px] text-muted">
                范围 {range.bottom[0]}–{range.bottom[1]}pt
              </p>
            </div>
          </div>
        )}
      </div>

      {/* 字体 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="text-sm font-medium text-ink">字体</div>
        <p className="text-xs text-muted">
          上行默认 Hiragino Sans GB（分组名/总览），下行默认 Menlo（数值）。填 macOS 字体族名，留空=系统字体；失焦或回车保存。
        </p>
        <div className="grid grid-cols-2 gap-3 pt-1">
          <label className="space-y-1">
            <span className="text-sm text-ink-soft leading-none">上行字体</span>
            <TextField.Root
              type="text"
              value={topFont}
              placeholder={MENUBAR_DEFAULTS.topFont}
              onChange={(e) => setTopFont(e.target.value)}
              onBlur={(e) => void commitFontFamily('top', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="mt-1"
              aria-label="上行字体"
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm text-ink-soft leading-none">下行字体</span>
            <TextField.Root
              type="text"
              value={bottomFont}
              placeholder={MENUBAR_DEFAULTS.bottomFont}
              onChange={(e) => setBottomFont(e.target.value)}
              onBlur={(e) => void commitFontFamily('bottom', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="mt-1"
              aria-label="下行字体"
            />
          </label>
        </div>
      </div>

      {/* 加粗 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="text-sm font-medium text-ink">加粗</div>
        <p className="text-xs text-muted">默认下行加粗（数值行）、上行不加粗（名称行）。</p>
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between rounded-md border border-line/50 bg-panel/60 px-3 py-2">
            <span className="text-sm text-ink-soft">上行加粗</span>
            <Switch
              checked={topBold}
              onCheckedChange={(c) => void handleBoldChange('top', c)}
              aria-label="上行加粗"
            />
          </div>
          <div className="flex items-center justify-between rounded-md border border-line/50 bg-panel/60 px-3 py-2">
            <span className="text-sm text-ink-soft">下行加粗</span>
            <Switch
              checked={bottomBold}
              onCheckedChange={(c) => void handleBoldChange('bottom', c)}
              aria-label="下行加粗"
            />
          </div>
        </div>
      </div>

      {/* 颜色 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="text-sm font-medium text-ink">颜色</div>
        <p className="text-xs text-muted">
          上行（分组名/总览）固定色默认白色；下行数值随涨跌变色，涨色默认 #FF4F44、跌色默认 #34C759，平盘灰色固定。
        </p>
        <div className="space-y-1.5 pt-1">
          {(
            [
              {key: 'top', label: '上行颜色', value: topColor},
              {key: 'rise', label: '下行涨色', value: riseColor},
              {key: 'fall', label: '下行跌色', value: fallColor},
            ] as const
          ).map(({key, label, value}) => (
            <div
              key={key}
              className="flex items-center justify-between rounded-md border border-line/50 bg-panel/60 px-3 py-2"
            >
              <span className="text-sm text-ink-soft">{label}</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted">{value}</span>
                <input
                  type="color"
                  value={value}
                  onChange={(e) => void commitColor(key, e.target.value)}
                  aria-label={label}
                  className="h-6 w-8 cursor-pointer rounded border border-line/50 bg-transparent p-0"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  )
}
