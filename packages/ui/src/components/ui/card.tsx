import * as React from 'react'
import {Card as RadixCard} from '@radix-ui/themes'
import {cn} from '@fund01/core'

export const Card = React.forwardRef<
  React.ElementRef<typeof RadixCard>,
  React.ComponentPropsWithoutRef<typeof RadixCard>
>(({className, ...props}, ref) => (
  <RadixCard ref={ref} className={cn(className)} {...props} />
))
Card.displayName = 'Card'

export const CardHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1 p-4', className)} {...props} />
)
export const CardTitle = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('text-sm font-semibold', className)} {...props} />
)
export const CardContent = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-4 pt-0', className)} {...props} />
)
export const CardFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center p-4 pt-0', className)} {...props} />
)
