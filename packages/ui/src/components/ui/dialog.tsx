import * as React from 'react'
import {Dialog as RadixDialog} from '@radix-ui/themes'
import {X} from 'lucide-react'
import {cn} from '@fund01/core'

export const Dialog = RadixDialog.Root
export const DialogTrigger = RadixDialog.Trigger
export const DialogClose = RadixDialog.Close

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof RadixDialog.Content>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Content>
>(({className, children, ...props}, ref) => (
  <RadixDialog.Content
    ref={ref}
    className={cn('rt-popup-dialog', className)}
    {...props}
  >
    {children}
    <RadixDialog.Close className="rt-dialog-close" aria-label="关闭">
      <X className="h-4 w-4" />
    </RadixDialog.Close>
  </RadixDialog.Content>
))
DialogContent.displayName = 'DialogContent'

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1', className)} {...props} />
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixDialog.Title>) {
  return (
    <RadixDialog.Title
      className={cn('font-display font-bold', className)}
      {...props}
    />
  )
}
