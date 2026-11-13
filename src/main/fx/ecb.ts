/**
 * Downloads the European Central Bank's public euro reference rates. Only this public file is
 * fetched; nothing about the user's data is sent. Rates are kept only for the currencies in use.
 */
import { net } from 'electron'
import { ECB_CURRENCIES } from '@shared/currency'
import type { Db } from '@core/database'
import { AppError } from '@core/errors'
import { currencyInfo, parseEcbCsv, storeEcbRates } from '@core/fx'
import { getSettings, updateSettings } from '@core/settings'
import { readZipEntry } from '@core/unzip'

const HISTORY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip'

export async function updateEcbRates(db: Db): Promise<{ added: number }> {
  const s = getSettings(db)
  const wanted = new Set(currencyInfo(db, s.currency).map((c) => c.currency).filter((c) => ECB_CURRENCIES.includes(c)))
  if (!wanted.size) {
    updateSettings(db, { fxLastEcbUpdateAt: new Date().toISOString() })
    return { added: 0 }
  }
  let zip: Buffer
  try {
    const res = await net.fetch(HISTORY_URL, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    zip = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    throw new AppError('fx.download', `The ECB rates could not be downloaded (${err instanceof Error ? err.message : 'network error'}).`)
  }
  const csv = readZipEntry(zip, (n) => n.toLowerCase().endsWith('.csv'))
  if (!csv) throw new AppError('fx.bad_file', 'The ECB file was not in the expected format.')
  const { added } = storeEcbRates(db, parseEcbCsv(csv.toString('utf8'), wanted))
  updateSettings(db, { fxLastEcbUpdateAt: new Date().toISOString() })
  return { added }
}

/** With automatic updates on: once a day at most, and only when other currencies are in use. */
export function shouldAutoUpdate(db: Db, now = Date.now()): boolean {
  const s = getSettings(db)
  if (!s.fxAutoUpdate) return false
  if (s.fxLastEcbUpdateAt && now - Date.parse(s.fxLastEcbUpdateAt) < 20 * 3600_000) return false
  return currencyInfo(db, s.currency).some((c) => ECB_CURRENCIES.includes(c.currency))
}
