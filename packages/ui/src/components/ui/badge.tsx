import * as React from 'react'
import {Badge as RadixBadge} from '@radix-ui/themes'
import {cn} from '@fund01/core'

type Tone = 'default' | 'rise' | 'fall' | 'muted' | 'accent'
const TONE_COLOR = {
  default: 'gray',
  rise: 'red',
  fall: 'green',
  muted: 'gray',
  accent: 'indigo',
} as const

export interface BadgeProps
  extends Omit<React.ComponentPropsWithoutRef<typeof RadixBadge>, 'color'> {
  tone?: Tone
}

export function Badge({className, tone = 'default', ...props}: BadgeProps) {
  return (
    <RadixBadge
      color={TONE_COLOR[tone]}
      variant="soft"
      className={cn(className)}
      {...props}
    />
  )
}
