/**
 * Tips for the Overview, found locally from the person's own data: price rises, a payment taken
 * twice, late or upcoming fixed costs, budgets, categories that grew, unusual payments. No model
 * and nothing is sent anywhere: this only builds facts; the texts are made from them on screen.
 * Every money value carries its currency (fixed costs stay in their account's currency); a fact that
 * mixes currencies is worked out in the main currency, and left out when a rate is missing.
 * Income is never a fact. What the person hid is kept in `insight_feedback` (this computer only).
 * Tips the assistant wrote from these facts (core/insight-plan.ts) are kept in `insights`, also on this
 * computer only, together with the facts that were sent.
 */
import { createHash } from 'node:crypto'
import { addMonths, localToday, monthOf } from '@shared/month'
import { presetFor, type ProviderId } from '@shared/ai-providers'
import type { InsightFact, InsightKind, InsightSuggestion, InsightValue, InsightsView, RecurringItem } from '@shared/types'
import { NEAR, listAlerts } from './alerts'
import type { Db } from './database'
import { convert } from './fx'
import { listBudgets } from './finance'
import { findRecurring, median } from './recurring'
import { categoryTrend, monthReview } from './review'
import { getSettings } from './settings'

/** Limits for the first version; to be tuned with use. Amounts are cents, shares are fractions. */
export const INSIGHT_LIMITS = {
  /** At most this many facts, the biggest first. */
  maxFacts: 30,
  maxTransactionIds: 20,
  /** A price rise counts while the last payment is at most this many days ago. */
  priceUpDays: 60,
  /** A payment taken twice: both within this share of the usual amount, in the last days. */
  chargedTwiceShare: 0.1,
  chargedTwiceDays: 60,
  /** A cost due within this many days, when it is quarterly or yearly or this many times the median fixed cost. */
  upcomingDays: 30,
  upcomingTimesMedian: 2,
  /** A category up by this share and this amount against the average of the three months before. */
  categoryUpShare: 0.25,
  categoryUpCents: 5000,
  /** A category without a budget that took this much a month on average in each of the last months. */
  noBudgetMonths: 3,
  noBudgetCents: 10000,
  /** The summary of fixed costs needs at least this many. */
  subscriptionsMin: 2
} as const

const DISMISSED = ['dismissed', 'not_useful']

type Draft = Omit<InsightFact, 'id'>

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)
const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The latest calendar month in the last days with two payments near the usual amount of a monthly fixed cost. */
function chargedTwice(db: Db, item: RecurringItem, today: string): { month: string; list: { id: number; booking_date: string; amount_cents: number }[]; last: { booking_date: string; amount_cents: number } } | null {
  const usual = Math.abs(item.typicalCents)
  const rows = db
    .prepare(`SELECT id, booking_date, amount_cents FROM transactions WHERE id IN (${item.transactionIds.map(() => '?').join(',')}) AND booking_date >= ? AND booking_date <= ? ORDER BY booking_date, id`)
    .all(...item.transactionIds, addDays(today, -INSIGHT_LIMITS.chargedTwiceDays), today) as { id: number; booking_date: string; amount_cents: number }[]
  const byMonth = new Map<string, typeof rows>()
  for (const r of rows) {
    if (Math.abs(Math.abs(r.amount_cents) - usual) > usual * INSIGHT_LIMITS.chargedTwiceShare) continue
    const m = r.booking_date.slice(0, 7)
    byMonth.set(m, [...(byMonth.get(m) ?? []), r])
  }
  const twice = [...byMonth].filter(([, list]) => list.length >= 2).at(-1)
  return twice ? { month: twice[0], list: twice[1], last: twice[1].at(-1)! } : null
}

/** The keys of the tips the person hid or called not useful. */
export function dismissedKeys(db: Db): Set<string> {
  return new Set((db.prepare(`SELECT key FROM insight_feedback WHERE verdict IN (${DISMISSED.map(() => '?').join(',')})`).all(...DISMISSED) as { key: string }[]).map((r) => r.key))
}

/**
 * The facts found for a month, kept per database while nothing in it changed (SQLite counts the rows this
 * connection changed). Working them out takes a moment on a big file, and the card asks again each time it opens.
 */
const cache = new WeakMap<Db, Map<string, Draft[]>>()

/** Forgets the kept facts, e.g. on a `data.changed` event. */
export function forgetFacts(db: Db): void {
  cache.delete(db)
}

const dataVersion = (db: Db): number => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

/** Facts for `month` ('YYYY-MM'): the biggest first, without the ones the person hid. */
export function buildFacts(db: Db, month: string, today = localToday()): InsightFact[] {
  const key = `${month}|${today}|${dataVersion(db)}`
  const kept = cache.get(db)?.get(key)
  const drafts = kept ?? draftFacts(db, month, today)
  // Only the latest version is kept.
  if (!kept) cache.set(db, new Map([[key, drafts]]))
  const hidden = dismissedKeys(db)
  return drafts
    .filter((d) => !hidden.has(d.key))
    .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key))
    .slice(0, INSIGHT_LIMITS.maxFacts)
    .map((d, n) => ({ id: `f${n + 1}`, ...d }))
}

function draftFacts(db: Db, month: string, today: string): Draft[] {
  const L = INSIGHT_LIMITS
  const main = getSettings(db).currency
  const currentMonth = monthOf(new Date(`${today}T12:00:00`))
  const currencyOf = new Map((db.prepare('SELECT id, currency FROM accounts').all() as { id: number; currency: string }[]).map((a) => [a.id, a.currency]))
  const inMain = (cents: number, currency: string): number | null => convert(db, cents, currency, today, main)
  const drafts: Draft[] = []
  const add = (kind: InsightKind, key: string, values: Record<string, InsightValue>, weight: number, extra: Partial<Pick<Draft, 'categoryId' | 'recurringKey' | 'transactionIds'>> = {}): void => {
    drafts.push({ key: `${kind}:${key}`, kind, values, categoryId: extra.categoryId ?? null, recurringKey: extra.recurringKey ?? null, transactionIds: (extra.transactionIds ?? []).slice(0, L.maxTransactionIds), weight: Math.max(0, Math.round(weight)) })
  }

  // Fixed costs and the balance warning are about now: only for the month that is running.
  if (month === currentMonth) {
    const costs = findRecurring(db, today).items.filter((i) => i.direction === 'out')
    const currency = (i: RecurringItem): string => currencyOf.get(i.accountId) ?? main
    const weightOf = (i: RecurringItem, cents: number): number => inMain(Math.abs(cents), currency(i)) ?? 0
    const amounts = costs.flatMap((i) => inMain(Math.abs(i.typicalCents), currency(i)) ?? [])
    const usualCost = amounts.length ? median(amounts) : null

    for (const i of costs) {
      const cur = currency(i)
      const base = { recurringKey: i.key, transactionIds: i.transactionIds.slice(-L.maxTransactionIds) }
      // More expensive than the payment before (money out is negative, so a rise is below zero).
      if (i.priceChangeCents !== null && i.priceChangeCents < 0 && daysBetween(i.lastDate, today) <= L.priceUpDays)
        add('price_up', `${i.key}:${i.lastDate.slice(0, 7)}`, { name: { text: i.name }, from: { money: Math.abs(i.lastCents - i.priceChangeCents), currency: cur }, to: { money: Math.abs(i.lastCents), currency: cur }, change: { money: Math.abs(i.priceChangeCents), currency: cur }, date: { date: i.lastDate } }, weightOf(i, i.priceChangeCents), base)
      if (i.status === 'late') add('late', `${i.key}:${i.nextDate}`, { name: { text: i.name }, amount: { money: Math.abs(i.typicalCents), currency: cur }, date: { date: i.nextDate } }, weightOf(i, i.typicalCents), base)
      const inDays = daysBetween(today, i.nextDate)
      const big = usualCost !== null && (inMain(Math.abs(i.typicalCents), cur) ?? 0) >= usualCost * L.upcomingTimesMedian
      if (inDays >= 0 && inDays <= L.upcomingDays && (i.frequency === 'quarterly' || i.frequency === 'yearly' || big))
        add('upcoming', `${i.key}:${i.nextDate}`, { name: { text: i.name }, amount: { money: Math.abs(i.typicalCents), currency: cur }, date: { date: i.nextDate } }, weightOf(i, i.typicalCents), base)
      if (i.frequency === 'monthly') {
        const twice = chargedTwice(db, i, today)
        if (twice) add('charged_twice', `${i.key}:${twice.month}`, { name: { text: i.name }, amount: { money: Math.abs(twice.last.amount_cents), currency: cur }, count: { count: twice.list.length }, date: { date: twice.last.booking_date } }, weightOf(i, twice.last.amount_cents), { recurringKey: i.key, transactionIds: twice.list.map((r) => r.id) })
      }
    }

    // Fixed costs together (a later step can look for overlaps), in the main currency.
    const converted = costs.flatMap((i) => {
      const v = inMain(Math.abs(i.monthlyCents), currency(i))
      return v === null ? [] : [{ name: i.name, cents: v }]
    })
    if (converted.length >= L.subscriptionsMin) {
      const total = converted.reduce((t, c) => t + c.cents, 0)
      const names = converted.sort((a, b) => b.cents - a.cents).map((c) => c.name).join(', ')
      add('subscriptions', month, { count: { count: converted.length }, amount: { money: total, currency: main }, names: { text: names } }, total)
    }

    for (const a of listAlerts(db, today)) {
      if (a.kind !== 'balance') continue
      add('balance_low', `${a.accountId}:${a.until}`, { name: { text: a.name }, lowest: { money: a.lowestCents, currency: a.currency }, balance: { money: a.balanceCents, currency: a.currency }, due: { money: a.dueCents, currency: a.currency }, date: { date: a.until } }, inMain(Math.abs(a.lowestCents), a.currency) ?? 0)
    }
  }

  // Budgets of the month (the same limits as the warnings).
  const budgets = listBudgets(db, month)
  for (const b of budgets) {
    if (!b.budgetCents || b.budgetCents <= 0 || b.spentCents < b.budgetCents * NEAR) continue
    const over = b.spentCents > b.budgetCents
    add(over ? 'over_budget' : 'near_budget', `${month}:${b.categoryId}`, { name: { text: b.name }, spent: { money: b.spentCents, currency: main }, budget: { money: b.budgetCents, currency: main }, percent: { count: Math.round((b.spentCents / b.budgetCents) * 100) }, month: { text: month } }, b.spentCents, { categoryId: b.categoryId })
  }

  // A category with steady spending and no budget.
  const earlier = Array.from({ length: L.noBudgetMonths }, (_, n) => listBudgets(db, addMonths(month, -(n + 1))))
  for (const b of budgets) {
    if (b.budgetCents !== null) continue
    const spent = earlier.map((rows) => rows.find((r) => r.categoryId === b.categoryId)?.spentCents ?? 0)
    const average = spent.reduce((t, c) => t + c, 0) / spent.length
    if (spent.every((c) => c > 0) && average >= L.noBudgetCents) add('no_budget', `${month}:${b.categoryId}`, { name: { text: b.name }, average: { money: Math.round(average), currency: main }, month: { text: month } }, average, { categoryId: b.categoryId })
  }

  // Against the three months before, only for a finished month: the one shown, or else the month before.
  const finished = month < currentMonth ? month : addMonths(currentMonth, -1)
  // The full review is only needed for the month shown (payments that stand out); the month before needs the category totals only.
  const shown = monthReview(db, month)
  for (const c of finished === month ? shown.categories : categoryTrend(db, finished)) {
    if (c.categoryId === null || c.averageCents <= 0 || c.changeCents < c.averageCents * L.categoryUpShare || c.changeCents < L.categoryUpCents) continue
    add('category_up', `${finished}:${c.categoryId}`, { name: { text: c.name }, amount: { money: c.cents, currency: main }, average: { money: c.averageCents, currency: main }, change: { money: c.changeCents, currency: main }, percent: { count: Math.round((c.changeCents / c.averageCents) * 100) }, month: { text: finished } }, c.changeCents, { categoryId: c.categoryId })
  }

  // Payments that stand out in the month shown.
  for (const u of shown.unusual)
    add('unusual', String(u.id), { name: { text: u.name }, amount: { money: u.cents, currency: main }, ...(u.usualCents !== null ? { usual: { money: u.usualCents, currency: main } } : {}), date: { date: u.date }, reason: { text: u.reason } }, u.cents, { transactionIds: [u.id] })

  return drafts
}

/**
 * A short hash of what the facts say (keys and values; not the ids and not the day), to know whether
 * anything changed since tips were last written from them.
 */
export function hashFacts(facts: InsightFact[]): string {
  const stable = [...facts]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((f) => [f.key, f.kind, Object.entries(f.values).sort(([a], [b]) => a.localeCompare(b))])
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32)
}

/** What the person did with a tip. Hidden and "not useful" tips are left out from then on. */
export function giveFeedback(db: Db, key: string, verdict: 'dismissed' | 'not_useful' | 'useful'): { ok: true } {
  db.prepare(
    `INSERT INTO insight_feedback (key, verdict) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET verdict = excluded.verdict, at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(key, verdict)
  return { ok: true }
}

/** Brings back the hidden and "not useful" tips. */
export function restoreDismissed(db: Db): { restored: number } {
  return { restored: db.prepare(`DELETE FROM insight_feedback WHERE verdict IN (${DISMISSED.map(() => '?').join(',')})`).run(...DISMISSED).changes }
}

/** The tips the assistant wrote for a month, with who wrote them and the facts they were written from. */
export interface StoredInsights {
  provider: string
  model: string
  language: string
  facts: InsightFact[]
  suggestions: InsightSuggestion[]
}

/** Keeps these tips for the month, replacing the ones before. */
export function saveInsights(db: Db, month: string, stored: StoredInsights, createdAt = new Date().toISOString()): void {
  db.prepare(
    `INSERT INTO insights (month, created_at, provider, model, language, facts_hash, facts_json, suggestions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(month) DO UPDATE SET created_at = excluded.created_at, provider = excluded.provider, model = excluded.model, language = excluded.language,
       facts_hash = excluded.facts_hash, facts_json = excluded.facts_json, suggestions_json = excluded.suggestions_json`
  ).run(month, createdAt, stored.provider, stored.model, stored.language, hashFacts(stored.facts), JSON.stringify(stored.facts), JSON.stringify(stored.suggestions))
}

/**
 * The local facts for a month and, when the assistant wrote tips for it, those tips: without what the
 * person hid since, and marked when the facts or the interface language are not the ones they were written for
 * (`language` null: not known here, so only the facts are compared).
 */
export function insightsView(db: Db, month: string, language: string | null, today = localToday()): InsightsView {
  const facts = buildFacts(db, month, today)
  const row = db.prepare('SELECT created_at, provider, model, language, facts_hash, facts_json, suggestions_json FROM insights WHERE month = ?').get(month) as
    | { created_at: string; provider: string; model: string; language: string; facts_hash: string; facts_json: string; suggestions_json: string }
    | undefined
  if (!row) return { facts, ai: null }
  let sent: InsightFact[]
  let suggestions: InsightSuggestion[]
  try {
    sent = JSON.parse(row.facts_json) as InsightFact[]
    suggestions = JSON.parse(row.suggestions_json) as InsightSuggestion[]
  } catch {
    return { facts, ai: null }
  }
  const hidden = dismissedKeys(db)
  const now = hashFacts(facts)
  // What was hidden after the tips were written is no change in the data.
  const sameData = now === row.facts_hash || now === hashFacts(sent.filter((f) => !hidden.has(f.key)))
  return {
    facts,
    ai: {
      createdAt: row.created_at,
      providerName: presetFor(row.provider as ProviderId, getSettings(db).aiProviders[row.provider]?.name).assistantName,
      model: row.model,
      language: row.language,
      stale: !sameData ? 'data' : language !== null && row.language !== language ? 'language' : null,
      suggestions: suggestions.filter((s) => !s.factKeys.some((k) => hidden.has(k))),
      facts: sent
    }
  }
}
