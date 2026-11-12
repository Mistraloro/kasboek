import { Check, Copy, Fingerprint, KeyRound, ScanFace } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DeviceAuthKind } from '@shared/types'
import { Button, Field, Input } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { ApiError, call } from '../../lib/api'

export const errText = (e: unknown): string => (e instanceof ApiError ? e.message : String(e))

export function DeviceIcon({ kind, size = 16 }: { kind: DeviceAuthKind; size?: number }) {
  return kind === 'touch-id' ? <Fingerprint size={size} /> : kind === 'windows-hello' ? <ScanFace size={size} /> : <KeyRound size={size} />
}

export function useDeviceName(kind: DeviceAuthKind): string {
  const { t } = useTranslation()
  return kind === 'touch-id' ? t('auth.touchId') : t('auth.windowsHello')
}

export function PasswordFields({ value, onChange, autoFocus }: { value: { a: string; b: string }; onChange: (v: { a: string; b: string }) => void; autoFocus?: boolean }) {
  const { t } = useTranslation()
  const tooShort = value.a.length > 0 && value.a.length < 10
  const mismatch = value.b.length > 0 && value.a !== value.b
  return (
    <div className="flex flex-col gap-4">
      <Field label={t('auth.newPassword')} hint={t('auth.passwordHint')}>
        {(id) => <Input id={id} type="password" autoFocus={autoFocus} autoComplete="new-password" value={value.a} onChange={(e) => onChange({ ...value, a: e.target.value })} />}
      </Field>
      <Field label={t('auth.repeatPassword')}>
        {(id) => <Input id={id} type="password" autoComplete="new-password" value={value.b} onChange={(e) => onChange({ ...value, b: e.target.value })} />}
      </Field>
      {(tooShort || mismatch) && <p className="text-[13px] text-negative">{tooShort ? t('auth.passwordTooShort') : t('auth.passwordMismatch')}</p>}
    </div>
  )
}

export const passwordsOk = (v: { a: string; b: string }): boolean => v.a.length >= 10 && v.a === v.b

export function CodeInput({ value, onChange, autoFocus, id }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; id?: string }) {
  return (
    <Input
      id={id}
      inputMode="numeric"
      autoComplete="one-time-code"
      autoFocus={autoFocus}
      maxLength={6}
      placeholder="123456"
      className="num text-center text-lg tracking-[0.4em]"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
    />
  )
}

/** Shows the recovery key once and makes sure it was written down. */
export function RecoveryKeyPanel({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [saved, setSaved] = useState(false)
  const [check, setCheck] = useState('')
  const last = recoveryKey.split('-').at(-1) ?? ''
  return (
    <div className="flex flex-col gap-4">
      <div className="selectable num rounded-lg border border-border bg-surface-2 px-4 py-4 text-center font-mono text-[17px] leading-relaxed font-semibold tracking-wider">
        {recoveryKey.split('-').slice(0, 4).join('-')}
        <br />
        {recoveryKey.split('-').slice(4).join('-')}
      </div>
      <Button
        icon={<Copy size={14} />}
        onClick={() =>
          void navigator.clipboard.writeText(recoveryKey).then(
            () => toast(t('auth.copied')),
            () => toast(t('auth.copyFailed'), 'error')
          )
        }
      >
        {t('auth.copy')}
      </Button>
      <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
        <li>{t('auth.recoveryTip1')}</li>
        <li>{t('auth.recoveryTip2')}</li>
        <li>{t('auth.recoveryTip3')}</li>
      </ul>
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {t('auth.recoverySaved')}
      </label>
      {saved && (
        <Field label={t('auth.recoveryConfirm', { n: 8 })}>
          {(id) => <Input id={id} value={check} onChange={(e) => setCheck(e.target.value.toUpperCase())} maxLength={4} className="num font-mono tracking-widest" />}
        </Field>
      )}
      <Button variant="primary" disabled={!saved || check !== last} onClick={onDone}>
        {t('auth.continue')}
      </Button>
    </div>
  )
}

/** Scan a QR code, enter the first code, done. */
export function TotpSetup({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [data, setData] = useState<{ secret: string; qrSvg: string } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void call('auth.totpBegin').then(setData, (e) => toast(errText(e), 'error'))
  }, [toast])
  if (!data) return null
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        void call('auth.totpEnable', { code })
          .then(() => {
            toast(t('auth.totpEnabled'))
            onDone()
          })
          .catch((err) => toast(errText(err), 'error'))
          .finally(() => setBusy(false))
      }}
    >
      <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted">
        <li>{t('auth.totpStep1')}</li>
        <li>{t('auth.totpStep2')}</li>
      </ol>
      <div className="flex items-center gap-4">
        <img alt={t('auth.qrAlt')} className="h-40 w-40 rounded-lg border border-border bg-white p-1" src={`data:image/svg+xml;utf8,${encodeURIComponent(data.qrSvg)}`} />
        <div className="min-w-0 text-[13px]">
          <p className="text-muted">{t('auth.totpManual')}</p>
          <p className="selectable num mt-1 font-mono text-[13px] font-semibold break-all">{data.secret}</p>
        </div>
      </div>
      <Field label={t('auth.totpStep3')}>{(id) => <CodeInput id={id} value={code} onChange={setCode} autoFocus />}</Field>
      <div className="flex justify-end gap-2">
        {onCancel && <Button onClick={onCancel}>{t('auth.notNow')}</Button>}
        <Button type="submit" variant="primary" icon={<Check size={14} />} disabled={code.length !== 6 || busy}>
          {t('auth.totpTurnOn')}
        </Button>
      </div>
    </form>
  )
}
