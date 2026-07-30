import {useEffect, useState} from 'react'
import {Settings2} from 'lucide-react'
import type {GoldPayload} from '@fund01/core'
import {updateGoldConfig} from '../lib/fundOps'
import {usePorts} from '../context'
import {formatAmount, formatMoney, pctClass} from '@fund01/core'
import {Button} from './ui/button'
import {Input} from './ui/input'
import {Label} from './ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import {Panel, PanelHeader} from './ui/panel'
import {SparkTrend} from './SparkTrend'

function useGoldSettings(data: GoldPayload | null, onChanged: () => void) {
  const ports = usePorts()
  const [open, setOpen] = useState(false)
  const [holding, setHolding] = useState('0')
  const [avgPrice, setAvgPrice] = useState('0')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!data) return
    setHolding(String(data.holding ?? 0))
    setAvgPrice(String(data.avgPrice ?? 0))
  }, [data?.holding, data?.avgPrice])

  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>AU9999 仓位设置</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            setSaving(true)
            try {
              await updateGoldConfig(ports, {
                holding: Number(holding) || 0,
                avgPrice: Number(avgPrice) || 0,
              })
              setOpen(false)
              onChanged()
            } finally {
              setSaving(false)
            }
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="gold-holding">持有（克）</Label>
              <Input
                id="gold-holding"
                type="number"
                step="0.01"
                inputMode="decimal"
                value={holding}
                onChange={(e) => setHolding(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gold-avg">均价（元/克）</Label>
              <Input
                id="gold-avg"
                type="number"
                step="0.01"
                inputMode="decimal"
                value={avgPrice}
                onChange={(e) => setAvgPrice(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )

  return {openSettings: () => setOpen(true), dialog}
}

/** 分时按真实金价画 */
function goldPricePoints(data: GoldPayload | null) {
  return (data?.trend || [])
    .filter((p) => p.price != null && Number.isFinite(p.price))
    .map((p) => ({
      time: p.time,
      value: p.price as number,
      price: p.price,
    }))
}

export function GoldPanel({
  data,
  loading,
  onChanged,
}: {
  data: GoldPayload | null
  loading?: boolean
  onChanged: () => void
}) {
  const {openSettings, dialog} = useGoldSettings(data, onChanged)
  const price = data?.price != null && data.price > 0 ? data.price : null
  const liveAmount =
    price != null && data && data.holding > 0 ? price * data.holding : null
  const cost =
    data && data.holding > 0 && data.avgPrice > 0
      ? data.holding * data.avgPrice
      : null
  const points = goldPricePoints(data)

  return (
    <Panel className="min-w-0 w-full">
      <PanelHeader
        title="黄金"
        desc="AU9999 沪金 · 交易跨日，独立于基金当日结算"
        action={
          <Button size="sm" variant="outline" onClick={openSettings}>
            <Settings2 className="h-4 w-4" />
            仓位
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 px-3 pb-4 pt-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-stretch lg:gap-5 sm:px-5 sm:pt-5">
        {/* 左侧数据 */}
        <div className="flex flex-col justify-center gap-3">
          <div className="relative overflow-hidden rounded-xl border border-gold/35 bg-gradient-to-br from-gold/15 via-gold/5 to-paper/50 px-4 py-4 sm:px-5 sm:py-5">
            <div
              className="pointer-events-none absolute -right-6 -top-8 h-24 w-24 rounded-full bg-gold/10 blur-2xl"
              aria-hidden
            />
            <div className="relative flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
              <div className="min-w-0">
                <div className="text-[11px] tracking-wide text-muted">当前总价值</div>
                <div className="mt-2 font-mono text-2xl font-bold leading-none tracking-tight tabular-nums text-gold sm:text-3xl">
                  {liveAmount != null ? (
                    <>
                      <span className="mr-1 align-baseline text-base font-semibold text-gold/65 sm:text-lg">
                        ¥
                      </span>
                      {formatAmount(liveAmount)}
                    </>
                  ) : loading ? (
                    '...'
                  ) : (
                    '--'
                  )}
                </div>
              </div>
              {data?.costPnl != null ? (
                <div className="shrink-0 border-l border-gold/25 pl-5">
                  <div className="text-[11px] tracking-wide text-muted">相对成本</div>
                  <div className="mt-2 flex flex-wrap items-baseline gap-2">
                    <span
                      className={`font-mono text-lg font-semibold tabular-nums sm:text-xl ${pctClass(data.costPnl)}`}
                    >
                      {formatMoney(data.costPnl)}
                    </span>
                    {data.costPnlPercent != null ? (
                      <span
                        className={`rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums ${data.costPnl >= 0
                          ? 'border-rise/30 bg-rise/10 text-rise'
                          : 'border-fall/30 bg-fall/10 text-fall'
                          }`}
                      >
                        {data.costPnlPercent > 0 ? '+' : ''}
                        {data.costPnlPercent.toFixed(2)}%
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-line/60 bg-paper/50 px-4 py-3.5">
            <div className="grid grid-cols-3 gap-3">
              <div className="min-w-0">
                <div className="text-[11px] text-muted">克数</div>
                <div className="mt-1.5 truncate font-mono text-sm font-semibold tabular-nums text-ink sm:text-base">
                  {data?.holding ? `${data.holding}克` : '--'}
                </div>
              </div>
              <div className="min-w-0 border-l border-line/50 pl-3">
                <div className="text-[11px] text-muted">均价</div>
                <div className="mt-1.5 truncate font-mono text-sm font-semibold tabular-nums text-ink sm:text-base">
                  {data?.avgPrice ? data.avgPrice.toFixed(2) : '--'}
                </div>
              </div>
              <div className="min-w-0 border-l border-line/50 pl-3">
                <div className="text-[11px] text-muted">成本</div>
                <div className="mt-1.5 truncate font-mono text-sm font-semibold tabular-nums text-ink sm:text-base">
                  {cost != null ? formatAmount(cost) : '--'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 右侧走势 */}
        <div className="flex min-h-[180px] flex-col rounded-xl border border-gold/20 bg-paper/30 px-2 py-2 sm:px-3 sm:py-3">
          <div className="mb-1 px-1 text-[11px] text-muted">分时金价</div>
          <div className="min-h-0 flex-1">
            <SparkTrend
              height={200}
              title="AU9999 分时金价"
              accentColor="#b8860b"
              className="h-full w-full"
              mode="price"
              showTimeAxis
              points={points}
            />
          </div>
        </div>
      </div>
      {dialog}
    </Panel>
  )
}
