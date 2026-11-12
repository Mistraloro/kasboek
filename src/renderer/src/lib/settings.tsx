import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppInfo, Prefs, Settings } from '@shared/types'
import i18n from '../i18n'
import { call } from './api'
import { formatMoney } from './format'

/* ---------- Preferences: available before login ---------- */

interface PrefsValue {
  prefs: Prefs
  info: AppInfo
  updatePrefs: (patch: Partial<Prefs>) => Promise<void>
}

const PrefsCtx = createContext<PrefsValue | null>(null)
const systemDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches

export function applyThemeToDocument(theme: Prefs['theme']): void {
  const dark = theme === 'dark' || (theme === 'system' && systemDark())
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light'
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void Promise.all([call('prefs.get'), call('app.info')]).then(([p, i]) => {
      setPrefs(p)
      setInfo(i)
    })
  }, [])

  useEffect(() => {
    if (!prefs) return
    applyThemeToDocument(prefs.theme)
    document.documentElement.lang = prefs.language
    void i18n.changeLanguage(prefs.language)
    if (prefs.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyThemeToDocument('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [prefs])

  const updatePrefs = useCallback(async (patch: Partial<Prefs>) => setPrefs(await call('prefs.update', patch)), [])
  const value = useMemo(() => (prefs && info ? { prefs, info, updatePrefs } : null), [prefs, info, updatePrefs])
  if (!value) return null
  return <PrefsCtx.Provider value={value}>{children}</PrefsCtx.Provider>
}

export function usePrefs(): PrefsValue {
  const v = useContext(PrefsCtx)
  if (!v) throw new Error('usePrefs outside PrefsProvider')
  return v
}

/* ---------- Data settings: only while unlocked ---------- */

interface SettingsValue extends PrefsValue {
  settings: Settings
  update: (patch: { currency?: string }) => Promise<void>
  money: (cents: number) => string
  locale: string
}

const Ctx = createContext<SettingsValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const prefsValue = usePrefs()
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    void call('settings.get').then(setSettings)
  }, [])
  const update = useCallback(async (patch: { currency?: string }) => setSettings(await call('settings.update', patch)), [])
  const value = useMemo(
    () =>
      settings
        ? {
            ...prefsValue,
            settings,
            update,
            locale: prefsValue.prefs.formatLocale,
            money: (c: number) => formatMoney(c, settings.currency, prefsValue.prefs.formatLocale)
          }
        : null,
    [settings, prefsValue, update]
  )
  if (!value) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSettings(): SettingsValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSettings outside SettingsProvider')
  return v
}
