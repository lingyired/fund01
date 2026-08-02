import {ExternalLink, MoreHorizontal, Pencil, Plus, Upload} from 'lucide-react'
import {DropdownMenu, IconButton} from '@radix-ui/themes'

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
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <IconButton variant="outline" title="管理持仓">
          <MoreHorizontal className="h-4 w-4" />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.Label>持仓管理</DropdownMenu.Label>
        <DropdownMenu.Item onSelect={onAdd}>
          <Plus className="h-4 w-4" />
          添加持仓
        </DropdownMenu.Item>
        <DropdownMenu.Item onSelect={onEdit}>
          <Pencil className="h-4 w-4" />
          编辑持仓
        </DropdownMenu.Item>
        <DropdownMenu.Item onSelect={onImport}>
          <Upload className="h-4 w-4" />
          导入配置
        </DropdownMenu.Item>
        {onOpenTab ? (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Item onSelect={onOpenTab}>
              <ExternalLink className="h-4 w-4" />
              新标签页打开
            </DropdownMenu.Item>
          </>
        ) : null}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}
