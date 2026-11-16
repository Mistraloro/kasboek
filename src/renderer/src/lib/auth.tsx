import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AuthStatus } from '@shared/types'
import { call } from './api'

interface AuthValue {
  status: AuthStatus
  refresh: () => Promise<void>
  set: (s: AuthStatus) => void
  /** True from creating the account until the first-run recovery key and two-factor steps end. */
  setupFlowActive: boolean
  setSetupFlowActive: (active: boolean) => void
}

const Ctx = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [setupFlowActive, setSetupFlowActive] = useState(false)
  const refresh = useCallback(async () => setStatus(await call('auth.status')), [])
  useEffect(() => {
    void refresh()
    return window.kasboek.onEvent((e) => {
      if (e.type === 'auth.locked' || e.type === 'auth.refresh') void refresh()
    })
  }, [refresh])
  if (!status) return null
  return <Ctx.Provider value={{ status, refresh, set: setStatus, setupFlowActive, setSetupFlowActive }}>{children}</Ctx.Provider>
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
