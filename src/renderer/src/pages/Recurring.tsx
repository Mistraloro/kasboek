import { MoreHorizontal, Repeat } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RecurringItem } from '@shared/types'
import type { Page } from '../App'
import { Badge, Button, Card, CardHeader, EmptyState, Modal, PageHeader } from '../components/ui'
import { useToast } from '../components/Toast'
import { call, useOp } from '../lib/api'
import { formatDate } from '../lib/format'
import { useSettings } from '../lib/settings'
import { errText } from './auth/parts'
import { Stat } from './Overview'
import { CategorySelect } from './Transactions'

const TONE: Record<RecurringItem['status'], 'accent' | 'warning' | 'negative' | 'neutral'> = { paid: 'accent', due: 'warning', late: 'negative', later: 'neutral' }

/** How long the "no longer counted" line with Undo stays where the row was. */
const UNDO_MS = 8000

/** A small "..." menu: opens on click, closes on Escape, a click elsewhere or a choice. */
function RowMenu({ label, items }: { label: string; items: { label: string; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-border bg-surface py-1 shadow-lg">
          {items.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                i.onSelect()
              }}
              className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-surface-2"
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Puts all payments of one fixed cost in a category, and optionally adds a rule for later ones. */
function CategoryDialog({ item, onClose, onDone }: { item: RecurringItem; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const categories = useOp('categories.list')
  const [categoryId, setCategoryId] = useState<number | null>(item.categoryId)
  const [rule, setRule] = useState(false)
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('transactions.categorize', { ids: item.transactionIds, categoryId })
      if (rule && categoryId !== null) await call('rules.create', { field: 'counterparty', pattern: item.name, categoryId, applyToExisting: true })
      onDone()
      onClose()
    } catch (e) {
      toast(errText(e), 'error')
      setBusy(false)
    }
  }
  return (
    <Modal open title={t('recurring.categoryTitle')} onClose={onClose} dirty={categoryId !== item.categoryId || rule}>
      <div className="flex flex-col gap-4 text-[13px]">
        <p>{t('recurring.categoryIntro', { count: item.transactionIds.length, name: item.name })}</p>
        <CategorySelect value={categoryId} categories={categories.data ?? []} onChange={setCategoryId} label={t('recurring.categoryTitle')} />
        <label className={categoryId === null ? 'flex items-center gap-2 text-muted' : 'flex items-center gap-2'}>
          <input type="checkbox" className="accent-[var(--accent)]" checked={rule && categoryId !== null} disabled={categoryId === null} onChange={(e) => setRule(e.target.checked)} />
          {t('recurring.categoryRule')}
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('settings.cancel')}</Button>
          <Button variant="primary" disabled={busy || categories.data === null || categoryId === item.categoryId} onClick={() => void save()}>
            {t('recurring.categorySave')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Subscriptions, rent, insurance, salary: what comes back, what is still due, and what changed. */
export function RecurringPage({ go }: { go: (p: Page, filter?: Record<string, unknown>) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { money, fmt } = useSettings()
  const data = useOp('recurring.list')
  useEffect(() => window.kasboek.onEvent((e) => e.type === 'data.changed' && void data.reload()), []) // eslint-disable-line react-hooks/exhaustive-deps
  // Items just hidden here: shown as a line with Undo where the row was, for a few seconds.
  const [justHidden, setJustHidden] = useState<RecurringItem[]>([])
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  const [recategorize, setRecategorize] = useState<RecurringItem | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const r = data.data

  const setHidden = async (item: RecurringItem, hidden: boolean): Promise<void> => {
    try {
      await call('recurring.hide', { key: item.key, hidden })
      if (hidden) {
        setJustHidden((l) => [...l.filter((x) => x.key !== item.key), item])
        timers.current.push(setTimeout(() => setJustHidden((l) => l.filter((x) => x.key !== item.key)), UNDO_MS))
      } else setJustHidden((l) => l.filter((x) => x.key !== item.key))
      void data.reload()
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  const section = (direction: 'out' | 'in') => {
    const list = [...(r?.items ?? []), ...justHidden].filter((i) => i.direction === direction).sort((a, b) => Math.abs(b.monthlyCents) - Math.abs(a.monthlyCents))
    if (!list.length) return null
    return (
      <Card className="mt-4">
        <CardHeader title={t(direction === 'out' ? 'recurring.costs' : 'recurring.income')} />
        {list.map((i) =>
          justHidden.some((h) => h.key === i.key) ? (
            <div key={i.key} className="flex items-center gap-3 border-b border-border px-5 py-3 text-[13px] last:border-b-0">
              <p className="min-w-0 flex-1 truncate text-muted">{t(direction === 'out' ? 'recurring.noLongerCost' : 'recurring.noLongerIncome', { name: i.name })}</p>
              <Button size="sm" variant="ghost" onClick={() => void setHidden(i, false)}>
                {t('recurring.undo')}
              </Button>
            </div>
          ) : (
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
              <RowMenu
                label={t('recurring.actions', { name: i.name })}
                items={[
                  { label: t(direction === 'out' ? 'recurring.notFixed' : 'recurring.notFixedIncome'), onSelect: () => void setHidden(i, true) },
                  { label: t('recurring.showPayments'), onSelect: () => go('transactions', { search: i.name }) },
                  { label: t('recurring.changeCategory'), onSelect: () => setRecategorize(i) }
                ]}
              />
            </div>
          )
        )}
      </Card>
    )
  }
  const hidden = r?.hidden ?? []
  return (
    <>
      <PageHeader title={t('recurring.title')} subtitle={`${t('recurring.subtitle')} ${t('recurring.hint')}`} />
      <div className="grid grid-cols-3 gap-4">
        <Stat label={t('recurring.perMonth')} value={r ? money(r.monthlyOutCents) : '—'} />
        <Stat label={t('recurring.due')} value={r ? money(r.dueThisMonthCents) : '—'} tone={r && r.dueThisMonthCents > 0 ? 'negative' : undefined} />
        <Stat label={t('recurring.incomePerMonth')} value={r ? money(r.monthlyInCents) : '—'} tone="accent" />
      </div>
      {r && r.items.length === 0 && justHidden.length === 0 ? (
        <Card className="mt-4">
          <EmptyState icon={<Repeat size={20} />} title={t('recurring.emptyTitle')} body={t('recurring.emptyBody')} />
        </Card>
      ) : (
        <>
          {section('out')}
          {section('in')}
        </>
      )}
      {hidden.length > 0 && (
        <Card className="mt-4">
          <button type="button" aria-expanded={showHidden} onClick={() => setShowHidden((s) => !s)} className="w-full px-5 py-3 text-left text-[13px] font-medium hover:bg-surface-2">
            {t('recurring.hiddenTitle', { count: hidden.length })}
          </button>
          {showHidden && (
            <>
              <p className="px-5 pb-2 text-xs text-muted">{t('recurring.hiddenHint')}</p>
              {hidden.map((i) => (
                <div key={i.key} className="flex items-center gap-4 border-t border-border px-5 py-3 text-[13px]">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{i.name}</p>
                    <p className="text-xs text-muted">
                      {t(`recurring.frequency.${i.frequency}`)} · {i.accountName}
                    </p>
                  </div>
                  <span className="num w-28 text-right font-medium">{money(i.typicalCents)}</span>
                  <Button size="sm" onClick={() => void setHidden(i, false)}>
                    {t('recurring.countAgain')}
                  </Button>
                </div>
              ))}
            </>
          )}
        </Card>
      )}
      {recategorize && <CategoryDialog item={recategorize} onClose={() => setRecategorize(null)} onDone={() => { toast(t('recurring.categoryDone', { count: recategorize.transactionIds.length })); void data.reload() }} />}
    </>
  )
}
