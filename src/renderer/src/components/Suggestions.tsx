import { AlertTriangle, ChevronDown, ChevronUp, Info, Lightbulb, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { monthOf } from '@shared/month'
import { actionOf, bodyKey, renderInsightText, severityOf, textVars, titleKey, type InsightSeverity } from '@shared/insights'
import type { InsightFact, InsightSuggestion, InsightsPreview, InsightsView } from '@shared/types'
import type { Page } from '../App'
import { ApiError, call } from '../lib/api'
import { formatDate, monthLabel } from '../lib/format'
import { useSettings } from '../lib/settings'
import { openSettingsTab } from '../lib/settings-tab'
import { errText } from '../pages/auth/parts'
import { useAssistant } from './AssistantPanel'
import { Button, Card, CardHeader, Modal } from './ui'

const SHOWN = 3
/** After a data change the tips are worked out again once nothing changed for this long. */
const RELOAD_DELAY_MS = 500
const COLLAPSED_KEY = 'kasboek.suggestions.collapsed'

const readCollapsed = (): boolean => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}
const writeCollapsed = (collapsed: boolean): void => {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // Not remembered: the card is expanded again next time.
  }
}

const ICONS: Record<InsightSeverity, ReactNode> = {
  warning: <AlertTriangle size={16} className="text-warning" />,
  tip: <Lightbulb size={16} className="text-accent" />,
  info: <Info size={16} className="text-muted" />
}

interface Tip {
  key: string
  severity: InsightSeverity
  title: string
  body: string
  fact: InsightFact
  /** The keys that are hidden together with this tip. */
  keys: string[]
}

/** Tips found locally from the month's data, and the ones the assistant wrote from them when asked; loaded only while the card is open. */
export function Suggestions({ month, monthText, go }: { month: string; monthText: string; go: (p: Page, params?: Record<string, unknown>) => void }) {
  const { t } = useTranslation()
  const { fmt, money } = useSettings()
  const assistant = useAssistant()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [view, setView] = useState<InsightsView | null>(null)
  const [failed, setFailed] = useState(false)
  const [all, setAll] = useState(false)
  // The run in progress in the main process, which goes on when this card is left or the month changes.
  const [run, setRun] = useState<{ running: boolean; month: string | null; startedAt: string | null } | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [consent, setConsent] = useState(false)
  const latest = useRef(0)
  const latestStatus = useRef(0)
  const monthRef = useRef(month)
  monthRef.current = month

  const load = useCallback(() => {
    const run = ++latest.current
    setFailed(false)
    call('insights.get', { month })
      .then((v) => run === latest.current && setView(v))
      .catch(() => run === latest.current && setFailed(true))
  }, [month])

  const refreshStatus = useCallback(() => {
    const asked = ++latestStatus.current
    call('insights.status')
      .then((st) => asked === latestStatus.current && setRun(st))
      .catch(() => undefined)
  }, [])
  // When the card shows, the month changes or the window comes back: a run may have started or ended meanwhile.
  useEffect(() => {
    refreshStatus()
    window.addEventListener('focus', refreshStatus)
    return () => window.removeEventListener('focus', refreshStatus)
  }, [refreshStatus, month])

  // After the first paint, and only while open: the facts take a moment to work out.
  useEffect(() => {
    if (collapsed) return
    setView(null)
    setAiError(null)
    load()
  }, [collapsed, load])
  // Data changes come in bursts (an import, a sync): wait for a quiet moment before working the tips out again.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.kasboek.onEvent((e) => {
      if (e.type === 'insights.updated') refreshStatus()
      if (collapsed) return
      if (e.type === 'data.changed') {
        clearTimeout(timer)
        timer = setTimeout(load, RELOAD_DELAY_MS)
      } else if (e.type === 'insights.updated' && e.month === month) load()
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [collapsed, load, month, refreshStatus])

  const toggle = (): void => {
    writeCollapsed(!collapsed)
    setCollapsed(!collapsed)
  }
  // The tip goes at once; the server leaves it out of the next answer too.
  const give = (keys: string[], verdict: 'dismissed' | 'not_useful'): void => {
    setView((v) => v && { ...v, facts: v.facts.filter((x) => !keys.includes(x.key)), ai: v.ai && { ...v.ai, suggestions: v.ai.suggestions.filter((x) => !x.factKeys.some((k) => keys.includes(k))) } })
    void Promise.all(keys.map((key) => call('insights.feedback', { key, verdict }))).catch(load)
  }

  const aiName = assistant?.providerName ?? ''
  // Asks for the tips; without the person's agreement for this provider the dialog opens first.
  const write = (agreed?: true): void => {
    const asked = month
    setRun({ running: true, month, startedAt: new Date().toISOString() })
    setAiError(null)
    call('insights.run', agreed ? { month, consent: agreed } : { month })
      .then((v) => asked === monthRef.current && setView(v))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'insights.consent_needed') setConsent(true)
        // Another run is on: the status below shows it, no error.
        else if (!(e instanceof ApiError && (e.code === 'insights.cancelled' || e.code === 'insights.busy')) && asked === monthRef.current) setAiError(errText(e))
      })
      .finally(refreshStatus)
  }
  const ask = (tip: Tip): void => {
    window.dispatchEvent(new Event('kasboek:open-assistant'))
    void call('assistant.send', { text: t('insights.askPrompt', { tip: `${tip.title} ${tip.body}` }) }).catch((e) => setAiError(errText(e)))
  }

  const ai = view?.ai ?? null
  const writing = !!run?.running && run.month === month
  const writingOther = !!run?.running && run.month !== month
  const otherReason = writingOther && run?.month ? t('insights.runningOther', { ai: aiName, month: monthLabel(new Date(Number(run.month.slice(0, 4)), Number(run.month.slice(5)) - 1, 1), fmt) }) : undefined
  const pastMonth = month < monthOf()
  const writeMoney = (cents: number, currency: string): string => money(cents, currency)
  const writeDate = (iso: string): string => formatDate(iso, fmt)
  const aiTips: Tip[] = (ai?.suggestions ?? []).flatMap((s: InsightSuggestion) => {
    const fact = ai!.facts.find((f) => f.key === s.factKeys[0])
    return fact ? [{ key: `ai:${s.factKeys.join('+')}`, severity: s.severity, title: renderInsightText(s.title, ai!.facts, writeMoney, writeDate), body: renderInsightText(s.body, ai!.facts, writeMoney, writeDate), fact, keys: s.factKeys }] : []
  })
  // A fact an assistant tip is about is not listed a second time.
  const covered = new Set(aiTips.flatMap((x) => x.keys))
  const localTips: Tip[] = (view?.facts ?? [])
    .filter((f) => !covered.has(f.key))
    .map((f) => {
      const vars = textVars(f.values, { money, date: writeDate })
      return { key: f.key, severity: severityOf(f.kind), title: t(titleKey(f), vars), body: t(bodyKey(f), vars), fact: f, keys: [f.key] }
    })
  const visible = all ? localTips : localTips.slice(0, SHOWN)
  const hasFacts = (view?.facts.length ?? 0) > 0

  const row = (tip: Tip, withAsk: boolean): ReactNode => {
    const action = actionOf(tip.fact)
    return (
      <li key={tip.key} className="flex items-start gap-3 border-b border-border px-5 py-3.5 last:border-b-0">
        <span className="mt-0.5 shrink-0" role="img" aria-label={t(`insights.severity.${tip.severity}`)}>{ICONS[tip.severity]}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">{tip.title}</p>
          <p className="text-xs text-muted">{tip.body}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <Button size="sm" onClick={() => go(action.page, action.params)}>{t(`insights.action.${action.label}`)}</Button>
            {withAsk && assistant?.configured && <Button size="sm" variant="ghost" disabled={assistant.busy} onClick={() => ask(tip)}>{t('insights.ask', { ai: aiName })}</Button>}
            <Button size="sm" variant="ghost" onClick={() => give(tip.keys, 'not_useful')}>{t('insights.notUseful')}</Button>
            <Button size="sm" variant="ghost" onClick={() => give(tip.keys, 'dismissed')}>{t('insights.hide')}</Button>
          </div>
        </div>
      </li>
    )
  }

  return (
    <Card className="mt-4">
      <CardHeader
        title={t('insights.title')}
        action={
          <div className="flex items-center gap-2">
            {!collapsed && assistant?.configured && hasFacts && !ai && !writing && (
              <Button size="sm" icon={<Sparkles size={14} />} disabled={writingOther} title={otherReason} onClick={() => write()}>{t('insights.get', { ai: aiName })}</Button>
            )}
            <Button size="sm" variant="ghost" aria-expanded={!collapsed} aria-label={t(collapsed ? 'insights.expand' : 'insights.collapse')} icon={collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />} onClick={toggle} />
          </div>
        }
      />
      {!collapsed && (
        <div>
          {failed ? (
            <div className="flex items-center justify-between gap-3 px-5 py-4 text-[13px]">
              <span className="text-muted">{t('insights.error')}</span>
              <Button size="sm" onClick={load}>{t('insights.retry')}</Button>
            </div>
          ) : view === null ? (
            <p className="px-5 py-4 text-[13px] text-muted">{t('insights.loading')}</p>
          ) : (
            <>
              {writing && (
                <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 text-[13px]" role="status">
                  <span className="text-muted">{t('insights.writing', { ai: aiName })}</span>
                  <Button size="sm" onClick={() => void call('insights.cancel')}>{t('insights.stop')}</Button>
                </div>
              )}
              {otherReason && (
                <p className="border-b border-border px-5 py-3 text-[13px] text-muted" role="status">{otherReason}</p>
              )}
              {aiError && (
                <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 text-[13px]" role="alert">
                  <span className="text-negative">{aiError}</span>
                  <Button size="sm" disabled={writing || writingOther} title={otherReason} onClick={() => write()}>{t('insights.retry')}</Button>
                </div>
              )}
              {ai && (
                <>
                  {aiTips.length > 0 ? <ul>{aiTips.map((x) => row(x, true))}</ul> : <p className="px-5 py-4 text-[13px] text-muted">{t('insights.empty', { month: monthText })}</p>}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5 text-xs text-muted">
                    <span>
                      {t('insights.writtenBy', { ai: ai.providerName, date: formatDate(new Date(ai.createdAt), fmt) })}
                      {ai.stale && <> · {t(ai.stale === 'data' ? 'insights.staleData' : 'insights.staleLanguage')}</>}
                    </span>
                    <Button size="sm" variant="ghost" disabled={writing || writingOther || !assistant?.configured} title={otherReason} onClick={() => write()}>{t('insights.refresh')}</Button>
                  </div>
                </>
              )}
              {localTips.length === 0 && !ai ? (
                <p className="px-5 py-4 text-[13px] text-muted">{t('insights.empty', { month: monthText })}</p>
              ) : (
                localTips.length > 0 && (
                  <>
                    <ul className={ai ? 'border-t border-border' : undefined}>{visible.map((x) => row(x, false))}</ul>
                    {localTips.length > SHOWN && (
                      <div className="border-t border-border px-5 py-2.5">
                        <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? t('insights.showLess') : t('insights.showAll', { n: localTips.length })}</Button>
                      </div>
                    )}
                  </>
                )
              )}
              {pastMonth && <p className="border-t border-border px-5 py-2.5 text-xs text-muted">{t('insights.pastMonthNote')}</p>}
              {hasFacts && assistant?.configured && <SentText month={month} />}
              {hasFacts && assistant && !assistant.configured && (
                <p className="border-t border-border px-5 py-2.5 text-xs text-muted">
                  {t('insights.setup')}{' '}
                  <button type="button" className="font-medium text-accent hover:underline" onClick={() => { openSettingsTab('assistant'); go('settings') }}>{t('assistant.setupButton')}</button>
                </p>
              )}
            </>
          )}
        </div>
      )}
      <ConsentModal open={consent} month={month} onClose={() => setConsent(false)} onSend={() => { setConsent(false); write(true) }} />
    </Card>
  )
}

/** What the assistant is sent when it writes tips for this month, as it would be sent now. Worked out when opened, so nothing is prepared for nothing. */
function SentText({ month }: { month: string }) {
  const { t } = useTranslation()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = (e: { currentTarget: HTMLDetailsElement }): void => {
    if (!e.currentTarget.open) return
    setText(null)
    setError(null)
    call('insights.preview', { month }).then((r) => setText(r.text), (err: unknown) => setError(errText(err)))
  }
  return (
    <details className="border-t border-border px-5 py-2.5 text-xs" onToggle={open}>
      <summary className="cursor-pointer text-muted">{t('insights.consent.show')}</summary>
      {error && <p className="mt-2 text-negative">{error}</p>}
      {text !== null && <pre className="selectable mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-[11px] leading-snug whitespace-pre-wrap">{text}</pre>}
    </details>
  )
}

/** Asks before the summary goes to the assistant (once per provider), and shows exactly what is sent. */
function ConsentModal({ open, month, onClose, onSend }: { open: boolean; month: string; onClose: () => void; onSend: () => void }) {
  const { t } = useTranslation()
  const [info, setInfo] = useState<InsightsPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setInfo(null)
    setError(null)
    let current = true
    void call('insights.preview', { month }).then(
      (r) => current && setInfo(r),
      (e) => current && setError(errText(e))
    )
    return () => {
      current = false
    }
  }, [open, month])
  const local = info?.company === null
  const vars = info && { ai: info.providerName, aiCompany: info.company ?? info.providerName, count: info.facts }
  return (
    <Modal open={open} title={t('insights.consent.title', { ai: info?.providerName ?? '' })} onClose={onClose}>
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1 text-[13px]">
        {error && <p className="text-negative">{error}</p>}
        {!info && !error && <p className="text-muted">{t('insights.consent.loading')}</p>}
        {info && vars && (
          <>
            <p>{t(local ? 'insights.consent.sendsLocal' : 'insights.consent.sendsRemote', vars)}</p>
            <p className="text-muted">{t('insights.consent.again')}</p>
            <p className="num text-muted">{t('insights.consent.stats', { tokens: info.approxTokens.toLocaleString(), address: info.address, model: info.model })}</p>
            <details>
              <summary className="cursor-pointer font-medium">{t('insights.consent.show')}</summary>
              <pre className="selectable mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-[11px] leading-snug whitespace-pre-wrap">{info.text}</pre>
            </details>
          </>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-4">
        <Button onClick={onClose}>{t('settings.cancel')}</Button>
        <Button variant="primary" icon={<Sparkles size={14} />} disabled={!info} onClick={onSend}>{t(local ? 'insights.consent.sendLocal' : 'insights.consent.send', vars ?? {})}</Button>
      </div>
    </Modal>
  )
}
