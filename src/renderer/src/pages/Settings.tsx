import { FolderOpen, Monitor, Moon, Plus, ShieldAlert, ShieldCheck, Sun } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { BANKS, type Bank, type PickedBackup } from '@shared/types'
import { Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, Segmented, Select, Switch } from '../components/ui'
import { useToast } from '../components/Toast'
import { LANGUAGES } from '../i18n'
import { ApiError, call, useOp } from '../lib/api'
import { formatDateTime, formatMoney } from '../lib/format'
import { useSettings } from '../lib/settings'

const FORMAT_LOCALES = ['en-BE', 'nl-BE', 'fr-BE', 'de-BE', 'en-GB', 'en-US']

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border px-5 py-4 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

const errMessage = (e: unknown): string => (e instanceof ApiError ? e.message : String(e))

export function SettingsPage() {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className="flex flex-col gap-6">
        <AccountsSection />
        <AppearanceSection />
        <BackupSection />
        <SecuritySection />
      </div>
    </>
  )
}

function AccountsSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const accounts = useOp('accounts.list')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [bank, setBank] = useState<Bank>('argenta')
  const [iban, setIban] = useState('')

  const save = async (): Promise<void> => {
    try {
      await call('accounts.create', { name, bank, iban: iban || null })
      toast(t('settings.accountAdded'))
      setAdding(false)
      setName('')
      setIban('')
      void accounts.reload()
    } catch (e) {
      toast(errMessage(e), 'error')
    }
  }

  return (
    <Card>
      <CardHeader
        title={t('settings.accounts')}
        description={t('settings.accountsHint')}
        action={
          !adding && (
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              {t('settings.addAccount')}
            </Button>
          )
        }
      />
      {(accounts.data ?? []).map((a) => (
        <Row key={a.id} label={a.name} hint={a.iban ? <span className="num selectable">{a.iban.replace(/(.{4})/g, '$1 ').trim()}</span> : undefined}>
          <Badge>{t(`banks.${a.bank}`)}</Badge>
        </Row>
      ))}
      {accounts.data?.length === 0 && !adding && <p className="px-5 py-4 text-[13px] text-muted">{t('settings.noAccounts')}</p>}
      {adding && (
        <form
          className="grid grid-cols-2 gap-4 border-t border-border px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Field label={t('settings.accountName')}>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.accountNamePlaceholder')} autoFocus required />}
          </Field>
          <Field label={t('settings.bank')}>
            {(id) => (
              <Select id={id} value={bank} onChange={(e) => setBank(e.target.value as Bank)}>
                {BANKS.map((b) => (
                  <option key={b} value={b}>
                    {t(`banks.${b}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="col-span-2">
            <Field label={t('settings.iban')} hint={t('settings.ibanOptional')}>
              {(id) => <Input id={id} value={iban} onChange={(e) => setIban(e.target.value)} placeholder="BE68 5390 0754 7034" className="num" />}
            </Field>
          </div>
          <div className="col-span-2 flex justify-end gap-2">
            <Button onClick={() => setAdding(false)}>{t('settings.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              {t('settings.save')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}

function AppearanceSection() {
  const { t } = useTranslation()
  const { settings, update } = useSettings()
  return (
    <Card>
      <CardHeader title={t('settings.appearance')} description={t('settings.appearanceHint')} />
      <Row label={t('settings.theme')}>
        <Segmented
          label={t('settings.theme')}
          value={settings.theme}
          onChange={(theme) => void update({ theme })}
          options={[
            { value: 'system', label: t('settings.themeSystem'), icon: <Monitor size={14} /> },
            { value: 'light', label: t('settings.themeLight'), icon: <Sun size={14} /> },
            { value: 'dark', label: t('settings.themeDark'), icon: <Moon size={14} /> }
          ]}
        />
      </Row>
      <Row label={t('settings.uiLanguage')} hint={t('settings.languageHint')}>
        <Select className="w-44" value={settings.language} onChange={(e) => void update({ language: e.target.value })} aria-label={t('settings.uiLanguage')}>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </Select>
      </Row>
      <Row
        label={t('settings.numberFormat')}
        hint={t('settings.example', {
          value: `${formatMoney(-123456, settings.currency, settings.formatLocale)} · ${new Intl.DateTimeFormat(settings.formatLocale).format(new Date())}`
        })}
      >
        <Select className="w-44" value={settings.formatLocale} onChange={(e) => void update({ formatLocale: e.target.value })} aria-label={t('settings.numberFormat')}>
          {FORMAT_LOCALES.map((l) => (
            <option key={l} value={l}>
              {new Intl.DisplayNames([settings.language], { type: 'language' }).of(l) ?? l}
            </option>
          ))}
        </Select>
      </Row>
    </Card>
  )
}

function BackupSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const { settings } = useSettings()
  const status = useOp('backup.status')
  const [pwOpen, setPwOpen] = useState(false)
  const [restoring, setRestoring] = useState<PickedBackup | null>(null)
  const s = status.data

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      toast(errMessage(e), 'error')
    } finally {
      void status.reload()
    }
  }

  return (
    <Card>
      <CardHeader title={t('settings.backups')} description={t('settings.backupsHint')} />
      <Row label={t('settings.backupPassword')} hint={t('settings.passwordHelp')}>
        <Badge tone={s?.passwordSet ? 'accent' : 'warning'}>{s?.passwordSet ? t('settings.passwordSet') : t('settings.passwordNotSet')}</Badge>
        <Button size="sm" onClick={() => setPwOpen(true)}>
          {s?.passwordSet ? t('settings.changePassword') : t('settings.setPassword')}
        </Button>
      </Row>
      <Row label={t('settings.lastBackup')} hint={s?.lastBackupFile ? <span className="selectable break-all">{s.lastBackupFile}</span> : undefined}>
        <span className="mr-2 text-[13px] text-muted">{s?.lastBackupAt ? formatDateTime(s.lastBackupAt, settings.formatLocale) : t('settings.never')}</span>
        <Button
          size="sm"
          variant="primary"
          disabled={!s?.passwordSet}
          title={s?.passwordSet ? undefined : t('settings.needPasswordFirst')}
          onClick={() =>
            void run(async () => {
              const { file } = await call('backup.createNow', { target: 'choose' })
              if (file) toast(t('settings.backupSaved', { file }))
            })
          }
        >
          {t('settings.backupNow')}
        </Button>
        <Button size="sm" onClick={() => void run(async () => setRestoring(await call('backup.pick')))}>
          {t('settings.restore')}
        </Button>
      </Row>
      <Row label={t('settings.auto')} hint={t('settings.autoHint')}>
        <Switch
          label={t('settings.auto')}
          checked={!!s?.autoEnabled}
          onChange={(enabled) =>
            void run(async () => {
              if (enabled && !s?.passwordSet) throw new ApiError('ui', t('settings.needPasswordFirst'))
              if (enabled && !s?.folder) {
                const { folder } = await call('backup.chooseFolder')
                if (!folder) return
              }
              await call('backup.configureAuto', { enabled })
            })
          }
        />
      </Row>
      <Row label={t('settings.folder')} hint={<span className="selectable break-all">{s?.folder ?? t('settings.noFolder')}</span>}>
        {s?.folder && (
          <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} onClick={() => void run(() => call('backup.revealFolder'))}>
            {t('settings.openFolder')}
          </Button>
        )}
        <Button size="sm" onClick={() => void run(() => call('backup.chooseFolder'))}>
          {t('settings.chooseFolder')}
        </Button>
      </Row>
      <Row label={t('settings.keep')}>
        <Select
          className="w-44"
          aria-label={t('settings.keep')}
          value={s?.keep ?? 10}
          onChange={(e) => void run(() => call('backup.configureAuto', { enabled: !!s?.autoEnabled, keep: Number(e.target.value) }))}
        >
          {[5, 10, 20, 30, 60].map((n) => (
            <option key={n} value={n}>
              {t('settings.keepValue', { count: n })}
            </option>
          ))}
        </Select>
      </Row>

      <PasswordModal open={pwOpen} onClose={() => setPwOpen(false)} onSaved={() => void status.reload()} />
      <RestoreModal picked={restoring} onClose={() => setRestoring(null)} />
    </Card>
  )
}

function PasswordModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const error = pw.length > 0 && pw.length < 10 ? t('settings.passwordTooShort') : pw2.length > 0 && pw !== pw2 ? t('settings.passwordMismatch') : null
  const close = (): void => {
    setPw('')
    setPw2('')
    onClose()
  }
  return (
    <Modal open={open} title={t('settings.backupPassword')} onClose={close}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void call('backup.setPassword', { password: pw })
            .then(() => {
              toast(t('settings.passwordSaved'))
              onSaved()
              close()
            })
            .catch((err) => toast(errMessage(err), 'error'))
        }}
      >
        <p className="text-[13px] text-muted">{t('settings.passwordHelp')}</p>
        <Field label={t('settings.newPassword')}>{(id) => <Input id={id} type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
        <Field label={t('settings.confirmPassword')}>{(id) => <Input id={id} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
        {error && <p className="text-[13px] text-negative">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t('settings.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={pw.length < 10 || pw !== pw2}>
            {t('settings.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function RestoreModal({ picked, onClose }: { picked: PickedBackup | null; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { settings } = useSettings()
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal open={!!picked} title={t('settings.restoreTitle')} onClose={onClose}>
      {picked && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            setBusy(true)
            void call('backup.restore', { token: picked.token, password: pw })
              .catch((err) => toast(errMessage(err), 'error'))
              .finally(() => setBusy(false))
          }}
        >
          <p className="text-[13px] text-muted">{t('settings.restoreBody', { date: formatDateTime(picked.createdAt, settings.formatLocale) })}</p>
          <p className="selectable rounded-lg bg-surface-2 px-3 py-2 text-xs break-all text-muted">{picked.fileName}</p>
          <Field label={t('settings.restorePassword')}>{(id) => <Input id={id} type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('settings.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!pw || busy}>
              {t('settings.restoreConfirm')}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}

function SecuritySection() {
  const { t } = useTranslation()
  const { info } = useSettings()
  const weak = info.keyProtection === 'weak'
  return (
    <Card>
      <CardHeader title={t('settings.security')} description={t('settings.securityHint')} />
      <Row label={t('settings.encryption')}>
        <Badge tone="accent">
          <ShieldCheck size={12} />
          {t('settings.encryptionValue')}
        </Badge>
      </Row>
      <Row label={t('settings.keyStorage')} hint={weak ? t('settings.keyStorageWeakHint') : undefined}>
        <Badge tone={weak ? 'warning' : 'accent'}>
          {weak ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />}
          {weak ? t('settings.keyStorageWeak') : t('settings.keyStorageOs')}
        </Badge>
      </Row>
      <Row label={t('settings.dataFolder')} hint={<span className="selectable break-all">{info.dataDir}</span>}>
        <span />
      </Row>
      <Row label={t('settings.about')}>
        <span className="text-[13px] text-muted">{t('settings.version', { version: info.version })}</span>
      </Row>
    </Card>
  )
}
