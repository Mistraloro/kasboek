import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Field, Input, Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { call } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { errText, PasswordFields, passwordsOk } from './parts'

/** After unlocking with the recovery key, a new password must be chosen. */
export function RecoveredModal({ weak = false }: { weak?: boolean }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { set } = useAuth()
  const [pw, setPw] = useState({ a: '', b: '' })
  const [current, setCurrent] = useState('')
  return (
    <Modal open title={weak ? t('auth.weakTitle') : t('auth.recoveredTitle')} onClose={() => {}} dismissible={false}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void call('auth.changePassword', weak ? { current, next: pw.a } : { next: pw.a })
            .then((s) => {
              toast(t('auth.passwordChanged'))
              set(s)
            })
            .catch((err) => toast(errText(err), 'error'))
        }}
      >
        <p className="text-[13px] text-muted">{weak ? t('auth.weakBody') : t('auth.recoveredBody')}</p>
        {weak && <Field label={t('auth.currentPassword')}>{(id) => <Input id={id} type="password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>}
        <PasswordFields value={pw} onChange={setPw} autoFocus={!weak} />
        <Button type="submit" variant="primary" disabled={!passwordsOk(pw) || (weak && !current)}>
          {t('settings.save')}
        </Button>
      </form>
    </Modal>
  )
}
