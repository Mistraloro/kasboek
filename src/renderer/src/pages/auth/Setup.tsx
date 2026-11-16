import { ArrowLeft, FileLock2, KeyRound, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { call } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { formatDateTime } from '../../lib/format'
import { usePrefsFmt } from '../../lib/settings'
import { AuthCard, AuthLayout } from './AuthLayout'
import { ImportFlow } from './ImportFlow'
import { DeviceIcon, errText, PasswordFields, passwordsOk, RecoveryKeyPanel, TotpSetup, useDeviceName } from './parts'

type Step = 'choose' | 'password' | 'import' | 'recovery' | 'twofactor'

function Choice({ icon, title, body, onClick, disabled, note }: { icon: ReactNode; title: string; body: string; onClick: () => void; disabled?: boolean; note?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3.5 text-left transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-border"
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">{icon}</span>
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-[13px] text-muted">{body}</span>
        {note && <span className="mt-1 block text-xs text-warning">{note}</span>}
      </span>
    </button>
  )
}

export function Setup() {
  const { t } = useTranslation()
  const toast = useToast()
  const { status, refresh, set } = useAuth()
  const deviceName = useDeviceName(status.device)
  const fmt = usePrefsFmt()
  const [step, setStep] = useState<Step>('choose')
  const [pw, setPw] = useState({ a: '', b: '' })
  const [recoveryKey, setRecoveryKey] = useState('')
  const [busy, setBusy] = useState(false)

  // Windows Hello may have been switched on (or was busy) after Kasboek looked: check again on return.
  useEffect(() => {
    const again = (): void => void refresh()
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [refresh])

  const create = (input: { mode: 'password'; password: string } | { mode: 'device' }): void => {
    setBusy(true)
    void call('auth.setup', input)
      .then((r) => {
        setRecoveryKey(r.recoveryKey)
        setStep('recovery')
      })
      .catch((e) => toast(errText(e), 'error'))
      .finally(() => setBusy(false))
  }

  const back = (
    <button type="button" onClick={() => setStep('choose')} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
      <ArrowLeft size={14} /> {t('auth.back')}
    </button>
  )

  return (
    <AuthLayout wide={step === 'twofactor'}>
      {step === 'choose' && (
        <AuthCard title={t('auth.welcome')} body={status.legacyData ? t('auth.welcomeLegacy') : t('auth.welcomeBody')}>
          <div className="flex flex-col gap-2.5">
            <Choice icon={<KeyRound size={16} />} title={t('auth.choosePassword')} body={t('auth.choosePasswordBody')} onClick={() => setStep('password')} />
            <Choice
              icon={<DeviceIcon kind={status.device} />}
              title={status.device ? t('auth.chooseDevice', { name: deviceName }) : t('auth.choosePasswordless')}
              body={t('auth.chooseDeviceBody')}
              disabled={!status.device || status.keyProtection !== 'os' || busy}
              note={
                status.device
                  ? status.keyProtection !== 'os'
                    ? t('auth.deviceUnprotectedHint')
                    : undefined
                  : status.deviceChecking
                    ? t('auth.deviceChecking')
                    : t('auth.deviceUnavailableHint')
              }
              onClick={() => create({ mode: 'device' })}
            />
            <Choice icon={<FileLock2 size={16} />} title={t('auth.chooseImport')} body={t('auth.chooseImportBody')} onClick={() => setStep('import')} />
          </div>
          {status.erased.length > 0 && (
            <div className="mt-4 rounded-lg bg-surface-2 px-3 py-2.5">
              <p className="text-[13px] font-medium">{t('auth.restoreErased')}</p>
              <p className="text-[13px] text-muted">{t('auth.restoreErasedBody')}</p>
              <div className="mt-2 flex flex-col items-start gap-1.5">
                {status.erased.map((e) => (
                  <Button
                    key={e.name}
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true)
                      void call('auth.restoreErased', { name: e.name })
                        .then(set)
                        .catch((err) => toast(errText(err), 'error'))
                        .finally(() => setBusy(false))
                    }}
                  >
                    {t('auth.restoreErasedItem', { date: formatDateTime(e.erasedAt, fmt) })}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {status.keyProtection === 'weak' && <p className="mt-4 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">{t('settings.keyStorageWeakHint')}</p>}
        </AuthCard>
      )}

      {step === 'password' && (
        <>
          {back}
          <AuthCard title={t('auth.choosePassword')} body={t('auth.passwordIntro')}>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                create({ mode: 'password', password: pw.a })
              }}
            >
              <PasswordFields value={pw} onChange={setPw} autoFocus />
              <Button type="submit" variant="primary" disabled={!passwordsOk(pw) || busy}>
                {busy ? t('auth.working') : t('auth.createAccount')}
              </Button>
            </form>
          </AuthCard>
        </>
      )}

      {step === 'import' && (
        <>
          {back}
          <AuthCard title={t('auth.chooseImport')}>
            <ImportFlow onCancel={() => setStep('choose')} onDone={set} />
          </AuthCard>
        </>
      )}

      {step === 'recovery' && (
        <AuthCard title={t('auth.recoveryTitle')} body={t('auth.recoveryBody')}>
          <RecoveryKeyPanel recoveryKey={recoveryKey} onDone={() => setStep('twofactor')} />
        </AuthCard>
      )}

      {step === 'twofactor' && (
        <AuthCard title={t('auth.totpTitle')} body={t('auth.totpBody')}>
          <TotpSetup onDone={() => void refresh()} onCancel={() => void refresh()} />
          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck size={13} /> {t('auth.totpLater')}
          </p>
        </AuthCard>
      )}
    </AuthLayout>
  )
}
