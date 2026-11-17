/** What a tip looks like on screen, decided from its kind: how serious it is, which texts and which button. */
import type { InsightFact, InsightKind, InsightValue } from './types'

export type InsightSeverity = 'warning' | 'tip' | 'info'

const SEVERITY: Record<InsightKind, InsightSeverity> = {
  over_budget: 'warning',
  balance_low: 'warning',
  charged_twice: 'warning',
  late: 'warning',
  price_up: 'tip',
  category_up: 'tip',
  no_budget: 'tip',
  upcoming: 'tip',
  subscriptions: 'tip',
  near_budget: 'info',
  unusual: 'info'
}

export const severityOf = (kind: InsightKind): InsightSeverity => SEVERITY[kind]

/** The button of a tip: its label (`insights.action.<label>`) and where it goes (`go(page, params)`). */
export interface InsightAction {
  label: 'fixedCosts' | 'budgets' | 'setBudget' | 'payments' | 'category'
  page: 'recurring' | 'budgets' | 'transactions'
  params?: { month?: string; categoryId?: number; search?: string }
}

const textOf = (f: InsightFact, key: string): string | undefined => {
  const v = f.values[key]
  return v && 'text' in v ? v.text : undefined
}
const dateOf = (f: InsightFact, key: string): string | undefined => {
  const v = f.values[key]
  return v && 'date' in v ? v.date : undefined
}

export function actionOf(f: InsightFact): InsightAction {
  const month = textOf(f, 'month')
  switch (f.kind) {
    case 'over_budget':
    case 'near_budget':
      return { label: 'budgets', page: 'budgets', params: month ? { month } : undefined }
    case 'no_budget':
      return { label: 'setBudget', page: 'budgets', params: month ? { month } : undefined }
    case 'category_up':
      return { label: 'category', page: 'transactions', params: { ...(f.categoryId !== null ? { categoryId: f.categoryId } : {}), ...(month ? { month } : {}) } }
    case 'charged_twice':
    case 'unusual': {
      const name = textOf(f, 'name')
      const date = dateOf(f, 'date')
      return { label: 'payments', page: 'transactions', params: { ...(name ? { search: name } : {}), ...(date ? { month: date.slice(0, 7) } : {}) } }
    }
    default:
      return { label: 'fixedCosts', page: 'recurring' }
  }
}

/** i18n keys of the title and the body; an unusual payment has one body per reason. */
export const titleKey = (f: InsightFact): string => `insights.${f.kind}.title`
export const bodyKey = (f: InsightFact): string => (f.kind === 'unusual' ? `insights.unusual.${textOf(f, 'reason') === 'new' ? 'bodyNew' : 'bodyHigher'}` : `insights.${f.kind}.body`)

/** The values as the texts need them: money and dates written the way the person set it up, counts as numbers. */
export function textVars(values: Record<string, InsightValue>, write: { money: (cents: number, currency: string) => string; date: (iso: string) => string }): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, 'money' in v ? write.money(v.money, v.currency) : 'date' in v ? write.date(v.date) : 'count' in v ? v.count : v.text])
  )
}

/** Placeholders in the texts the assistant writes: a fact id and one of its fields, like {f3.amount}. */
export const PLACEHOLDER = /\{(f\d+)\.([A-Za-z_]+)\}/g

/**
 * An assistant's text with its placeholders filled in from the facts, in the money and date formats the
 * person has now (so tips written earlier follow a changed setting). A placeholder that names no fact
 * or field is left as it is; the checks in core/insight-plan.ts keep such texts from being stored.
 */
export function renderInsightText(text: string, facts: InsightFact[], formatMoney: (cents: number, currency: string) => string, formatDate: (iso: string) => string): string {
  return text.replace(PLACEHOLDER, (whole, id: string, field: string) => {
    const v = facts.find((f) => f.id === id)?.values[field]
    if (!v) return whole
    return 'money' in v ? formatMoney(v.money, v.currency) : 'date' in v ? formatDate(v.date) : 'count' in v ? String(v.count) : v.text
  })
}
