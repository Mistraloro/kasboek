import { Check, PieChart } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Page } from '../App'
import { Button, Card, CardHeader, EmptyState, PageHeader, cx } from '../components/ui'
import { useOp } from '../lib/api'
import { monthLabel } from '../lib/format'
import { useSettings } from '../lib/settings'

export function Overview({ go }: { go: (p: Page) => void }) {
  const { t } = useTranslation()
  const { settings, money } = useSettings()
  const backup = useOp('backup.status')
  const accounts = useOp('accounts.list')

  const steps: { done: boolean; title: string; body: string; page: Page }[] = [
    { done: !!backup.data?.passwordSet, title: t('overview.stepBackup'), body: t('overview.stepBackupBody'), page: 'settings' },
    { done: (accounts.data?.length ?? 0) > 0, title: t('overview.stepAccounts'), body: t('overview.stepAccountsBody'), page: 'settings' },
    { done: false, title: t('overview.stepImport'), body: t('overview.stepImportBody'), page: 'import' }
  ]

  return (
    <>
      <PageHeader title={t('overview.title')} subtitle={monthLabel(new Date(), settings.formatLocale)} />

      <div className="grid grid-cols-3 gap-4">
        <Stat label={t('overview.income')} value={money(0)} />
        <Stat label={t('overview.spending')} value={money(0)} />
        <Stat label={t('overview.left')} value={money(0)} accent />
      </div>

      <div className="mt-6 grid grid-cols-5 gap-4">
        <Card className="col-span-3">
          <CardHeader title={t('overview.byCategory')} description={t('overview.thisMonth')} />
          <EmptyState icon={<PieChart size={20} />} title={t('transactions.emptyTitle')} body={t('overview.byCategoryEmpty')} />
        </Card>
        <Card className="col-span-2">
          <CardHeader title={t('overview.getStarted')} description={t('overview.getStartedHint')} />
          <ol className="flex flex-col">
            {steps.map((s, i) => (
              <li key={s.title} className="flex items-start gap-3 border-b border-border px-5 py-3.5 last:border-b-0">
                <span
                  className={cx(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                    s.done ? 'bg-accent text-accent-fg' : 'border border-border-strong text-muted'
                  )}
                >
                  {s.done ? <Check size={12} strokeWidth={3} /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cx('text-[13px] font-medium', s.done && 'text-muted line-through decoration-border-strong')}>{s.title}</p>
                  <p className="text-xs text-muted">{s.body}</p>
                </div>
                {!s.done && (
                  <Button size="sm" variant="ghost" onClick={() => go(s.page)}>
                    {t('overview.open')}
                  </Button>
                )}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  )
}

function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-[13px] text-muted">{label}</p>
      <p className={cx('num mt-1 text-[26px] font-semibold tracking-[-0.02em]', accent && 'text-accent')}>{value}</p>
    </Card>
  )
}
