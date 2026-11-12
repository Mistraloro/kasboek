import { Check, PieChart, Tags } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { monthOf } from '@shared/month'
import type { Page } from '../App'
import { CategoryBars, MonthBars } from '../components/charts'
import { Button, Card, CardHeader, EmptyState, MonthNav, PageHeader, cx } from '../components/ui'
import { useOp } from '../lib/api'
import { monthLabel } from '../lib/format'
import { useSettings } from '../lib/settings'

const toDate = (m: string): Date => new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1)

export function Overview({ go }: { go: (p: Page, filter?: Record<string, unknown>) => void }) {
  const { t } = useTranslation()
  const { locale, money } = useSettings()
  const [month, setMonth] = useState(monthOf())
  const summary = useOp('summary.month', { month })
  const backup = useOp('backup.status')
  const accounts = useOp('accounts.list')
  const s = summary.data
  const hasTx = (accounts.data ?? []).some((a) => a.transactionCount > 0)

  const steps: { done: boolean; title: string; body: string; page: Page }[] = [
    { done: (accounts.data?.length ?? 0) > 0, title: t('overview.stepAccounts'), body: t('overview.stepAccountsBody'), page: 'settings' },
    { done: hasTx, title: t('overview.stepImport'), body: t('overview.stepImportBody'), page: 'import' },
    { done: !!backup.data?.autoEnabled, title: t('overview.stepBackup'), body: t('overview.stepBackupBody'), page: 'settings' }
  ]
  const allDone = steps.every((x) => x.done)

  return (
    <>
      <PageHeader title={t('overview.title')} action={<MonthNav month={month} label={monthLabel(toDate(month), locale)} onChange={setMonth} />} />

      <div className="grid grid-cols-3 gap-4">
        <Stat label={t('overview.income')} value={money(s?.incomeCents ?? 0)} />
        <Stat label={t('overview.spending')} value={money(s?.spendingCents ?? 0)} />
        <Stat
          label={t('overview.left')}
          value={s?.leftCents == null ? '—' : money(s.leftCents)}
          tone={s?.leftCents == null ? undefined : s.leftCents < 0 ? 'negative' : 'accent'}
          hint={s?.leftCents == null ? t('overview.noBudgets') : t('overview.ofBudget', { budget: money(s.budgetedCents) })}
        />
      </div>

      {s && s.uncategorized > 0 && (
        <button
          type="button"
          onClick={() => go('transactions', { categoryId: 'none', month })}
          className="mt-4 flex w-full items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-left text-[13px] hover:border-accent"
        >
          <Tags size={15} className="text-accent" />
          {t('overview.uncategorized', { count: s.uncategorized })}
          <span className="ml-auto font-medium text-accent">{t('overview.review')}</span>
        </button>
      )}

      <div className="mt-4 grid grid-cols-5 gap-4">
        <Card className="col-span-3">
          <CardHeader title={t('overview.byCategory')} description={monthLabel(toDate(month), locale)} />
          {s && s.byCategory.length > 0 ? (
            <div className="px-5 py-4">
              <CategoryBars rows={s.byCategory.map((c) => ({ name: c.categoryId === null ? t('transactions.uncategorized') : c.name, cents: c.cents }))} format={money} />
            </div>
          ) : (
            <EmptyState icon={<PieChart size={20} />} title={t('overview.nothingYet')} body={t('overview.byCategoryEmpty')} />
          )}
        </Card>
        {!allDone ? (
          <Card className="col-span-2">
            <CardHeader title={t('overview.getStarted')} description={t('overview.getStartedHint')} />
            <ol className="flex flex-col">
              {steps.map((st, i) => (
                <li key={st.title} className="flex items-start gap-3 border-b border-border px-5 py-3.5 last:border-b-0">
                  <span className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', st.done ? 'bg-accent text-accent-fg' : 'border border-border-strong text-muted')}>
                    {st.done ? <Check size={12} strokeWidth={3} /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cx('text-[13px] font-medium', st.done && 'text-muted line-through decoration-border-strong')}>{st.title}</p>
                    <p className="text-xs text-muted">{st.body}</p>
                  </div>
                  {!st.done && <Button size="sm" variant="ghost" onClick={() => go(st.page)}>{t('overview.open')}</Button>}
                </li>
              ))}
            </ol>
          </Card>
        ) : (
          <Card className="col-span-2">
            <CardHeader title={t('overview.accounts')} />
            {(accounts.data ?? []).filter((a) => !a.archived).map((a) => (
              <div key={a.id} className="flex items-center justify-between border-b border-border px-5 py-3 text-[13px] last:border-b-0">
                <span className="truncate">{a.name}</span>
                <span className="num font-medium">{money(a.balanceCents)}</span>
              </div>
            ))}
          </Card>
        )}
      </div>

      <Card className="mt-4">
        <CardHeader title={t('overview.trend')} description={t('overview.trendHint')} />
        <div className="px-5 py-4">
          {s && (
            <MonthBars
              label={t('overview.trend')}
              legend={{ income: t('overview.income'), spending: t('overview.spending') }}
              format={money}
              data={s.history.map((h) => ({ month: h.month, label: new Intl.DateTimeFormat(locale, { month: 'short' }).format(toDate(h.month)), income: h.incomeCents, spending: h.spendingCents }))}
            />
          )}
        </div>
      </Card>
    </>
  )
}

function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'accent' | 'negative'; hint?: string }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-[13px] text-muted">{label}</p>
      <p className={cx('num mt-1 text-[26px] font-semibold tracking-[-0.02em]', tone === 'accent' && 'text-accent', tone === 'negative' && 'text-negative')}>{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </Card>
  )
}
