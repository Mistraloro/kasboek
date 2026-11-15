/**
 * System notifications for new warnings (a budget nearly or fully spent, a balance heading below
 * zero), each once per run of the app.
 */
import { Notification } from 'electron'
import { formatDate, formatMoney } from '@shared/format'
import type { Alert } from '@shared/types'
import { listAlerts } from '@core/alerts'
import { getSettings } from '@core/settings'
import { getPrefs } from './prefs'
import { db, isUnlocked } from './session'

type Text = { near: string; over: string; balance: string }
const TEXT: Record<string, Text> = {
  en: { near: '{name}: {pct}% of the budget used ({spent} of {budget}).', over: '{name}: over budget ({spent} of {budget}).', balance: '{name} may go below zero before {date}: {lowest} after the fixed costs still due.' },
  nl: { near: '{name}: {pct}% van het budget gebruikt ({spent} van {budget}).', over: '{name}: over het budget ({spent} van {budget}).', balance: '{name} kan voor {date} onder nul gaan: {lowest} na de vaste kosten die nog komen.' },
  fr: { near: '{name} : {pct} % du budget utilisé ({spent} sur {budget}).', over: '{name} : budget dépassé ({spent} sur {budget}).', balance: '{name} pourrait passer sous zéro avant le {date} : {lowest} après les frais fixes à venir.' },
  de: { near: '{name}: {pct} % des Budgets verbraucht ({spent} von {budget}).', over: '{name}: Budget überschritten ({spent} von {budget}).', balance: '{name} könnte vor dem {date} ins Minus gehen: {lowest} nach den noch fälligen Fixkosten.' },
  es: { near: '{name}: {pct} % del presupuesto usado ({spent} de {budget}).', over: '{name}: presupuesto superado ({spent} de {budget}).', balance: '{name} podría quedar en negativo antes del {date}: {lowest} tras los gastos fijos pendientes.' },
  pt: { near: '{name}: {pct}% do orçamento usado ({spent} de {budget}).', over: '{name}: orçamento ultrapassado ({spent} de {budget}).', balance: '{name} pode ficar negativo antes de {date}: {lowest} depois dos custos fixos por pagar.' }
}

const shown = new Set<string>()

function message(a: Alert): string {
  const prefs = getPrefs()
  const tx = TEXT[prefs.language] ?? TEXT[prefs.language.split('-')[0]!] ?? TEXT['en']!
  const main = getSettings(db()).currency
  const money = (c: number, cur = main): string => formatMoney(c, cur, prefs.formats)
  const fill = (s: string, v: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''))
  if (a.kind === 'budget') return fill(a.level === 'over' ? tx.over : tx.near, { name: a.name, pct: Math.round((a.spentCents / a.budgetCents) * 100), spent: money(a.spentCents), budget: money(a.budgetCents) })
  return fill(tx.balance, { name: a.name, date: formatDate(a.until, prefs.formats, prefs.language), lowest: money(a.lowestCents, a.currency) })
}

export function notifyAlerts(): void {
  if (!isUnlocked() || !Notification.isSupported()) return
  let alerts: Alert[]
  try {
    alerts = listAlerts(db())
  } catch (err) {
    console.warn('[alerts]', err instanceof Error ? err.message : err)
    return
  }
  for (const a of alerts) {
    if (shown.has(a.key)) continue
    shown.add(a.key)
    new Notification({ title: 'Kasboek', body: message(a), silent: false }).show()
  }
}

/** Checks now and then (and soon after unlocking, via the first tick). */
export function startAlertChecks(): void {
  setTimeout(notifyAlerts, 30_000)
  setInterval(notifyAlerts, 10 * 60_000)
}
