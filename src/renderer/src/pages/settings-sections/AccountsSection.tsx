import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ACCOUNT_KINDS, type AccountKind, type AccountWithBalance } from '@shared/types'
import { Button, Card, CardHeader, Field, Input, Modal, Select } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { call, useOp } from '../../lib/api'
import { formatDate, formatNumber } from '../../lib/format'
import { useSettings } from '../../lib/settings'
import { CurrencySelect } from '../../components/CurrencySelect'
import { errText } from '../auth/parts'
import { BalanceFields, BankBalanceModal } from '../../components/BankBalance'
import { parseAmount } from '@shared/amount'
import { localToday } from '@shared/month'
import { Row } from './Row'

export function AccountsSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const accounts = useOp('accounts.list')
  const [editing, setEditing] = useState<AccountWithBalance | 'new' | null>(null)
  const { settings } = useSettings()
  const { fmt, money } = useSettings()
  const today = localToday()
  const [form, setForm] = useState({ name: '', bank: '', iban: '', currency: 'EUR', kind: 'current' as AccountKind, balance: '', balanceDate: today, fxCost: '' })
  const [balanceOf, setBalanceOf] = useState<AccountWithBalance | null>(null)
  const [initialForm, setInitialForm] = useState(form)
  const formDirty = (Object.keys(form) as (keyof typeof form)[]).some((k) => form[k] !== initialForm[k])
  const open = (a: AccountWithBalance | 'new'): void => {
    const next: typeof form =
      a === 'new'
        ? { name: '', bank: '', iban: '', currency: settings.currency, kind: 'current', balance: '', balanceDate: today, fxCost: '' }
        : { name: a.name, bank: a.bank, iban: a.iban ?? '', currency: a.currency, kind: a.kind, balance: '', balanceDate: today, fxCost: a.fxCostPct === null ? '' : formatNumber(a.fxCostPct, fmt, 2).replace(/[.,]?0+$/, '') }
    setForm(next)
    setInitialForm(next)
    setEditing(a)
  }
  const balanceCents = form.balance.trim() ? parseAmount(form.balance, 'auto', fmt.formats.decimal) : null
  // A percentage like "1,5" or "1.5"; empty = not known.
  const fxCostPct = form.fxCost.trim() === '' ? null : Number(form.fxCost.trim().replace('%', '').replace(',', '.'))
  const fxCostBad = fxCostPct !== null && (!Number.isFinite(fxCostPct) || fxCostPct < 0 || fxCostPct > 20)
  const save = async (): Promise<void> => {
    try {
      if (editing === 'new')
        await call('accounts.create', {
          name: form.name,
          bank: form.bank,
          iban: form.iban || null,
          currency: form.currency,
          kind: form.kind,
          fxCostPct,
          ...(balanceCents !== null ? { bankBalance: { date: form.balanceDate, cents: balanceCents } } : {})
        })
      else if (editing) await call('accounts.update', { id: editing.id, name: form.name, bank: form.bank, iban: form.iban || null, currency: form.currency, kind: form.kind, fxCostPct })
      toast(editing === 'new' ? t('settings.accountAdded') : t('settings.accountSaved'))
      setEditing(null)
      void accounts.reload()
    } catch (e) {
      toast(errText(e), 'error')
    }
  }
  return (
    <Card>
      <CardHeader
        title={t('settings.accounts')}
        description={t('settings.accountsHint')}
        action={<Button size="sm" icon={<Plus size={14} />} onClick={() => open('new')}>{t('settings.addAccount')}</Button>}
      />
      {(accounts.data ?? []).map((a) => (
        <Row
          key={a.id}
          label={<span className={a.archived ? 'text-muted line-through' : undefined}>{a.name}</span>}
          hint={[t(`accountKind.${a.kind}`), a.bank, a.iban ? a.iban.replace(/(.{4})/g, '$1 ').trim() : '', a.currency !== settings.currency ? a.currency : ''].filter(Boolean).join(' · ') || undefined}
        >
          <span className="num mr-2 text-right text-[13px]">
            <span className="block font-medium">{money(a.balanceCents, a.currency)}</span>
            <span className="block text-xs text-muted">{a.lastBankBalance ? t('balance.checkedOn', { date: formatDate(a.lastBankBalance.date, fmt) }) : t('balance.notChecked')}</span>
            {!!a.lastBankBalance?.differenceCents && <span className="block text-xs text-warning">{t('balance.off', { difference: money(a.lastBankBalance.differenceCents, a.currency) })}</span>}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setBalanceOf(a)}>{t('balance.button')}</Button>
          <Button size="sm" variant="ghost" onClick={() => open(a)}>{t('settings.edit')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void call('accounts.update', { id: a.id, archived: !a.archived }).then(() => accounts.reload())}>
            {a.archived ? t('budgets.restore') : t('budgets.archive')}
          </Button>
        </Row>
      ))}
      {accounts.data?.length === 0 && <p className="px-5 py-4 text-[13px] text-muted">{t('settings.noAccounts')}</p>}
      <Modal open={!!editing} title={editing === 'new' ? t('settings.addAccount') : t('settings.editAccount')} onClose={() => setEditing(null)} dirty={formDirty}>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <Field label={t('settings.accountName')}>{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('settings.accountNamePlaceholder')} autoFocus required />}</Field>
          <Field label={t('settings.bankName')} hint={t('settings.bankNameHint')}>{(id) => <Input id={id} value={form.bank} maxLength={60} onChange={(e) => setForm({ ...form, bank: e.target.value })} />}</Field>
          <Field label={t('settings.accountKind')} hint={form.kind === 'investment' ? t('settings.accountKindInvestment') : undefined}>
            {(id) => (
              <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as AccountKind })}>
                {ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{t(`accountKind.${k}`)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('settings.accountCurrency')} hint={editing !== 'new' && editing && editing.transactionCount > 0 && form.currency !== editing.currency ? t('settings.accountCurrencyChange', { from: editing.currency, to: form.currency }) : undefined}>
            {(id) => <CurrencySelect id={id} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />}
          </Field>
          <Field label={t('settings.iban')} hint={t('settings.ibanOptional')}>{(id) => <Input id={id} value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} placeholder="BE68 5390 0754 7034" className="num" />}</Field>
          <Field label={t('settings.fxCost')} hint={fxCostBad ? <span className="text-negative">{t('settings.fxCostBad')}</span> : t('settings.fxCostHint')}>
            {(id) => <Input id={id} value={form.fxCost} inputMode="decimal" className="num w-32!" placeholder="1,5" onChange={(e) => setForm({ ...form, fxCost: e.target.value })} />}
          </Field>
          {editing === 'new' && (
            <div>
              <p className="mb-1 text-[13px] font-medium">{t(form.kind === 'investment' ? 'balance.newInvestment' : 'balance.newTitle')}</p>
              <p className="mb-2 text-xs text-muted">{t('balance.newHint')}</p>
              <BalanceFields value={form.balance} date={form.balanceDate} currency={form.currency} onValue={(balance) => setForm({ ...form, balance })} onDate={(balanceDate) => setForm({ ...form, balanceDate })} />
              {form.balance.trim() !== '' && balanceCents === null && <p className="mt-1 text-xs text-negative">{t('budgets.invalid')}</p>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditing(null)}>{t('settings.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!form.name.trim() || fxCostBad || (form.balance.trim() !== '' && balanceCents === null) || (balanceCents !== null && !form.balanceDate)}>{t('settings.save')}</Button>
          </div>
        </form>
      </Modal>
      <BankBalanceModal account={balanceOf} onClose={() => setBalanceOf(null)} onSaved={() => void accounts.reload()} />
    </Card>
  )
}
