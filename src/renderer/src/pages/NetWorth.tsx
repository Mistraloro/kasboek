import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseAmount } from '@shared/amount'
import { centsToInput, currencySymbol } from '@shared/format'
import type { AccountKind, NetWorthAccount } from '@shared/types'
import { TrendLine } from '../components/charts'
import { Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, Segmented, cx } from '../components/ui'
import { useToast } from '../components/Toast'
import { call, useOp } from '../lib/api'
import { formatDate, formatNumber, monthShort } from '../lib/format'
import { useSettings } from '../lib/settings'
import { errText } from './auth/parts'
import { Stat } from './Overview'
import { BankBalanceModal } from '../components/BankBalance'
import { localToday } from '@shared/month'

const toDate = (m: string): Date => new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1)
const GROUPS: { kinds: AccountKind[]; key: string }[] = [
  { kinds: ['current', 'cash', 'other'], key: 'everyday' },
  { kinds: ['savings'], key: 'savings' },
  { kinds: ['investment'], key: 'investments' },
  { kinds: ['credit_card', 'loan'], key: 'debts' }
]
const RANGES = [12, 24, 60, 0] as const
/** Accounts whose value isn't just their payments: a portfolio, a savings plan, a loan balance. */

export function NetWorthPage() {
  const { t } = useTranslation()
  const { money, fmt, settings } = useSettings()
  const [range, setRange] = useState<(typeof RANGES)[number]>(24)
  const data = useOp('networth.summary', { months: range })
  const [valuing, setValuing] = useState<NetWorthAccount | null>(null)
  const [balanceOf, setBalanceOf] = useState<NetWorthAccount | null>(null)
  useEffect(() => window.kasboek.onEvent((e) => e.type === 'data.changed' && void data.reload()), []) // eslint-disable-line react-hooks/exhaustive-deps
  const nw = data.data
  const sym = currencySymbol(settings.currency)
  const compact = (c: number): string => {
    const v = c / 100
    const a = Math.abs(v)
    const n = a >= 1e6 ? `${formatNumber(v / 1e6, fmt, 1)}M` : a >= 1e4 ? `${formatNumber(v / 1e3, fmt, 0)}k` : formatNumber(v, fmt, 0)
    return fmt.formats.currencyPosition.startsWith('before') ? `${sym}${n}` : `${n} ${sym}`
  }
  const change = nw && nw.history.length > 1 ? nw.history[nw.history.length - 1]!.cents - nw.history[0]!.cents : null

  return (
    <>
      <PageHeader title={t('networth.title')} subtitle={t('networth.subtitle')} />
      <div className="grid grid-cols-3 gap-4">
        <Stat label={t('networth.total')} value={nw ? money(nw.totalCents) : '—'} hint={change === null ? undefined : t('networth.change', { amount: (change >= 0 ? '+' : '') + money(change), months: nw!.history.length - 1 })} />
        <Stat label={t('networth.assets')} value={nw ? money(nw.assetsCents) : '—'} />
        <Stat label={t('networth.debts')} value={nw ? money(-nw.liabilitiesCents) : '—'} />
      </div>
      {nw && nw.unconverted > 0 && <p className="mt-3 text-[13px] text-warning">{t('networth.unconverted', { count: nw.unconverted })}</p>}

      <Card className="mt-4">
        <CardHeader
          title={t('networth.history')}
          description={t('networth.historyHint')}
          action={<Segmented label={t('networth.range')} value={String(range)} onChange={(v) => setRange(Number(v) as (typeof RANGES)[number])} options={RANGES.map((r) => ({ value: String(r), label: r === 0 ? t('networth.all') : t('networth.years', { count: r / 12 }) }))} />}
        />
        <div className="px-5 py-4">
          {nw && nw.history.length > 0 ? (
            <TrendLine
              label={t('networth.history')}
              format={money}
              compact={compact}
              data={nw.history.map((h) => ({ key: h.month, label: `${monthShort(toDate(h.month), fmt)} ${h.month.slice(2, 4)}`, cents: h.cents, note: h.unconverted ? t('networth.missingRates', { count: h.unconverted }) : undefined }))}
            />
          ) : (
            <p className="text-[13px] text-muted">{t('networth.empty')}</p>
          )}
        </div>
      </Card>

      {nw &&
        GROUPS.map((g) => {
          const list = nw.accounts.filter((a) => g.kinds.includes(a.kind) && (!a.archived || a.valueCents !== 0))
          if (!list.length) return null
          const total = list.reduce((s, a) => s + (a.valueMainCents ?? 0), 0)
          return (
            <Card key={g.key} className="mt-4">
              <CardHeader title={t(`networth.group.${g.key}`)} action={<span className="num text-[15px] font-semibold">{money(total)}</span>} />
              {list.map((a) => (
                <div key={a.id} className="flex items-center gap-4 border-b border-border px-5 py-3 text-[13px] last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className={cx('truncate font-medium', a.archived && 'text-muted')}>{a.name}</p>
                    <p className="text-xs text-muted">
                      {t(`accountKind.${a.kind}`)}
                      {a.lastValuation && ` · ${t('networth.valuedOn', { date: formatDate(a.lastValuation.date, fmt) })}`}
                    </p>
                  </div>
                  {a.gainCents !== null && (
                    <span className="num text-right text-xs">
                      <span className="block text-muted">{t('networth.gain')}</span>
                      <span className={cx('font-medium', a.gainCents >= 0 ? 'text-accent' : 'text-negative')}>
                        {(a.gainCents >= 0 ? '+' : '') + money(a.gainCents, a.currency)}
                        {a.investedCents ? ` (${formatNumber((a.gainCents / Math.abs(a.investedCents)) * 100, fmt, 1)}%)` : ''}
                      </span>
                    </span>
                  )}
                  <span className="num w-36 text-right">
                    <span className="block font-medium">{money(a.valueCents, a.currency)}</span>
                    {a.currency !== settings.currency && <span className="block text-xs text-muted">{a.valueMainCents === null ? t('fx.noRateShort') : `≈ ${money(a.valueMainCents)}`}</span>}
                  </span>
                  {a.kind === 'investment' ? (
                    <Button size="sm" variant="ghost" onClick={() => setValuing(a)}>{t('networth.setValue')}</Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setBalanceOf(a)}>{t('balance.button')}</Button>
                  )}
                </div>
              ))}
            </Card>
          )
        })}
      {nw && nw.accounts.length === 0 && <p className="mt-4 text-[13px] text-muted">{t('settings.noAccounts')}</p>}
      <ValuationModal account={valuing} onClose={() => setValuing(null)} onSaved={() => void data.reload()} />
      <BankBalanceModal account={balanceOf} onClose={() => setBalanceOf(null)} onSaved={() => void data.reload()} />
    </>
  )
}

function ValuationModal({ account, onClose, onSaved }: { account: NetWorthAccount | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { money, fmt } = useSettings()
  const list = useOp('valuations.list', { accountId: account?.id ?? 0 })
  const today = localToday()
  const [form, setForm] = useState({ date: today, value: '', note: '' })
  useEffect(() => {
    if (account) setForm({ date: today, value: centsToInput(account.valueCents, fmt.formats), note: '' })
  }, [account]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!account) return null
  const cents = parseAmount(form.value, 'auto', fmt.formats.decimal)
  const save = (): void => {
    if (cents === null) return
    void call('valuations.set', { accountId: account.id, date: form.date, valueCents: cents, note: form.note.trim() || null })
      .then(() => {
        toast(t('networth.valueSaved'))
        void list.reload()
        onSaved()
      })
      .catch((e) => toast(errText(e), 'error'))
  }
  return (
    <Modal open title={t('networth.valueTitle', { name: account.name })} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save() }}>
        <p className="text-[13px] text-muted">{t('networth.valueHelp')}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('fx.date')}>{(id) => <Input id={id} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />}</Field>
          <Field label={t('networth.value', { currency: account.currency })}>{(id) => <Input id={id} inputMode="decimal" className="num" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} required />}</Field>
        </div>
        <Field label={t('networth.note')}>{(id) => <Input id={id} value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('settings.cancel')}</Button>
          <Button type="submit" variant="primary" icon={<Plus size={14} />} disabled={cents === null || !form.date}>{t('networth.saveValue')}</Button>
        </div>
      </form>
      {(list.data ?? []).length > 0 && (
        <div className="mt-5 border-t border-border pt-4">
          <p className="mb-2 text-[13px] font-medium">{t('networth.recorded')}</p>
          {(list.data ?? []).map((v) => (
            <div key={v.date} className="flex items-center gap-3 py-1.5 text-[13px]">
              <span className="num w-28 text-muted">{formatDate(v.date, fmt)}</span>
              <span className="num flex-1 font-medium">{money(v.valueCents, account.currency)}</span>
              {v.note && <Badge>{v.note}</Badge>}
              <Button size="sm" variant="ghost" aria-label={t('fx.remove')} icon={<Trash2 size={14} />} onClick={() => void call('valuations.delete', { accountId: account.id, date: v.date }).then(() => { void list.reload(); onSaved() })} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
