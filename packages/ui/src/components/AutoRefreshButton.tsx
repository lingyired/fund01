import {useEffect, useState} from 'react'
import {RefreshCw} from 'lucide-react'
import {IconButton} from '@radix-ui/themes'

interface AutoRefreshButtonProps {
  /** 当前自动刷新周期（秒） */
  intervalSeconds: number
  /** 下次自动刷新的 Unix 毫秒时间戳 */
  nextRefreshAt: number
  /** 点击回调（通常触发手动刷新并重置周期） */
  onClick: () => void
  disabled?: boolean
  /** 按钮基础提示；组件会在末尾追加「刷新周期 X 秒」 */
  title?: string
  /** 数据加载中为 true：刷新图标持续旋转（loading 态），结束后复原 */
  loading?: boolean
}

/**
 * 带「方形边框进度」的刷新按钮。
 *
 * 进度条是按钮外侧一圈贴合按钮形状的方角边框：随自动刷新周期从 0 走到 100%，
 * 走满即代表一次自动刷新；点击按钮立即重置周期（手动刷新）。
 * 参考：real-time-fund 的 RefreshButton（方形边框进度 + 计时起点重置）。
 */
export function AutoRefreshButton({
  intervalSeconds,
  nextRefreshAt,
  onClick,
  disabled,
  title = '刷新',
  loading = false,
}: AutoRefreshButtonProps) {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let rafId: number
    const tick = () => {
      const now = Date.now()
      const total = Math.max(1, intervalSeconds * 1000)
      const remaining = Math.max(0, nextRefreshAt - now)
      const p = Math.min(1, Math.max(0, 1 - remaining / total))
      setProgress(p)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [intervalSeconds, nextRefreshAt])

  // 方形边框周长（圆角矩形）：按钮 32×32，ring 矩形与按钮外轮廓完全重合，
  // stroke 一半向内覆盖按钮边框、一半向外延伸，这样圆角与按钮严格对齐。
  const RW = 32
  const RH = 32
  const R = 6
  const STROKE = 2.5
  // 容器只需比按钮大一个 stroke，给 stroke 外半部分留空间
  const EXTRA = STROKE
  const STRAIGHT = 2 * (RW - 2 * R + (RH - 2 * R))
  const ARC = 2 * Math.PI * R
  const PERIMETER = STRAIGHT + ARC
  const dashOffset = PERIMETER * (1 - progress)
  const tooltip = `${title}（刷新周期 ${intervalSeconds} 秒）`

  return (
    <div className="relative inline-flex h-8 w-8 items-center justify-center">
      {/* 方形进度边框：与按钮外轮廓重合，不拦截点击 */}
      <svg
        className="pointer-events-none absolute inset-[-2px] overflow-visible"
        viewBox={`0 0 ${RW + EXTRA} ${RH + EXTRA}`}
        aria-hidden="true"
      >
        <rect
          x={EXTRA / 2}
          y={EXTRA / 2}
          width={RW}
          height={RH}
          rx={R}
          ry={R}
          fill="none"
          stroke="var(--app-ink-soft)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={PERIMETER}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <IconButton
        variant="outline"
        size="2"
        onClick={onClick}
        disabled={disabled}
        title={tooltip}
        aria-label={tooltip}
        style={{borderRadius: 6}}
      >
        <RefreshCw className={`h-4 w-4${loading ? ' animate-spin' : ''}`} />
      </IconButton>
    </div>
  )
}
