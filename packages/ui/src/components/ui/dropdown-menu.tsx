import * as React from 'react'
import {DropdownMenu as RadixDropdownMenu} from '@radix-ui/themes'
import {cn} from '@fund01/core'

export const DropdownMenu = RadixDropdownMenu.Root
export const DropdownMenuTrigger = RadixDropdownMenu.Trigger
export const DropdownMenuGroup = RadixDropdownMenu.Group

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof RadixDropdownMenu.Content>,
  React.ComponentPropsWithoutRef<typeof RadixDropdownMenu.Content>
>(({className, ...props}, ref) => (
  <RadixDropdownMenu.Content
    ref={ref}
    className={cn(className)}
    {...props}
  />
))
DropdownMenuContent.displayName = 'DropdownMenuContent'

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof RadixDropdownMenu.Item>,
  React.ComponentPropsWithoutRef<typeof RadixDropdownMenu.Item> & {inset?: boolean}
>(({className, inset, ...props}, ref) => (
  <RadixDropdownMenu.Item
    ref={ref}
    className={cn(inset && 'pl-8', className)}
    {...props}
  />
))
DropdownMenuItem.displayName = 'DropdownMenuItem'

export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof RadixDropdownMenu.Label>,
  React.ComponentPropsWithoutRef<typeof RadixDropdownMenu.Label>
>(({className, ...props}, ref) => (
  <RadixDropdownMenu.Label ref={ref} className={cn(className)} {...props} />
))
DropdownMenuLabel.displayName = 'DropdownMenuLabel'

export const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof RadixDropdownMenu.Separator>,
  React.ComponentPropsWithoutRef<typeof RadixDropdownMenu.Separator>
>(({className, ...props}, ref) => (
  <RadixDropdownMenu.Separator ref={ref} className={cn(className)} {...props} />
))
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator'
