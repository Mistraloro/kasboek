import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImportPreview, PdfAssistPreview, CheckAssistPreview } from '@shared/types'
import { Button, Modal } from '../../components/ui'
import { call } from '../../lib/api'
import { errText } from '../auth/parts'
import { useAssistant } from '../../components/AssistantPanel'

/** Asks the person every time before a PDF's text goes to the assistant, and shows exactly what would be sent. */
export function PdfConsentModal({ open, preview, onClose, onSend }: { open: boolean; preview: ImportPreview; onClose: () => void; onSend: () => void }) {
  const { t } = useTranslation()
  const assistant = useAssistant()
  const [info, setInfo] = useState<PdfAssistPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setInfo(null)
    setError(null)
    let current = true
    void call('import.pdfAssistPreview', { sessionId: preview.sessionId }).then(
      (r) => current && setInfo(r),
      (e) => current && setError(errText(e))
    )
    return () => {
      current = false
    }
  }, [open, preview.sessionId])
  const local = assistant?.company === null
  const message =
    info &&
    [
      t(preview.pdf?.tableFound === false ? 'import.pdf.ai.introNoTable' : 'import.pdf.ai.introMismatch'),
      t(local ? 'import.pdf.ai.sendsLocal' : 'import.pdf.ai.sendsRemote', { count: info.pages }),
      t(info.preambleLeftOut ? 'import.pdf.ai.hiddenTop' : 'import.pdf.ai.hiddenNoTop'),
      t('import.pdf.ai.verify'),
      t('import.pdf.ai.replaces')
    ].join(' ')
  return (
    <Modal open={open} title={t('import.pdf.ai.title')} onClose={onClose}>
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1 text-[13px]">
        {error && <p className="text-negative">{error}</p>}
        {!info && !error && <p className="text-muted">{t('import.pdf.ai.loading')}</p>}
        {info && (
          <>
            <p>{message}</p>
            {preview.edited > 0 && <p className="font-medium text-warning">{t('import.pdf.ai.edited', { count: preview.edited })}</p>}
            <p className="num text-muted">{t('import.pdf.ai.stats', { pages: info.pages, tokens: info.approxTokens.toLocaleString(), parts: info.parts })}</p>
            <details>
              <summary className="cursor-pointer font-medium">{t('import.pdf.ai.show')}</summary>
              <pre className="selectable mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-[11px] leading-snug whitespace-pre-wrap">{info.text}</pre>
            </details>
          </>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-4">
        <Button onClick={onClose}>{t('settings.cancel')}</Button>
        <Button variant="primary" icon={<Sparkles size={14} />} disabled={!info} onClick={onSend}>{t(local ? 'import.pdf.ai.sendLocal' : 'import.pdf.ai.send')}</Button>
      </div>
    </Modal>
  )
}

/** Asks before the rows of a CSV file go to the assistant (once per provider, address and model), and shows exactly what is sent. */
export function CheckConsentModal({ open, preview, onClose, onSend }: { open: boolean; preview: ImportPreview; onClose: () => void; onSend: () => void }) {
  const { t } = useTranslation()
  const [info, setInfo] = useState<CheckAssistPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setInfo(null)
    setError(null)
    let current = true
    void call('import.assistPreview', { sessionId: preview.sessionId }).then(
      (r) => current && setInfo(r),
      (e) => current && setError(errText(e))
    )
    return () => {
      current = false
    }
  }, [open, preview.sessionId])
  const local = info?.company === null
  const vars = info && { ai: info.providerName, aiCompany: info.company ?? info.providerName }
  return (
    <Modal open={open} title={t('import.consent.title', { ai: info?.providerName ?? '' })} onClose={onClose}>
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1 text-[13px]">
        {error && <p className="text-negative">{error}</p>}
        {!info && !error && <p className="text-muted">{t('import.consent.loading')}</p>}
        {info && vars && (
          <>
            <p>{t('import.consent.intro', vars)}</p>
            <p>{t(local ? 'import.consent.sendsLocal' : 'import.consent.sendsRemote', vars)}</p>
            <p>{t('import.consent.notSent')}</p>
            <p className="text-muted">{t('import.consent.again')}</p>
            <p className="num text-muted">{t('import.consent.stats', { rows: info.rows, tokens: info.approxTokens.toLocaleString(), parts: info.parts, address: info.address, model: info.model })}</p>
            <details>
              <summary className="cursor-pointer font-medium">{t('import.consent.show')}</summary>
              <pre className="selectable mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-[11px] leading-snug whitespace-pre-wrap">{info.text}</pre>
            </details>
          </>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-4">
        <Button onClick={onClose}>{t('settings.cancel')}</Button>
        <Button variant="primary" icon={<Sparkles size={14} />} disabled={!info} onClick={onSend}>{t(local ? 'import.consent.sendLocal' : 'import.consent.send', vars ?? {})}</Button>
      </div>
    </Modal>
  )
}
