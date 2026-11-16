import { ArrowDownToLine, Bot, Check, Coins, FileUp, FolderInput, FolderSync, Lock, Monitor, Moon, PiggyBank, Plug, ShieldCheck, Sparkles, Sun, Terminal } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from '@shared/ai-providers'
import type { LanguageCode } from '@shared/languages'
import type { BackupStatus, McpSetupStatus, Settings, SyncStatus } from '@shared/types'
import { useAssistant } from '../components/AssistantPanel'
import { DesktopRunningWarning, SeenLine, useClaudeClients, useDesktopRunning } from '../components/ClaudeApps'
import { CurrencySelect } from '../components/CurrencySelect'
import { useToast } from '../components/Toast'
import { startTour } from '../components/Tour'
import { Badge, Button, Field, Input, Segmented, Select, Switch, cx } from '../components/ui'
import { LANGUAGES } from '../i18n'
import { ApiError, call } from '../lib/api'
import { FORMAT_PRESETS, formatDate as fmtDate, formatMoney as fmtMoney, formatTime as fmtTime, matchingPreset, type FormatPrefs } from '@shared/format'
import { usePrefs } from '../lib/settings'
import { AuthCard, AuthLayout } from './auth/AuthLayout'
import { errText } from './auth/parts'

const STEPS = ['intro', 'basics', 'safety', 'assistant', 'claude', 'updates'] as const
type Step = (typeof STEPS)[number]

/** Claude Desktop and Claude Code: the connection switch and the one-click setup, as in Settings. */
function ClaudeApps({ enabled, onEnabled }: { enabled: boolean; onEnabled: (v: boolean) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [st, setSt] = useState<McpSetupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const reload = (): void => void call('mcp.setupStatus').then(setSt, () => setSt(null))
  useEffect(reload, [enabled])
  const act = (p: Promise<unknown>, done: string): void => {
    setBusy(true)
    p.then(() => toast(done), (e) => toast(errText(e), 'error')).finally(() => {
      setBusy(false)
      reload()
    })
  }
  const state = (s: 'absent' | 'current' | 'outdated'): ReactNode => <Badge tone={s === 'current' ? 'accent' : s === 'outdated' ? 'warning' : 'neutral'}>{t(`mcp.state.${s}`)}</Badge>
  const seen = useClaudeClients()
  // Claude Desktop rewrites its settings when it quits: add only while it is closed.
  const desktopOpen = useDesktopRunning(enabled && !!st?.desktop && st.desktop.state !== 'current')
  const addDesktop = (): void => act(call('mcp.desktopAdd'), t('mcp.addedDesktop'))
  return (
    <div className="flex flex-col gap-2.5">
      <Choice icon={<Plug size={16} />} title={t('mcp.title')} hint={t('mcp.hint')}>
        <Switch label={t('mcp.title')} checked={enabled} onChange={onEnabled} />
      </Choice>
      {enabled && st && (
        <>
          {!st.helperFound && <p className="text-xs text-warning">{t('mcp.helperMissing')}</p>}
          <Choice icon={<Monitor size={16} />} title={t('mcp.desktopLabel')} hint={st.desktop ? (st.desktop.state !== 'absent' || !!seen?.desktop) && <SeenLine at={seen?.desktop ?? seen?.other} /> : t('mcp.desktopUnavailable')}>
            {st.desktop && (
              <span className="flex items-center gap-2">
                {state(st.desktop.state)}
                {st.desktop.state !== 'current' && (
                  <Button size="sm" variant="primary" disabled={busy || desktopOpen} onClick={addDesktop}>
                    {st.desktop.state === 'outdated' ? t('mcp.update') : t('mcp.addDesktop')}
                  </Button>
                )}
              </span>
            )}
          </Choice>
          {desktopOpen && <DesktopRunningWarning onAnyway={addDesktop} busy={busy} />}
          <Choice icon={<Terminal size={16} />} title={t('mcp.codeLabel')} hint={st.code ? (st.code.state !== 'absent' || !!seen?.code) && <SeenLine at={seen?.code} /> : t('welcome.codeNotFound')}>
            {st.code && (
              <span className="flex items-center gap-2">
                {state(st.code.state)}
                {st.code.state !== 'current' && (
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => act(call('mcp.codeAdd'), t('mcp.codeAdded'))}>
                    {st.code.state === 'outdated' ? t('mcp.update') : t('mcp.addCode')}
                  </Button>
                )}
              </span>
            )}
          </Choice>
          <p className="text-xs text-muted">{t('welcome.claudeNote')}</p>
        </>
      )}
    </div>
  )
}

/** One setting in the welcome window: an icon, a title and hint, and its control. */
function Choice({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
      <span className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">{icon}</span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{title}</span>
          {hint && <span className="block text-[13px] break-words text-muted">{hint}</span>}
        </span>
      </span>
      {children && <span className="shrink-0">{children}</span>}
    </div>
  )
}

/**
 * Shown once per computer, after creating or opening the data: an introduction, the basics
 * (language, look, currency), safety (backups, auto-lock), the assistant's AI and the update check,
 * and then, if wanted, a tour of the app.
 */
export function Welcome() {
  const { t } = useTranslation()
  const toast = useToast()
  const { prefs, updatePrefs } = usePrefs()
  const assistant = useAssistant()
  const [step, setStep] = useState<Step>('intro')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [backup, setBackup] = useState<BackupStatus | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [updates, setUpdates] = useState(prefs.updateCheck)
  const [ecb, setEcb] = useState(true)
  useEffect(() => {
    void call('settings.get').then(setSettings)
    void call('backup.status').then(setBackup)
    void call('sync.status').then(setSync)
  }, [])
  const provider: ProviderId = settings?.aiProvider ?? 'anthropic'
  const preset = PROVIDERS[provider]
  const hasKey = !!assistant?.keyHint && assistant.provider === provider
  const at = STEPS.indexOf(step)
  const go = (s: Step): void => setStep(s)
  const fail = (e: unknown): void => toast(errText(e), 'error')

  const chooseProvider = (id: ProviderId): void => {
    setKey('')
    void call('assistant.configure', { aiProvider: id }).then(setSettings, fail)
  }
  const saveKey = (): void => {
    if (!key.trim()) return go('claude')
    setBusy(true)
    void call('assistant.setKey', { apiKey: key.trim(), provider })
      .then(() => {
        setKey('')
        go('claude')
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }
  const toggleBackups = async (enabled: boolean): Promise<void> => {
    try {
      if (enabled && !backup?.folder && !(await call('backup.chooseFolder')).folder) return
      await call('backup.configureAuto', { enabled })
      setBackup(await call('backup.status'))
    } catch (e) {
      fail(e)
    }
  }
  const startSync = (): void => {
    void call('sync.start').then(setSync, (e) => (e instanceof ApiError && e.code === 'sync.cancelled' ? undefined : fail(e)))
  }
  const finish = (tour: boolean): void => {
    void updatePrefs({ updateCheck: updates, welcomeDone: true }).then(() => {
      if (updates) void call('update.check')
      // The ECB's reference rates: downloaded once now, then kept up to date. Only the rates are fetched.
      if (ecb) void call('settings.update', { fxAutoUpdate: true }).then(() => call('fx.updateEcb')).catch(() => undefined)
      if (tour) startTour()
    })
  }

  const dots = (
    <div className="mb-4 flex justify-center gap-1.5" aria-label={t('tour.progress', { n: at + 1, total: STEPS.length })}>
      {STEPS.map((s, i) => <span key={s} className={cx('h-1.5 w-6 rounded-full', i <= at ? 'bg-accent' : 'bg-border')} />)}
    </div>
  )
  const nav = (back: Step | null, next: ReactNode) => (
    <div className="mt-5 flex items-center justify-between gap-2">
      {back ? <button type="button" className="text-[13px] text-muted hover:text-text" onClick={() => go(back)}>{t('auth.back')}</button> : <span />}
      {next}
    </div>
  )

  return (
    <AuthLayout wide>
      {dots}
      {step === 'intro' && (
        <AuthCard title={t('welcome.introTitle')} body={t('welcome.introBody')}>
          <div className="flex flex-col gap-2.5">
            <Choice icon={<ShieldCheck size={16} />} title={t('welcome.introPrivate')} hint={t('welcome.introPrivateHint')} />
            <Choice icon={<FileUp size={16} />} title={t('welcome.introImport')} hint={t('welcome.introImportHint')} />
            <Choice icon={<PiggyBank size={16} />} title={t('welcome.introPlan')} hint={t('welcome.introPlanHint')} />
            <Choice icon={<Bot size={16} />} title={t('welcome.introAssistant')} hint={t('welcome.introAssistantHint')} />
          </div>
          {nav(null, <Button variant="primary" onClick={() => go('basics')}>{t('welcome.start')}</Button>)}
        </AuthCard>
      )}

      {step === 'basics' && (
        <AuthCard title={t('welcome.basicsTitle')} body={t('welcome.basicsBody')}>
          <div className="flex flex-col gap-4">
            <Field label={t('settings.uiLanguage')}>
              {(id) => (
                <Select id={id} value={prefs.language} onChange={(e) => void updatePrefs({ language: e.target.value as LanguageCode })}>
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('settings.theme')}>
              {() => (
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
              )}
            </Field>
            <Field label={t('fx.main')} hint={t('fx.mainHint')}>
              {(id) => <CurrencySelect id={id} value={settings?.currency ?? 'EUR'} onChange={(e) => void call('settings.update', { currency: e.target.value }).then(setSettings, fail)} />}
            </Field>
            <Field label={t('welcome.formatLabel')} hint={t('welcome.formatHint')}>
              {(id) => {
                const cur = settings?.currency ?? 'EUR'
                const sample = (f: FormatPrefs): string => `${fmtMoney(-123456, cur, f)} · ${fmtDate('2026-12-31', f, prefs.language)} · ${fmtTime('2026-12-31T14:30:00', f)}`
                const chosen = matchingPreset(prefs.formats)
                return (
                  <Select id={id} value={chosen ?? 'custom'} onChange={(e) => { const p = FORMAT_PRESETS.find((x) => x.id === e.target.value); if (p) void updatePrefs({ formats: p.formats }) }}>
                    {!chosen && <option value="custom">{sample(prefs.formats)}</option>}
                    {FORMAT_PRESETS.map((p) => <option key={p.id} value={p.id}>{sample(p.formats)}</option>)}
                  </Select>
                )
              }}
            </Field>
            <Choice icon={<Coins size={16} />} title={t('welcome.ecb')} hint={t('welcome.ecbHint')}>
              <Switch label={t('welcome.ecb')} checked={ecb} onChange={setEcb} />
            </Choice>
          </div>
          {nav('intro', <Button variant="primary" onClick={() => go('safety')}>{t('welcome.next')}</Button>)}
        </AuthCard>
      )}

      {step === 'safety' && (
        <AuthCard title={t('welcome.safetyTitle')} body={t('welcome.safetyBody')}>
          <div className="flex flex-col gap-2.5">
            <Choice icon={<FolderInput size={16} />} title={t('settings.auto')} hint={backup?.autoEnabled && backup.folder ? <span className="selectable">{backup.folder}</span> : t('settings.autoHint')}>
              <Switch label={t('settings.auto')} checked={!!backup?.autoEnabled} onChange={(v) => void toggleBackups(v)} />
            </Choice>
            <Choice icon={<FolderSync size={16} />} title={t('sync.title')} hint={sync?.state === 'on' && sync.folder ? <span className="selectable">{sync.folder}</span> : t('welcome.syncHint')}>
              {sync?.state === 'on' ? (
                <span className="inline-flex items-center gap-1 text-[13px] font-medium text-accent"><Check size={14} />{t('welcome.syncOn')}</span>
              ) : (
                <Button size="sm" onClick={startSync}>{t('sync.startButton')}</Button>
              )}
            </Choice>
            <Choice icon={<Lock size={16} />} title={t('settings.autoLock')} hint={t('settings.autoLockHint')}>
              <Select className="w-40" aria-label={t('settings.autoLock')} value={prefs.autoLockMinutes} onChange={(e) => void updatePrefs({ autoLockMinutes: Number(e.target.value) })}>
                {[1, 5, 10, 15, 30, 60, 0].map((m) => <option key={m} value={m}>{m === 0 ? t('settings.never') : t('settings.minutes', { count: m })}</option>)}
              </Select>
            </Choice>
            <p className="text-xs text-muted">{t('welcome.safetyRecovery')}</p>
          </div>
          {nav('basics', <Button variant="primary" onClick={() => go('assistant')}>{t('welcome.next')}</Button>)}
        </AuthCard>
      )}

      {step === 'assistant' && (
        <AuthCard title={t('welcome.aiTitle')} body={t('welcome.aiBody')}>
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); saveKey() }}>
            <Field label={t('welcome.provider')}>
              {(id) => (
                <Select id={id} value={provider} onChange={(e) => chooseProvider(e.target.value as ProviderId)}>
                  {PROVIDER_IDS.filter((p) => p !== 'custom').map((p) => <option key={p} value={p}>{PROVIDERS[p].name}</option>)}
                </Select>
              )}
            </Field>
            {preset.needsKey ? (
              hasKey ? (
                <p className="flex items-center gap-1.5 text-[13px] text-accent"><Check size={14} />{t('welcome.keySaved', { hint: assistant?.keyHint })}</p>
              ) : (
                <Field label={t('claude.apiKey')} hint={preset.keyUrl ? <a className="font-medium text-accent hover:underline" href={preset.keyUrl} target="_blank" rel="noreferrer">{t('ai.getKey', { name: preset.name })}</a> : undefined}>
                  {(id) => <Input id={id} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={preset.keyPlaceholder ?? ''} autoComplete="off" />}
                </Field>
              )
            ) : (
              <p className="text-[13px] text-muted">{t('welcome.local', { name: preset.name })}</p>
            )}
            <p className="flex items-start gap-1.5 text-xs text-muted">
              <Sparkles size={13} className="mt-0.5 shrink-0 text-accent" />
              {preset.company ? t('welcome.privacy', { name: preset.name, company: preset.company }) : t('welcome.privacyLocal')}
            </p>
            <div className="flex items-center justify-between gap-2">
              <button type="button" className="text-[13px] text-muted hover:text-text" onClick={() => go('safety')}>{t('auth.back')}</button>
              <div className="flex items-center gap-3">
                <button type="button" className="text-[13px] text-muted hover:text-text" onClick={() => go('claude')}>{t('welcome.skip')}</button>
                <Button type="submit" variant="primary" disabled={busy}>{busy ? t('claude.checking') : t('welcome.next')}</Button>
              </div>
            </div>
          </form>
        </AuthCard>
      )}

      {step === 'claude' && (
        <AuthCard title={t('welcome.claudeTitle')} body={t('welcome.claudeBody')}>
          <ClaudeApps enabled={!!settings?.mcpEnabled} onEnabled={(mcpEnabled) => void call('assistant.configure', { mcpEnabled }).then(setSettings, fail)} />
          {nav('assistant', <Button variant="primary" onClick={() => go('updates')}>{t('welcome.next')}</Button>)}
        </AuthCard>
      )}

      {step === 'updates' && (
        <AuthCard title={t('welcome.updatesTitle')} body={t('welcome.updatesBody')}>
          <div className="flex flex-col gap-4">
            <Choice icon={<ArrowDownToLine size={16} />} title={t('welcome.updatesSwitch')} hint={t('welcome.updatesHint')}>
              <Switch label={t('welcome.updatesSwitch')} checked={updates} onChange={setUpdates} />
            </Choice>
            <p className="text-xs text-muted">{t('welcome.updatesPrivacy')}</p>
          </div>
          {nav(
            'claude',
            <div className="flex items-center gap-3">
              <button type="button" className="text-[13px] text-muted hover:text-text" onClick={() => finish(false)}>{t('welcome.noTour')}</button>
              <Button variant="primary" onClick={() => finish(true)}>{t('welcome.tour')}</Button>
            </div>
          )}
        </AuthCard>
      )}
    </AuthLayout>
  )
}
