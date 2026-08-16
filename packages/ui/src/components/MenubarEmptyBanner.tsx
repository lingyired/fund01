import {RefreshCw, RotateCcw, Settings2} from 'lucide-react'
import {Button, IconButton, Tooltip} from '@radix-ui/themes'

/** menubar 全空时的 header 替换 banner（App.tsx / OptionsApp.tsx 共用）：
 *  用户移除了所有菜单栏状态项（含总览）→ 提示 + 一键恢复；不做任何操作关闭窗口后 app 将退出。
 *  样式对齐 popup header（border-b bg-panel/85），高度相近，不额外占行。
 *  刷新 / 打开设置为可选（popup 场景需要保留这两个能力；设置页自身即设置入口，不传）。 */
export function MenubarEmptyBanner({
  onRestore,
  onRefresh,
  onOpenSettings,
}: {
  onRestore: () => void
  onRefresh?: () => void
  onOpenSettings?: () => void
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/70 bg-panel/85 px-3 py-1.5 backdrop-blur-md">
      <div className="flex min-w-0 flex-col justify-center">
        <span className="truncate text-[12px] font-semibold text-ink">菜单栏已全部关闭</span>
        <span className="truncate text-[11px] text-muted">当所有窗口都关闭后，app 将退出</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onRefresh ? (
          <Tooltip content="刷新">
            <IconButton variant="outline" onClick={onRefresh} aria-label="刷新">
              <RefreshCw className="h-4 w-4" />
            </IconButton>
          </Tooltip>
        ) : null}
        {onOpenSettings ? (
          <Tooltip content="设置">
            <IconButton variant="outline" onClick={onOpenSettings} aria-label="设置">
              <Settings2 className="h-4 w-4" />
            </IconButton>
          </Tooltip>
        ) : null}
        <Button size="1" variant="solid" onClick={onRestore}>
          <RotateCcw className="h-3.5 w-3.5" />
          恢复菜单栏
        </Button>
      </div>
    </div>
  )
}
