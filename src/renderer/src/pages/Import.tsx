import { CheckCircle2, FileUp, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImportCommitResult, ImportPreview } from '@shared/types'
import type { Page } from '../App'
import { Button, Card, CardHeader, PageHeader, Select, cx } from '../components/ui'
import { useToast } from '../components/Toast'
import { SNIFF_BYTES, fileKindOf, isCancelledRead } from '@shared/pdf-import'
import { ApiError, call, useOp } from '../lib/api'
import { errorMessage } from '../lib/error-message'
import { openSettingsTab } from '../lib/settings-tab'
import { formatDateTime } from '../lib/format'
import { useSettings } from '../lib/settings'
import { errText } from './auth/parts'
import { useAssistant } from '../components/AssistantPanel'
import { ImportBalanceCheck } from '../components/BankBalance'
import { PreviewView, type AssistKind } from './import-parts/PreviewView'

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
  // A PDF being read: the page the reader is on (0 before the first page is reported).
  const [reading, setReading] = useState<{ page: number; pages: number } | null>(null)
  const busyRef = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const account = accountId ?? accounts.data?.find((a) => !a.archived)?.id ?? null
  const assistant = useAssistant()
  // When the running check started (null: none), so the timer continues after switching tabs.
  const [assisting, setAssisting] = useState<number | null>(null)
  const [assistKind, setAssistKind] = useState<AssistKind>('check')
  const kindRef = useRef(assistKind)
  kindRef.current = assistKind
  const sessionRef = useRef<string | null>(null)
  sessionRef.current = preview?.sessionId ?? null
  // Coming back to this tab: the open import (kept in the background) and a check still running.
  useEffect(() => {
    void call('import.current').then(async (p) => {
      if (!p) return
      setPreview((cur) => cur ?? p)
      const st = await call('import.assistStatus', { sessionId: p.sessionId })
      if (st?.running) {
        setAssisting(st.startedAt)
        setAssistKind(st.kind)
      }
    })
  }, [])
  useEffect(
    () =>
      window.kasboek.onEvent((e) => {
        // The chat assistant can change the open import too: refresh when it does.
        if (e.type === 'import.pdfProgress') setReading((cur) => cur && { page: e.page, pages: e.pages })
        if (e.type === 'import.updated') void call('import.current').then((p) => p && setPreview(p))
        if (e.type === 'import.checkDone' && e.sessionId === sessionRef.current) {
          setAssisting(null)
          if (e.error) {
            if (e.error.code !== 'assistant.cancelled') toast(errorMessage(e.error), 'error')
          } else {
            void call('import.preview', { sessionId: e.sessionId }).then(setPreview)
            toast(t(kindRef.current === 'pdf' ? 'import.pdf.ai.done' : 'import.checked'))
          }
        }
      }),
    [toast, t]
  )

  const open = async (file: File): Promise<void> => {
    // A second file while one is being opened is ignored.
    if (!account || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      // PDF or text is decided by the file's first bytes, not by its name.
      const isPdf = fileKindOf(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer())) === 'pdf'
      const input = { fileName: file.name, contentBase64: toBase64(await file.arrayBuffer()), accountId: account }
      if (isPdf) setReading({ page: 0, pages: 0 })
      setPreview(await call(isPdf ? 'import.analyzePdf' : 'import.analyze', input))
      setDone(null)
    } catch (e) {
      // Cancelling is the person's own choice: back to the drop zone without a message.
      if (!(e instanceof ApiError && isCancelledRead(e.code))) toast(errText(e), 'error')
    } finally {
      setReading(null)
      setBusy(false)
      busyRef.current = false
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
            ? (p, consent, needConsent) => {
                setAssistKind('check')
                setAssisting(Date.now())
                // The result arrives as an event (import.checkDone), also when this tab was left meanwhile.
                void call('import.assist', consent ? { sessionId: p.sessionId, consent } : { sessionId: p.sessionId }).catch((e) => {
                  setAssisting(null)
                  // Not agreed yet for this provider, address and model: the dialog asks.
                  if (e instanceof ApiError && e.code === 'import.consent_needed') needConsent()
                  else if (!(e instanceof ApiError)) toast(errText(e), 'error')
                })
              }
            : undefined
        }
        assistKind={assistKind}
        onAssistPdf={
          assistant?.configured
            ? (p) => {
                setAssistKind('pdf')
                setAssisting(Date.now())
                // Like the check: the result arrives as an event (import.checkDone).
                void call('import.pdfAssist', { sessionId: p.sessionId, consent: true }).catch((e) => {
                  setAssisting(null)
                  if (!(e instanceof ApiError)) toast(errText(e), 'error')
                })
              }
            : undefined
        }
        onSetup={() => {
          openSettingsTab('assistant')
          go('settings')
        }}
        onCancel={() => {
          // Closing the import also stops a check that is still running for it.
          if (assisting !== null) void call('import.assistCancel', { sessionId: preview.sessionId })
          void call('import.discard', { sessionId: preview.sessionId }).finally(() => setPreview(null))
        }}
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
              {done.balanceNote && <p className="mt-1 text-xs text-warning">{done.balanceNote}</p>}
              {(done.transfersPaired > 0 || done.transfersSuggested > 0) && (
                <p className="mt-1 text-[13px] text-muted">
                  {done.transfersPaired > 0 && t('import.transfersPaired', { count: done.transfersPaired })} {done.transfersSuggested > 0 && t('import.transfersSuggested', { count: done.transfersSuggested })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {accounts.data && accounts.data.length === 0 ? (
        <Card className="px-5 py-6 text-center text-[13px] text-muted">
          {t('import.needAccount')} <button type="button" className="font-medium text-accent hover:underline" onClick={() => { openSettingsTab('accounts'); go('settings') }}>{t('import.addAccount')}</button>
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
            {reading ? (
              <div className="mt-5 flex items-center gap-3 text-[13px]" role="status">
                <span className="num">{reading.pages > 0 ? t('import.pdf.readingPage', { page: reading.page, pages: reading.pages }) : t('import.pdf.reading')}</span>
                <Button size="sm" onClick={() => void call('import.pdfCancel')}>{t('settings.cancel')}</Button>
              </div>
            ) : (
              <Button className="mt-5" variant="primary" disabled={busy || !account} onClick={() => fileInput.current?.click()}>{busy ? t('auth.working') : t('import.choose')}</Button>
            )}
            <input ref={fileInput} type="file" accept=".csv,.txt,.pdf,text/csv,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void open(f) }} />
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
