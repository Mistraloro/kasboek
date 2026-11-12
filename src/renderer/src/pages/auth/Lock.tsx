import { Lock as LockIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Field, Input } from '../../components/ui'
import { call } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { AuthCard, AuthLayout } from './AuthLayout'
import { CodeInput, DeviceIcon, errText, useDeviceName } from './parts'

type View = 'unlock' | 'recovery' | 'erase'

export function Lock() {
  const { t } = useTranslation()
  const { status, set } = useAuth()
  const deviceName = useDeviceName(status.device)
  const [view, setView] = useState<View>('unlock')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [erase, setErase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = (p: Promise<Parameters<typeof set>[0]>): void => {
    setBusy(true)
    setError(null)
    p.then(set)
      .catch((e) => {
        setError(errText(e))
        setPassword('')
        setCode('')
      })
      .finally(() => setBusy(false))
  }

  if (status.error) {
    return (
      <AuthLayout>
        <AuthCard title={t('auth.cantOpen')} body={status.error.message}>
          <Button className="mb-2 w-full" onClick={() => window.location.reload()}>
            {t('auth.tryAgain')}
          </Button>
          <Button variant="danger" className="w-full" onClick={() => setView('erase')}>
            {t('auth.eraseTitle')}
          </Button>
          {view === 'erase' && <EraseForm value={erase} onChange={setErase} onConfirm={() => run(call('auth.erase', { confirm: 'ERASE' }))} busy={busy} />}
        </AuthCard>
      </AuthLayout>
    )
  }

  const device = status.mode === 'device'
  return (
    <AuthLayout>
      {view === 'unlock' && (
        <AuthCard title={t('auth.unlockTitle')} body={device ? t('auth.unlockDeviceBody', { name: deviceName }) : undefined}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              run(call('auth.unlock', device ? { code } : { password, code }))
            }}
          >
            {!device && (
              <Field label={t('auth.password')}>
                {(id) => <Input id={id} type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
              </Field>
            )}
            {status.twoFactor && <Field label={t('auth.code')}>{(id) => <CodeInput id={id} value={code} onChange={setCode} autoFocus={device} />}</Field>}
            {error && <p className="text-[13px] text-negative" role="alert">{error}</p>}
            {status.throttleSeconds > 0 && !error && <p className="text-[13px] text-warning">{t('auth.throttled', { s: status.throttleSeconds })}</p>}
            <Button
              type="submit"
              variant="primary"
              icon={device ? <DeviceIcon kind={status.device} /> : <LockIcon size={14} />}
              disabled={busy || (!device && !password) || (status.twoFactor && code.length !== 6)}
            >
              {busy ? t('auth.working') : device ? t('auth.unlockWith', { name: deviceName }) : t('auth.unlock')}
            </Button>
          </form>
          <div className="mt-5 flex justify-between text-[13px]">
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => setView('recovery')}>
              {t('auth.forgot')}
            </button>
            <button type="button" className="text-muted hover:text-negative" onClick={() => setView('erase')}>
              {t('auth.eraseLink')}
            </button>
          </div>
        </AuthCard>
      )}

      {view === 'recovery' && (
        <AuthCard title={t('auth.recoveryUnlockTitle')} body={t('auth.recoveryUnlockBody')}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              run(call('auth.unlockRecovery', { recoveryKey }))
            }}
          >
            <Field label={t('auth.recoveryKey')}>
              {(id) => <Input id={id} autoFocus value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} placeholder="XXXX-XXXX-XXXX-…" className="num font-mono" />}
            </Field>
            {error && <p className="text-[13px] text-negative">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setView('unlock')}>{t('auth.back')}</Button>
              <Button type="submit" variant="primary" disabled={busy || recoveryKey.length < 32}>
                {t('auth.unlock')}
              </Button>
            </div>
          </form>
        </AuthCard>
      )}

      {view === 'erase' && (
        <AuthCard title={t('auth.eraseTitle')} body={t('auth.eraseBody')}>
          <EraseForm value={erase} onChange={setErase} onConfirm={() => run(call('auth.erase', { confirm: 'ERASE' }))} busy={busy} />
          <Button className="mt-2 w-full" onClick={() => setView('unlock')}>
            {t('auth.back')}
          </Button>
        </AuthCard>
      )}
    </AuthLayout>
  )
}

function EraseForm({ value, onChange, onConfirm, busy }: { value: string; onChange: (v: string) => void; onConfirm: () => void; busy: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="mt-4 flex flex-col gap-3">
      <Field label={t('auth.eraseType')}>{(id) => <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="ERASE" />}</Field>
      <Button variant="danger" disabled={value !== 'ERASE' || busy} onClick={onConfirm}>
        {t('auth.eraseConfirm')}
      </Button>
    </div>
  )
}
