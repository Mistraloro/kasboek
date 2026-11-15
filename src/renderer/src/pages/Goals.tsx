import { PiggyBank, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseAmount } from '@shared/amount'
import { centsToInput } from '@shared/format'
import type { Goal } from '@shared/types'
import { Meter } from '../components/charts'
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select } from '../components/ui'
import { useToast } from '../components/Toast'
import { call, useOp } from '../lib/api'
import { formatDate } from '../lib/format'
import { useSettings } from '../lib/settings'
import { errText } from './auth/parts'

/** Savings goals: progress, and what to put aside per month. */
export function GoalsPage() {
  const { t } = useTranslation()
  const { money, fmt } = useSettings()
  const goals = useOp('goals.list')
  const [editing, setEditing] = useState<Goal | 'new' | null>(null)
  useEffect(() => window.kasboek.onEvent((e) => e.type === 'data.changed' && void goals.reload()), []) // eslint-disable-line react-hooks/exhaustive-deps
  const list = (goals.data ?? []).filter((g) => !g.archived)
  return (
    <>
      <PageHeader title={t('goals.title')} subtitle={t('goals.subtitle')} action={<Button icon={<Plus size={14} />} onClick={() => setEditing('new')}>{t('goals.add')}</Button>} />
      {goals.data && list.length === 0 ? (
        <Card>
          <EmptyState icon={<PiggyBank size={20} />} title={t('goals.emptyTitle')} body={t('goals.emptyBody')} action={<Button variant="primary" onClick={() => setEditing('new')}>{t('goals.add')}</Button>} />
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {list.map((g) => (
            <Card key={g.id} className="px-5 py-4">
              <button type="button" className="w-full text-left" onClick={() => setEditing(g)}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <p className="truncate font-semibold">{g.name}</p>
                  <p className="num text-[13px] text-muted">{money(g.targetCents)}</p>
                </div>
                <Meter value={g.currentCents} max={g.targetCents} />
                <p className="num mt-2 text-[13px]">
                  {t('goals.saved', { saved: money(g.currentCents), pct: Math.min(100, Math.round((g.currentCents / g.targetCents) * 100)) })}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {g.reached
                    ? t('goals.reached')
                    : g.overdue
                      ? t('goals.overdue', { date: formatDate(g.targetDate!, fmt), left: money(g.remainingCents) })
                      : g.perMonthCents !== null
                        ? t('goals.perMonth', { amount: money(g.perMonthCents), date: formatDate(g.targetDate!, fmt) })
                        : t('goals.left', { left: money(g.remainingCents) })}
                  {g.accountName && ` · ${t('goals.tracks', { account: g.accountName })}`}
                </p>
              </button>
            </Card>
          ))}
        </div>
      )}
      <GoalModal goal={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void goals.reload() }} />
    </>
  )
}

function GoalModal({ goal, onClose, onSaved }: { goal: Goal | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { fmt } = useSettings()
  const accounts = useOp('accounts.list')
  const [form, setForm] = useState({ name: '', target: '', date: '', accountId: '', saved: '' })
  const base = goal && goal !== 'new' ? goal : null
  useEffect(() => {
    if (!goal) return
    setForm({
      name: base?.name ?? '',
      target: base ? centsToInput(base.targetCents, fmt.formats) : '',
      date: base?.targetDate ?? '',
      accountId: base?.accountId ? String(base.accountId) : '',
      saved: base?.savedCents ? centsToInput(base.savedCents, fmt.formats) : ''
    })
  }, [goal]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!goal) return null
  const target = parseAmount(form.target, 'auto', fmt.formats.decimal)
  const saved = form.saved.trim() ? parseAmount(form.saved, 'auto', fmt.formats.decimal) : 0
  const valid = !!form.name.trim() && target !== null && target > 0 && (form.accountId !== '' || (saved !== null && saved >= 0))
  const save = (): void => {
    const g = { name: form.name, targetCents: target!, targetDate: form.date || null, accountId: form.accountId ? Number(form.accountId) : null, savedCents: form.accountId ? null : saved }
    const p = base ? call('goals.update', { id: base.id, ...g }) : call('goals.create', g)
    p.then(onSaved, (e) => toast(errText(e), 'error'))
  }
  return (
    <Modal open title={base ? t('goals.edit') : t('goals.add')} onClose={onClose}>
      <form className="grid grid-cols-2 gap-4" onSubmit={(e) => { e.preventDefault(); if (valid) save() }}>
        <div className="col-span-2"><Field label={t('goals.name')}>{(id) => <Input id={id} value={form.name} maxLength={80} placeholder={t('goals.namePlaceholder')} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />}</Field></div>
        <Field label={t('goals.target')}>{(id) => <Input id={id} className="num" inputMode="decimal" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} />}</Field>
        <Field label={t('goals.date')} hint={t('goals.dateHint')}>{(id) => <Input id={id} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />}</Field>
        <div className="col-span-2">
          <Field label={t('goals.trackWith')}>
            {(id) => (
              <Select id={id} value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                <option value="">{t('goals.byHand')}</option>
                {(accounts.data ?? []).filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{t('goals.balanceOf', { account: a.name })}</option>)}
              </Select>
            )}
          </Field>
        </div>
        {!form.accountId && <div className="col-span-2"><Field label={t('goals.savedSoFar')}>{(id) => <Input id={id} className="num" inputMode="decimal" value={form.saved} onChange={(e) => setForm({ ...form, saved: e.target.value })} placeholder="0" />}</Field></div>}
        <div className="col-span-2 flex justify-between gap-2">
          {base ? (
            <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => { if (window.confirm(t('goals.deleteConfirm', { name: base.name }))) void call('goals.delete', { id: base.id }).then(onSaved) }}>{t('transactions.delete')}</Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={onClose}>{t('settings.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!valid}>{t('settings.save')}</Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
