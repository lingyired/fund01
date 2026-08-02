import {Button as RadixButton} from '@radix-ui/themes'
import type {ComponentProps} from 'react'
import {cn} from '@fund01/core'

type ShadcnVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'danger'
type ShadcnSize = 'default' | 'sm' | 'lg' | 'icon'

export interface ButtonProps
  extends Omit<ComponentProps<typeof RadixButton>, 'variant' | 'size'> {
  variant?: ShadcnVariant
  size?: ShadcnSize
}

const VARIANT_MAP: Record<ShadcnVariant, NonNullable<ComponentProps<typeof RadixButton>['variant']>> = {
  default: 'solid',
  secondary: 'soft',
  outline: 'outline',
  ghost: 'ghost',
  danger: 'solid',
}
const SIZE_MAP: Record<ShadcnSize, NonNullable<ComponentProps<typeof RadixButton>['size']>> = {
  default: '2',
  sm: '1',
  lg: '3',
  icon: '1',
}

export function Button({variant, size, className, color, ...props}: ButtonProps) {
  const rVariant = variant ? VARIANT_MAP[variant] : undefined
  const rSize = size ? SIZE_MAP[size] : undefined
  const resolvedColor = variant === 'danger' ? 'red' : color
  const iconCls = size === 'icon' ? 'aspect-square p-0' : ''
  return (
    <RadixButton
      variant={rVariant}
      size={rSize}
      color={resolvedColor}
      className={cn(iconCls, className)}
      {...props}
    />
  )
}
