import * as React from 'react'
import {cn} from '@fund01/core'

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({className, ...props}, ref) => (
  <label
    ref={ref}
    className={cn('text-sm font-medium text-ink-soft leading-none', className)}
    {...props}
  />
))
Label.displayName = 'Label'
