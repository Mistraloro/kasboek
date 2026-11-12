import { Download, FolderOpen, Monitor, Moon, Plus, ShieldAlert, ShieldCheck, Sun, Upload } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { BANKS, type Bank } from '@shared/types'
import { Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, Segmented, Select, Switch } from '../components/ui'
import { useToast } from '../components/Toast'
import { LANGUAGES } from '../i18n'
import { ApiError, call, useOp } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatDateTime, formatMoney } from '../lib/format'
import { useSettings } from '../lib/settings'
import { ImportFlow } from './auth/ImportFlow'
import { ClaudeSection } from './SettingsClaude'
import { CodeInput, DeviceIcon, errText, PasswordFields, passwordsOk, RecoveryKeyPanel, TotpSetup, useDeviceName } from './auth/parts'

const FORMAT_LOCALES = ['en-BE', 'nl-BE', 'fr-BE', 'de-BE', 'en-GB', 'en-US']

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border px-5 py-4 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <div className="mt-0.5 text-[13px] text-muted">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export function SettingsPage() {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className="flex flex-col gap-6">
        <SecuritySection />
        <ClaudeSection />
        <TransferSection />
        <BackupSection />
        <AccountsSection />
        <AppearanceSection />
      </div>
    </>
  )
}

/* ---------- Security ---------- */

type SecurityModal = null | 'password' | 'passwordless' | 'totp-on' | 'totp-off' | 'recovery'

function SecuritySection() {
  const { t } = useTranslation()
  const toast = useToast()
  const { status, set } = useAuth()
  const { prefs, updatePrefs, info } = useSettings()
  const deviceName = useDeviceName(status.device)
  const [modal, setModal] = useState<SecurityModal>(null)
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState({ a: '', b: '' })
  const [code, setCode] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const device = status.mode === 'device'
  const close = (): void => {
    setModal(null)
    setCurrent('')
    setPw({ a: '', b: '' })
    setCode('')
    setNewKey(null)
  }
  const run = (p: Promise<unknown>, done: string): void => {
    setBusy(true)
    p.then(() => {
      toast(done)
      void call('auth.status').then(set)
      if (modal !== 'recovery') close()
    })
      .catch((e) => toast(errText(e), 'error'))
      .finally(() => setBusy(false))
  }
  const currentField = !device && (
    <Field label={t('auth.currentPassword')}>{(id) => <Input id={id} type="password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
  )

  return (
    <Card>
      <CardHeader title={t('settings.security')} description={t('settings.securityHint')} />
      <Row label={t('settings.signIn')} hint={device ? t('settings.signInDevice', { name: deviceName }) : t('settings.signInPassword')}>
        <Badge tone="accent">
          {device ? <DeviceIcon kind={status.device} size={12} /> : <ShieldCheck size={12} />}
          {device ? deviceName : t('auth.password')}
        </Badge>
        {device ? (
          <Button size="sm" onClick={() => setModal('password')}>{t('settings.usePassword')}</Button>
        ) : (
          <>
            <Button size="sm" onClick={() => setModal('password')}>{t('settings.changePassword')}</Button>
            {status.device && <Button size="sm" onClick={() => setModal('passwordless')}>{t('settings.goPasswordless', { name: deviceName })}</Button>}
          </>
        )}
      </Row>
      <Row label={t('settings.twoFactor')} hint={t('settings.twoFactorHint')}>
        <Badge tone={status.twoFactor ? 'accent' : 'neutral'}>{status.twoFactor ? t('settings.on') : t('settings.off')}</Badge>
        <Button size="sm" onClick={() => setModal(status.twoFactor ? 'totp-off' : 'totp-on')}>
          {status.twoFactor ? t('settings.turnOff') : t('settings.turnOn')}
        </Button>
      </Row>
      <Row label={t('auth.recoveryKey')} hint={t('settings.recoveryHint')}>
        <Button size="sm" onClick={() => setModal('recovery')}>{t('settings.newRecoveryKey')}</Button>
      </Row>
      <Row label={t('settings.autoLock')} hint={t('settings.autoLockHint')}>
        <Select className="w-44" aria-label={t('settings.autoLock')} value={prefs.autoLockMinutes} onChange={(e) => void updatePrefs({ autoLockMinutes: Number(e.target.value) })}>
          {[1, 5, 10, 15, 30, 60, 0].map((m) => (
            <option key={m} value={m}>
              {m === 0 ? t('settings.never') : t('settings.minutes', { count: m })}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('settings.encryption')} hint={t('settings.encryptionHint')}>
        <Badge tone="accent"><ShieldCheck size={12} />{t('settings.encryptionValue')}</Badge>
      </Row>
      <Row label={t('settings.keyStorage')} hint={status.keyProtection === 'weak' ? t('settings.keyStorageWeakHint') : t('settings.keyStorageOsHint')}>
        <Badge tone={status.keyProtection === 'weak' ? 'warning' : 'accent'}>
          {status.keyProtection === 'weak' ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />}
          {status.keyProtection === 'weak' ? t('settings.keyStorageWeak') : t('settings.keyStorageOs')}
        </Badge>
      </Row>
      <Row label={t('settings.dataFolder')} hint={<span className="selectable break-all">{info.dataDir}</span>}>
        <span className="text-[13px] text-muted">{t('settings.version', { version: info.version })}</span>
      </Row>

      <Modal open={modal === 'password'} title={device ? t('settings.usePassword') : t('settings.changePassword')} onClose={close}>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); run(call('auth.changePassword', { current: device ? undefined : current, next: pw.a }), t('auth.passwordChanged')) }}>
          {currentField}
          {device && <p className="text-[13px] text-muted">{t('settings.confirmWithDevice', { name: deviceName })}</p>}
          <PasswordFields value={pw} onChange={setPw} autoFocus={device} />
          <p className="text-xs text-muted">{t('settings.oldExportsNote')}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={close}>{t('settings.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!passwordsOk(pw) || busy || (!device && !current)}>{t('settings.save')}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={modal === 'passwordless'} title={t('settings.goPasswordless', { name: deviceName })} onClose={close}>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); run(call('auth.usePasswordless', { current }), t('settings.passwordlessOn')) }}>
          <p className="text-[13px] text-muted">{t('settings.passwordlessExplain', { name: deviceName })}</p>
          {currentField}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>{t('settings.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!current || busy}>{t('auth.continue')}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={modal === 'totp-on'} title={t('auth.totpTitle')} onClose={close}>
        {modal === 'totp-on' && <TotpSetup onCancel={close} onDone={() => { void call('auth.status').then(set); close() }} />}
      </Modal>

      <Modal open={modal === 'totp-off'} title={t('settings.twoFactorOff')} onClose={close}>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); run(call('auth.totpDisable', { code }), t('settings.twoFactorDisabled')) }}>
          <p className="text-[13px] text-muted">{t('settings.twoFactorOffBody')}</p>
          <Field label={t('auth.code')}>{(id) => <CodeInput id={id} value={code} onChange={setCode} autoFocus />}</Field>
          <div className="flex justify-end gap-2">
            <Button onClick={close}>{t('settings.cancel')}</Button>
            <Button type="submit" variant="danger" disabled={code.length !== 6 || busy}>{t('settings.turnOff')}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={modal === 'recovery'} title={t('settings.newRecoveryKey')} onClose={close}>
        {newKey ? (
          <RecoveryKeyPanel recoveryKey={newKey} onDone={close} />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setBusy(true); void call('auth.newRecoveryKey', { current: device ? undefined : current }).then((r) => setNewKey(r.recoveryKey)).catch((err) => toast(errText(err), 'error')).finally(() => setBusy(false)) }}>
            <p className="text-[13px] text-muted">{t('settings.newRecoveryBody')}</p>
            {currentField}
            <div className="flex justify-end gap-2">
              <Button onClick={close}>{t('settings.cancel')}</Button>
              <Button type="submit" variant="primary" disabled={busy || (!device && !current)}>{t('auth.continue')}</Button>
            </div>
          </form>
        )}
      </Modal>
    </Card>
  )
}

/* ---------- Move to another computer ---------- */

function TransferSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const { set } = useAuth()
  const [importing, setImporting] = useState(false)
  return (
    <Card>
      <CardHeader title={t('transfer.title')} description={t('transfer.hint')} />
      <Row label={t('transfer.export')} hint={t('transfer.exportHint')}>
        <Button
          size="sm"
          variant="primary"
          icon={<Download size={14} />}
          onClick={() => void call('transfer.export').then((r) => r.file && toast(t('transfer.exported', { file: r.file })), (e) => toast(errText(e), 'error'))}
        >
          {t('transfer.exportButton')}
        </Button>
      </Row>
      <Row label={t('transfer.import')} hint={t('transfer.importHint')}>
        <Button size="sm" icon={<Upload size={14} />} onClick={() => setImporting(true)}>{t('transfer.importButton')}</Button>
      </Row>
      <Modal open={importing} title={t('transfer.import')} onClose={() => setImporting(false)}>
        {importing && <ImportFlow replacing onCancel={() => setImporting(false)} onDone={(s) => { setImporting(false); set(s); window.location.reload() }} />}
      </Modal>
    </Card>
  )
}

/* ---------- Backups ---------- */

function BackupSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const { locale } = useSettings()
  const status = useOp('backup.status')
  const s = status.data
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error')
    } finally {
      void status.reload()
    }
  }
  return (
    <Card>
      <CardHeader title={t('settings.backups')} description={t('settings.backupsHint')} />
      <Row label={t('settings.auto')} hint={t('settings.autoHint')}>
        <Switch
          label={t('settings.auto')}
          checked={!!s?.autoEnabled}
          onChange={(enabled) =>
            void run(async () => {
              if (enabled && !s?.folder && !(await call('backup.chooseFolder')).folder) return
              await call('backup.configureAuto', { enabled })
            })
          }
        />
      </Row>
      <Row label={t('settings.folder')} hint={<span className="selectable break-all">{s?.folder ?? t('settings.noFolder')}</span>}>
        {s?.folder && <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} onClick={() => void run(() => call('backup.revealFolder'))}>{t('settings.openFolder')}</Button>}
        <Button size="sm" onClick={() => void run(() => call('backup.chooseFolder'))}>{t('settings.chooseFolder')}</Button>
      </Row>
      <Row label={t('settings.keep')}>
        <Select className="w-44" aria-label={t('settings.keep')} value={s?.keep ?? 10} onChange={(e) => void run(() => call('backup.configureAuto', { enabled: !!s?.autoEnabled, keep: Number(e.target.value) }))}>
          {[5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{t('settings.keepValue', { count: n })}</option>)}
        </Select>
      </Row>
      <Row label={t('settings.lastBackup')} hint={s?.lastBackupFile ? <span className="selectable break-all">{s.lastBackupFile}</span> : undefined}>
        <span className="mr-2 text-[13px] text-muted">{s?.lastBackupAt ? formatDateTime(s.lastBackupAt, locale) : t('settings.never')}</span>
        <Button size="sm" disabled={!s?.folder} onClick={() => void run(async () => toast(t('settings.backupSaved', { file: (await call('backup.runNow')).file })))}>
          {t('settings.backupNow')}
        </Button>
      </Row>
    </Card>
  )
}

/* ---------- Accounts ---------- */

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
      toast(errText(e), 'error')
    }
  }
  return (
    <Card>
      <CardHeader
        title={t('settings.accounts')}
        description={t('settings.accountsHint')}
        action={!adding && <Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>{t('settings.addAccount')}</Button>}
      />
      {(accounts.data ?? []).map((a) => (
        <Row key={a.id} label={a.name} hint={a.iban ? <span className="num selectable">{a.iban.replace(/(.{4})/g, '$1 ').trim()}</span> : undefined}>
          <Badge>{t(`banks.${a.bank}`)}</Badge>
        </Row>
      ))}
      {accounts.data?.length === 0 && !adding && <p className="px-5 py-4 text-[13px] text-muted">{t('settings.noAccounts')}</p>}
      {adding && (
        <form className="grid grid-cols-2 gap-4 border-t border-border px-5 py-4" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <Field label={t('settings.accountName')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.accountNamePlaceholder')} autoFocus required />}</Field>
          <Field label={t('settings.bank')}>
            {(id) => (
              <Select id={id} value={bank} onChange={(e) => setBank(e.target.value as Bank)}>
                {BANKS.map((b) => <option key={b} value={b}>{t(`banks.${b}`)}</option>)}
              </Select>
            )}
          </Field>
          <div className="col-span-2">
            <Field label={t('settings.iban')} hint={t('settings.ibanOptional')}>{(id) => <Input id={id} value={iban} onChange={(e) => setIban(e.target.value)} placeholder="BE68 5390 0754 7034" className="num" />}</Field>
          </div>
          <div className="col-span-2 flex justify-end gap-2">
            <Button onClick={() => setAdding(false)}>{t('settings.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>{t('settings.save')}</Button>
          </div>
        </form>
      )}
    </Card>
  )
}

/* ---------- Appearance ---------- */

function AppearanceSection() {
  const { t } = useTranslation()
  const { prefs, updatePrefs, settings } = useSettings()
  return (
    <Card>
      <CardHeader title={t('settings.appearance')} description={t('settings.appearanceHint')} />
      <Row label={t('settings.theme')}>
        <Segmented
          label={t('settings.theme')}
          value={prefs.theme}
          onChange={(theme) => void updatePrefs({ theme })}
          options={[
            { value: 'system', label: t('settings.themeSystem'), icon: <Monitor size={14} /> },
            { value: 'light', label: t('settings.themeLight'), icon: <Sun size={14} /> },
            { value: 'dark', label: t('settings.themeDark'), icon: <Moon size={14} /> }
          ]}
        />
      </Row>
      <Row label={t('settings.uiLanguage')} hint={t('settings.languageHint')}>
        <Select className="w-44" value={prefs.language} onChange={(e) => void updatePrefs({ language: e.target.value })} aria-label={t('settings.uiLanguage')}>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </Select>
      </Row>
      <Row
        label={t('settings.numberFormat')}
        hint={t('settings.example', { value: `${formatMoney(-123456, settings.currency, prefs.formatLocale)} · ${new Intl.DateTimeFormat(prefs.formatLocale).format(new Date())}` })}
      >
        <Select className="w-44" value={prefs.formatLocale} onChange={(e) => void updatePrefs({ formatLocale: e.target.value })} aria-label={t('settings.numberFormat')}>
          {FORMAT_LOCALES.map((l) => <option key={l} value={l}>{new Intl.DisplayNames([prefs.language], { type: 'language' }).of(l) ?? l}</option>)}
        </Select>
      </Row>
    </Card>
  )
}
