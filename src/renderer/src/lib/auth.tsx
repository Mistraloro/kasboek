import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AuthStatus } from '@shared/types'
import { call } from './api'

interface AuthValue {
  status: AuthStatus
  refresh: () => Promise<void>
  set: (s: AuthStatus) => void
}

const Ctx = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const refresh = useCallback(async () => setStatus(await call('auth.status')), [])
  useEffect(() => {
    void refresh()
    return window.kasboek.onEvent((e) => {
      if (e.type === 'auth.locked') void refresh()
    })
  }, [refresh])
  if (!status) return null
  return <Ctx.Provider value={{ status, refresh, set: setStatus }}>{children}</Ctx.Provider>
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
