import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MonthBars } from '../components/charts'
import { Download, FileText } from 'lucide-react'
import { Button, Card, CardHeader, PageHeader, cx } from '../components/ui'
import { useToast } from '../components/Toast'
import { call, useOp } from '../lib/api'
import { exportTransactions, yearReportHtml } from '../lib/export'
import { monthLabel, monthShort } from '../lib/format'
import { errText } from './auth/parts'
import { useSettings } from '../lib/settings'
import { Stat } from './Overview'

const toDate = (m: string): Date => new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1)

export function YearPage() {
  const { t } = useTranslation()
  const { money, fmt } = useSettings()
  const toast = useToast()
  const [year, setYear] = useState(new Date().getFullYear())
  const data = useOp('summary.year', { year })
  useEffect(() => window.kasboek.onEvent((e) => e.type === 'data.changed' && void data.reload()), []) // eslint-disable-line react-hooks/exhaustive-deps
  const y = data.data
  const net = y ? y.incomeCents - y.spendingCents : 0
  const short = (c: number): string => (c === 0 ? '' : money(c).replace(/[,.]00(?=\D*$)/, ''))
  const section = (kind: 'income' | 'expense') => {
    const rows = (y?.categories ?? []).filter((c) => c.kind === kind)
    if (!rows.length) return null
    const totals = Array.from({ length: 12 }, (_, i) => rows.reduce((s, r) => s + r.months[i]!, 0))
    return (
      <>
        <tr className="border-b border-border bg-surface-2/50">
          <th scope="rowgroup" colSpan={14} className="px-4 py-2 text-left text-xs font-medium tracking-wide text-muted uppercase">{t(kind === 'income' ? 'year.income' : 'year.spending')}</th>
        </tr>
        {rows.map((r) => (
          <tr key={`${kind}-${r.categoryId}`} className="border-b border-border last:border-b-0 hover:bg-surface-2/40">
            <th scope="row" className="sticky left-0 max-w-40 truncate bg-surface px-4 py-2 text-left font-normal">{r.name || t('transactions.uncategorized')}</th>
            {r.months.map((c, i) => <td key={i} className="num px-2 py-2 text-right text-muted">{short(c)}</td>)}
            <td className="num px-4 py-2 text-right font-medium">{money(r.totalCents)}</td>
          </tr>
        ))}
        <tr className="border-b border-border font-medium">
          <th scope="row" className="sticky left-0 bg-surface px-4 py-2 text-left">{t('year.total')}</th>
          {totals.map((c, i) => <td key={i} className="num px-2 py-2 text-right">{short(c)}</td>)}
          <td className="num px-4 py-2 text-right">{money(totals.reduce((a, b) => a + b, 0))}</td>
        </tr>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('year.title')}
        subtitle={t('year.subtitle')}
        action={
          <div className="flex items-center gap-2">
          {y && (y.incomeCents > 0 || y.spendingCents > 0) && (
            <>
              <Button size="sm" icon={<Download size={14} />} onClick={() => void exportTransactions(t, { from: `${year}-01-01`, to: `${year}-12-31` }, `Kasboek ${year}`).then((r) => r.file && toast(t('export.saved', { count: r.rows })), (e) => toast(errText(e), 'error'))}>
                {t('export.csv')}
              </Button>
              <Button
                size="sm"
                icon={<FileText size={14} />}
                onClick={() =>
                  void call('export.pdf', { html: yearReportHtml(y, t, (c) => money(c), (m) => monthLabel(toDate(m), fmt)), defaultName: `Kasboek ${year}.pdf` }).then((r) => r.file && toast(t('export.pdfSaved')), (e) => toast(errText(e), 'error'))
                }
              >
                {t('export.pdf')}
              </Button>
            </>
          )}
          <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
            <button type="button" aria-label={t('year.previous')} onClick={() => setYear(year - 1)} className="h-8 w-8 rounded-md text-muted hover:bg-surface-2 hover:text-text">‹</button>
            <span className="num min-w-20 text-center text-[13px] font-medium">{year}</span>
            <button type="button" aria-label={t('year.next')} onClick={() => setYear(year + 1)} className="h-8 w-8 rounded-md text-muted hover:bg-surface-2 hover:text-text">›</button>
          </div>
          </div>
        }
      />
      <div className="grid grid-cols-3 gap-4">
        <Stat label={t('overview.income')} value={y ? money(y.incomeCents) : '—'} />
        <Stat label={t('overview.spending')} value={y ? money(y.spendingCents) : '—'} hint={y && y.budgetedCents > 0 ? t('year.budgeted', { amount: money(y.budgetedCents) }) : undefined} />
        <Stat label={t('year.net')} value={y ? (net > 0 ? '+' : '') + money(net) : '—'} tone={!y || net === 0 ? undefined : net > 0 ? 'accent' : 'negative'} hint={y && y.incomeCents > 0 ? t('year.saved', { pct: Math.round((net / y.incomeCents) * 100) }) : undefined} />
      </div>

      <Card className="mt-4">
        <CardHeader title={t('year.perMonth')} description={t('overview.trendHint')} />
        <div className="px-5 py-4">
          {y && (
            <MonthBars
              label={t('year.perMonth')}
              legend={{ income: t('overview.income'), spending: t('overview.spending') }}
              format={money}
              data={y.months.map((m) => ({ month: m.month, label: monthShort(toDate(m.month), fmt), income: m.incomeCents, spending: m.spendingCents }))}
            />
          )}
        </div>
      </Card>

      <Card className="mt-4 overflow-hidden">
        <CardHeader title={t('year.byCategory')} description={t('year.byCategoryHint')} />
        {y && y.categories.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th scope="col" className="sticky left-0 bg-surface px-4 py-2 text-left font-medium">{t('transactions.category')}</th>
                  {y.months.map((m) => <th key={m.month} scope="col" className="px-2 py-2 text-right font-medium">{monthShort(toDate(m.month), fmt)}</th>)}
                  <th scope="col" className="px-4 py-2 text-right font-medium">{t('year.total')}</th>
                </tr>
              </thead>
              <tbody>
                {section('income')}
                {section('expense')}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-5 py-4 text-[13px] text-muted">{t('year.empty')}</p>
        )}
      </Card>

      {y && y.years.length > 1 && (
        <Card className="mt-4">
          <CardHeader title={t('year.allYears')} />
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-muted">
                <th scope="col" className="px-5 py-2 text-left font-medium">{t('year.yearCol')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('overview.income')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('overview.spending')}</th>
                <th scope="col" className="px-5 py-2 text-right font-medium">{t('year.net')}</th>
              </tr>
            </thead>
            <tbody>
              {[...y.years].reverse().map((r) => {
                const n = r.incomeCents - r.spendingCents
                return (
                  <tr key={r.year} className={cx('border-b border-border last:border-b-0', r.year === year && 'bg-accent-soft/40')}>
                    <th scope="row" className="px-5 py-2 text-left font-medium"><button type="button" className="hover:text-accent" onClick={() => setYear(r.year)}>{r.year}</button></th>
                    <td className="num px-3 py-2 text-right">{money(r.incomeCents)}</td>
                    <td className="num px-3 py-2 text-right">{money(r.spendingCents)}</td>
                    <td className={cx('num px-5 py-2 text-right font-medium', n > 0 ? 'text-accent' : n < 0 && 'text-negative')}>{(n > 0 ? '+' : '') + money(n)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  )
}
