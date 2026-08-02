import {useEffect, useRef, useState} from 'react'
import {Check, Download, Pencil, Plus, Trash2, Upload, X} from 'lucide-react'
import type {AppConfig, AppThemePref, IndexItem} from '@fund01/core'
import {
  DEFAULT_SELECTED_INDICES,
  MAX_SELECTED_INDICES,
} from '@fund01/core'
import {
  addHoldingGroup,
  exportConfig,
  fetchSettings,
  importConfig,
  listHoldingGroups,
  removeHoldingGroup,
  renameHoldingGroup,
  updateSettings,
} from '../lib/fundOps'
import {usePorts} from '../context'
import {MIN_REFRESH_INTERVAL} from '@fund01/core'
import {applyTheme} from '../theme'
import {Button} from './ui/button'
import {Input} from './ui/input'
import {Label} from './ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import {cn} from '@fund01/core'

const THEME_OPTIONS: {value: AppThemePref; label: string}[] = [
  {value: 'system', label: '跟随系统'},
  {value: 'light', label: '亮色'},
  {value: 'dark', label: '暗色'},
]

export function ConfigDialog({
  open,
  onOpenChange,
  onImported,
  onSettingsChanged,
  indices,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onImported: () => void
  onSettingsChanged?: () => void
  indices: IndexItem[]
}) {
  const ports = usePorts()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [trading, setTrading] = useState('')
  const [nonTrading, setNonTrading] = useState('')
  const [savingInterval, setSavingInterval] = useState(false)
  const [quoteSource, setQuoteSource] = useState<'fund123' | 'fundmnfinfo'>(
    'fundmnfinfo',
  )
  const [savingSource, setSavingSource] = useState(false)

  // 外观
  const [themePref, setThemePref] = useState<AppThemePref>('system')
  const [selectedIndices, setSelectedIndices] = useState<string[]>(
    DEFAULT_SELECTED_INDICES,
  )

  // 分组管理
  const [groups, setGroups] = useState<string[]>([])
  const [newGroupName, setNewGroupName] = useState('')
  const [addingGroup, setAddingGroup] = useState(false)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')
  const [groupError, setGroupError] = useState('')

  // 打开时载入当前刷新间隔 + 分组列表 + 外观
  useEffect(() => {
    if (!open) return
    const s = fetchSettings(ports)
    setTrading(String(s.refreshInterval?.trading ?? ''))
    setNonTrading(String(s.refreshInterval?.nonTrading ?? ''))
    setQuoteSource(s.quoteSource === 'fund123' ? 'fund123' : 'fundmnfinfo')
    setGroups(listHoldingGroups(ports))
    setThemePref(s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system')
    setSelectedIndices(
      s.selectedIndices && s.selectedIndices.length > 0
        ? s.selectedIndices
        : DEFAULT_SELECTED_INDICES,
    )
    setNewGroupName('')
    setAddingGroup(false)
    setEditingIdx(null)
    setGroupError('')
  }, [open])

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
      setMessage('配置已导入')
      onImported()
      setGroups(listHoldingGroups(ports))
    } catch (e: unknown) {
      setError((e as Error)?.message || '导入失败，请检查 JSON 文件')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
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

  async function handleThemeChange(next: AppThemePref) {
    setThemePref(next)
    applyTheme(next)
    try {
      await updateSettings(ports, {theme: next})
      onSettingsChanged?.()
    } catch {
      // ignore
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
      onSettingsChanged?.()
    } catch {
      // ignore
    }
  }

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

  const indexOptions = indices.length
    ? indices
    : DEFAULT_SELECTED_INDICES.map((code) => ({code, name: code, percent: null}))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>个人配置</DialogTitle>
        </DialogHeader>

        {/* 外观：主题 */}
        <div className="space-y-2 rounded-lg border border-line/70 bg-paper/40 px-3 py-3">
          <div className="text-sm font-medium text-ink">主题</div>
          <p className="text-xs text-muted">默认跟随系统，可在亮色 / 暗色间切换。</p>
          <div className="flex gap-1.5 pt-1">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => void handleThemeChange(opt.value)}
                className={cn(
                  'flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors',
                  themePref === opt.value
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-line bg-panel text-ink-soft hover:border-accent/50',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 指数看板：最多选 5 个 */}
        <div className="space-y-2 rounded-lg border border-line/70 bg-paper/40 px-3 py-3">
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

        {/* 持仓分组管理 */}
        <div className="space-y-2 rounded-lg border border-line/70 bg-paper/40 px-3 py-3">
          <div className="text-sm font-medium text-ink">持仓分组</div>
          <p className="text-xs text-muted">
            管理持仓的分组。删除分组后，该分组下的持仓会变成未分组（不会被删除）。
          </p>

          {/* 分组列表 */}
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
                      <Input
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
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => handleRenameGroup(idx)}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setEditingIdx(null)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 truncate text-sm text-ink">{g}</span>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => {
                          setEditingIdx(idx)
                          setEditingName(g)
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => handleRemoveGroup(g)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-rise" />
                      </Button>
                    </>
                  )}
                </div>
              ))
            )}
          </div>

          {/* 新增分组 */}
          <div className="flex gap-2 pt-1">
            <Input
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
              size="sm"
              disabled={addingGroup || !newGroupName.trim()}
              onClick={handleAddGroup}
            >
              <Plus className="h-4 w-4" />
              新增
            </Button>
          </div>
          {groupError ? <p className="text-xs text-rise">{groupError}</p> : null}
        </div>

        {/* 数据源设置 */}
        <div className="space-y-2 rounded-lg border border-line/70 bg-paper/40 px-3 py-3">
          <div className="text-sm font-medium text-ink">数据源</div>
          <p className="text-xs text-muted">
            基金当日净值/估值/涨跌幅的来源。两种数据源的盘中分时走势均走 fund123。
          </p>
          <div className="space-y-1 pt-1">
            <Label htmlFor="quote-source">当日行情数据源</Label>
            <select
              id="quote-source"
              value={quoteSource}
              disabled={savingSource}
              onChange={(e) =>
                handleQuoteSourceChange(
                  e.target.value as 'fund123' | 'fundmnfinfo',
                )
              }
              className="flex h-9 w-full rounded-md border border-line bg-panel px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="fundmnfinfo">FundMNFInfo（东方财富批量接口，默认）</option>
              <option value="fund123">fund123（蚂蚁基金）</option>
            </select>
            <p className="text-[11px] text-muted">
              FundMNFInfo：批量请求东方财富接口（最多 200 只/次），速度更快；fund123：逐只请求蚂蚁基金 + 东方财富历史净值。
            </p>
          </div>
        </div>

        {/* 刷新间隔设置 */}
        <div className="space-y-2 rounded-lg border border-line/70 bg-paper/40 px-3 py-3">
          <div className="text-sm font-medium text-ink">定时刷新间隔</div>
          <p className="text-xs text-muted">
            任一市场开盘时用「盘中」间隔，所有市场休市时用「非开市」间隔。非交易时段对应数据源会自动跳过刷新。
          </p>
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div className="space-y-1">
              <Label htmlFor="ri-trading">盘中（秒）</Label>
              <Input
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
              <Label htmlFor="ri-nontrading">非开市（秒）</Label>
              <Input
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
              size="sm"
              disabled={savingInterval}
              onClick={saveRefreshInterval}
            >
              {savingInterval ? '保存中...' : '保存间隔'}
            </Button>
          </div>
        </div>

        <p className="text-sm text-muted">
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
        {message ? <p className="mt-1 text-sm text-fall">{message}</p> : null}
        {error ? <p className="mt-1 text-sm text-rise">{error}</p> : null}
      </DialogContent>
    </Dialog>
  )
}
