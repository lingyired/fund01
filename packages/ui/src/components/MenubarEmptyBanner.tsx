import {RotateCcw} from 'lucide-react'
import {Button} from '@radix-ui/themes'

/** menubar 全空时的 header 替换 banner（App.tsx / OptionsApp.tsx 共用）：
 *  用户移除了所有菜单栏状态项（含总览）→ 提示 + 一键恢复；不做任何操作关闭窗口后 app 将退出。
 *  样式对齐 popup header（border-b bg-panel/85），高度相近，不额外占行。 */
export function MenubarEmptyBanner({onRestore}: {onRestore: () => void}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/70 bg-panel/85 px-3 py-1.5 backdrop-blur-md">
      <div className="flex min-w-0 flex-col justify-center">
        <span className="truncate text-[12px] font-semibold text-ink">菜单栏已全部关闭</span>
        <span className="truncate text-[11px] text-muted">关闭窗口后 app 将退出</span>
      </div>
      <Button size="1" variant="solid" onClick={onRestore}>
        <RotateCcw className="h-3.5 w-3.5" />
        恢复菜单栏
      </Button>
    </div>
  )
}
