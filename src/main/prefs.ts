/** Non-sensitive interface preferences, readable before login (theme, language, auto-lock). */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Prefs } from '@shared/types'
import { paths } from './paths'

export const DEFAULT_PREFS: Prefs = { theme: 'system', language: 'en', formatLocale: 'en-BE', autoLockMinutes: 10 }

let cache: Prefs | null = null

export function getPrefs(): Prefs {
  if (cache) return cache
  try {
    const raw = existsSync(paths.prefsFile) ? (JSON.parse(readFileSync(paths.prefsFile, 'utf8')) as Partial<Prefs>) : {}
    cache = { ...DEFAULT_PREFS, ...raw }
  } catch {
    cache = { ...DEFAULT_PREFS }
  }
  return cache
}

export function updatePrefs(patch: Partial<Prefs>): Prefs {
  cache = { ...getPrefs(), ...patch }
  const tmp = paths.prefsFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(cache, null, 2))
  renameSync(tmp, paths.prefsFile)
  return cache
}
