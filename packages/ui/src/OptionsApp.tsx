import {useEffect, useMemo, useRef, useState} from 'react'
import {
  Check,
  Database,
  Download,
  FolderTree,
  Plus,
  Settings2,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  Button,
  IconButton,
  SegmentedControl,
  Select,
  Tabs,
  TextArea,
  TextField,
  Theme,
} from '@radix-ui/themes'
import type {
  AppConfig,
  AppThemePref,
  BadgeMode,
} from '@fund01/core'
import {
  AVAILABLE_INDICES,
  DEFAULT_SELECTED_INDICES,
  MAX_SELECTED_INDICES,
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
import './index.css'

/* ── Tab 定义 ─────────────────────────────────────────────── */
type TabId = 'general' | 'holdings' | 'data'

const TABS: {id: TabId; label: string; icon: typeof Settings2}[] = [
  {id: 'general', label: '通用', icon: Settings2},
  {id: 'holdings', label: '持仓', icon: FolderTree},
  {id: 'data', label: '数据', icon: Database},
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

export function OptionsApp() {
  const [tab, setTab] = useState<TabId>('general')
  // 导入持仓成功后会自增，用来触发「编辑持仓」实时刷新
  const [holdingsReload, setHoldingsReload] = useState(0)

  return (
    <Theme accentColor="blue" grayColor="gray" radius="small">
      <Tabs.Root
        value={tab}
        onValueChange={(v) => setTab(v as TabId)}
        className="flex min-h-screen flex-col bg-paper text-ink"
      >
        {/* 顶部：品牌 + 一级 Tab 导航（激活态颜色由 Radix 主题变量驱动，暗色模式自动正确） */}
        <header className="shrink-0 border-b border-line/70 bg-panel/85">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
            <div className="flex items-center gap-2">
              <span className="font-display text-lg font-extrabold tracking-tight">
                Fund01
              </span>
              <span className="font-mono text-[11px] text-muted">设置</span>
            </div>
            <span className="text-[11px] text-muted">修改即时保存到本机浏览器。</span>
          </div>
          <div className="mx-auto max-w-3xl px-6">
            <Tabs.List>
              {TABS.map((t) => {
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
        <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-6">
          <Tabs.Content value="general">
            <GeneralSection onNavigate={setTab} />
          </Tabs.Content>

          <Tabs.Content value="holdings">
            <div className="space-y-8">
              <HoldingGroupsSection />
              <AddFundSection />
              <EditHoldingsSection reloadSignal={holdingsReload} />
              <ImportSection onImported={() => setHoldingsReload((t) => t + 1)} />
            </div>
          </Tabs.Content>

          <Tabs.Content value="data">
            <DataBackupSection />
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
      <div className="space-y-3 rounded-xl border border-line/70 bg-paper/40 p-4">
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

  // 看板候选：完整指数目录（带名称）+ 已选中但不在目录里的 code（保留既有选择）
  const indexOptions = useMemo(() => {
    const byCode = new Map(AVAILABLE_INDICES.map((i) => [i.code, i]))
    const extra = selectedIndices
      .filter((c) => !byCode.has(c))
      .map((c) => ({code: c, name: c}))
    return [...AVAILABLE_INDICES, ...extra]
  }, [selectedIndices])

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

      {/* 扩展角标 */}
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

      {/* 指数看板 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-ink">指数看板</div>
          <span className="font-mono text-xs text-muted">
            {selectedIndices.length}/{MAX_SELECTED_INDICES}
          </span>
        </div>
        <p className="text-xs text-muted">勾选要在看板显示的指数（最多 5 个）。</p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {indexOptions.map((item) => {
            const selected = selectedIndices.includes(item.code)
            const disabled =
              !selected && selectedIndices.length >= MAX_SELECTED_INDICES
            return (
              <button
                key={item.code}
                type="button"
                disabled={disabled}
                onClick={() => void toggleIndex(item.code)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs transition-colors',
                  selected
                    ? 'border-accent bg-accent text-white'
                    : disabled
                      ? 'cursor-not-allowed border-line bg-panel text-muted/50'
                      : 'border-line bg-panel text-ink-soft hover:border-accent/50',
                )}
              >
                {item.name}
              </button>
            )
          })}
        </div>
      </div>

      {/* 数据源 */}
      <div className="space-y-2 border-t border-line/50 pt-3">
        <div className="text-sm font-medium text-ink">数据源</div>
        <p className="text-xs text-muted">
          基金当日净值/估值/涨跌幅的来源。两种数据源的盘中分时走势均走 fund123。
        </p>
        <div className="space-y-1 pt-1">
          <label
            htmlFor="quote-source"
            className="text-sm font-medium text-ink-soft leading-none"
          >
            当日行情数据源
          </label>
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
function HoldingGroupsSection() {
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
  }, [ports])

  async function handleAddGroup() {
    const name = newGroupName.trim()
    if (!name) return
    setAddingGroup(true)
    setGroupError('')
    try {
      const next = await addHoldingGroup(ports, name)
      setGroups(next)
      setNewGroupName('')
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
function AddFundSection() {
  const ports = usePorts()
  const [groups, setGroups] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setGroups(listHoldingGroups(ports))
  }, [ports])

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

function EditHoldingsSection({reloadSignal}: {reloadSignal: number}) {
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
  }, [ports, reloadSignal])

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
      for (const r of rows) {
        const shares = Number(r.shares) || 0
        const cost = r.cost.trim() === '' ? undefined : Number(r.cost) || 0
        await setFundAllocation(ports, r.code, r.group, shares, cost)
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
                <div className="mb-2 flex items-center justify-between rounded-md bg-paper/40 px-3 py-1.5">
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
                      <col className="w-[44px]" />
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-panel text-muted">
                      <tr className="border-b border-line/40">
                        <th className="px-2 py-1.5 font-medium">基金</th>
                        <th className="px-2 py-1.5 text-right font-medium">持仓金额</th>
                        <th className="px-2 py-1.5 text-right font-medium">持有份额</th>
                        <th className="px-2 py-1.5 text-right font-medium">成本单价</th>
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

function ImportSection({onImported}: {onImported: () => void}) {
  const ports = usePorts()
  const [mode, setMode] = useState<'file' | 'paste'>('file')
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
  const [showFormat, setShowFormat] = useState(false)
  const [message, setMessage] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setMode('file')
    setText('')
    setEntries([])
    setError('')
    setMessage('')
    setProgress({done: 0, total: 0, failed: []})
    setWarnings([])
    setDefaultGroup('')
    setShowFormat(false)
    setGroups(listHoldingGroups(ports))
  }, [ports])

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
    if (failed.length === 0) {
      setMessage(`成功导入 ${entries.length} 条`)
      // 重置，便于再次导入
      setText('')
      setEntries([])
      setGroups(listHoldingGroups(ports))
      // 通知「编辑持仓」分区刷新数据
      onImported()
    } else {
      setError(`导入完成，但有 ${failed.length} 条失败`)
    }
  }

  return (
    <SectionCard title="导入持仓">
      {/* 格式说明 */}
      <div className="rounded-lg border border-line/70 bg-paper/40 text-xs text-muted">
        <Button
          type="button"
          variant="ghost"
          size="1"
          onClick={() => setShowFormat((v) => !v)}
          className="flex h-auto w-full items-center justify-start gap-1 px-3 py-2 text-left font-medium text-ink-soft"
          aria-expanded={showFormat}
        >
          {showFormat ? '收起格式说明' : 'JSON 格式说明（数组，每条 = 一个基金在某分组的份额）'}
        </Button>
        {showFormat ? (
          <div className="px-3 pb-2">
            <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed">
{IMPORT_SAMPLE}
            </pre>
            <ul className="mt-1.5 space-y-0.5">
              <li><code className="font-mono">code</code> 必填，6 位基金代码</li>
              <li><code className="font-mono">amount</code> 必填，持仓金额（元）</li>
              <li><code className="font-mono">amountBasis</code> 可选，<code>prev</code>(昨结算，默认) / <code>today</code>(今结算)。<b>按持仓截图判断</b>：显示「今日收益已更新」填 <code>today</code>，否则填 <code>prev</code>——填错会让份额整体偏一天涨跌幅</li>
              <li><code className="font-mono">navDate</code> 可选，金额对应的净值日期（<code>2026-08-01</code> 或 <code>08-01</code>）。<b>优先级高于 amountBasis</b>，截图能读到净值日期时填它最稳，隔夜导入也不会错位</li>
              <li><code className="font-mono">group</code> 可选，分组名（未声明则用下方默认分组；同一基金写多条即可分布在多个分组）</li>
              <li><code className="font-mono">cost</code> 可选，持仓成本单价（元/份，用于累计收益；不填则不统计）</li>
              <li><code className="font-mono">holdProfit</code> 可选，累计收益（元，用于反推成本单价；与 cost 二选一，cost 优先）</li>
              <li><code className="font-mono">shares</code> 可选，持有份额（份）。提供则直接作为份额、<b>跳过金额→净值折算</b>，最精确也无基准歧义；与 <code>cost</code> 搭配可同时锁定份额与成本</li>
              <li><code className="font-mono">holdProfitRate</code> 可选，持仓收益率（支持 <code>&quot;9.95%&quot;</code> 或 <code>0.0995</code>）。<code>holdProfit</code> 缺失时用它反推；都有则做成本交叉校验</li>
              <li><code className="font-mono">dailyProfit</code> 可选，昨日/今日收益（元）。<b>不参与计算</b>，仅用于校验金额口径——截图没有份额时，这是唯一能自动发现数据错位的信号，建议填。<b>非交易日空窗期（周末/节假日/未更新）App 会显示 0.00，此时请省略该字段</b>（填 0 会被当作「无数据」跳过校验，不会误报）</li>
              <li><code className="font-mono">name</code> 可选，留空会自动解析</li>
            </ul>
          </div>
        ) : null}
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
          variant={mode === 'file' ? 'solid' : 'outline'}
          onClick={() => setMode('file')}
          disabled={running}
        >
          选择文件
        </Button>
        <Button
          type="button"
          size="1"
          variant={mode === 'paste' ? 'solid' : 'outline'}
          onClick={() => setMode('paste')}
          disabled={running}
        >
          粘贴 JSON
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
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line/60 bg-paper/30 p-2">
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
        <div className="max-h-24 overflow-y-auto rounded-lg border border-rise/30 bg-rise/5 p-2 text-xs text-rise">
          {progress.failed.map((f, i) => (
            <div key={i}>{f}</div>
          ))}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="max-h-32 overflow-y-auto rounded-lg border border-gold/20 bg-gold/10 p-2 text-xs text-gold">
          <div className="mb-1 font-medium">数据校验提醒（已导入，但建议核对）</div>
          {warnings.map((w, i) => (
            <div key={i} className="mt-0.5">
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
