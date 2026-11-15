import { ArrowLeftRight, Plus, Search, Trash2, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseAmount } from '@shared/amount'
import { centsToInput } from '@shared/format'
import { addMonths, monthOf } from '@shared/month'
import type { TransferPair, Category, Transaction } from '@shared/types'
import type { Page } from '../App'
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, cx } from '../components/ui'
import { useToast } from '../components/Toast'
import { call, useOp } from '../lib/api'
import { formatDate, monthLabel } from '../lib/format'
import { useSettings } from '../lib/settings'
import { errText } from './auth/parts'
import { localToday } from '@shared/month'

export interface TxFilter {
  accountId?: number
  categoryId?: number | 'none'
  month?: string
  search?: string
}

export function CategorySelect({ value, categories, onChange, className, allowNone = true, label, id }: { value: number | null; categories: Category[]; onChange: (id: number | null) => void; className?: string; allowNone?: boolean; label: string; id?: string }) {
  const { t } = useTranslation()
  const groups: Category['kind'][] = ['expense', 'income', 'transfer']
  return (
    <Select id={id} aria-label={label} className={className} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {allowNone && <option value="">{t('transactions.uncategorized')}</option>}
      {groups.map((g) => (
        <optgroup key={g} label={t(`categories.kind.${g}`)}>
          {categories.filter((c) => c.kind === g && (!c.archived || c.id === value)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </optgroup>
      ))}
    </Select>
  )
}

export function Transactions({ go, initial }: { go: (p: Page) => void; initial?: TxFilter }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { money, fmt } = useSettings()
  const [filter, setFilter] = useState<TxFilter>(initial ?? {})
  const [searchText, setSearchText] = useState(initial?.search ?? '')
  const [limit, setLimit] = useState(100)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<Transaction | 'new' | null>(null)
  const [suggest, setSuggest] = useState<{ pattern: string; categoryId: number; categoryName: string } | null>(null)
  const [transfersOpen, setTransfersOpen] = useState(false)
  const accounts = useOp('accounts.list')
  const categories = useOp('categories.list')
  const page = useOp('transactions.list', { ...filter, limit, offset: 0 })
  const cats = categories.data ?? []

  useEffect(() => {
    const h = setTimeout(() => setFilter((f) => ({ ...f, search: searchText || undefined })), 250)
    return () => clearTimeout(h)
  }, [searchText])
  useEffect(() => setSelected(new Set()), [filter])

  const months = useMemo(() => Array.from({ length: 24 }, (_, i) => addMonths(monthOf(), -i)), [])
  const items = page.data?.items ?? []
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id))

  const categorize = async (ids: number[], categoryId: number | null, tx?: Transaction): Promise<void> => {
    try {
      await call('transactions.categorize', { ids, categoryId })
      void page.reload()
      const cat = cats.find((c) => c.id === categoryId)
      if (tx?.counterpartyName && cat) setSuggest({ pattern: tx.counterpartyName, categoryId: cat.id, categoryName: cat.name })
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  return (
    <>
      <PageHeader
        title={t('transactions.title')}
        subtitle={t('transactions.subtitle')}
        action={
          <div className="flex gap-2">
            {(accounts.data ?? []).length > 1 && <Button icon={<ArrowLeftRight size={14} />} onClick={() => setTransfersOpen(true)}>{t('transfers.button')}</Button>}
            <Button icon={<Plus size={14} />} onClick={() => setEditing('new')} disabled={!accounts.data?.length}>{t('transactions.add')}</Button>
          </div>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <Input placeholder={t('transactions.search')} className="pl-9" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label={t('transactions.search')} />
        </div>
        <Select className="w-48!" aria-label={t('transactions.account')} value={filter.accountId ?? ''} onChange={(e) => setFilter({ ...filter, accountId: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">{t('transactions.allAccounts')}</option>
          {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select className="w-48!" aria-label={t('transactions.category')} value={filter.categoryId ?? ''} onChange={(e) => setFilter({ ...filter, categoryId: e.target.value === 'none' ? 'none' : e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">{t('transactions.allCategories')}</option>
          <option value="none">{t('transactions.uncategorized')}</option>
          {cats.filter((c) => !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select className="w-48!" aria-label={t('transactions.month')} value={filter.month ?? ''} onChange={(e) => setFilter({ ...filter, month: e.target.value || undefined })}>
          <option value="">{t('transactions.allDates')}</option>
          {months.map((m) => <option key={m} value={m}>{monthLabel(new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1), fmt)}</option>)}
        </Select>
      </div>

      {page.data && page.data.total > 0 && (
        <p className="num mb-3 text-[13px] text-muted">
          {t('transactions.count', { count: page.data.total })} · {t('transactions.in')} <span className="font-medium text-text">{money(page.data.inCents)}</span> · {t('transactions.out')}{' '}
          <span className="font-medium text-text">{money(page.data.outCents)}</span>
        </p>
      )}

      {suggest && (
        <div className="mb-3 flex items-center gap-3 rounded-xl border border-border bg-accent-soft px-4 py-2.5 text-[13px]">
          <Wand2 size={15} className="text-accent" />
          <span className="flex-1">{t('transactions.ruleSuggest', { name: suggest.pattern, category: suggest.categoryName })}</span>
          <Button size="sm" variant="ghost" onClick={() => setSuggest(null)}>{t('auth.notNow')}</Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              void call('rules.create', { field: 'counterparty', pattern: suggest.pattern, categoryId: suggest.categoryId, applyToExisting: true }).then(
                (r) => {
                  toast(t('transactions.ruleCreated', { count: r.applied }))
                  setSuggest(null)
                  void page.reload()
                },
                (e) => toast(errText(e), 'error')
              )
            }
          >
            {t('transactions.ruleCreate')}
          </Button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-2 text-[13px]">
          <span className="font-medium">{t('transactions.selected', { count: selected.size })}</span>
          <span className="ml-4 text-muted">{t('transactions.setCategory')}</span>
          <CategorySelect label={t('transactions.setCategory')} className="h-8 w-48" value={null} categories={cats} onChange={(id) => void categorize([...selected], id).then(() => setSelected(new Set()))} />
          <Button
            size="sm"
            variant="danger"
            className="ml-auto"
            icon={<Trash2 size={14} />}
            onClick={() => {
              if (!window.confirm(t('transactions.deleteConfirm', { count: selected.size }))) return
              void call('transactions.delete', { ids: [...selected] }).then(() => {
                setSelected(new Set())
                void page.reload()
              })
            }}
          >
            {t('transactions.delete')}
          </Button>
        </div>
      )}

      <Card>
        {page.data && items.length === 0 ? (
          <EmptyState
            icon={<ArrowLeftRight size={20} />}
            title={Object.values(filter).some(Boolean) ? t('transactions.noMatch') : t('transactions.emptyTitle')}
            body={Object.values(filter).some(Boolean) ? undefined : t('transactions.emptyBody')}
            action={!Object.values(filter).some(Boolean) && <Button variant="primary" onClick={() => go('import')}>{t('transactions.goImport')}</Button>}
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[12px] text-muted">
                <th className="w-10 py-3 pl-5">
                  <input type="checkbox" aria-label={t('transactions.selectAll')} className="accent-[var(--accent)]" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))} />
                </th>
                <th className="w-28 px-3 py-3 font-medium">{t('transactions.date')}</th>
                <th className="px-3 py-3 font-medium">{t('transactions.description')}</th>
                <th className="w-40 px-3 py-3 font-medium">{t('transactions.category')}</th>
                <th className="w-32 py-3 pr-5 pl-3 text-right font-medium">{t('transactions.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((tx) => (
                <tr key={tx.id} className={cx('border-b border-border last:border-b-0 hover:bg-surface-2/60', selected.has(tx.id) && 'bg-accent-soft/50')}>
                  <td className="py-2.5 pl-5">
                    <input
                      type="checkbox"
                      aria-label={t('transactions.select')}
                      className="accent-[var(--accent)]"
                      checked={selected.has(tx.id)}
                      onChange={() => {
                        const n = new Set(selected)
                        if (n.has(tx.id)) n.delete(tx.id)
                        else n.add(tx.id)
                        setSelected(n)
                      }}
                    />
                  </td>
                  <td className="num px-3 py-2.5 text-[13px] whitespace-nowrap text-muted">{formatDate(tx.bookingDate, fmt)}</td>
                  <td className="max-w-0 px-3 py-2.5">
                    <button type="button" className="block w-full truncate text-left" onClick={() => setEditing(tx)}>
                      {tx.transferAccount && <span className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted" title={t('transfers.pairedHint')}>⇄ {tx.transferAccount}</span>}
                      {tx.splitCount > 0 && <span className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{t('splits.badge', { count: tx.splitCount })}</span>}
                      <span className="font-medium">{tx.counterpartyName || tx.description}</span>
                      {tx.counterpartyName && <span className="ml-2 text-[13px] text-muted">{tx.description}</span>}
                    </button>
                  </td>
                  <td className="px-3 py-1.5">
                    {tx.splitCount > 0 ? (
                      <button type="button" className="h-8 w-full truncate rounded-md border border-border px-2 text-left text-[13px] text-muted hover:text-text" onClick={() => setEditing(tx)}>
                        {t('splits.badge', { count: tx.splitCount })}
                      </button>
                    ) : (
                      <CategorySelect label={t('transactions.category')} className={cx('h-8 text-[13px]', tx.categoryId === null && 'text-muted')} value={tx.categoryId} categories={cats} onChange={(id) => void categorize([tx.id], id, tx)} />
                    )}
                  </td>
                  <td className={cx('num py-2.5 pr-5 pl-3 text-right font-medium whitespace-nowrap', tx.amountCents > 0 && 'text-accent')}>
                    {tx.amountCents > 0 ? '+' : ''}
                    {money(tx.amountCents, tx.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {page.data && page.data.total > items.length && (
        <div className="mt-4 flex justify-center">
          <Button onClick={() => setLimit((l) => l + 100)}>{t('transactions.more')}</Button>
        </div>
      )}

      <TransfersModal open={transfersOpen} onClose={() => setTransfersOpen(false)} onPaired={() => void page.reload()} />
      <TxModal
        tx={editing}
        categories={cats}
        accounts={(accounts.data ?? []).map((a) => ({ id: a.id, name: a.name }))}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          void page.reload()
        }}
      />
    </>
  )
}

function TxModal({ tx, categories, accounts, onClose, onSaved }: { tx: Transaction | 'new' | null; categories: Category[]; accounts: { id: number; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const isNew = tx === 'new'
  const { fmt } = useSettings()
  const base = tx && tx !== 'new' ? tx : null
  const [form, setForm] = useState({ accountId: 0, bookingDate: '', amount: '', description: '', counterpartyName: '', categoryId: null as number | null, notes: '' })
  useEffect(() => {
    if (!tx) return
    setForm({
      accountId: base?.accountId ?? accounts[0]?.id ?? 0,
      bookingDate: base?.bookingDate ?? localToday(),
      amount: base ? centsToInput(base.amountCents, fmt.formats) : '',
      description: base?.description ?? '',
      counterpartyName: base?.counterpartyName ?? '',
      categoryId: base?.categoryId ?? null,
      notes: base?.notes ?? ''
    })
  }, [tx]) // eslint-disable-line react-hooks/exhaustive-deps
  const cents = parseAmount(form.amount, 'auto', fmt.formats.decimal)
  const valid = cents !== null && cents !== 0 && form.description.trim() && /^\d{4}-\d{2}-\d{2}$/.test(form.bookingDate)
  const save = (): void => {
    const common = { bookingDate: form.bookingDate, amountCents: cents!, description: form.description, counterpartyName: form.counterpartyName || null, categoryId: form.categoryId, notes: form.notes || null }
    const p = isNew ? call('transactions.create', { accountId: form.accountId, ...common }) : call('transactions.update', { id: base!.id, ...common })
    p.then(onSaved, (e) => toast(errText(e), 'error'))
  }
  return (
    <Modal open={!!tx} title={isNew ? t('transactions.add') : t('transactions.edit')} onClose={onClose}>
      <form className="grid grid-cols-2 gap-4" onSubmit={(e) => { e.preventDefault(); if (valid) save() }}>
        {isNew && (
          <div className="col-span-2">
            <Field label={t('transactions.account')}>
              {(id) => <Select id={id} value={form.accountId} onChange={(e) => setForm({ ...form, accountId: Number(e.target.value) })}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}
            </Field>
          </div>
        )}
        <Field label={t('transactions.date')}>{(id) => <Input id={id} type="date" value={form.bookingDate} onChange={(e) => setForm({ ...form, bookingDate: e.target.value })} />}</Field>
        <Field label={t('transactions.amount')} hint={t('transactions.amountHint')}>{(id) => <Input id={id} className="num" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="-12,50" />}</Field>
        <div className="col-span-2"><Field label={t('transactions.counterparty')}>{(id) => <Input id={id} value={form.counterpartyName} onChange={(e) => setForm({ ...form, counterpartyName: e.target.value })} />}</Field></div>
        <div className="col-span-2"><Field label={t('transactions.description')}>{(id) => <Input id={id} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field></div>
        <div className="col-span-2">
          <Field label={t('transactions.category')} hint={cents !== null && cents > 0 && categories.find((c) => c.id === form.categoryId)?.kind === 'expense' ? t('transactions.refundHint') : undefined}>
            {(id) => <CategorySelect id={id} label={t('transactions.category')} value={form.categoryId} categories={categories} onChange={(c) => setForm({ ...form, categoryId: c })} />}
          </Field>
        </div>
        <div className="col-span-2"><Field label={t('transactions.notes')}>{(id) => <Input id={id} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}</Field></div>
        {base?.communication && <p className="selectable col-span-2 text-xs text-muted">{t('transactions.communication')}: {base.communication}</p>}
        {base?.counterpartyIban && <p className="selectable num col-span-2 -mt-3 text-xs text-muted">IBAN: {base.counterpartyIban}</p>}
        {base && <div className="col-span-2"><SplitEditor tx={base} categories={categories} onSaved={onSaved} /></div>}
        {base?.transferAccount && (
          <p className="col-span-2 flex items-center gap-2 text-xs text-muted">
            ⇄ {t('transfers.pairedWith', { account: base.transferAccount })}
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => void call('transfers.unpair', { id: base.id }).then(onSaved, (e) => toast(errText(e), 'error'))}>{t('transfers.unpair')}</button>
          </p>
        )}
        <div className="col-span-2 flex justify-between gap-2">
          {base ? (
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => { if (window.confirm(t('transactions.deleteConfirm', { count: 1 }))) void call('transactions.delete', { ids: [base.id] }).then(onSaved) }}>
              {t('transactions.delete')}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button onClick={onClose}>{t('settings.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!valid}>{t('settings.save')}</Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

/** Transfers between own accounts that aren't paired yet; the sure ones are ticked. */
function TransfersModal({ open, onClose, onPaired }: { open: boolean; onClose: () => void; onPaired: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { money, fmt } = useSettings()
  const [list, setList] = useState<TransferPair[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const key = (p: TransferPair): string => `${p.outId}-${p.inId}`
  useEffect(() => {
    if (!open) return
    setList(null)
    void call('transfers.find').then((l) => {
      setList(l)
      setPicked(new Set(l.filter((p) => p.confidence === 'iban').map(key)))
    })
  }, [open])
  const pair = (): void => {
    const pairs = (list ?? []).filter((p) => picked.has(key(p))).map((p) => ({ outId: p.outId, inId: p.inId }))
    void call('transfers.pair', { pairs }).then(
      (r) => {
        toast(t('transfers.paired', { count: r.paired }))
        onPaired()
        onClose()
      },
      (e) => toast(errText(e), 'error')
    )
  }
  return (
    <Modal open={open} title={t('transfers.title')} onClose={onClose}>
      <p className="mb-3 text-[13px] text-muted">{t('transfers.hint')}</p>
      {list === null ? (
        <p className="text-[13px] text-muted">…</p>
      ) : list.length === 0 ? (
        <p className="text-[13px] text-muted">{t('transfers.none')}</p>
      ) : (
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {list.map((p) => (
            <li key={key(p)}>
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={picked.has(key(p))}
                  onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(key(p)); else n.delete(key(p)); return n })}
                />
                <span className="num w-24 text-muted">{formatDate(p.date, fmt)}</span>
                <span className="min-w-0 flex-1 truncate">{p.fromAccount} → {p.toAccount}</span>
                <span className="text-xs text-muted">{t(p.confidence === 'iban' ? 'transfers.sure' : 'transfers.maybe')}</span>
                <span className="num w-24 text-right font-medium">{money(p.amountCents, p.currency)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>{t('settings.cancel')}</Button>
        <Button variant="primary" disabled={!picked.size} onClick={pair}>{t('transfers.pair', { count: picked.size })}</Button>
      </div>
    </Modal>
  )
}

/** Split one transaction over categories; the parts add up to its amount. */
function SplitEditor({ tx, categories, onSaved }: { tx: Transaction; categories: Category[]; onSaved: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { money, fmt } = useSettings()
  const [parts, setParts] = useState<{ categoryId: number | null; amount: string }[] | null>(null)
  useEffect(() => {
    setParts(null)
    if (tx.splitCount > 0)
      void call('transactions.splits', { id: tx.id }).then((l) => setParts(l.map((p) => ({ categoryId: p.categoryId, amount: centsToInput(p.amountCents, fmt.formats) }))))
  }, [tx.id, tx.splitCount]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!parts)
    return (
      <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => setParts([{ categoryId: tx.categoryId, amount: centsToInput(tx.amountCents, fmt.formats) }, { categoryId: null, amount: '' }])}>
        {t('splits.start')}
      </button>
    )
  const cents = parts.map((p) => parseAmount(p.amount, 'auto', fmt.formats.decimal))
  const sum = cents.reduce<number>((a, c) => a + (c ?? 0), 0)
  const left = tx.amountCents - sum
  const valid = parts.length >= 2 && cents.every((c) => c !== null && c !== 0) && left === 0
  const save = (list: { categoryId: number | null; amountCents: number }[]): void =>
    void call('transactions.split', { id: tx.id, parts: list }).then(onSaved, (e) => toast(errText(e), 'error'))
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-2 text-[13px] font-medium">{t('splits.title')}</p>
      {parts.map((p, i) => (
        <div key={i} className="mb-2 flex items-center gap-2">
          <CategorySelect label={t('transactions.category')} className="h-8 flex-1 text-[13px]" value={p.categoryId} categories={categories} onChange={(c) => setParts(parts.map((x, j) => (j === i ? { ...x, categoryId: c } : x)))} />
          <Input aria-label={t('transactions.amount')} className="num h-8! w-28!" value={p.amount} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
          <button type="button" aria-label={t('transactions.delete')} className="rounded p-1 text-muted hover:text-negative" onClick={() => setParts(parts.filter((_, j) => j !== i))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className="font-medium text-accent hover:underline" onClick={() => setParts([...parts, { categoryId: null, amount: left ? centsToInput(left, fmt.formats) : '' }])}>{t('splits.add')}</button>
        <span className={cx('num ml-auto', left === 0 ? 'text-muted' : 'text-warning')}>{left === 0 ? t('splits.matches') : t('splits.left', { amount: money(left, tx.currency) })}</span>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {tx.splitCount > 0 && <Button size="sm" variant="ghost" onClick={() => save([])}>{t('splits.remove')}</Button>}
        <Button size="sm" variant="primary" disabled={!valid} onClick={() => save(parts.map((p, i) => ({ categoryId: p.categoryId, amountCents: cents[i]! })))}>{t('splits.save')}</Button>
      </div>
    </div>
  )
}
