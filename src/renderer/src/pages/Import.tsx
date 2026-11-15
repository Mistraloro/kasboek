import { AlertTriangle, CheckCircle2, Columns3, Copy, FileUp, ListChecks, RotateCcw, Sparkles, Square, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { CheckPart, ImportCommitResult, ImportColumns, ImportMapping, ImportPreview, ImportRow } from '@shared/types'
import type { Page } from '../App'
import { Badge, Button, Card, CardHeader, Field, Modal, PageHeader, Select, Switch, cx } from '../components/ui'
import { useToast } from '../components/Toast'
import { parseAmount } from '@shared/amount'
import { ApiError, call, useOp } from '../lib/api'
import { formatDate, formatDateTime } from '../lib/format'
import { useSettings } from '../lib/settings'
import { errText } from './auth/parts'
import { CategorySelect } from './Transactions'
import { useAssistant } from '../components/AssistantPanel'
import { ImportBalanceCheck } from '../components/BankBalance'

type Filter = 'all' | ImportRow['status']

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function ImportPage({ go }: { go: (p: Page) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { fmt } = useSettings()
  const accounts = useOp('accounts.list')
  const batches = useOp('import.batches')
  const [accountId, setAccountId] = useState<number | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [done, setDone] = useState<(ImportCommitResult & { accountId: number; currency: string }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const account = accountId ?? accounts.data?.find((a) => !a.archived)?.id ?? null
  const assistant = useAssistant()
  const [assisting, setAssisting] = useState(false)
  // The chat assistant can change the open import too: refresh when it does.
  useEffect(
    () =>
      window.kasboek.onEvent((e) => {
        if (e.type === 'import.updated') void call('import.current').then((p) => p && setPreview(p))
      }),
    []
  )

  const open = async (file: File): Promise<void> => {
    if (!account) return
    setBusy(true)
    try {
      setPreview(await call('import.analyze', { fileName: file.name, contentBase64: toBase64(await file.arrayBuffer()), accountId: account }))
      setDone(null)
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (preview) {
    return (
      <PreviewView
        preview={preview}
        onChange={setPreview}
        assisting={assisting}
        onAssist={
          assistant?.configured
            ? (p) => {
                setAssisting(true)
                void call('import.assist', { sessionId: p.sessionId })
                  .then((next) => {
                    setPreview(next)
                    toast(t('import.checked'))
                  }, (e) => (e instanceof ApiError && e.code === 'assistant.cancelled' ? undefined : toast(errText(e), 'error')))
                  .finally(() => setAssisting(false))
              }
            : undefined
        }
        onCancel={() => void call('import.discard', { sessionId: preview.sessionId }).finally(() => setPreview(null))}
        onCommitted={(r) => {
          setPreview(null)
          setDone({ ...r, accountId: preview.accountId, currency: preview.currency })
          void batches.reload()
        }}
      />
    )
  }

  return (
    <>
      <PageHeader title={t('import.title')} subtitle={t('import.subtitle')} />
      {done && (
        <div className="mb-4 rounded-xl border border-border bg-accent-soft px-4 py-3 text-[13px]">
          <div className="flex items-center gap-3">
            <CheckCircle2 size={16} className="text-accent" />
            <span className="flex-1">{t('import.done', { count: done.imported })}</span>
            <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} onClick={() => void call('import.undo', { batchId: done.batchId }).then((r) => { toast(t('import.undone', { count: r.deleted })); setDone(null); void batches.reload() })}>{t('import.undo')}</Button>
            <Button size="sm" variant="primary" onClick={() => go('transactions')}>{t('import.viewTransactions')}</Button>
          </div>
          {done.lastDate && done.balanceOnLastDate !== null && (
            <div className="mt-1 pl-7">
              <ImportBalanceCheck key={done.batchId} accountId={done.accountId} currency={done.currency} date={done.lastDate} kasboekCents={done.balanceOnLastDate} ask={done.askBalance} fromCsv={done.bankBalance} />
            </div>
          )}
        </div>
      )}
      {accounts.data && accounts.data.length === 0 ? (
        <Card className="px-5 py-6 text-center text-[13px] text-muted">
          {t('import.needAccount')} <button type="button" className="font-medium text-accent hover:underline" onClick={() => go('settings')}>{t('import.addAccount')}</button>
        </Card>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3">
            <span className="text-[13px] font-medium">{t('import.intoAccount')}</span>
            <Select className="w-64!" aria-label={t('import.intoAccount')} value={account ?? ''} onChange={(e) => setAccountId(Number(e.target.value))}>
              {(accounts.data ?? []).filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.bank ? `${a.name} · ${a.bank}` : a.name}</option>)}
            </Select>
          </div>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) void open(f) }}
            className={cx('flex flex-col items-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors', drag ? 'border-accent bg-accent-soft' : 'border-border bg-surface')}
          >
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent"><FileUp size={20} /></div>
            <h3 className="font-semibold">{t('import.dropTitle')}</h3>
            <p className="mt-1 max-w-md text-[13px] text-muted">{t('import.dropBody')}</p>
            <Button className="mt-5" variant="primary" disabled={busy || !account} onClick={() => fileInput.current?.click()}>{busy ? t('auth.working') : t('import.choose')}</Button>
            <input ref={fileInput} type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void open(f) }} />
          </div>
          <p className="mt-4 text-[13px] text-muted">{t('import.anyBank')}</p>
        </>
      )}
      {(batches.data ?? []).length > 0 && (
        <Card className="mt-8">
          <CardHeader title={t('import.recent')} />
          {(batches.data ?? []).map((b) => (
            <div key={b.id} className="flex items-center gap-3 border-b border-border px-5 py-3 text-[13px] last:border-b-0">
              <span className="min-w-0 flex-1 truncate"><span className="font-medium">{b.fileName}</span> <span className="text-muted">→ {b.accountName}</span></span>
              <span className="text-muted">{t('import.rows', { count: b.remaining })} · {formatDateTime(b.committedAt, fmt)}</span>
              {b.remaining > 0 && (
                <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} onClick={() => { if (window.confirm(t('import.undoConfirm', { count: b.remaining }))) void call('import.undo', { batchId: b.id }).then(() => batches.reload()) }}>{t('import.undo')}</Button>
              )}
            </div>
          ))}
        </Card>
      )}
    </>
  )
}

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

const STATUS_TONE: Record<ImportRow['status'], 'accent' | 'warning' | 'negative' | 'neutral'> = { ready: 'accent', duplicate: 'warning', possible_duplicate: 'warning', problem: 'negative', skipped: 'neutral' }

function PreviewView({ preview, onChange, onCancel, onCommitted, onAssist, assisting }: { preview: ImportPreview; onChange: (p: ImportPreview) => void; onCancel: () => void; onCommitted: (r: ImportCommitResult) => void; onAssist?: (p: ImportPreview) => void; assisting: boolean }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { money, fmt } = useSettings()
  const assistant = useAssistant()
  const categories = useOp('categories.list')
  // Seconds since the check started, so a slow answer visibly isn't stuck.
  const [elapsed, setElapsed] = useState(0)
  const [progress, setProgress] = useState<{ done: number; total: number; parts: number } | null>(null)
  useEffect(
    () =>
      window.kasboek.onEvent((e) => {
        if (e.type === 'import.checkProgress' && e.sessionId === preview.sessionId) setProgress({ done: e.groupsDone, total: e.groupsTotal, parts: e.partsTotal })
      }),
    [preview.sessionId]
  )
  useEffect(() => {
    if (!assisting) return
    setProgress(null)
    setElapsed(0)
    const started = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [assisting])
  const [filter, setFilter] = useState<Filter>(preview.stats.problems ? 'problem' : preview.stats.possibleDuplicates ? 'possible_duplicate' : 'all')
  const [limit, setLimit] = useState(300)
  const [mappingOpen, setMappingOpen] = useState(!preview.mapping)
  const [saveProfile, setSaveProfile] = useState(true)
  const [busy, setBusy] = useState(false)
  const s = preview.stats
  const rows = preview.rows.filter((r) => filter === 'all' || r.status === filter)
  // Every row of the file is already in Kasboek: there is nothing to import.
  const allKnown = !!preview.mapping && s.total > 0 && s.ready === 0 && s.duplicates + s.possibleDuplicates + s.skipped === s.total && s.duplicates > 0
  const update = (changes: Parameters<typeof call<'import.updateRows'>>[1]['changes']): void =>
    void call('import.updateRows', { sessionId: preview.sessionId, changes }).then(onChange, (e) => toast(errText(e), 'error'))

  const chip = (f: Filter, label: string, n: number, tone?: string): ReactNode => (
    <button type="button" onClick={() => setFilter(f)} className={cx('rounded-full border px-3 py-1 text-[13px] font-medium transition-colors', filter === f ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface text-muted hover:text-text', tone)}>
      {label} <span className="num">{n}</span>
    </button>
  )

  return (
    <>
      <PageHeader
        title={t('import.reviewTitle')}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="selectable font-medium text-text">{preview.fileName}</span> → {preview.accountName}
            {preview.layout && <Badge tone="accent">{t('import.layoutRecognised')}</Badge>}
            <Badge>{t(`import.source.${preview.mappingSource}`)}</Badge>
          </span>
        }
        action={
          <div className="flex gap-2">
            <Button variant={allKnown ? 'primary' : undefined} onClick={onCancel}>{allKnown ? t('import.discard') : t('settings.cancel')}</Button>
            {!allKnown && <Button variant="primary" disabled={!s.ready || busy} onClick={() => { setBusy(true); void call('import.commit', { sessionId: preview.sessionId, saveProfile }).then((r) => { toast(t('import.done', { count: r.imported })); onCommitted(r) }, (e) => toast(errText(e), 'error')).finally(() => setBusy(false)) }}>
              {t('import.commit', { count: s.ready })}
            </Button>}
          </div>
        }
      />

      {allKnown && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-border bg-accent-soft px-4 py-3 text-[13px]">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent" />
          <span className="flex-1">
            <span className="font-medium">{t('import.allKnown', { from: s.fileFrom ? formatDate(s.fileFrom, fmt) : '—', to: s.fileTo ? formatDate(s.fileTo, fmt) : '—' })}</span>
            {onAssist && <span className="block text-muted">{t('import.allKnownHint', { name: assistant?.providerName ?? 'Claude' })}</span>}
          </span>
        </div>
      )}
      <Card className="mb-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
          {!allKnown && (
            <>
              <span className="num">{t('import.period')}: <span className="font-medium">{s.from ? `${formatDate(s.from, fmt)} – ${formatDate(s.to!, fmt)}` : '—'}</span></span>
              <span className="num">{t('transactions.in')} <span className="font-medium">{money(s.inCents, preview.currency)}</span></span>
              <span className="num">{t('transactions.out')} <span className="font-medium">{money(s.outCents, preview.currency)}</span></span>
            </>
          )}
          <span className="ml-auto flex items-center gap-2">
            {onAssist ? (
              assisting ? (
                <>
                  <span className="text-xs text-muted" title={t('import.checkSlowHint')}>
                    {progress && progress.parts > 1 ? t('import.checkingGroups', { done: progress.done, total: progress.total }) : t('import.checking')} <span className="num">{clock(elapsed)}</span>
                  </span>
                  <Button size="sm" icon={<Square size={12} />} onClick={() => void call('import.assistCancel', { sessionId: preview.sessionId })}>{t('import.stopCheck')}</Button>
                </>
              ) : (
                <Button size="sm" variant="primary" icon={<Sparkles size={14} />} title={t(assistant?.company === null ? 'import.checkPrivacyLocal' : 'import.checkPrivacy')} onClick={() => onAssist(preview)}>
                  {allKnown ? t('import.categoriseExisting', { name: assistant?.providerName ?? 'Claude' }) : t('import.checkWithClaude')}
                </Button>
              )
            ) : (
              <span className="text-xs text-muted">{t('import.claudeOff')}</span>
            )}
            <Button size="sm" icon={<Columns3 size={14} />} onClick={() => setMappingOpen(true)}>{t('import.columns')}</Button>
          </span>
        </div>
        {preview.notes.length > 0 && (
          <ul className="mt-3 list-disc space-y-0.5 border-t border-border pt-3 pl-5 text-[13px] text-muted">
            {preview.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </Card>

      {preview.check && <CheckSummaryCard preview={preview} onChange={onChange} />}

      {!preview.mapping ? (
        <Card className="px-5 py-6 text-[13px] text-muted"><AlertTriangle size={15} className="mr-2 inline text-warning" />{t('import.noMapping')}</Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {chip('all', t('import.all'), s.total)}
            {chip('ready', t('import.status.ready'), s.ready)}
            {chip('duplicate', t('import.status.duplicate'), s.duplicates)}
            {s.possibleDuplicates > 0 && chip('possible_duplicate', t('import.status.possible_duplicate'), s.possibleDuplicates)}
            {chip('problem', t('import.status.problem'), s.problems)}
            {chip('skipped', t('import.status.skipped'), s.skipped)}
            <label className="ml-auto flex items-center gap-2 text-[13px] text-muted">
              <Switch label={t('import.remember')} checked={saveProfile} onChange={setSaveProfile} /> {t('import.remember')}
            </label>
          </div>
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[12px] text-muted">
                  <th className="w-10 py-3 pl-5" />
                  <th className="w-24 px-2 py-3 font-medium">{t('transactions.date')}</th>
                  <th className="px-2 py-3 font-medium">{t('transactions.description')}</th>
                  <th className="w-36 px-2 py-3 font-medium">{t('transactions.category')}</th>
                  <th className="w-28 px-2 py-3 text-right font-medium">{t('transactions.amount')}</th>
                  <th className="w-28 py-3 pr-5 pl-2 font-medium">{t('import.statusCol')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((r) => (
                  <tr key={r.index} className={cx('border-b border-border last:border-b-0', r.status !== 'ready' && 'text-muted')}>
                    <td className="py-2 pl-5">
                      <input
                        type="checkbox"
                        aria-label={t('import.includeRow')}
                        className="accent-[var(--accent)]"
                        disabled={r.status === 'problem'}
                        checked={r.status === 'ready'}
                        onChange={(e) => update([{ index: r.index, decided: e.target.checked ? 'include' : 'skip' }])}
                      />
                    </td>
                    <td className="num px-2 py-2 text-[13px] whitespace-nowrap">
                      {r.bookingDate ? formatDate(r.bookingDate, fmt) : (
                        <button type="button" className="font-medium text-negative underline decoration-dotted" onClick={() => {
                          const v = window.prompt(t('import.fixDate'), '')
                          const m = v?.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/)
                          if (m) update([{ index: r.index, bookingDate: `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` }])
                          else if (v) toast(t('import.fixDateInvalid'), 'error')
                        }}>{t('import.badDate')}</button>
                      )}
                    </td>
                    <td className="max-w-0 px-2 py-2">
                      <p className="truncate"><span className="font-medium text-text">{r.counterpartyName || r.description}</span>{r.counterpartyName && <span className="ml-2 text-[13px] text-muted">{r.description}</span>}</p>
                      {(r.note || r.communication) && <p className="truncate text-xs text-muted">{r.note ? `✦ ${r.note}` : r.communication}</p>}
                      {r.match && r.status === 'possible_duplicate' && (
                        <p className="truncate text-xs text-muted">{t('import.matches', { date: formatDate(r.match.bookingDate, fmt), text: r.match.counterpartyName || r.match.description })}</p>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <CategorySelect label={t('transactions.category')} className="h-8 text-[13px]" value={r.categoryId} categories={categories.data ?? []} onChange={(id) => update([{ index: r.index, categoryId: id }])} />
                    </td>
                    <td className={cx('num px-2 py-2 text-right font-medium whitespace-nowrap', r.status === 'ready' && (r.amountCents ?? 0) > 0 && 'text-accent', r.status === 'ready' && (r.amountCents ?? 0) <= 0 && 'text-text')}>
                      {r.amountCents === null ? (
                        <button type="button" className="text-negative underline decoration-dotted" onClick={() => {
                          const v = window.prompt(t('import.fixAmount'), '')
                          const c = v ? parseAmount(v, 'auto', fmt.formats.decimal) : null
                          if (c) update([{ index: r.index, amountCents: c }])
                          else if (v) toast(t('budgets.invalid'), 'error')
                        }}>{t('import.badAmount')}</button>
                      ) : money(r.amountCents, preview.currency)}
                    </td>
                    <td className="py-2 pr-5 pl-2" title={r.issues.map((i) => t(`import.issue.${i}`)).join(' · ')}>
                      <Badge tone={STATUS_TONE[r.status]}>{t(`import.status.${r.status}`)}</Badge>
                      {r.issues.length > 0 && <p className="mt-0.5 text-[11px] leading-tight">{r.issues.map((i) => t(`import.issue.${i}`)).join(', ')}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {rows.length > limit && <div className="mt-4 flex justify-center"><Button onClick={() => setLimit((l) => l + 500)}>{t('transactions.more')}</Button></div>}
        </>
      )}
      <MappingModal open={mappingOpen} preview={preview} onClose={() => setMappingOpen(false)} onApplied={(p) => { onChange(p); setMappingOpen(false) }} />
    </>
  )
}

/** What Check did (each part can be undone) and what it proposes for later imports and older transactions. */
function CheckSummaryCard({ preview, onChange }: { preview: ImportPreview; onChange: (p: ImportPreview) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { money } = useSettings()
  const c = preview.check!
  const [rules, setRules] = useState<Set<number>>(() => new Set(c.rules.map((r) => r.id)))
  const [existing, setExisting] = useState<Set<number>>(() => new Set(c.existing.map((e) => e.id)))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setRules(new Set(c.rules.map((r) => r.id)))
    setExisting(new Set(c.existing.map((e) => e.id)))
  }, [c.rules, c.existing])
  const undo = (part: CheckPart): void => void call('import.checkUndo', { sessionId: preview.sessionId, part }).then(onChange, (e) => toast(errText(e), 'error'))
  const toggle = (set: Set<number>, id: number, on: boolean): Set<number> => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }
  const line = (text: string, part: CheckPart | null): ReactNode => (
    <li className="flex items-center gap-2">
      <CheckCircle2 size={14} className="shrink-0 text-accent" />
      <span className="flex-1">{text}</span>
      {part && <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} onClick={() => undo(part)}>{t('import.undoPart')}</Button>}
    </li>
  )
  const done = [
    c.categorised > 0 && line(t('import.check.categorised', { count: c.categorised }), 'categories'),
    c.renamed > 0 && line(t('import.check.renamed', { count: c.renamed }), 'names'),
    c.fixed > 0 && line(t('import.check.fixed', { count: c.fixed }), 'fixes'),
    c.mappingChanged && line(t('import.check.mapping'), null)
  ].filter(Boolean)
  const picked = rules.size + existing.size
  const apply = (): void => {
    setBusy(true)
    void call('import.checkApply', { sessionId: preview.sessionId, rules: [...rules], existing: [...existing] })
      .then((r) => {
        onChange(r.preview)
        toast(t('import.check.applied', { rules: r.rules, count: r.categorised }) + (r.skipped ? ` ${t('import.check.skippedSince', { count: r.skipped })}` : ''))
      }, (e) => toast(errText(e), 'error'))
      .finally(() => setBusy(false))
  }
  return (
    <Card className="mb-4 px-5 py-4 text-[13px]">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={15} className="text-accent" />
        <h3 className="flex-1 font-semibold">{t('import.check.title', { name: c.by })}</h3>
        <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => undo('all')}>{t('import.check.undoAll')}</Button>
      </div>
      {c.alreadyImported > 0 && <p className="mb-2 text-muted">{t('import.check.already', { count: c.alreadyImported, total: c.total })}</p>}
      {done.length > 0 ? <ul className="space-y-1">{done}</ul> : <p className="text-muted">{t('import.check.nothingChanged')}</p>}
      {(c.rules.length > 0 || c.existing.length > 0) && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 flex items-center gap-2 font-medium"><ListChecks size={14} /> {t('import.check.proposals')}</p>
          {c.existing.length > 0 && (
            <>
              <p className="mb-1 text-xs text-muted">{t('import.check.existingTitle')}</p>
              <ul className="mb-3 max-h-48 space-y-1 overflow-y-auto">
                {c.existing.map((e) => (
                  <li key={e.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="accent-[var(--accent)]" checked={existing.has(e.id)} onChange={(ev) => setExisting((s) => toggle(s, e.id, ev.target.checked))} />
                      <span className="min-w-0 flex-1 truncate"><span className="font-medium">{e.label}</span> → {e.categoryName}</span>
                      <span className="num text-muted">{t('import.check.count', { count: e.count })} · {money(e.totalCents, preview.currency)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          {c.rules.length > 0 && (
            <>
              <p className="mb-1 text-xs text-muted">{t('import.check.rulesTitle')}</p>
              <ul className="mb-3 max-h-48 space-y-1 overflow-y-auto">
                {c.rules.map((r) => (
                  <li key={r.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="accent-[var(--accent)]" checked={rules.has(r.id)} onChange={(ev) => setRules((s) => toggle(s, r.id, ev.target.checked))} />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-muted">{t(`budgets.field.${r.field}`)} {t(`budgets.match.${r.match}`)}</span> “{r.pattern}” → <span className="font-medium">{r.categoryName}</span>
                      </span>
                      <span className="num text-muted">{t('import.check.ruleReach', { here: r.rowsHere, existing: r.existing })}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex justify-end">
            <Button size="sm" variant="primary" disabled={!picked || busy} onClick={apply}>{t('import.check.apply', { rules: rules.size, groups: existing.size })}</Button>
          </div>
        </div>
      )}
      {c.dropped.length > 0 && (
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer">{t('import.check.dropped', { count: c.dropped.length })}</summary>
          <ul className="mt-1 list-disc pl-5">{c.dropped.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </details>
      )}
    </Card>
  )
}

const FIELDS: (keyof Omit<ImportColumns, 'description'>)[] = ['bookingDate', 'amount', 'debit', 'credit', 'counterpartyName', 'counterpartyIban', 'communication', 'valueDate', 'currency', 'bankReference', 'status', 'balance']

function MappingModal({ open, preview, onClose, onApplied }: { open: boolean; preview: ImportPreview; onClose: () => void; onApplied: (p: ImportPreview) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [m, setM] = useState<ImportMapping>(
    preview.mapping ?? { delimiter: ';', headerRow: 0, dateOrder: 'DMY', decimal: ',', invertSign: false, columns: { bookingDate: 0, amount: 1, description: [] } }
  )
  const header = preview.headers
  const col = (f: (typeof FIELDS)[number]): string => (m.columns[f] === undefined ? '' : String(m.columns[f]))
  const setCol = (f: (typeof FIELDS)[number], v: string): void => {
    const columns = { ...m.columns } as ImportColumns
    if (v === '') delete (columns as Partial<ImportColumns>)[f]
    else (columns as unknown as Record<string, number>)[f] = Number(v)
    setM({ ...m, columns })
  }
  const label = (i: number): string => `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''} · ${header[i] || t('import.column', { n: i + 1 })}${preview.sample[0]?.[i] ? `  (${preview.sample[0][i]!.slice(0, 24)})` : ''}`
  return (
    <Modal open={open} title={t('import.columns')} onClose={onClose}>
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
        <p className="text-[13px] text-muted">{t('import.columnsHint')}</p>
        {FIELDS.map((f) => (
          <Field key={f} label={t(`import.field.${f}`)}>
            {(id) => (
              <Select id={id} value={col(f)} onChange={(e) => setCol(f, e.target.value)}>
                <option value="">{f === 'bookingDate' ? t('import.pick') : t('import.none')}</option>
                {header.map((_, i) => <option key={i} value={i}>{label(i)}</option>)}
              </Select>
            )}
          </Field>
        ))}
        <div>
          <p className="mb-1.5 text-[13px] font-medium">{t('import.field.description')}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {header.map((h, i) => (
              <label key={i} className="flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" className="accent-[var(--accent)]" checked={m.columns.description.includes(i)} onChange={(e) => setM({ ...m, columns: { ...m.columns, description: e.target.checked ? [...m.columns.description, i] : m.columns.description.filter((x) => x !== i) } })} />
                {h || t('import.column', { n: i + 1 })}
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('import.dateOrder')}>{(id) => <Select id={id} value={m.dateOrder} onChange={(e) => setM({ ...m, dateOrder: e.target.value as ImportMapping['dateOrder'] })}><option value="DMY">31/12/2026</option><option value="YMD">2026-12-31</option><option value="MDY">12/31/2026</option></Select>}</Field>
          <Field label={t('import.decimal')}>{(id) => <Select id={id} value={m.decimal} onChange={(e) => setM({ ...m, decimal: e.target.value as ',' | '.' })}><option value=",">1.234,56</option><option value=".">1,234.56</option></Select>}</Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]"><Switch label={t('import.invert')} checked={m.invertSign} onChange={(v) => setM({ ...m, invertSign: v })} />{t('import.invert')}</label>
      </div>
      <div className="mt-4 flex justify-between gap-2 border-t border-border pt-4">
        <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => preview.mapping && setM(preview.mapping)}>{t('import.reset')}</Button>
        <div className="flex gap-2">
          <Button onClick={onClose}>{t('settings.cancel')}</Button>
          <Button variant="primary" icon={<Copy size={14} />} onClick={() => void call('import.remap', { sessionId: preview.sessionId, mapping: m }).then(onApplied, (e) => toast(errText(e), 'error'))}>{t('import.apply')}</Button>
        </div>
      </div>
    </Modal>
  )
}
