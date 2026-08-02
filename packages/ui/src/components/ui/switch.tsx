import * as React from 'react'
import {Switch as RadixSwitch} from '@radix-ui/themes'
import {cn} from '@fund01/core'

export const Switch = React.forwardRef<
  React.ElementRef<typeof RadixSwitch>,
  React.ComponentPropsWithoutRef<typeof RadixSwitch>
>(({className, ...props}, ref) => (
  <RadixSwitch ref={ref} className={cn(className)} {...props} />
))
Switch.displayName = 'Switch'
