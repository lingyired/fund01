import {useEffect, useMemo, useState} from 'react'
import {X} from 'lucide-react'
import {Button, Dialog, RadioCards, TextField} from '@radix-ui/themes'
import type {FundQuoteRow, ResolveFundResult} from '@fund01/core'
import {createFund, pickBasisNav, updateFund, type AmountBasis} from '../../lib/fundOps'
import {groupAmount, groupCumPnl} from '../../lib/groupStats'
import {usePorts} from '../../context'

/**
 * 持仓「内联编辑弹层」（spec 持仓录入与展示统一 D1/D2）：
 * - 统一录入字段 = 持有金额(当前市值) + 持有收益；成本单价降为派生值，只读回显
 * - 新增模式（row=null）：基金代码 + 分组 + 金额 + 收益
 * - 编辑模式（row 有值）：分组可切换（默认 initialGroup），预填该分组当前金额/收益
 * - 保存走 fundOps 现有折算路径（createFund / updateFund），存储模型 allocations/costs 不变
 *
 * 用 Radix Dialog 实现「弹层」（popup 空间小、居中模态更稳；文件名沿用 spec 的 Popover 命名）。
 */
export function HoldingEditPopover({
  open,
  onOpenChange,
  row,
  initialGroup,
  groups,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 编辑目标行；null = 新增模式 */
  row: FundQuoteRow | null
  /** 编辑模式默认分组（''=未分组）；未传时按该基金分组情况推导 */
  initialGroup?: string
  /** 所有持仓分组（分组选择器候选，不含未分组） */
  groups: string[]
  /** 保存成功回调（触发列表刷新等） */
  onSaved?: () => void
}) {
  const ports = usePorts()
  const isEdit = !!row
  const [code, setCode] = useState('')
  const [amount, setAmount] = useState('')
  const [holdProfit, setHoldProfit] = useState('')
  const [amountBasis, setAmountBasis] = useState<AmountBasis>('prev')
  const [group, setGroup] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** resolveFund 结果缓存：只读回显派生份额/成本/持有成本用（保存时会重新拉取） */
  const [meta, setMeta] = useState<ResolveFundResult | null>(null)

  /** 编辑模式可选分组：该基金已有分组 + 全部持仓分组（去重保序） */
  const groupOptions = useMemo(() => {
    const set = new Set<string>()
    for (const g of Object.keys(row?.allocations || {})) set.add(g)
    for (const g of groups) set.add(g)
    return Array.from(set)
  }, [row, groups])

  // 打开时按目标行重置表单
  useEffect(() => {
    if (!open) return
    setCode(row?.code || '')
    setError('')
    setSaving(false)
    setMeta(null)
    // 默认分组：显式 initialGroup 优先；「全部」tab 下 initialGroup 为空串但该基金有
    // 已命名分组时，取第一个已命名分组（避免默认落到未分组、预填为 0）；否则取唯一/
    // 第一个已有分组，最后回退未分组
    const allocKeys = Object.keys(row?.allocations || {})
    const namedGroup = allocKeys.find((g) => g !== '')
    const initGroup =
      initialGroup === '' && namedGroup != null
        ? namedGroup
        : initialGroup != null
          ? initialGroup
          : allocKeys.length >= 1
            ? allocKeys[0]
            : ''
    setGroup(initGroup)
    // 预填：编辑模式按当前分组回显（与列表展示口径一致：金额=分组市值、收益=分组持有收益）
    if (row) {
      // 0 金额（份额 0）显示「0」而非空白：0 金额基金 = 关注/待加仓，可直接改金额加仓
      const ga = groupAmount(row, initGroup)
      setAmount(ga > 0 ? String(ga) : ga === 0 ? '0' : '')
      const p = groupCumPnl(row, initGroup)
      setHoldProfit(p != null && p !== 0 ? String(p) : p === 0 ? '0' : '')
      setAmountBasis(row.percentSource === 'confirmed' ? 'today' : 'prev')
    } else {
      setAmount('')
      setHoldProfit('')
      setAmountBasis('prev')
    }
  }, [open, row, initialGroup])

  // 拉取净值（只读回显用）：依赖 code + amountBasis，两者变化都重取
  useEffect(() => {
    if (!open || !code) {
      setMeta(null)
      return
    }
    let cancelled = false
    ports.data
      .resolveFund({code, type: 'hold'})
      .then((m) => {
        if (!cancelled) setMeta(m)
      })
      .catch(() => {
        if (!cancelled) setMeta(null)
      })
    return () => {
      cancelled = true
    }
  }, [ports, open, code, amountBasis])

  /** 当前 amountBasis 对应的基准净值（meta 缺失时 null） */
  const basisNav = useMemo(() => {
    if (!meta) return null
    try {
      return pickBasisNav(amountBasis, meta).nav
    } catch {
      return null
    }
  }, [meta, amountBasis])

  /** 实时派生：持有份额 = 金额 ÷ 基准净值 */
  const derivedShares = useMemo(() => {
    const a = Number(amount)
    if (!(a > 0) || !(basisNav != null && basisNav > 0)) return null
    return Math.round((a / basisNav) * 10000) / 10000
  }, [amount, basisNav])

  /** 实时派生：成本单价 = (金额 − 收益) ÷ 份额 */
  const derivedCostPrice = useMemo(() => {
    const a = Number(amount)
    const p = holdProfit.trim() === '' ? Number.NaN : Number(holdProfit)
    if (!(a > 0) || !Number.isFinite(p) || !(derivedShares != null && derivedShares > 0)) {
      return null
    }
    const cp = (a - p) / derivedShares
    if (!(cp > 0)) return null
    return Math.round(cp * 1e6) / 1e6
  }, [amount, holdProfit, derivedShares])

  /** 实时派生：持有成本 = 持有金额 − 持有收益 */
  const derivedCost = useMemo(() => {
    const a = Number(amount)
    const p = holdProfit.trim() === '' ? Number.NaN : Number(holdProfit)
    if (!(a > 0) || !Number.isFinite(p)) return null
    return Math.round((a - p) * 100) / 100
  }, [amount, holdProfit])

  /** 切换编辑分组：预填该分组的金额/收益 */
  function handleGroupChange(next: string) {
    if (next === group) return
    setGroup(next)
    if (!row) return
    // 0 金额（份额 0）显示「0」而非空白
    const ga = groupAmount(row, next)
    setAmount(ga > 0 ? String(ga) : ga === 0 ? '0' : '')
    const p = groupCumPnl(row, next)
    setHoldProfit(p != null && p !== 0 ? String(p) : p === 0 ? '0' : '')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const a = Number(amount)
    // 0 金额 = 关注/待加仓：编辑模式保留 0 份额分组、新增模式创建占位，均允许；
    // 仅拒绝负数/非数字
    if (!Number.isFinite(a) || a < 0) {
      setError('请填写有效的持有金额（≥ 0）')
      return
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setError('基金代码须为6位数字')
      return
    }
    const pRaw = holdProfit.trim()
    const p = pRaw === '' ? undefined : Number(pRaw)
    if (p !== undefined && !Number.isFinite(p)) {
      setError('持有收益须为数字')
      return
    }
    setSaving(true)
    setError('')
    try {
      if (isEdit && row) {
        // 编辑：按金额折算新份额（updateFund 内部用同一 pickBasisNav），
        // 成本单价 = (金额 − 收益) ÷ 份额（派生，D2 下不再手填）
        const m = await ports.data.resolveFund({code: row.code, type: 'hold'})
        const picked = pickBasisNav(amountBasis, m)
        const shares = Math.round((a / picked.nav) * 10000) / 10000
        const cost =
          p != null && shares > 0 && p < a
            ? Math.round(((a - p) / shares) * 1e6) / 1e6
            : undefined
        await updateFund(ports, row.code, {amount: a, amountBasis, group, cost}, 'hold')
      } else {
        await createFund(
          ports,
          {
            code: code.trim(),
            amount: a,
            amountBasis,
            group,
            holdProfit: p,
            type: 'hold',
          },
        )
      }
      onSaved?.()
      onOpenChange(false)
    } catch (err: unknown) {
      setError((err as Error)?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="rt-popup-dialog max-h-[90vh] overflow-y-auto">
        <div className="mb-4 pr-8">
          <Dialog.Title size="4" mb="0" className="font-display font-bold leading-none">
            {isEdit ? '编辑持仓' : '添加持仓'}
          </Dialog.Title>
          {isEdit && row ? (
            <p className="mt-1 truncate text-xs text-muted">
              {row.name}
              <span className="ml-1 font-mono">{row.code}</span>
            </p>
          ) : null}
        </div>

        <form className="space-y-3" onSubmit={handleSubmit}>
          {/* 基金代码（仅新增可编辑） */}
          {!isEdit ? (
            <div className="space-y-1.5">
              <label htmlFor="hep-code" className="text-sm font-medium leading-none text-ink-soft">
                基金代码
              </label>
              <TextField.Root
                id="hep-code"
                value={code}
                disabled={saving}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="如 001618"
                inputMode="numeric"
                required
              />
            </div>
          ) : null}

          {/* 分组（编辑可切换；新增选择目标分组） */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium leading-none text-ink-soft">
              分组
            </label>
            <div className="flex flex-wrap gap-1.5 rounded-md border border-line bg-paper/40 p-2">
              <Button
                type="button"
                size="1"
                radius="full"
                variant={group === '' ? 'solid' : 'outline'}
                onClick={() => handleGroupChange('')}
                disabled={saving}
              >
                未分组
              </Button>
              {groupOptions.map((g) => (
                <Button
                  key={g}
                  type="button"
                  size="1"
                  radius="full"
                  variant={group === g ? 'solid' : 'outline'}
                  onClick={() => handleGroupChange(g)}
                  disabled={saving}
                >
                  {g}
                </Button>
              ))}
            </div>
            {isEdit ? (
              <p className="text-[11px] text-muted">
                本次录入的金额/收益将更新「{group || '未分组'}」分组的份额与成本，其他分组不受影响。
              </p>
            ) : (
              <p className="text-[11px] text-muted">
                本次金额将记入「{group || '未分组'}」分组；同一基金可加入多个分组。
              </p>
            )}
          </div>

          {/* 金额口径 */}
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

          {/* 统一录入字段：持有金额 + 持有收益 */}
          <div className="space-y-1.5">
            <label htmlFor="hep-amount" className="text-sm font-medium leading-none text-ink-soft">
              持有金额（当前市值）
            </label>
            <TextField.Root
              id="hep-amount"
              type="number"
              step="0.01"
              min="0"
              value={amount}
              disabled={saving}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="与列表/截图一致的市值"
              required
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="hep-profit"
              className="text-sm font-medium leading-none text-ink-soft"
            >
              持有收益
            </label>
            <TextField.Root
              id="hep-profit"
              type="number"
              step="0.01"
              value={holdProfit}
              disabled={saving}
              onChange={(e) => setHoldProfit(e.target.value)}
              placeholder={isEdit ? '如 123.45；留空则保留原成本单价' : '如 123.45；留空则无成本'}
            />
            <p className="text-[11px] text-muted">
              当前市值 − 成本本金；与支付宝「持有收益」/天天基金「持仓收益」同一口径（不追已实现）。
            </p>
          </div>

          {/* 只读回显：持有份额 / 成本单价 / 持有成本（实时派生） */}
          <div className="grid grid-cols-3 gap-2 rounded-md border border-line/60 bg-paper-deep/40 p-2.5 text-xs">
            <div>
              <div className="text-muted">持有份额</div>
              <div className="mt-0.5 truncate font-mono tabular-nums text-ink-soft" title={derivedShares != null ? String(derivedShares) : undefined}>
                {derivedShares != null ? derivedShares.toFixed(4) : '--'}
              </div>
            </div>
            <div>
              <div className="text-muted">成本单价</div>
              <div
                className="mt-0.5 truncate font-mono tabular-nums text-ink-soft"
                title={derivedCostPrice != null ? String(derivedCostPrice) : undefined}
              >
                {derivedCostPrice != null ? derivedCostPrice.toFixed(4) : '--'}
              </div>
            </div>
            <div>
              <div className="text-muted">持有成本</div>
              <div className="mt-0.5 truncate font-mono tabular-nums text-ink-soft" title={derivedCost != null ? String(derivedCost) : undefined}>
                {derivedCost != null ? `¥${derivedCost.toFixed(2)}` : '--'}
              </div>
            </div>
          </div>

          {error ? <p className="text-sm text-rise">{error}</p> : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
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
