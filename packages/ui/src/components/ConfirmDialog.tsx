import type * as React from 'react'
import {AlertDialog, Button, Flex} from '@radix-ui/themes'

/**
 * 受控的二次确认弹窗。
 *
 * ⚠️ 为什么不用 window.confirm：Tauri v2 的 WebView 默认不实现
 * window.confirm / alert / prompt（弹窗被抑制、直接返回 false），因此在 Tauri
 * 桌面端点击「删除分组」会毫无反应、confirm 永远走进 return 分支。改用 Radix
 * AlertDialog 在 WebView 内渲染，Chrome / Tauri 两端通用。
 *
 * 用法：父组件用一个 state 保存待确认动作。
 * - open=false 时不渲染；open=true 显示弹窗。
 * - 点「确认」触发 onConfirm（父组件在此执行真正操作）。
 * - 取消 / ESC / 点遮罩 → onOpenChange(false)，父组件清空 state 即可。
 */
export type ConfirmAction = {
  title: string
  description?: React.ReactNode
  confirmText?: string
  cancelText?: string
  confirmColor?: 'red' | 'gray' | 'blue' | 'green'
  onConfirm: () => void
}

export function ConfirmDialog({
  action,
  onOpenChange,
}: {
  /** 待确认动作；为 null 时弹窗关闭 */
  action: ConfirmAction | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <AlertDialog.Root
      open={action !== null}
      onOpenChange={(o) => {
        if (!o) onOpenChange(false)
      }}
    >
      <AlertDialog.Content maxWidth="420px">
        <AlertDialog.Title>{action?.title ?? ''}</AlertDialog.Title>
        {action?.description != null && (
          <AlertDialog.Description>{action.description}</AlertDialog.Description>
        )}
        <Flex gap="3" justify="end" mt="4">
          <AlertDialog.Cancel>
            <Button variant="soft" color="gray">
              {action?.cancelText ?? '取消'}
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button
              color={action?.confirmColor ?? 'red'}
              onClick={() => action?.onConfirm()}
            >
              {action?.confirmText ?? '确认'}
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  )
}
