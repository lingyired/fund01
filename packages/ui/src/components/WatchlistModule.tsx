import {useState} from 'react'
import {LineChart, Plus, Trash2} from 'lucide-react'
import type {FundQuoteRow} from '@fund01/core'
import {createFund, removeFund} from '../lib/fundOps'
import {usePorts} from '../context'
import {Button} from './ui/button'
import {Panel, PanelHeader} from './ui/panel'
import {FundTrendDialog} from './FundTrendDialog'
import {FundFormDialog} from './FundFormDialog'
import {SectorTags} from './fundBits'
import {formatPct, pctClass} from '@fund01/core'

export function WatchlistModule({
  list,
  loading,
  onChanged,
}: {
  list: FundQuoteRow[]
  loading?: boolean
  onChanged: () => void
}) {
  const ports = usePorts()
  const [open, setOpen] = useState(false)
  const [trendRow, setTrendRow] = useState<FundQuoteRow | null>(null)

  const trendPoints = (row: FundQuoteRow) =>
    (row.trend || [])
      .filter((p) => p.growth != null)
      .map((p) => ({time: p.time, value: p.growth as number}))

  return (
    <Panel className="min-w-0">
      <PanelHeader
        title="自选基金"
        desc="按添加顺序固定排列"
        action={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setOpen(true)}
          >
            <Plus className="h-4 w-4" />
            添加自选
          </Button>
        }
      />

      <div className="space-y-2 px-3 pb-4 pt-2 md:hidden">
        {loading && !list.length ? (
          <div className="py-8 text-center text-sm text-muted">加载中...</div>
        ) : list.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted">暂无自选基金</div>
        ) : (
          list.map((row) => (
            <div key={row.code} className="rounded-xl border border-line/70 bg-paper/40 p-3">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{row.name}</div>
                  <div className="font-mono text-xs text-muted">{row.code}</div>
                </div>
                <span className={`font-mono text-sm font-semibold tabular-nums ${pctClass(row.percent)}`}>
                  {formatPct(row.percent)}
                </span>
              </div>
              <div className="mt-2">
                <SectorTags sectors={row.sectors} />
              </div>
              <div className="mt-2 flex justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setTrendRow(row)}
                >
                  <LineChart className="h-4 w-4" />
                  走势
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={async () => {
                    if (!confirm(`删除自选 ${row.name}?`)) return
                    await removeFund(ports, row.code, 'watch')
                    onChanged()
                  }}
                >
                  <Trash2 className="h-4 w-4 text-rise" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="hidden overflow-x-auto px-2 pb-4 pt-1 md:block">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr className="border-y border-line/70">
              <th className="px-3 py-2 font-medium">基金</th>
              <th className="px-3 py-2 font-medium">关联板块</th>
              <th className="w-28 whitespace-nowrap px-3 py-2 text-right font-medium">涨跌幅</th>
              <th className="w-32 whitespace-nowrap pl-4 pr-3 py-2 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && !list.length ? (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-muted">
                  加载中...
                </td>
              </tr>
            ) : list.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-muted">
                  暂无自选基金
                </td>
              </tr>
            ) : (
              list.map((row) => (
                <tr key={row.code} className="border-b border-line/50 hover:bg-paper/60">
                  <td className="px-3 py-3">
                    <div className="font-medium">{row.name}</div>
                    <div className="font-mono text-xs text-muted">{row.code}</div>
                  </td>
                  <td className="px-3 py-3">
                    <SectorTags sectors={row.sectors} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    <span className={`font-mono text-sm font-semibold tabular-nums ${pctClass(row.percent)}`}>
                      {formatPct(row.percent)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap pl-4 pr-3 py-2">
                    <div className="flex justify-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setTrendRow(row)}
                      >
                        <LineChart className="h-4 w-4" />
                        走势
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={async () => {
                          if (!confirm(`删除自选 ${row.name}?`)) return
                          await removeFund(ports, row.code, 'watch')
                          onChanged()
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-rise" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <FundFormDialog
        open={open}
        onOpenChange={setOpen}
        mode="watch"
        initial={null}
        groups={[]}
        onSubmit={async (payload) => {
          await createFund(ports, {code: payload.code, type: 'watch'})
          onChanged()
        }}
      />

      <FundTrendDialog
        open={!!trendRow}
        onOpenChange={(v) => !v && setTrendRow(null)}
        code={trendRow?.code || ''}
        name={trendRow?.name || ''}
        fundKey={trendRow?.fundKey || undefined}
        intradayPoints={trendRow ? trendPoints(trendRow) : []}
        badgePercent={trendRow?.percent ?? null}
      />
    </Panel>
  )
}
