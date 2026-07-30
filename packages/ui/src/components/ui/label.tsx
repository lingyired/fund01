import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@fund01/core';

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn('text-sm font-medium text-ink-soft leading-none', className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;
