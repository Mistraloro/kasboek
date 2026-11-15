import { ArrowDownToLine, Check, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from '@shared/ai-providers'
import type { Settings } from '@shared/types'
import { useAssistant } from '../components/AssistantPanel'
import { useToast } from '../components/Toast'
import { Button, Field, Input, Select, Switch, cx } from '../components/ui'
import { call } from '../lib/api'
import { usePrefs } from '../lib/settings'
import { AuthCard, AuthLayout } from './auth/AuthLayout'
import { errText } from './auth/parts'

type Step = 'assistant' | 'updates'

/**
 * Shown once per computer, after creating or opening the data: which AI the assistant uses (or
 * none yet), and whether Kasboek looks for updates (on unless switched off here).
 */
export function Welcome() {
  const { t } = useTranslation()
  const toast = useToast()
  const { prefs, updatePrefs } = usePrefs()
  const assistant = useAssistant()
  const [step, setStep] = useState<Step>('assistant')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [updates, setUpdates] = useState(prefs.updateCheck)
  useEffect(() => void call('settings.get').then(setSettings), [])
  const provider: ProviderId = settings?.aiProvider ?? 'anthropic'
  const preset = PROVIDERS[provider]
  const hasKey = !!assistant?.keyHint && assistant.provider === provider

  const choose = (id: ProviderId): void => {
    setKey('')
    void call('assistant.configure', { aiProvider: id }).then(setSettings, (e) => toast(errText(e), 'error'))
  }
  const next = (): void => {
    if (!key.trim()) return setStep('updates')
    setBusy(true)
    void call('assistant.setKey', { apiKey: key.trim(), provider })
      .then(() => {
        setKey('')
        setStep('updates')
      })
      .catch((e) => toast(errText(e), 'error'))
      .finally(() => setBusy(false))
  }
  const finish = (): void => {
    void updatePrefs({ updateCheck: updates, welcomeDone: true }).then(() => {
      if (updates) void call('update.check')
    })
  }

  const dots = (
    <div className="mb-4 flex justify-center gap-1.5" aria-hidden>
      {(['assistant', 'updates'] as Step[]).map((s) => <span key={s} className={cx('h-1.5 w-6 rounded-full', s === step ? 'bg-accent' : 'bg-border')} />)}
    </div>
  )

  return (
    <AuthLayout wide>
      {dots}
      {step === 'assistant' ? (
        <AuthCard title={t('welcome.aiTitle')} body={t('welcome.aiBody')}>
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); next() }}>
            <Field label={t('welcome.provider')}>
              {(id) => (
                <Select id={id} value={provider} onChange={(e) => choose(e.target.value as ProviderId)}>
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
              <button type="button" className="text-[13px] text-muted hover:text-text" onClick={() => setStep('updates')}>{t('welcome.skip')}</button>
              <Button type="submit" variant="primary" disabled={busy}>{busy ? t('claude.checking') : t('welcome.next')}</Button>
            </div>
          </form>
        </AuthCard>
      ) : (
        <AuthCard title={t('welcome.updatesTitle')} body={t('welcome.updatesBody')}>
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
              <span className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><ArrowDownToLine size={16} /></span>
                <span>
                  <span className="block text-sm font-semibold">{t('welcome.updatesSwitch')}</span>
                  <span className="block text-[13px] text-muted">{t('welcome.updatesHint')}</span>
                </span>
              </span>
              <Switch label={t('welcome.updatesSwitch')} checked={updates} onChange={setUpdates} />
            </div>
            <p className="text-xs text-muted">{t('welcome.updatesPrivacy')}</p>
            <div className="flex items-center justify-between gap-2">
              <button type="button" className="text-[13px] text-muted hover:text-text" onClick={() => setStep('assistant')}>{t('auth.back')}</button>
              <Button variant="primary" onClick={finish}>{t('welcome.finish')}</Button>
            </div>
          </div>
        </AuthCard>
      )}
    </AuthLayout>
  )
}
