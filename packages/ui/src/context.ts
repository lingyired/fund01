import { createContext, useContext } from 'react'
import type { Ports } from '@fund01/core'

export const PortsContext = createContext<Ports | null>(null)

export function usePorts(): Ports {
  const p = useContext(PortsContext)
  if (!p) throw new Error('PortsContext.Provider 未注入')
  return p
}
