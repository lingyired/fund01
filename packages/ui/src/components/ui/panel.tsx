import * as React from 'react'
import {Card as RadixCard} from '@radix-ui/themes'
import {cn} from '@fund01/core'

export function Panel({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
}) {
  return (
    <RadixCard className={cn('rt-panel', className)}>{children}</RadixCard>
  )
}

export function PanelHeader({
  title,
  desc,
  action,
}: {
  title: string
  desc?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line/70 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="shrink-0 font-display text-base font-bold tracking-tight">
          {title}
        </h2>
        {desc ? (
          <p className="min-w-0 truncate text-xs text-muted">{desc}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
