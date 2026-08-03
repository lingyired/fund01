import {useEffect, useState} from 'react'
import {Plus, X} from 'lucide-react'
import {Button, Dialog, RadioCards, TextField} from '@radix-ui/themes'
import type {FundQuoteRow} from '@fund01/core'
import {addHoldingGroup} from '../lib/fundOps'
import {usePorts} from '../context'

/** 录入金额对应哪一版确认净值市值 */
export type AmountBasis = 'prev' | 'today'

type Payload = {
  code: string
  amount?: number
  /** 持仓金额口径：昨确认 / 今确认 */
  amountBasis?: AmountBasis
  type?: 'hold' | 'watch'
  /** 持仓分组（仅 hold 有效；空字符串=未分组）。指定本次金额对应的分组份额 */
  group?: string
  /** 该分组的持仓成本单价（元/份，可选；用于累计收益） */
  cost?: number
}

function defaultBasis(initial: FundQuoteRow | null): AmountBasis {
  if (!initial) return 'prev'
  return initial.percentSource === 'confirmed' ? 'today' : 'prev'
}

export function FundFormDialog({
  open,
  onOpenChange,
  mode,
  initial,
  /** 编辑/新增时默认选中的分组（空字符串=未分组）；新增时可作为预选 */
  editingGroup = '',
  /** 编辑某分组时，该分组的当前金额（覆盖 initial.amount，避免显示总额误导） */
  initialAmount,
  /** 编辑某分组时该分组的当前成本 */
  initialCost,
  groups,
  onSubmit,
  onGroupsChanged,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: 'hold' | 'watch'
  initial: FundQuoteRow | null
  /** 编辑/新增时默认选中的分组 */
  editingGroup?: string
  /** 编辑某分组时该分组的当前金额 */
  initialAmount?: number
  /** 编辑某分组时该分组的当前成本 */
  initialCost?: number
  /** 当前所有持仓分组 */
  groups: string[]
  onSubmit: (payload: Payload) => Promise<void>
  /** 分组列表变更时通知父组件刷新（新增分组后） */
  onGroupsChanged?: () => void
}) {
  const ports = usePorts()
  const [code, setCode] = useState('')
  const [amount, setAmount] = useState('')
  const [cost, setCost] = useState('')
  const [amountBasis, setAmountBasis] = useState<AmountBasis>('prev')
  /** 当前选中的单一分组（'' = 未分组） */
  const [selectedGroup, setSelectedGroup] = useState<string>('')
  const [newGroup, setNewGroup] = useState('')
  const [addingGroup, setAddingGroup] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setCode(initial?.code || '')
    // 编辑某分组时优先用该分组的金额，避免显示总额误导
    const amt = initialAmount != null ? initialAmount : initial?.amount
    setAmount(amt != null ? String(amt) : '')
    // 该分组的成本（未录入则为空）
    setCost(initialCost != null && initialCost > 0 ? String(initialCost) : '')
    setAmountBasis(defaultBasis(initial))
    // 编辑模式：用 editingGroup 指定要编辑的分组份额；新增模式：预选 editingGroup（来自当前 tab）
    setSelectedGroup(editingGroup ?? '')
    setNewGroup('')
    setAddingGroup(false)
    setError('')
  }, [open, initial, editingGroup, initialAmount, initialCost])

  async function handleAddGroup() {
    const name = newGroup.trim()
    if (!name) return
    setAddingGroup(true)
    setError('')
    try {
      await addHoldingGroup(ports, name)
      // 新增后自动选中
      setSelectedGroup(name)
      setNewGroup('')
      onGroupsChanged?.()
    } catch (e: unknown) {
      setError((e as Error)?.message || '新增分组失败')
    } finally {
      setAddingGroup(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="rt-popup-dialog">
        <div className="mb-4 flex flex-col gap-1">
          <Dialog.Title size="4" mb="0" className="font-display font-bold leading-none">
            {initial
              ? mode === 'hold'
                ? '编辑持仓金额'
                : '编辑自选'
              : mode === 'hold'
                ? '添加持仓'
                : '添加自选'}
          </Dialog.Title>
        </div>

        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            setSaving(true)
            setError('')
            try {
              const payload: Payload = {
                code: code.trim(),
                type: mode,
              }
              if (mode === 'hold') {
                payload.amount = Number(amount) || 0
                payload.amountBasis = amountBasis
                payload.group = selectedGroup
                // 成本：空字符串=不传（保留原值/无成本）；0=清空；>0=覆盖
                const costNum = cost.trim() === '' ? undefined : Number(cost) || 0
                if (costNum !== undefined) payload.cost = costNum
              }
              await onSubmit(payload)
              onOpenChange(false)
            } catch (err: unknown) {
              const msg =
                (err as {response?: {data?: {message?: string}}; message?: string})
                  ?.response?.data?.message ||
                (err as Error)?.message ||
                '保存失败'
              setError(msg)
            } finally {
              setSaving(false)
            }
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="code" className="text-sm font-medium text-ink-soft leading-none">基金代码</label>
            <TextField.Root
              id="code"
              value={code}
              disabled={!!initial}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="如 001618"
              inputMode="numeric"
              required
            />
          </div>

          {mode === 'hold' ? (
            <>
              {/* 分组（单选） */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-ink-soft leading-none">
                  分组（单选，本次金额对应的分组份额；一个基金可在多个分组各持有独立份额）
                </label>
                <div className="flex flex-wrap gap-1.5 rounded-md border border-line bg-paper/40 p-2">
                  {/* 未分组选项 */}
                  <Button
                    type="button"
                    size="1"
                    radius="full"
                    variant={selectedGroup === '' ? 'solid' : 'outline'}
                    onClick={() => setSelectedGroup('')}
                    disabled={saving || addingGroup}
                  >
                    未分组
                  </Button>
                  {groups.map((g) => {
                    const checked = selectedGroup === g
                    return (
                      <Button
                        key={g}
                        type="button"
                        size="1"
                        radius="full"
                        variant={checked ? 'solid' : 'outline'}
                        onClick={() => setSelectedGroup(g)}
                        disabled={saving || addingGroup}
                      >
                        {g}
                      </Button>
                    )
                  })}
                </div>
                {initial ? (
                  <p className="text-[11px] text-muted">
                    当前编辑「{selectedGroup || '未分组'}」分组下的份额；其他分组的份额保持不变。
                  </p>
                ) : (
                  <p className="text-[11px] text-muted">
                    本次金额将记入「{selectedGroup || '未分组'}」分组。如需把同一基金加入其他分组，再次添加并选其它分组即可。
                  </p>
                )}
                {/* 内联新增分组 */}
                <div className="flex gap-2 pt-1">
                  <TextField.Root
                    type="text"
                    value={newGroup}
                    onChange={(e) => setNewGroup(e.target.value)}
                    placeholder="输入新分组名"
                    disabled={saving || addingGroup}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="1"
                    disabled={saving || addingGroup || !newGroup.trim()}
                    onClick={handleAddGroup}
                  >
                    <Plus className="h-4 w-4" />
                    新增
                  </Button>
                </div>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-ink">金额口径</legend>
                <RadioCards.Root
                  value={amountBasis}
                  onValueChange={(v) => setAmountBasis(v as AmountBasis)}
                  columns={{initial: '1', sm: '2'}}
                >
                  <RadioCards.Item value="prev">
                    <div className="text-left">
                      <div className="text-sm font-medium text-ink">昨日结算的持仓金额</div>
                      <div className="mt-0.5 text-xs text-muted">
                        用昨确认净值算份额；列表金额之后按最新净值实时计算
                      </div>
                    </div>
                  </RadioCards.Item>
                  <RadioCards.Item value="today">
                    <div className="text-left">
                      <div className="text-sm font-medium text-ink">今日结算的持仓金额</div>
                      <div className="mt-0.5 text-xs text-muted">
                        输入即今日确认市值（与列表一致）；用今净值算份额
                      </div>
                    </div>
                  </RadioCards.Item>
                </RadioCards.Root>
              </fieldset>
              <div className="space-y-1.5">
                <label htmlFor="amount" className="text-sm font-medium text-ink-soft leading-none">
                  {initial
                    ? `持仓金额（${selectedGroup || '未分组'}）`
                    : '持仓金额'}
                </label>
                <TextField.Root
                  id="amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="填写与上方口径一致的金额"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="cost" className="text-sm font-medium text-ink-soft leading-none">
                  持仓成本单价（可选，用于累计收益）
                </label>
                <TextField.Root
                  id="cost"
                  type="number"
                  step="0.0001"
                  min="0"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="留空则不统计累计收益；填 0 清空已有成本"
                />
                <p className="text-[11px] text-muted">
                  买入时的单位成本价（元/份）。累计收益 = 当前市值 − 成本单价 × 份额。
                </p>
              </div>
            </>
          ) : null}

          {mode === 'watch' && initial ? (
            <p className="text-sm text-muted">
              自选仅需基金代码，当前：{initial.name || initial.code}
            </p>
          ) : null}

          {error ? <p className="text-sm text-rise">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={saving || (mode === 'watch' && !!initial)}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </form>
        <Dialog.Close className="rt-dialog-close" aria-label="关闭">
          <X className="h-4 w-4" />
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Root>
  )
}
