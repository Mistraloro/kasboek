/** Exports made in the interface's language: CSV column names and the year report page. */
import type { TFunction } from 'i18next'
import type { SavedSearch, YearSummary } from '@shared/types'
import { call } from './api'

export const csvLabels = (t: TFunction): string[] =>
  ['date', 'account', 'counterparty', 'iban', 'description', 'communication', 'category', 'amount', 'currency', 'notes'].map((k) => t(`export.col.${k}`))

export function exportTransactions(t: TFunction, filter: SavedSearch['filter'], name: string): Promise<{ file: string | null; rows: number }> {
  return call('export.csv', { filter, labels: csvLabels(t), defaultName: `${name}.csv` })
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** A printable year report: totals, months and categories. */
export function yearReportHtml(y: YearSummary, t: TFunction, money: (c: number) => string, monthName: (m: string) => string): string {
  const row = (cells: string[], head = false): string => `<tr>${cells.map((c, i) => (head || i === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join('')}</tr>`
  const months = y.months.map((m) => row([esc(monthName(m.month)), money(m.incomeCents), money(m.spendingCents), money(m.incomeCents - m.spendingCents)]))
  const cats = (kind: 'income' | 'expense'): string =>
    y.categories
      .filter((c) => c.kind === kind)
      .map((c) => row([esc(c.name || t('transactions.uncategorized')), money(c.totalCents)]))
      .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t('export.reportTitle', { year: y.year }))}</title><style>
    body { font: 11pt -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; margin: 0; }
    h1 { font-size: 20pt; margin: 0 0 4pt; } h2 { font-size: 12pt; margin: 18pt 0 6pt; }
    p.sub { color: #666; margin: 0 0 12pt; }
    .totals { display: flex; gap: 24pt; margin: 12pt 0; } .totals div { font-size: 9pt; color: #666; } .totals b { display: block; font-size: 14pt; color: #1a1a1a; }
    table { border-collapse: collapse; width: 100%; } th, td { padding: 4pt 6pt; border-bottom: 0.5pt solid #ddd; text-align: right; font-variant-numeric: tabular-nums; }
    th:first-child { text-align: left; font-weight: normal; } tr.head th { font-weight: 600; color: #666; font-size: 9pt; }
  </style></head><body>
    <h1>${esc(t('export.reportTitle', { year: y.year }))}</h1>
    <p class="sub">${esc(t('export.reportSub'))}</p>
    <div class="totals">
      <div>${esc(t('overview.income'))}<b>${money(y.incomeCents)}</b></div>
      <div>${esc(t('overview.spending'))}<b>${money(y.spendingCents)}</b></div>
      <div>${esc(t('export.net'))}<b>${money(y.incomeCents - y.spendingCents)}</b></div>
    </div>
    <h2>${esc(t('export.perMonth'))}</h2>
    <table><tr class="head">${['', t('overview.income'), t('overview.spending'), t('export.net')].map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${months.join('')}</table>
    <h2>${esc(t('year.income'))}</h2><table>${cats('income')}</table>
    <h2>${esc(t('year.spending'))}</h2><table>${cats('expense')}</table>
  </body></html>`
}
