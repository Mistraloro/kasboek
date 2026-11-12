import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppInfo, Settings } from '@shared/types'
import i18n from '../i18n'
import { call } from './api'
import { formatMoney } from './format'

interface SettingsValue {
  settings: Settings
  info: AppInfo
  update: (patch: Partial<Pick<Settings, 'theme' | 'language' | 'formatLocale' | 'currency'>>) => Promise<void>
  money: (cents: number) => string
}

const Ctx = createContext<SettingsValue | null>(null)

const systemDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches

export function applyThemeToDocument(theme: Settings['theme']): void {
  const dark = theme === 'dark' || (theme === 'system' && systemDark())
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light'
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void Promise.all([call('settings.get'), call('app.info')]).then(([s, i]) => {
      setSettings(s)
      setInfo(i)
    })
  }, [])

  useEffect(() => {
    if (!settings) return
    applyThemeToDocument(settings.theme)
    document.documentElement.lang = settings.language
    void i18n.changeLanguage(settings.language)
    if (settings.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyThemeToDocument('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings])

  const update = useCallback<SettingsValue['update']>(async (patch) => {
    setSettings(await call('settings.update', patch))
  }, [])

  const value = useMemo(
    () =>
      settings && info
        ? { settings, info, update, money: (c: number) => formatMoney(c, settings.currency, settings.formatLocale) }
        : null,
    [settings, info, update]
  )

  if (!value) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSettings(): SettingsValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSettings outside SettingsProvider')
  return v
}
