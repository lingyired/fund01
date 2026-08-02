import {ExternalLink, MoreHorizontal, Pencil, Plus, Upload} from 'lucide-react'
import {Button} from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'

/** 持仓管理下拉：添加 / 编辑 / 导入 / 新标签页打开 */
export function FundActionsMenu({
  onAdd,
  onEdit,
  onImport,
  onOpenTab,
}: {
  onAdd: () => void
  onEdit: () => void
  onImport: () => void
  onOpenTab?: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Button variant="outline" size="icon" title="管理持仓">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>持仓管理</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onAdd}>
          <Plus className="h-4 w-4" />
          添加持仓
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil className="h-4 w-4" />
          编辑持仓
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onImport}>
          <Upload className="h-4 w-4" />
          导入配置
        </DropdownMenuItem>
        {onOpenTab ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenTab}>
              <ExternalLink className="h-4 w-4" />
              新标签页打开
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
