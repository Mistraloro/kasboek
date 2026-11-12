import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { call } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { errText, PasswordFields, passwordsOk } from './parts'

/** After unlocking with the recovery key, a new password must be chosen. */
export function RecoveredModal() {
  const { t } = useTranslation()
  const toast = useToast()
  const { set } = useAuth()
  const [pw, setPw] = useState({ a: '', b: '' })
  return (
    <Modal open title={t('auth.recoveredTitle')} onClose={() => {}}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void call('auth.changePassword', { next: pw.a })
            .then((s) => {
              toast(t('auth.passwordChanged'))
              set(s)
            })
            .catch((err) => toast(errText(err), 'error'))
        }}
      >
        <p className="text-[13px] text-muted">{t('auth.recoveredBody')}</p>
        <PasswordFields value={pw} onChange={setPw} autoFocus />
        <Button type="submit" variant="primary" disabled={!passwordsOk(pw)}>
          {t('settings.save')}
        </Button>
      </form>
    </Modal>
  )
}
