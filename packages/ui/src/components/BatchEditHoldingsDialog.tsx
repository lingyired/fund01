import {useEffect, useMemo, useState} from 'react'
import {ArrowDown, ArrowUp, Trash2, X} from 'lucide-react'
import {Button, Dialog, IconButton, Tabs, TextField} from '@radix-ui/themes'
import type {FundRecord, Ports} from '@fund01/core'
import {
  getHoldingGroupOrder,
  listFunds,
  listHoldingGroups,
  removeHoldingGroupWithFunds,
  setFundAllocation,
  setHoldingGroupOrder,
} from '../lib/fundOps'
import {usePorts} from '../context'

/** 一行可编辑项：某基金在某分组的份额与成本 */
type EditRow = {
  code: string
  name: string
  group: string
  shares: string
  cost: string
}

/** 把基金记录按分组展开成 EditRow 列表，应用排序 */
async function loadEditRows(ports: Ports): Promise<{rows: EditRow[]; groups: string[]}> {
  const [funds, declaredGroups] = await Promise.all([
    listFunds(ports, 'hold'),
    listHoldingGroups(ports),
  ])
  // 收集所有出现过的分组（含未分组 ''），保序
  const groupSet = new Set<string>(declaredGroups)
  for (const f of funds) {
    for (const g of Object.keys(f.allocations || {})) {
      groupSet.add(g)
    }
  }
  // 排序：声明的分组在前（保声明顺序），未声明的在后，未分组 '' 最后
  const groups: string[] = []
  for (const g of declaredGroups) if (groupSet.has(g)) groups.push(g)
  for (const g of groupSet) if (g && !groups.includes(g)) groups.push(g)
  if (groupSet.has('')) groups.push('')

  // 每个分组读取排序 + 展开行
  const rows: EditRow[] = []
  for (const g of groups) {
    const order = getHoldingGroupOrder(ports, g)
    const inGroup = funds.filter((f) => (f.allocations?.[g] ?? 0) > 0)
    // 按 order 排序，未在 order 中的按金额降序补在后面
    const ordered: FundRecord[] = []
    const used = new Set<string>()
    for (const code of order) {
      const f = inGroup.find((x) => x.code === code)
      if (f) {
        ordered.push(f)
        used.add(code)
      }
    }
    for (const f of inGroup) {
      if (!used.has(f.code)) ordered.push(f)
    }
    for (const f of ordered) {
      const shares = f.allocations?.[g] ?? 0
      const cost = f.costs?.[g]
      rows.push({
        code: f.code,
        name: f.name || f.code,
        group: g,
        shares: shares ? String(shares) : '',
        cost: cost != null && cost > 0 ? String(cost) : '',
      })
    }
  }
  return {rows, groups}
}

const ALL_TAB = 'all'
const UNGROUPED_TAB = '__ungrouped__'

function tabValueForGroup(group: string) {
  return group || UNGROUPED_TAB
}

export function BatchEditHoldingsDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onChanged: () => void
}) {
  const ports = usePorts()
  const [rows, setRows] = useState<EditRow[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string>(ALL_TAB)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    loadEditRows(ports)
      .then(({rows, groups}) => {
        setRows(rows)
        setGroups(groups)
        // 切回「全部」避免上一次选中的分组已被删除
        setActiveTab(ALL_TAB)
      })
      .catch((e) => setError((e as Error)?.message || '加载失败'))
  }, [open])

  // 打开时允许 body 滚动（覆盖 Radix 的 scroll lock）
  useEffect(() => {
    if (!open) return
    document.body.classList.add('allow-dialog-scroll')
    return () => document.body.classList.remove('allow-dialog-scroll')
  }, [open])

  function updateRow(index: number, patch: Partial<EditRow>) {
    setRows((cur) => cur.map((r, i) => (i === index ? {...r, ...patch} : r)))
  }

  /** 在某分组内上下移动某行 */
  function moveRow(group: string, code: string, dir: -1 | 1) {
    setRows((cur) => {
      // 找到该分组的行索引列表
      const idxInGroup: number[] = []
      cur.forEach((r, i) => {
        if (r.group === group) idxInGroup.push(i)
      })
      const pos = idxInGroup.findIndex((i) => cur[i].code === code)
      if (pos < 0) return cur
      const swapWith = pos + dir
      if (swapWith < 0 || swapWith >= idxInGroup.length) return cur
      const next = [...cur]
      const a = idxInGroup[pos]
      const b = idxInGroup[swapWith]
      ;[next[a], next[b]] = [next[b], next[a]]
      return next
    })
  }

  /** 删除某行（基金在该分组的份额） */
  function removeRow(index: number) {
    setRows((cur) => cur.filter((_, i) => i !== index))
  }

  /** 删除整组（连带基金） */
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
      onChanged()
    } catch (e) {
      setError((e as Error)?.message || '删除分组失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      // 1. 保存所有行的份额与成本
      for (const r of rows) {
        const shares = Number(r.shares) || 0
        const cost = r.cost.trim() === '' ? undefined : Number(r.cost) || 0
        await setFundAllocation(ports, r.code, r.group, shares, cost)
      }
      // 2. 保存每个分组的排序（按当前 rows 顺序）
      for (const g of groups) {
        const codes = rows.filter((r) => r.group === g).map((r) => r.code)
        await setHoldingGroupOrder(ports, g, codes)
      }
      onChanged()
      onOpenChange(false)
    } catch (e) {
      setError((e as Error)?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // Tab 列表：全部 → 各分组 → 未分组（仅存在时）
  const tabs: {id: string; label: string}[] = useMemo(() => {
    const t: {id: string; label: string}[] = [{id: ALL_TAB, label: '全部'}]
    for (const g of groups) {
      t.push({id: tabValueForGroup(g), label: g || '未分组'})
    }
    return t
  }, [groups])

  // 当前 tab 的有效分组 key（'' 表示未分组 / 全部）
  const isAllTab = activeTab === ALL_TAB
  const activeGroupKey =
    activeTab === ALL_TAB ? null : activeTab === UNGROUPED_TAB ? '' : activeTab

  // 当前 tab 显示的行（保持原 rows 索引，便于编辑）
  const visibleItems = useMemo(() => {
    return rows
      .map((r, i) => ({r, i}))
      .filter(({r}) =>
        isAllTab ? true : r.group === activeGroupKey,
      )
  }, [rows, isAllTab, activeGroupKey])

  // 当前 tab 的分组名（用于删除分组按钮）
  const currentTabGroup = isAllTab ? null : activeGroupKey

  function renderTable(items: typeof visibleItems, canMove: boolean) {
    if (items.length === 0) {
      return (
        <div className="py-8 text-center text-sm text-muted">
          {rows.length === 0 ? '暂无持仓' : '该分组暂无基金'}
        </div>
      )
    }
    return (
      <table className="w-full table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[40%]" />
          <col className="w-[22%]" />
          <col className="w-[22%]" />
          <col className="w-[10%]" />
          <col className="w-[6%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-panel text-muted">
          <tr className="border-b border-line/40">
            <th className="px-2 py-1.5 font-medium">基金</th>
            <th className="px-2 py-1.5 text-right font-medium">持有份额</th>
            <th className="px-2 py-1.5 text-right font-medium">成本单价</th>
            <th className="px-2 py-1.5 text-center font-medium">排序</th>
            <th className="px-2 py-1.5 text-center font-medium">删</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({r, i}, idx) => {
            const groupRows = isAllTab
              ? []
              : rows
                  .map((rr, ii) => ({rr, ii}))
                  .filter(({rr}) => rr.group === r.group)
            const idxInGroup = isAllTab
              ? idx
              : groupRows.findIndex(({rr}) => rr.code === r.code)
            const isFirst = !canMove ? true : idxInGroup === 0
            const isLast = !canMove
              ? true
              : idxInGroup === groupRows.length - 1
            return (
              <tr
                key={`${r.code}-${r.group}`}
                className="border-b border-line/30"
              >
                <td className="px-2 py-1.5 align-middle">
                  <div className="truncate font-medium text-ink" title={r.name}>
                    {r.name}
                  </div>
                  <div className="font-mono text-[11px] text-muted">
                    {r.code}
                    {isAllTab ? (
                      <span className="ml-1 text-muted/80">
                        · {r.group || '未分组'}
                      </span>
                    ) : null}
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
                  <div className="flex justify-center gap-0.5">
                    <IconButton
                      type="button"
                      variant="ghost"
                      className="h-7 w-7"
                      disabled={saving || !canMove || isFirst}
                      onClick={() => moveRow(r.group, r.code, -1)}
                      title={
                        canMove
                          ? '上移'
                          : '请进入具体分组 tab 后再调整排序'
                      }
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      type="button"
                      variant="ghost"
                      className="h-7 w-7"
                      disabled={saving || !canMove || isLast}
                      onClick={() => moveRow(r.group, r.code, 1)}
                      title={
                        canMove
                          ? '下移'
                          : '请进入具体分组 tab 后再调整排序'
                      }
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                </td>
                <td className="px-2 py-1.5 align-middle">
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
    )
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <Dialog.Content className="rt-popup-dialog max-w-3xl">
        <div className="mb-4 flex flex-col gap-1 shrink-0">
          <Dialog.Title size="4" mb="0" className="font-display font-bold leading-none">
            批量编辑持仓
          </Dialog.Title>
        </div>
        <p className="shrink-0 text-xs text-muted">
          可直接修改每只基金在各分组的「持有份额」与「持仓成本单价」；上下箭头调整组内排序；删除分组会连带删除组内所有基金。保存后生效。
        </p>

        {error ? <p className="shrink-0 text-sm text-rise">{error}</p> : null}

        <Tabs.Root value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-col">
          {/* 分组 Tab 栏 */}
          <Tabs.List className="shrink-0 flex-wrap gap-1" wrap="wrap">
            {tabs.map((t) => {
              const count =
                t.id === ALL_TAB
                  ? rows.length
                  : rows.filter(
                      (r) =>
                        tabValueForGroup(r.group) === t.id,
                    ).length
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
                {/* 当前 tab 工具条：分组名 + 删除分组按钮 */}
                {!isAll ? (
                  <div className="shrink-0 flex items-center justify-between rounded-md bg-paper/40 px-3 py-1.5">
                    <div className="text-sm font-medium text-ink">
                      {groupKey || '未分组'}
                      <span className="ml-1.5 text-xs text-muted">
                        {items.length} 只
                      </span>
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

                {/* 表格区：flex-1 撑满剩余空间，内部滚动 */}
                <div className="min-h-0 flex-1 overflow-auto pr-1">
                  {renderTable(items, isAll)}
                </div>
              </Tabs.Content>
            )
          })}
        </Tabs.Root>

        <div className="shrink-0 flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button type="button" disabled={saving} onClick={handleSave}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
        <Dialog.Close className="rt-dialog-close" aria-label="关闭">
          <X className="h-4 w-4" />
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Root>
  )
}
