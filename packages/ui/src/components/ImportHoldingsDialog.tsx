import {useEffect, useRef, useState} from 'react'
import {ChevronDown, ChevronRight, Upload, X} from 'lucide-react'
import {Button, Dialog, Select, TextArea, TextField} from '@radix-ui/themes'
import {addHoldingGroup, createFund, listHoldingGroups} from '../lib/fundOps'
import {usePorts} from '../context'

/** 一条导入记录：一个 (基金, 分组, 金额[, 成本]) 元组 */
export type ImportEntry = {
  code: string
  amount: number
  amountBasis: 'prev' | 'today'
  name?: string
  /** 该条记录指定的分组（'' = 使用默认分组；空字符串=未分组由 defaultGroup 决定） */
  group: string
  /** 该分组的持仓成本单价（元/份，可选；用于累计收益）。undefined=不传，保留原值/无成本 */
  cost?: number
  /** 累计收益（元，可选；用于反推成本单价）。与 cost 二选一，cost 优先 */
  holdProfit?: number
}

/** 解析用户输入的 JSON 字符串为导入条目数组 */
export function parseImport(input: string): ImportEntry[] {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('内容为空')

  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch (e) {
    throw new Error('JSON 格式错误：' + (e as Error).message)
  }

  if (!Array.isArray(data)) throw new Error('JSON 必须是数组')
  if (data.length === 0) throw new Error('数组为空')

  return data.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`第 ${i + 1} 项不是对象`)
    }
    const obj = item as Record<string, unknown>
    const rawCode = String(obj.code ?? obj.fundCode ?? '').replace(/\D/g, '')
    const code = rawCode.padStart(6, '0').slice(0, 6)
    if (!/^\d{6}$/.test(code)) {
      throw new Error(`第 ${i + 1} 项基金代码无效`)
    }
    const rawAmount = Number(obj.amount ?? obj.shares ?? obj.money ?? 0)
    if (!Number.isFinite(rawAmount) || rawAmount < 0) {
      throw new Error(`第 ${i + 1} 项金额无效`)
    }
    const rawBasis = String(obj.amountBasis ?? obj.basis ?? 'prev').toLowerCase()
    const amountBasis: 'prev' | 'today' = rawBasis === 'today' ? 'today' : 'prev'
    const name = obj.name != null ? String(obj.name) : undefined
    // 优先 group(字符串)；兼容旧版 groups(数组) 取第一个非空
    let group = ''
    if (typeof obj.group === 'string') {
      group = obj.group.trim()
    } else if (Array.isArray(obj.groups)) {
      for (const g of obj.groups) {
        const n = String(g ?? '').trim()
        if (n) {
          group = n
          break
        }
      }
    }
    // 成本单价（可选）：支持 cost / costPrice / costBasis 字段名
    let cost: number | undefined
    const rawCost = obj.cost ?? obj.costPrice ?? obj.costBasis
    if (rawCost != null) {
      const c = Number(rawCost)
      if (Number.isFinite(c) && c >= 0) cost = c
    }
    // 累计收益（可选）：支持 holdProfit / totalProfit / cumProfit 字段名
    let holdProfit: number | undefined
    const rawHoldProfit = obj.holdProfit ?? obj.totalProfit ?? obj.cumProfit
    if (rawHoldProfit != null) {
      const h = Number(rawHoldProfit)
      if (Number.isFinite(h)) holdProfit = h
    }
    return {code, amount: rawAmount, amountBasis, name, group, cost, holdProfit}
  })
}

const SAMPLE = `[\n  { "code": "001618", "amount": 10000, "cost": 1.2345 },\n{ "code": "025687", "amount": 28175.78, "amountBasis": "today", "group": "人工智能投资", "holdProfit": 4038.86 },\n{ "code": "025687", "amount": 3000, "group": "核心" }\n]`

const UNGROUPED_VALUE = '__ungrouped__'

export function ImportHoldingsDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onImported: () => void
}) {
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
  // 默认分组：用于 JSON 中未指定 group 的条目（空字符串=未分组）
  const [defaultGroup, setDefaultGroup] = useState('')
  // 当前所有分组（下拉用）
  const [groups, setGroups] = useState<string[]>([])
  // 格式说明是否展开（默认折叠以节省空间）
  const [showFormat, setShowFormat] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // 打开时重置状态 + 加载分组列表
  useEffect(() => {
    if (!open) return
    setMode('file')
    setText('')
    setEntries([])
    setError('')
    setProgress({done: 0, total: 0, failed: []})
    setDefaultGroup('')
    setShowFormat(false)
    setGroups(listHoldingGroups(ports))
  }, [open])

  // 当 text 变化时尝试解析预览
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

  // 收集 JSON 中出现但尚未在 groups 列表里的分组名，提示用户
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

    // 先把 JSON 中出现的新分组注册到 settings，避免导入后分组丢失
    const allGroups = new Set(groups)
    for (const g of unknownGroups) allGroups.add(g)
    // defaultGroup 也确保存在
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
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      try {
        // 逐条 group 优先，否则用默认分组
        const group = e.group || defaultGroup
        await createFund(ports, {
          code: e.code,
          amount: e.amount,
          amountBasis: e.amountBasis,
          name: e.name,
          type: 'hold',
          group,
          cost: e.cost,
          holdProfit: e.holdProfit,
        })
      } catch (err) {
        failed.push(`${e.code}：${(err as Error)?.message || '失败'}`)
      }
      setProgress({done: i + 1, total: entries.length, failed: [...failed]})
    }
    setRunning(false)
    if (failed.length === 0) {
      onImported()
      onOpenChange(false)
    }
  }

  const selectedFileName = (() => {
    if (!text || mode !== 'file') return null
    // 文件加载后 text 不为空，但没有文件名；显示已加载即可
    return '已加载文件，预览见下方'
  })()

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !running && onOpenChange(v)}>
      <Dialog.Content className="rt-popup-dialog max-w-lg">
        <div className="mb-4 flex flex-col gap-1">
          <Dialog.Title size="4" mb="0" className="font-display font-bold leading-none">
            导入持仓
          </Dialog.Title>
        </div>

        {/* 格式说明（可折叠） */}
        <div className="rounded-lg border border-line/70 bg-paper/40 text-xs text-muted">
          <Button
            type="button"
            variant="ghost"
            size="1"
            onClick={() => setShowFormat((v) => !v)}
            className="flex h-auto w-full items-center justify-start gap-1 px-3 py-2 text-left font-medium text-ink-soft"
            aria-expanded={showFormat}
          >
            {showFormat ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            )}
            JSON 格式（数组，每条 = 一个基金在某分组的份额）
          </Button>
          {showFormat ? (
            <div className="px-3 pb-2">
              <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed">
{SAMPLE}
              </pre>
              <ul className="mt-1.5 space-y-0.5">
                <li><code className="font-mono">code</code> 必填，6 位基金代码</li>
                <li><code className="font-mono">amount</code> 必填，持仓金额（元）</li>
                <li><code className="font-mono">amountBasis</code> 可选，<code>prev</code>(昨结算，默认) / <code>today</code>(今结算)</li>
                <li><code className="font-mono">group</code> 可选，分组名（未声明则用下方默认分组；同一基金写多条即可分布在多个分组）</li>
                <li><code className="font-mono">cost</code> 可选，持仓成本单价（元/份，用于累计收益；不填则不统计）</li>
                <li><code className="font-mono">holdProfit</code> 可选，累计收益（元，用于反推成本单价；与 cost 二选一，cost 优先）</li>
                <li><code className="font-mono">name</code> 可选，留空会自动解析</li>
              </ul>
            </div>
          ) : null}
        </div>

        {/* 默认分组选择（用于 JSON 中未指定 group 的条目） */}
        <div className="space-y-1.5">
          <label htmlFor="default-group" className="text-sm font-medium text-ink-soft leading-none">默认分组（JSON 未指定 group 时应用）</label>
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
                {selectedFileName ?? '未选择文件'}
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <label htmlFor="import-text" className="text-sm font-medium text-ink-soft leading-none">粘贴 JSON 数组</label>
            <TextArea
              id="import-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={SAMPLE}
              rows={6}
              disabled={running}
              className="w-full font-mono text-xs"
            />
          </div>
        )}

        {/* 错误 */}
        {error ? (
          <p className="text-sm text-rise">{error}</p>
        ) : null}

        {/* 预览 */}
        {entries.length > 0 ? (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line/60 bg-paper/30 p-2">
            <div className="text-xs text-muted">
              共 {entries.length} 条{running ? `（${progress.done}/${progress.total}）` : null}
            </div>
            <table className="w-full text-left text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="px-1.5 py-1 font-medium">代码</th>
                  <th className="px-1.5 py-1 font-medium">名称</th>
                  <th className="px-1.5 py-1 text-right font-medium">金额</th>
                  <th className="px-1.5 py-1 text-right font-medium">成本/累计收益</th>
                  <th className="px-1.5 py-1 font-medium">口径</th>
                  <th className="px-1.5 py-1 font-medium">分组</th>
                  <th className="px-1.5 py-1 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => {
                  const status =
                    running && i < progress.done
                      ? progress.failed.includes(
                          `${e.code}：`,
                        )
                        ? '失败'
                        : '成功'
                      : running && i === progress.done
                        ? '导入中'
                        : ''
                  const displayGroup = e.group || defaultGroup || '—'
                  // 显示成本单价或累计收益（前者优先）
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
                        {e.amountBasis === 'today' ? '今' : '昨'}
                      </td>
                      <td className="px-1.5 py-1 text-muted">{displayGroup}</td>
                      <td className="px-1.5 py-1 text-muted">{status}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* 失败明细 */}
        {progress.failed.length > 0 ? (
          <div className="max-h-24 overflow-y-auto rounded-lg border border-rise/30 bg-rise/5 p-2 text-xs text-rise">
            {progress.failed.map((f, i) => (
              <div key={i}>{f}</div>
            ))}
          </div>
        ) : null}

        {/* 操作 */}
        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={running || entries.length === 0 || !!error}
            onClick={runImport}
          >
            {running
              ? `导入中 ${progress.done}/${progress.total}`
              : `导入 ${entries.length} 条`}
          </Button>
        </div>
        <Dialog.Close className="rt-dialog-close" aria-label="关闭">
          <X className="h-4 w-4" />
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Root>
  )
}
