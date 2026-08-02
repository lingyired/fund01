import * as React from 'react'
import {TextField} from '@radix-ui/themes'
import {cn} from '@fund01/core'

type InputProps = React.ComponentProps<'input'>

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({className, ...props}, ref) => (
    <TextField.Root
      ref={ref}
      className={cn('w-full', className)}
      {...(props as React.ComponentProps<typeof TextField.Root>)}
    />
  ),
)
Input.displayName = 'Input'
