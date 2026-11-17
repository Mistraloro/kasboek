import { AlertTriangle, Check, PieChart, Sparkles, Tags } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { monthOf } from '@shared/month'
import type { Page } from '../App'
import { CategoryBars, MonthBars } from '../components/charts'
import { Button, Card, CardHeader, EmptyState, MonthNav, PageHeader, cx } from '../components/ui'
import { call, useOp } from '../lib/api'
import { usePublishPageContext } from '../lib/page-context'
import { useAssistant } from '../components/AssistantPanel'
import { Suggestions } from '../components/Suggestions'
import { useToast } from '../components/Toast'
import { errText } from './auth/parts'
import { formatDate, monthLabel, monthShort } from '../lib/format'
import { useSettings } from '../lib/settings'
import { openSettingsTab, type SettingsTab } from '../lib/settings-tab'

const toDate = (m: string): Date => new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1)

export function Overview({ go }: { go: (p: Page, filter?: Record<string, unknown>) => void }) {
  const { t } = useTranslation()
  const { fmt, money, settings, prefs } = useSettings()
  const [month, setMonth] = useState(monthOf())
  const summary = useOp('summary.month', { month })
  const backup = useOp('backup.status')
  const accounts = useOp('accounts.list')
  const assistant = useAssistant()
  usePublishPageContext({ page: 'overview', filters: { month }, selectedIds: [], openId: null, rows: [] })
  const alerts = useOp('alerts.list')
  const toast = useToast()
  const s = summary.data
  const hasTx = (accounts.data ?? []).some((a) => a.transactionCount > 0)

  const steps: { done: boolean; title: string; body: string; page: Page; tab?: SettingsTab }[] = [
    { done: (accounts.data?.length ?? 0) > 0, title: t('overview.stepAccounts'), body: t('overview.stepAccountsBody'), page: 'settings', tab: 'accounts' },
    { done: hasTx, title: t('overview.stepImport'), body: t('overview.stepImportBody'), page: 'import' },
    { done: !!backup.data?.autoEnabled, title: t('overview.stepBackup'), body: t('overview.stepBackupBody'), page: 'settings', tab: 'data' }
  ]
  const allDone = steps.every((x) => x.done)

  return (
    <>
      <PageHeader
        title={t('overview.title')}
        action={
          <div className="flex items-center gap-2">
            {assistant?.configured && hasTx && (
              <Button
                size="sm"
                icon={<Sparkles size={14} />}
                disabled={assistant.busy}
                onClick={() => {
                  // Opens the assistant panel and asks for a review of the month shown.
                  window.dispatchEvent(new Event('kasboek:open-assistant'))
                  void call('assistant.send', { text: t('overview.reviewPrompt', { month: monthLabel(toDate(month), fmt), iso: month }) }).catch((e) => toast(errText(e), 'error'))
                }}
              >
                {t('overview.review', { ai: assistant.providerName })}
              </Button>
            )}
            <MonthNav month={month} label={monthLabel(toDate(month), fmt)} onChange={setMonth} />
          </div>
        }
      />

      {(alerts.data ?? []).length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {(alerts.data ?? []).map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => go(a.kind === 'budget' ? 'budgets' : 'recurring')}
              className={cx(
                'flex items-center gap-3 rounded-xl border px-4 py-2.5 text-left text-[13px]',
                a.kind === 'budget' && a.level === 'near' ? 'border-border bg-surface' : 'border-negative/30 bg-negative/5'
              )}
            >
              <AlertTriangle size={15} className={a.kind === 'budget' && a.level === 'near' ? 'text-warning' : 'text-negative'} />
              <span className="flex-1">
                {a.kind === 'budget'
                  ? t(a.level === 'over' ? 'alerts.budgetOver' : 'alerts.budgetNear', { name: a.name, spent: money(a.spentCents), budget: money(a.budgetCents), pct: Math.round((a.spentCents / a.budgetCents) * 100) })
                  : t('alerts.balance', { name: a.name, date: formatDate(a.until, fmt), lowest: money(a.lowestCents, a.currency), due: money(a.dueCents, a.currency) })}
              </span>
            </button>
          ))}
        </div>
      )}
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

      {prefs.insights && <Suggestions month={month} monthText={monthLabel(toDate(month), fmt)} go={go} />}

      {s && s.unconverted > 0 && (
        <button type="button" onClick={() => { openSettingsTab('general'); go('settings') }} className="mt-4 flex w-full items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-left text-[13px] hover:bg-surface-2">
          <span className="font-medium text-warning">{t('fx.unconverted', { count: s.unconverted })}</span>
          <span className="text-muted">{t('fx.unconvertedHint')}</span>
        </button>
      )}

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
          <CardHeader title={t('overview.byCategory')} description={monthLabel(toDate(month), fmt)} />
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
                  {!st.done && <Button size="sm" variant="ghost" onClick={() => { if (st.tab) openSettingsTab(st.tab); go(st.page) }}>{t('overview.open')}</Button>}
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
                <span className="text-right">
                  <span className="num font-medium">{money(a.balanceCents, a.currency)}</span>
                  {a.currency !== settings.currency && (
                    <span className="num block text-xs text-muted">{a.balanceMainCents === null ? t('fx.noRateShort') : `≈ ${money(a.balanceMainCents)}`}</span>
                  )}
                </span>
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
              data={s.history.map((h) => ({ month: h.month, label: monthShort(toDate(h.month), fmt), income: h.incomeCents, spending: h.spendingCents }))}
            />
          )}
        </div>
      </Card>
    </>
  )
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'accent' | 'negative'; hint?: string }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-[13px] text-muted">{label}</p>
      <p className={cx('num mt-1 text-[26px] font-semibold tracking-[-0.02em]', tone === 'accent' && 'text-accent', tone === 'negative' && 'text-negative')}>{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </Card>
  )
}
