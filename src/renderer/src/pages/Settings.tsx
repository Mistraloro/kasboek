import { Download, FolderOpen, Monitor, Moon, Plus, ShieldAlert, ShieldCheck, Sun, Upload } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AccountWithBalance, PickedTransfer } from '@shared/types'
import { Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, Segmented, Select, Switch } from '../components/ui'
import { useToast } from '../components/Toast'
import { LANGUAGES } from '../i18n'
import { ApiError, call, useOp } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatDate, formatDateTime, formatMoney, formatNumber, type Fmt } from '../lib/format'
import { CURRENCY_POSITIONS, CURRENCY_STYLES, DATE_PATTERNS, DECIMAL_SEPARATORS, GROUP_SEPARATORS, GROUPINGS, NEGATIVE_STYLES, TIME_FORMATS, formatTime, type CurrencyPosition, type CurrencyStyle, type DatePattern, type DecimalSeparator, type FormatPrefs, type GroupSeparator, type Grouping, type NegativeStyle, type TimeFormat } from '@shared/format'
import { useSettings } from '../lib/settings'
import { ImportFlow } from './auth/ImportFlow'
import { CurrencySelect } from '../components/CurrencySelect'
import { ClaudeSection } from './SettingsClaude'
import { CodeInput, DeviceIcon, errText, PasswordFields, passwordsOk, RecoveryKeyPanel, TotpSetup, useDeviceName } from './auth/parts'

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
        <CurrenciesSection />
        <AppearanceSection />
        <FormatsSection />
      </div>
    </>
  )
}

/* ---------- Security ---------- */

type SecurityModal = null | 'password' | 'passwordless' | 'totp-on' | 'totp-off' | 'recovery'

function SecuritySection() {
  const { fmt } = useSettings()
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
      <Row
        label={t('settings.twoFactor')}
        hint={status.rememberedUntil ? t('settings.rememberedHint', { date: formatDate(status.rememberedUntil, fmt) }) : t('settings.twoFactorHint')}
      >
        {status.rememberedUntil && (
          <Button size="sm" variant="ghost" onClick={() => void call('auth.forgetComputer').then((s2) => { set(s2); toast(t('settings.forgotten')) }, (e) => toast(errText(e), 'error'))}>
            {t('settings.forgetComputer')}
          </Button>
        )}
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
  const { fmt } = useSettings()
  const { set } = useAuth()
  const status = useOp('backup.status')
  const list = useOp('backup.list')
  const [showAll, setShowAll] = useState(false)
  const [restoring, setRestoring] = useState<PickedTransfer | null>(null)
  const s = status.data
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error')
    } finally {
      void status.reload()
      void list.reload()
    }
  }
  useEffect(() => window.kasboek.onEvent((e) => { if (e.type === 'backup.completed') { void list.reload(); void status.reload() } }), []) // eslint-disable-line react-hooks/exhaustive-deps
  const backups = list.data ?? []
  const shown = showAll ? backups : backups.slice(0, 6)
  const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`
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
      <Row label={t('settings.whenBackup')} hint={t('settings.whenBackupHint')}>
        <Button size="sm" disabled={!s?.folder} onClick={() => void run(async () => toast(t('settings.backupSaved', { file: (await call('backup.runNow')).file })))}>
          {t('settings.backupNow')}
        </Button>
      </Row>
      {backups.length > 0 && (
        <div className="border-t border-border">
          {shown.map((b) => (
            <div key={b.name} className="flex items-center gap-3 border-b border-border px-5 py-2.5 text-[13px] last:border-b-0">
              <span className="num flex-1">{formatDateTime(b.createdAt, fmt)}</span>
              <Badge tone={b.tier === 'recent' ? 'accent' : 'neutral'}>{t(`settings.tier.${b.tier}`)}</Badge>
              <span className="num w-16 text-right text-muted">{kb(b.size)}</span>
              <Button size="sm" variant="ghost" onClick={() => void run(async () => setRestoring(await call('backup.pick', { name: b.name })))}>{t('settings.restoreThis')}</Button>
            </div>
          ))}
          {backups.length > 6 && (
            <button type="button" className="w-full px-5 py-2.5 text-left text-[13px] font-medium text-accent hover:underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? t('settings.showFewer') : t('settings.showAllBackups', { count: backups.length })}
            </button>
          )}
        </div>
      )}
      <Modal open={!!restoring} title={t('settings.restoreTitle')} onClose={() => setRestoring(null)}>
        {restoring && <ImportFlow replacing preset={restoring} onCancel={() => setRestoring(null)} onDone={(st) => { setRestoring(null); set(st); window.location.reload() }} />}
      </Modal>
    </Card>
  )
}

/* ---------- Currencies ---------- */

function CurrenciesSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const { settings, update, fmt } = useSettings()
  const status = useOp('fx.status')
  const manual = useOp('fx.rates', {})
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const today = new Date().toISOString().slice(0, 10)
  const [rate, setRate] = useState({ currency: 'USD', date: today, perEur: '' })
  const reload = (): void => {
    void status.reload()
    void manual.reload()
  }
  useEffect(() => window.kasboek.onEvent((e) => e.type === 'data.changed' && reload()), []) // eslint-disable-line react-hooks/exhaustive-deps
  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await call('fx.updateEcb', {})
      toast(t('fx.downloaded', { count: r.added }))
      reload()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const saveRate = async (): Promise<void> => {
    const perEur = Number(rate.perEur.replace(',', '.'))
    try {
      await call('fx.setRate', { currency: rate.currency, date: rate.date, perEur })
      toast(t('fx.rateSaved'))
      setAdding(false)
      reload()
    } catch (e) {
      toast(errText(e), 'error')
    }
  }
  const s = status.data
  const rateText = (cur: string, perEur: number): string => `1 EUR = ${formatNumber(perEur, fmt, perEur >= 100 ? 2 : 4)} ${cur}`
  return (
    <Card>
      <CardHeader title={t('fx.title')} description={t('fx.hint')} />
      <Row label={t('fx.main')} hint={t('fx.mainHint')}>
        <CurrencySelect className="w-64!" value={settings.currency} onChange={(e) => void update({ currency: e.target.value }).then(reload)} aria-label={t('fx.main')} />
      </Row>
      {s?.currencies.map((c) => (
        <Row
          key={c.currency}
          label={c.currency}
          hint={
            c.latest
              ? `${rateText(c.currency, c.latest.perEur)} · ${formatDate(c.latest.date, fmt)} · ${t(c.latest.source === 'ecb' ? 'fx.sourceEcb' : 'fx.sourceManual')}${c.coversOldest ? '' : ' · ' + t('fx.olderThanRates')}`
              : t('fx.noRate')
          }
        >
          {c.latest ? <Badge tone="accent">{t('fx.converted')}</Badge> : <Badge tone="warning">{t('fx.notConverted')}</Badge>}
        </Row>
      ))}
      <Row label={t('fx.ecb')} hint={s?.lastEcbUpdateAt ? t('fx.ecbLast', { date: formatDateTime(s.lastEcbUpdateAt, fmt) }) : t('fx.ecbHint')}>
        <Button size="sm" icon={<Download size={14} />} disabled={busy} onClick={() => void download()}>{busy ? t('fx.downloading') : t('fx.download')}</Button>
      </Row>
      <Row label={t('fx.auto')} hint={t('fx.autoHint')}>
        <Switch checked={settings.fxAutoUpdate} onChange={(v) => void update({ fxAutoUpdate: v })} label={t('fx.auto')} />
      </Row>
      <Row label={t('fx.manual')} hint={t('fx.manualHint')}>
        <Button size="sm" icon={<Plus size={14} />} onClick={() => { setRate({ currency: s?.currencies[0]?.currency ?? 'USD', date: today, perEur: '' }); setAdding(true) }}>{t('fx.addRate')}</Button>
      </Row>
      {(manual.data ?? []).map((r) => (
        <Row key={`${r.currency}-${r.date}`} label={<span className="num text-[13px]">{rateText(r.currency, r.perEur)}</span>} hint={formatDate(r.date, fmt)}>
          <Button size="sm" variant="ghost" onClick={() => void call('fx.deleteRate', { currency: r.currency, date: r.date }).then(reload)}>{t('fx.remove')}</Button>
        </Row>
      ))}
      <Modal open={adding} title={t('fx.addRate')} onClose={() => setAdding(false)}>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void saveRate() }}>
          <Field label={t('fx.currency')}>{(id) => <CurrencySelect id={id} value={rate.currency} onChange={(e) => setRate({ ...rate, currency: e.target.value })} />}</Field>
          <Field label={t('fx.date')} hint={t('fx.dateHint')}>{(id) => <Input id={id} type="date" value={rate.date} onChange={(e) => setRate({ ...rate, date: e.target.value })} required />}</Field>
          <Field label={t('fx.perEur', { currency: rate.currency })}>{(id) => <Input id={id} inputMode="decimal" value={rate.perEur} onChange={(e) => setRate({ ...rate, perEur: e.target.value })} placeholder="1.0800" className="num" required />}</Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAdding(false)}>{t('settings.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!(Number(rate.perEur.replace(',', '.')) > 0) || rate.currency === 'EUR'}>{t('settings.save')}</Button>
          </div>
        </form>
      </Modal>
    </Card>
  )
}

/* ---------- Accounts ---------- */

function AccountsSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const accounts = useOp('accounts.list')
  const [editing, setEditing] = useState<AccountWithBalance | 'new' | null>(null)
  const { settings } = useSettings()
  const [form, setForm] = useState({ name: '', bank: '', iban: '', currency: 'EUR' })
  const open = (a: AccountWithBalance | 'new'): void => {
    setForm(a === 'new' ? { name: '', bank: '', iban: '', currency: settings.currency } : { name: a.name, bank: a.bank, iban: a.iban ?? '', currency: a.currency })
    setEditing(a)
  }
  const save = async (): Promise<void> => {
    try {
      if (editing === 'new') await call('accounts.create', { name: form.name, bank: form.bank, iban: form.iban || null, currency: form.currency })
      else if (editing) await call('accounts.update', { id: editing.id, name: form.name, bank: form.bank, iban: form.iban || null, currency: form.currency })
      toast(editing === 'new' ? t('settings.accountAdded') : t('settings.accountSaved'))
      setEditing(null)
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
        action={<Button size="sm" icon={<Plus size={14} />} onClick={() => open('new')}>{t('settings.addAccount')}</Button>}
      />
      {(accounts.data ?? []).map((a) => (
        <Row
          key={a.id}
          label={<span className={a.archived ? 'text-muted line-through' : undefined}>{a.name}</span>}
          hint={[a.bank, a.iban ? a.iban.replace(/(.{4})/g, '$1 ').trim() : '', a.currency !== settings.currency ? a.currency : ''].filter(Boolean).join(' · ') || undefined}
        >
          <Button size="sm" variant="ghost" onClick={() => open(a)}>{t('settings.edit')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void call('accounts.update', { id: a.id, archived: !a.archived }).then(() => accounts.reload())}>
            {a.archived ? t('budgets.restore') : t('budgets.archive')}
          </Button>
        </Row>
      ))}
      {accounts.data?.length === 0 && <p className="px-5 py-4 text-[13px] text-muted">{t('settings.noAccounts')}</p>}
      <Modal open={!!editing} title={editing === 'new' ? t('settings.addAccount') : t('settings.editAccount')} onClose={() => setEditing(null)}>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <Field label={t('settings.accountName')}>{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('settings.accountNamePlaceholder')} autoFocus required />}</Field>
          <Field label={t('settings.bankName')} hint={t('settings.bankNameHint')}>{(id) => <Input id={id} value={form.bank} maxLength={60} onChange={(e) => setForm({ ...form, bank: e.target.value })} />}</Field>
          <Field label={t('settings.accountCurrency')} hint={editing !== 'new' && editing && editing.transactionCount > 0 && form.currency !== editing.currency ? t('settings.accountCurrencyChange', { from: editing.currency, to: form.currency }) : undefined}>
            {(id) => <CurrencySelect id={id} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />}
          </Field>
          <Field label={t('settings.iban')} hint={t('settings.ibanOptional')}>{(id) => <Input id={id} value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} placeholder="BE68 5390 0754 7034" className="num" />}</Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditing(null)}>{t('settings.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!form.name.trim()}>{t('settings.save')}</Button>
          </div>
        </form>
      </Modal>
    </Card>
  )
}

/* ---------- Formats ---------- */

function FormatsSection() {
  const { t } = useTranslation()
  const { prefs, updatePrefs, settings, fmt } = useSettings()
  const f = prefs.formats
  const set = (patch: Partial<FormatPrefs>): void => void updatePrefs({ formats: patch })
  const with_ = (patch: Partial<FormatPrefs>): Fmt => ({ ...fmt, formats: { ...f, ...patch } })
  const sample = new Date(2026, 0, 31, 14, 30)
  const cur = settings.currency
  const row = (label: string, value: string, options: { value: string; label: string; disabled?: boolean }[], onChange: (v: string) => void) => (
    <Row label={label}>
      <Select className="w-64!" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </Select>
    </Row>
  )
  return (
    <Card>
      <CardHeader
        title={t('settings.formats')}
        description={t('settings.formatsHint', { value: `${formatMoney(-123456789, cur, fmt)} · ${formatDateTime(sample, fmt)}` })}
      />
      {row(t('settings.decimalSeparator'), f.decimal, DECIMAL_SEPARATORS.map((d) => ({ value: d, label: `${t(`settings.sep.${sepKey(d)}`)}  (${formatNumber(1234.5, with_({ decimal: d, group: d === f.group ? (d === ',' ? '.' : ',') : f.group }))})` })), (v) => {
        const decimal = v as DecimalSeparator
        set(decimal === f.group ? { decimal, group: decimal === ',' ? '.' : ',' } : { decimal })
      })}
      {row(t('settings.groupSeparator'), f.group, GROUP_SEPARATORS.map((g) => ({ value: g, disabled: g === f.decimal, label: `${t(`settings.sep.${sepKey(g)}`)}  (${formatNumber(1234567, with_({ group: g }), 0)})` })), (v) => set({ group: v as GroupSeparator }))}
      {row(t('settings.grouping'), f.grouping, GROUPINGS.map((g) => ({ value: g, label: `${t(`settings.groupingOption.${g}`)}  (${formatNumber(12345678, with_({ grouping: g }), 0)})` })), (v) => set({ grouping: v as Grouping }))}
      {row(t('settings.currencyPosition'), f.currencyPosition, CURRENCY_POSITIONS.map((p) => ({ value: p, label: formatMoney(123450, cur, with_({ currencyPosition: p })) })), (v) => set({ currencyPosition: v as CurrencyPosition }))}
      {row(t('settings.currencyStyle'), f.currencyStyle, CURRENCY_STYLES.map((s) => ({ value: s, label: `${t(`settings.currencyStyleOption.${s}`)}  (${formatMoney(123450, cur, with_({ currencyStyle: s }))})` })), (v) => set({ currencyStyle: v as CurrencyStyle }))}
      {row(t('settings.negative'), f.negative, NEGATIVE_STYLES.map((n) => ({ value: n, label: formatMoney(-123450, cur, with_({ negative: n })) })), (v) => set({ negative: v as NegativeStyle }))}
      {row(t('settings.dateFormat'), f.date, DATE_PATTERNS.map((p) => ({ value: p, label: `${formatDate(sample, with_({ date: p }))}  (${p})` })), (v) => set({ date: v as DatePattern }))}
      {row(t('settings.timeFormat'), f.time, TIME_FORMATS.map((tf) => ({ value: tf, label: `${t(`settings.timeOption.${tf}`)}  (${formatTime(sample, { ...f, time: tf })})` })), (v) => set({ time: v as TimeFormat }))}
    </Card>
  )
}

function sepKey(s: string): string {
  return { '.': 'dot', ',': 'comma', ' ': 'space', "'": 'apostrophe', '': 'none' }[s] ?? 'none'
}

/* ---------- Appearance ---------- */

function AppearanceSection() {
  const { t } = useTranslation()
  const { prefs, updatePrefs } = useSettings()
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
    </Card>
  )
}
