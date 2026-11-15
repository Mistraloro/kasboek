import { Repeat } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { RecurringItem } from '@shared/types'
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '../components/ui'
import { useOp } from '../lib/api'
import { formatDate } from '../lib/format'
import { useSettings } from '../lib/settings'
import { Stat } from './Overview'

const TONE: Record<RecurringItem['status'], 'accent' | 'warning' | 'negative' | 'neutral'> = { paid: 'accent', due: 'warning', late: 'negative', later: 'neutral' }

/** Subscriptions, rent, insurance, salary: what comes back, what is still due, and what changed. */
export function RecurringPage() {
  const { t } = useTranslation()
  const { money, fmt } = useSettings()
  const data = useOp('recurring.list')
  useEffect(() => window.kasboek.onEvent((e) => e.type === 'data.changed' && void data.reload()), []) // eslint-disable-line react-hooks/exhaustive-deps
  const r = data.data
  const section = (direction: 'out' | 'in') => {
    const list = (r?.items ?? []).filter((i) => i.direction === direction)
    if (!list.length) return null
    return (
      <Card className="mt-4">
        <CardHeader title={t(direction === 'out' ? 'recurring.costs' : 'recurring.income')} />
        {list.map((i) => (
          <div key={i.key} className="flex items-center gap-4 border-b border-border px-5 py-3 text-[13px] last:border-b-0">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{i.name}</p>
              <p className="text-xs text-muted">
                {t(`recurring.frequency.${i.frequency}`)} · {i.categoryName ?? t('transactions.uncategorized')} · {i.accountName}
              </p>
              {i.priceChangeCents !== null && (
                <p className={i.priceChangeCents * (direction === 'out' ? -1 : 1) > 0 ? 'text-xs text-warning' : 'text-xs text-accent'}>
                  {t('recurring.changed', { from: money(i.lastCents - i.priceChangeCents), to: money(i.lastCents) })}
                </p>
              )}
            </div>
            <span className="num w-32 text-right text-xs text-muted">
              {t('recurring.last', { date: formatDate(i.lastDate, fmt) })}
              <br />
              {t('recurring.next', { date: formatDate(i.nextDate, fmt) })}
            </span>
            <Badge tone={TONE[i.status]}>{t(`recurring.status.${i.status}`)}</Badge>
            <span className="num w-28 text-right font-medium">{money(i.typicalCents)}</span>
          </div>
        ))}
      </Card>
    )
  }
  return (
    <>
      <PageHeader title={t('recurring.title')} subtitle={t('recurring.subtitle')} />
      <div className="grid grid-cols-3 gap-4">
        <Stat label={t('recurring.perMonth')} value={r ? money(r.monthlyOutCents) : '—'} />
        <Stat label={t('recurring.due')} value={r ? money(r.dueThisMonthCents) : '—'} tone={r && r.dueThisMonthCents > 0 ? 'negative' : undefined} />
        <Stat label={t('recurring.incomePerMonth')} value={r ? money(r.monthlyInCents) : '—'} tone="accent" />
      </div>
      {r && r.items.length === 0 ? (
        <Card className="mt-4">
          <EmptyState icon={<Repeat size={20} />} title={t('recurring.emptyTitle')} body={t('recurring.emptyBody')} />
        </Card>
      ) : (
        <>
          {section('out')}
          {section('in')}
        </>
      )}
    </>
  )
}
