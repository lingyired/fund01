import {X} from 'lucide-react'
import {Dialog} from '@radix-ui/themes'
import {FundTrendChart} from './FundTrendChart'
import type {TrendPoint} from './SparkTrend'

export function FundTrendDialog({
  open,
  onOpenChange,
  code,
  name,
  intradayPoints,
  badgePercent,
  fundKey,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  code: string
  name: string
  /** 预加载的盘中分时点（fund123 数据源刷新时已拉取）；为空则懒加载 */
  intradayPoints?: TrendPoint[]
  badgePercent?: number | null
  /** fund123 的 productId，懒加载分时走势时需要；缺失则 SW 内 searchFund 兜底 */
  fundKey?: string
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="rt-popup-dialog w-[calc(100%-1rem)] max-w-2xl p-4 sm:w-[calc(100%-2rem)] sm:max-w-4xl sm:p-5 lg:max-w-5xl">
        <div className="mb-4 flex flex-col gap-1 pr-6">
          <Dialog.Title size="4" mb="0" className="font-display truncate text-base leading-none sm:text-lg">
            {name || '基金走势'}
          </Dialog.Title>
        </div>

        <FundTrendChart
          active={open}
          code={code}
          intradayPoints={intradayPoints}
          badgePercent={badgePercent}
          fundKey={fundKey}
        />

        <Dialog.Close className="rt-dialog-close" aria-label="关闭">
          <X className="h-4 w-4" />
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Root>
  )
}
