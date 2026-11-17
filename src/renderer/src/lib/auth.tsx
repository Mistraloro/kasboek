import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
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
let loadedReported = false

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [setupFlowActive, setSetupFlowActive] = useState(false)
  const latest = useRef(0)
  const set = useCallback((s: AuthStatus) => {
    latest.current++
    setStatus(s)
  }, [])
  const refresh = useCallback(async () => {
    const mine = ++latest.current
    const next = await call('auth.status')
    // A newer refresh was started meanwhile: its answer is the one to keep.
    if (mine === latest.current) setStatus(next)
    // Once, for the start-up log in the data folder (fire and forget).
    if (!loadedReported) {
      loadedReported = true
      void window.kasboek.invoke('app.milestone', { name: 'auth loaded', ms: Math.round(performance.now()) }).catch(() => {})
    }
  }, [])
  useEffect(() => {
    void refresh()
    return window.kasboek.onEvent((e) => {
      if (e.type === 'auth.locked' || e.type === 'auth.refresh') void refresh()
    })
  }, [refresh])
  if (!status) return null
  return <Ctx.Provider value={{ status, refresh, set, setupFlowActive, setSetupFlowActive }}>{children}</Ctx.Provider>
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
