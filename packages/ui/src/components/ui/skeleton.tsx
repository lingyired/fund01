import {cn} from '@fund01/core'

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-paper-deep/70', className)}
      {...props}
    />
  )
}
