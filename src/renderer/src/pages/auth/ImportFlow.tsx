import { FileLock2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AuthStatus, PickedTransfer } from '@shared/types'
import { Button, Field, Input } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { call } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { usePrefs } from '../../lib/settings'
import { CodeInput, errText, PasswordFields, passwordsOk } from './parts'

/** Pick a .kasboek file and open it with the login details it was made with. */
export function ImportFlow({ onDone, onCancel, replacing, preset }: { onDone: (s: AuthStatus) => void; onCancel: () => void; replacing?: boolean; preset?: PickedTransfer }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { prefs } = usePrefs()
  const [picked, setPicked] = useState<PickedTransfer | null>(preset ?? null)
  const [useRecovery, setUseRecovery] = useState(preset ? !preset.hasPassword : false)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [newPw, setNewPw] = useState({ a: '', b: '' })
  const [busy, setBusy] = useState(false)

  if (!picked) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">{t('transfer.importIntro')}</p>
        {replacing && <p className="rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">{t('transfer.replaceWarning')}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>{t('settings.cancel')}</Button>
          <Button
            variant="primary"
            icon={<FileLock2 size={14} />}
            onClick={() =>
              void call('transfer.pick').then(
                (p) => {
                  if (!p) return
                  setPicked(p)
                  setUseRecovery(!p.hasPassword)
                },
                (e) => toast(errText(e), 'error')
              )
            }
          >
            {t('transfer.chooseFile')}
          </Button>
        </div>
      </div>
    )
  }

  const needsCode = picked.twoFactor && !useRecovery
  const ready =
    (useRecovery ? recoveryKey.replace(/[^A-Za-z2-7]/g, '').length >= 32 : password.length > 0 && (!needsCode || code.length === 6)) &&
    (!picked.needsNewPassword || passwordsOk(newPw))

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        void call('transfer.import', {
          token: picked.token,
          ...(useRecovery ? { recoveryKey } : { password, ...(needsCode ? { code } : {}) }),
          ...(picked.needsNewPassword ? { newPassword: newPw.a } : {})
        })
          .then((s) => {
            toast(t('transfer.imported'))
            onDone(s)
          })
          .catch((err) => toast(errText(err), 'error'))
          .finally(() => setBusy(false))
      }}
    >
      <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-[13px]">
        <p className="selectable font-medium break-all">{picked.fileName}</p>
        <p className="text-muted">
          {t(picked.kind === 'export' ? 'transfer.kindExport' : 'transfer.kindBackup')} · {formatDateTime(picked.createdAt, prefs.formatLocale)}
        </p>
      </div>
      {useRecovery ? (
        <Field label={t('auth.recoveryKey')}>
          {(id) => <Input id={id} autoFocus value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} placeholder="XXXX-XXXX-XXXX-…" className="num font-mono" />}
        </Field>
      ) : (
        <>
          <Field label={t('auth.password')}>{(id) => <Input id={id} type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          {needsCode && <Field label={t('auth.code')}>{(id) => <CodeInput id={id} value={code} onChange={setCode} />}</Field>}
        </>
      )}
      {picked.hasPassword && (
        <button type="button" className="self-start text-[13px] font-medium text-accent hover:underline" onClick={() => setUseRecovery((v) => !v)}>
          {useRecovery ? t('auth.usePasswordInstead') : t('auth.useRecoveryInstead')}
        </button>
      )}
      {picked.needsNewPassword && (
        <div className="border-t border-border pt-4">
          <p className="mb-3 text-[13px] text-muted">{t('transfer.needsNewPassword')}</p>
          <PasswordFields value={newPw} onChange={setNewPw} />
        </div>
      )}
      {replacing && <p className="rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">{t('transfer.replaceWarning')}</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t('settings.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          {busy ? t('auth.working') : t('transfer.importConfirm')}
        </Button>
      </div>
    </form>
  )
}
