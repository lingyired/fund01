import {useEffect, useMemo, useRef, useState} from 'react'
import {
  Check,
  Copy,
  Database,
  Download,
  FolderTree,
  GripVertical,
  Menu,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
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
  SettingsTabId,
} from '@fund01/core'
import {
  AVAILABLE_INDICES,
  DEFAULT_SELECTED_INDICES,
  MAX_SELECTED_INDICES,
  MENUBAR_FONT_RANGES,
  MIN_REFRESH_INTERVAL,
} from '@fund01/core'
import {cn, formatAmount} from '@fund01/core'
import {
  addHoldingGroup,
  createFund,
  exportConfig,
  fetchSettings,
  importConfig,
  listHoldingGroups,
  removeHoldingGroup,
  removeHoldingGroupWithFunds,
  renameHoldingGroup,
  setFundAllocation,
  setHoldingGroupOrder,
  updateSettings,
} from './lib/fundOps'
import {loadEditRows, type EditRow} from './lib/batchEdit'
import {parseImport, IMPORT_SAMPLE, type ImportEntry} from './lib/importHoldings'
import {FundFormBody} from './components/FundFormDialog'
import {applyTheme} from './theme'
import {usePorts} from './context'
import importPromptMd from '../../../docs/import-prompt.md?raw'
import './index.css'

/* ── Tab 定义 ─────────────────────────────────────────────── */
type TabId = SettingsTabId

const TABS: {id: TabId; label: string; icon: typeof Settings2}[] = [
  {id: 'general', label: '通用', icon: Settings2},
  {id: 'holdings', label: '持仓', icon: FolderTree},
  {id: 'data', label: '数据', icon: Database},
  {id: 'menubar', label: '菜单栏', icon: Menu},
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
  version,
}: {
  initialTab?: TabId
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
            <div className="space-y-8">
              <HoldingGroupsSection
                groupsReload={groupsReload}
                onGroupsChanged={() => setGroupsReload((t) => t + 1)}
              />
              <AddFundSection groupsReload={groupsReload} />
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
            </div>
          </Tabs.Content>

          <Tabs.Content value="data">
            <DataBackupSection />
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
  title,
  children,
}: {
  title?: string
  children: React.ReactNode
}) {
  return (
    <section>
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
    } catch (e: unknown) {
      setGroupError((e as Error)?.message || '删除失败')
    }
  }

  return (
    <SectionCard title="持仓分组">
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
function AddFundSection({groupsReload}: {groupsReload: number}) {
  const ports = usePorts()
  const [groups, setGroups] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setGroups(listHoldingGroups(ports))
  }, [ports, groupsReload])

  return (
    <SectionCard title="添加持仓">
      <p className="text-xs text-muted">
        录入基金代码与金额即可添加。同一基金可在多个分组各持有独立份额；添加后表单自动清空，方便连续录入。
      </p>
      <FundFormBody
        mode="hold"
        initial={null}
        groups={groups}
        onSubmit={async (payload) => {
          setMessage('')
          setError('')
          try {
            await createFund(ports, {
              code: payload.code,
              amount: payload.amount,
              amountBasis: payload.amountBasis,
              group: payload.group,
              cost: payload.cost,
              type: 'hold',
            })
            setGroups(listHoldingGroups(ports))
            setMessage(`已添加 ${payload.code}`)
          } catch (e: unknown) {
            setError((e as Error)?.message || '添加失败')
            throw e
          }
        }}
      />
      {message ? <p className="text-sm text-fall">{message}</p> : null}
      {error ? <p className="text-sm text-rise">{error}</p> : null}
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
  // 最新净值缓存（code → netValue），用于展示「当前持仓金额」（只读，不参与保存）
  const [navMap, setNavMap] = useState<Record<string, number>>({})

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
      setNavMap({})
      return
    }
    let cancelled = false
    Promise.all(
      codes.map(async (code) => {
        try {
          const meta = await ports.data.resolveFund({code, type: 'hold'})
          return [code, meta?.netValue ?? null] as const
        } catch {
          return [code, null] as const
        }
      }),
    ).then((results) => {
      if (cancelled) return
      const m: Record<string, number> = {}
      for (const [code, nav] of results) {
        if (nav != null && nav > 0) m[code] = nav
      }
      setNavMap(m)
    })
    return () => {
      cancelled = true
    }
  }, [ports, navCodes])

  function updateRow(index: number, patch: Partial<EditRow>) {
    setRows((cur) => cur.map((r, i) => (i === index ? {...r, ...patch} : r)))
  }

  function removeRow(index: number) {
    setRows((cur) => cur.filter((_, i) => i !== index))
  }

  /** 修改某行份额所属分组；目标分组已有同一基金时先确认再合并累加 */
  function handleGroupChange(index: number, next: string) {
    const cur = rows[index]
    if (next === cur.group) return
    const targetIdx = rows.findIndex(
      (r, i) => i !== index && r.code === cur.code && r.group === next,
    )
    if (targetIdx !== -1) {
      const target = rows[targetIdx]
      const label = next || '未分组'
      const msg = `「${cur.name}」在分组「${label}」已有份额 ${target.shares || 0}，确定合并累加吗？\n合并后：份额相加，成本单价按份额加权平均。`
      if (!confirm(msg)) return
      const s1 = Number(cur.shares) || 0
      const s2 = Number(target.shares) || 0
      const c1 = Number(cur.cost) || 0
      const c2 = Number(target.cost) || 0
      const mergedShares = s1 + s2
      let mergedCost = ''
      if (mergedShares > 0 && c1 > 0 && c2 > 0) {
        // 份额加权平均成本单价
        mergedCost = String(Math.round(((s1 * c1 + s2 * c2) / mergedShares) * 1e6) / 1e6)
      } else if (c1 > 0) {
        mergedCost = cur.cost
      } else if (c2 > 0) {
        mergedCost = target.cost
      }
      setRows((curRows) =>
        curRows
          .map((r, i) =>
            i === targetIdx
              ? {...r, shares: String(mergedShares), cost: mergedCost}
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
          const shares = Number(r.shares) || 0
          const cost = r.cost.trim() === '' ? undefined : Number(r.cost) || 0
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
    <SectionCard title="编辑持仓">
      <p className="text-xs text-muted">
        可直接修改每只基金在各分组的「持有份额」与「持仓成本单价」；「持仓金额」按最新净值实时估算、仅供查看不可编辑；删除分组会连带删除组内所有基金。记得点保存。
      </p>
      {error ? <p className="text-sm text-rise">{error}</p> : null}
      {message ? <p className="text-sm text-fall">{message}</p> : null}

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
                      <col className="w-[150px]" />
                      <col className="w-[150px]" />
                      <col className="w-[150px]" />
                      <col className="w-[140px]" />
                      <col className="w-[44px]" />
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-paper-deep/40 text-muted">
                      <tr className="border-b border-line/40">
                        <th className="px-2 py-1.5 font-medium">基金</th>
                        <th className="px-2 py-1.5 text-right font-medium">持仓金额</th>
                        <th className="px-2 py-1.5 text-right font-medium">持有份额</th>
                        <th className="px-2 py-1.5 text-right font-medium">成本单价</th>
                        <th className="px-2 py-1.5 text-center font-medium">分组</th>
                        <th className="px-1 py-1.5 text-center font-medium">删</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(({r, i}) => {
                        const sharesNum = Number(r.shares) || 0
                        const nav = navMap[r.code]
                        const amountText =
                          sharesNum > 0 && nav != null ? `¥${formatAmount(sharesNum * nav)}` : '—'
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
                              <div
                                className="truncate text-right font-mono text-ink"
                                title={amountText}
                              >
                                {amountText}
                              </div>
                            </td>
                            <td className="px-2 py-1.5 align-middle">
                              <TextField.Root
                                type="number"
                                step="0.0001"
                                min="0"
                                value={r.shares}
                                onChange={(e) => updateRow(i, {shares: e.target.value})}
                                disabled={saving}
                                className="h-8 text-right font-mono text-xs"
                                placeholder="0"
                              />
                            </td>
                            <td className="px-2 py-1.5 align-middle">
                              <TextField.Root
                                type="number"
                                step="0.0001"
                                min="0"
                                value={r.cost}
                                onChange={(e) => updateRow(i, {cost: e.target.value})}
                                disabled={saving}
                                className="h-8 text-right font-mono text-xs"
                                placeholder="留空"
                              />
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
    <SectionCard title="导入持仓">
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

/* ── 数据备份 ─────────────────────────────────────────────── */
function DataBackupSection() {
  const ports = usePorts()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

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

  // Radix Tabs 切走会卸载内容，切回时重新挂载 → 每次进入都读最新配置
  useEffect(() => {
    const s = fetchSettings(ports)
    const l: MenubarLayout = s.menubarLayout === 2 ? 2 : 0
    setLayout(l)
    setHidden(s.menubarHiddenGroups ?? [])
    // 每种布局的字号独立存储：布局 0 用 top/bottom，布局 2 用 equal
    setTop(clampToRange(s.menubarTopFontSize, MENUBAR_FONT_RANGES[0].top, 7))
    setBottom(clampToRange(s.menubarBottomFontSize, MENUBAR_FONT_RANGES[0].bottom, 12))
    setEqual(clampToRange(s.menubarEqualFontSize, MENUBAR_FONT_RANGES[2].top, 9))
    setShowAmount(s.menubarShowAmount === true)
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
          可单独隐藏某个持仓分组在菜单栏中的实例；「总览」始终显示。
        </p>
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between rounded-md border border-line/50 bg-panel/60 px-3 py-2">
            <span className="text-sm text-ink-soft">总览</span>
            <Switch checked disabled aria-label="总览固定显示" />
          </div>
          {groups.map((g) => (
            <div
              key={g}
              className="flex items-center justify-between rounded-md border border-line/50 bg-panel/60 px-3 py-2"
            >
              <span className="truncate text-sm text-ink">{g}</span>
              <Switch
                checked={!hidden.includes(g)}
                onCheckedChange={(c) => void toggleGroup(g, c)}
                aria-label={`显示/隐藏分组 ${g}`}
              />
            </div>
          ))}
          {hasUngrouped ? (
            <div className="flex items-center justify-between rounded-md border border-line/50 bg-panel/60 px-3 py-2">
              <span className="truncate text-sm text-ink">未分组</span>
              <Switch
                checked={!hidden.includes('')}
                onCheckedChange={(c) => void toggleGroup('', c)}
                aria-label="显示/隐藏未分组"
              />
            </div>
          ) : null}
        </div>
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
    </SectionCard>
  )
}
