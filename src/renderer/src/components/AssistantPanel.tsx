import { ArrowUp, Check, ChevronRight, FileCheck2, RotateCcw, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { REASONING_LEVELS, claudeEfforts, type ReasoningLevel } from '@shared/reasoning'
import { ASSISTANT_MODELS, type AssistantModel, type AssistantStatus, type ChatMessage, type Effort, type Settings } from '@shared/types'
import { PROVIDERS, type ProviderId } from '@shared/ai-providers'
import type { Page } from '../App'
import { call } from '../lib/api'
import { setAiName } from '../i18n'
import { errText } from '../pages/auth/parts'
import { useToast } from './Toast'
import { Badge, Button, cx } from './ui'

export function useAssistant(): AssistantStatus | null {
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  useEffect(() => {
    const apply = (s: AssistantStatus): void => {
      // Texts name the chosen assistant ("Check with Mistral") through {{ai}} and {{aiCompany}}.
      setAiName(s.providerName, s.company)
      setStatus(s)
    }
    void call('assistant.status').then(apply)
    return window.kasboek.onEvent((e) => {
      if (e.type === 'assistant.update') apply(e.status)
    })
  }, [])
  return status
}

/** Minimal formatting: # headings, **bold**, `code`, line breaks and "- " bullets. No HTML is ever injected. */
export function Rich({ text }: { text: string }) {
  const inline = (s: string, key: number): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong> : part.startsWith('`') && part.endsWith('`') ? <code key={`${key}-${i}`} className="rounded bg-surface-2 px-1 text-[12px]">{part.slice(1, -1)}</code> : part
    )
  const bullet = /^\s*[-•*] /
  return (
    <div className="selectable space-y-1.5">
      {text.split(/\n{2,}/).map((para, i) => {
        // Runs of bullet lines become a list; other lines stay text, headings bold.
        const blocks: { list: boolean; lines: string[] }[] = []
        for (const l of para.split('\n')) {
          const list = bullet.test(l)
          const last = blocks.at(-1)
          if (last && last.list === list) last.lines.push(l)
          else blocks.push({ list, lines: [l] })
        }
        return (
          <div key={i} className="space-y-1">
            {blocks.map((b, j) =>
              b.list ? (
                <ul key={j} className="list-disc space-y-0.5 pl-4">{b.lines.map((l, k) => <li key={k}>{inline(l.replace(bullet, ''), k)}</li>)}</ul>
              ) : (
                <p key={j}>{b.lines.flatMap((l, k) => {
                  const h = /^#{1,6} /.test(l)
                  const parts = h ? [<strong key={`h${k}`}>{l.replace(/^#{1,6} /, '')}</strong>] : inline(l, k)
                  return k ? [<br key={`br${k}`} />, ...parts] : parts
                })}</p>
              )
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The chat's model (and, for Claude, its effort), right under the message box. The same settings
 * as Settings → Assistant → Chat; the CSV check keeps its own.
 */
function ModelPicker({ provider, disabled, unsupported }: { provider: ProviderId; disabled: boolean; unsupported?: boolean }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [s, setS] = useState<Settings | null>(null)
  const [models, setModels] = useState<string[]>([])
  useEffect(() => {
    const load = (): void => void call('settings.get').then(setS, () => undefined)
    load()
    return window.kasboek.onEvent((e) => e.type === 'data.changed' && load())
  }, [])
  // Other providers: the models they offer (quietly skipped when the list can't be loaded).
  useEffect(() => {
    if (provider === 'anthropic') return
    void call('assistant.models', {}).then(setModels, () => setModels([]))
  }, [provider])
  if (!s) return null
  const configure = (patch: Parameters<typeof call<'assistant.configure'>>[1]): void =>
    void call('assistant.configure', patch).then(setS, (e) => toast(errText(e), 'error'))
  const small = 'h-7 rounded-md border-0 bg-transparent px-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50'
  if (provider === 'anthropic')
    return (
      <div className="mt-1.5 flex min-w-0 items-center gap-1">
        <select className={cx(small, 'min-w-0 flex-1 truncate')} disabled={disabled} aria-label={t('assistant.model')} value={s.chatModel} onChange={(e) => configure({ chatModel: e.target.value as AssistantModel })}>
          {ASSISTANT_MODELS.map((m) => <option key={m} value={m}>{t(`claude.model.${m}`)}</option>)}
        </select>
        <select className={cx(small, 'shrink-0')} disabled={disabled} aria-label={t('claude.effortLabel')} value={s.chatEffort} onChange={(e) => configure({ chatEffort: e.target.value as Effort })}>
          {claudeEfforts(s.chatModel).map((x) => <option key={x} value={x}>{x === 'off' ? t('claude.effort.off') : t('assistant.effortOption', { level: t(`claude.effort.${x}`) })}</option>)}
        </select>
      </div>
    )
  const options = [...new Set([s.aiChatModel, ...models, ...PROVIDERS[provider].suggestedModels].filter(Boolean))]
  if (!options.length) return null
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1">
      <select className={cx(small, 'min-w-0 max-w-full truncate')} disabled={disabled} aria-label={t('assistant.model')} value={s.aiChatModel} onChange={(e) => configure({ aiChatModel: e.target.value })}>
        {options.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <select
        className={cx(small, 'shrink-0', unsupported && 'line-through')}
        disabled={disabled}
        aria-label={t('assistant.reasoningLabel')}
        title={unsupported ? t('assistant.reasoningUnsupported') : t('assistant.reasoningHint')}
        value={s.aiReasoning}
        onChange={(e) => configure({ aiReasoning: e.target.value as ReasoningLevel })}
      >
        {REASONING_LEVELS.map((x) => <option key={x} value={x}>{t('assistant.reasoningOption', { level: t(`assistant.reasoning.${x}`) })}</option>)}
      </select>
    </div>
  )
}

/** The model's reasoning: collapsed, and open while it is still thinking with no answer yet. */
function Thinking({ text, live }: { text: string; live: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const shown = open || live
  return (
    <div className="mb-2 rounded-lg border border-border bg-surface/60">
      <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted hover:text-text">
        <ChevronRight size={13} className={cx('transition-transform', shown && 'rotate-90')} />
        <span className={cx(live && 'animate-pulse')}>{live ? t('assistant.thinkingLive') : t('assistant.thinkingShown')}</span>
      </button>
      {shown && <p className="selectable max-h-56 overflow-y-auto px-3 pb-2 text-xs whitespace-pre-wrap text-muted">{text.trim()}</p>}
    </div>
  )
}

function Bubble({ m }: { m: ChatMessage }) {
  const { t } = useTranslation()
  const toast = useToast()
  if (m.role === 'user') return <div className="selectable ml-8 self-end rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2 text-[13px] whitespace-pre-wrap">{m.text}</div>
  // Made without asking, as the person's permissions allow.
  if (m.role === 'confirm' && m.state === 'auto')
    return (
      <p className="flex items-start gap-1.5 rounded-lg bg-surface-2/60 px-2.5 py-1.5 text-xs text-muted">
        {m.failed ? <X size={13} className="mt-0.5 shrink-0 text-negative" /> : <Check size={13} className="mt-0.5 shrink-0 text-accent" />}
        <span>
          <span className="font-medium text-text">{m.failed ? t('assistant.autoFailed') : t('assistant.autoDone')}</span> {m.summary}
        </span>
      </p>
    )
  if (m.role === 'confirm')
    return (
      <div className="rounded-xl border border-border bg-surface p-3 text-[13px]">
        <p className="mb-1 text-xs font-medium text-muted">{t('assistant.wantsTo')}</p>
        <p className="font-medium">{m.summary}</p>
        {m.state === 'pending' ? (
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={() => void call('assistant.confirm', { id: m.id, approve: true }).catch((e) => toast(errText(e), 'error'))}>{t('assistant.approve')}</Button>
            <Button size="sm" icon={<X size={14} />} onClick={() => void call('assistant.confirm', { id: m.id, approve: false })}>{t('assistant.decline')}</Button>
          </div>
        ) : (
          <div className="mt-2"><Badge tone={m.state === 'approved' ? 'accent' : 'neutral'}>{m.state === 'approved' ? t('assistant.approved') : t('assistant.declined')}</Badge></div>
        )}
      </div>
    )
  const check = m.check
  return (
    <div className="text-[13px] leading-relaxed">
      {check && (
        <p className={cx('mb-1 flex items-center gap-1.5 text-xs text-muted', !check.done && 'animate-pulse')}>
          <FileCheck2 size={13} />
          {!check.done
            ? check.groupsTotal
              ? t('assistant.checkRunningGroups', { file: check.fileName, done: check.groupsDone, total: check.groupsTotal })
              : t('assistant.checkRunning', { file: check.fileName })
            : m.error
              ? t('assistant.checkFailed', { file: check.fileName })
              : t('assistant.checkDone', { file: check.fileName, categorised: check.categorised ?? 0, renamed: check.renamed ?? 0, rules: check.rules ?? 0, existing: check.existing ?? 0 })}
        </p>
      )}
      {m.thinking?.trim() && <Thinking text={m.thinking} live={!m.text && !m.error && (!check || !check.done)} />}
      {m.tools.length > 0 && (
        <p className="mb-1 text-xs text-muted">
          {[...new Set(m.tools.map((x) => t(`assistant.tool.${x.name}`, { defaultValue: x.name.replace(/_/g, ' ') })))].join(' · ')}
        </p>
      )}
      {m.text && <Rich text={m.text} />}
      {m.error && <p className="mt-1 text-negative">{m.error}</p>}
    </div>
  )
}

export function AssistantPanel({ go }: { go: (p: Page) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const status = useAssistant()
  const [text, setText] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [status?.messages])
  const examples = [t('assistant.example1'), t('assistant.example2'), t('assistant.example3')]
  const sendText = (v: string): void => {
    if (!v.trim() || status?.busy) return
    setText('')
    void call('assistant.send', { text: v }).catch((e) => toast(errText(e), 'error'))
  }

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-border bg-bg" aria-label={t('assistant.title')}>
      <div className="flex items-center justify-between px-5 pt-3 pb-3">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-accent" />
          <h2 className="text-sm font-semibold">{t('assistant.title')}</h2>
        </div>
        {status?.configured && status.messages.length > 0 && (
          <button type="button" title={t('assistant.newChat')} aria-label={t('assistant.newChat')} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text" onClick={() => void call('assistant.reset')}>
            <RotateCcw size={14} />
          </button>
        )}
      </div>
      {!status ? null : !status.configured ? (
        <div className="flex-1 px-5">
          <p className="text-[13px] text-muted">{t('assistant.setupBody')}</p>
          <Button className="mt-4" variant="primary" onClick={() => go('settings')}>{t('assistant.setupButton')}</Button>
          <p className="mt-4 text-xs text-muted">{t(status?.company === null ? 'assistant.privacyLocal' : 'assistant.privacy')}</p>
        </div>
      ) : (
        <>
          <div ref={scroller} className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
            {status.messages.length === 0 ? (
              <>
                <p className="text-[13px] text-muted">{t('assistant.intro')}</p>
                <div className="flex flex-col gap-2">
                  {examples.map((e) => (
                    <button key={e} type="button" onClick={() => sendText(e)} className="rounded-lg border border-border bg-surface px-3 py-2 text-left text-[13px] hover:border-accent">{e}</button>
                  ))}
                </div>
                <p className="text-xs text-muted">{t(status?.company === null ? 'assistant.privacyLocal' : 'assistant.privacy')}</p>
              </>
            ) : (
              status.messages.map((m) => <Bubble key={m.id} m={m} />)
            )}
            {status.busy && <p className={cx('text-xs text-muted', 'animate-pulse')}>{t('assistant.thinking')}</p>}
          </div>
          <form className="p-4" onSubmit={(e) => { e.preventDefault(); sendText(text) }}>
            <div className="flex items-end gap-2 rounded-xl border border-border bg-surface px-3 py-2 focus-within:border-accent">
              <textarea
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(text) } }}
                placeholder={t('assistant.placeholder')}
                aria-label={t('assistant.placeholder')}
                className="max-h-32 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm outline-none"
              />
              {status.busy ? (
                <button type="button" aria-label={t('assistant.stop')} onClick={() => void call('assistant.stop')} className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-2 text-text"><Square size={12} /></button>
              ) : (
                <button type="submit" aria-label={t('assistant.send')} disabled={!text.trim()} className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-fg disabled:opacity-40"><ArrowUp size={15} /></button>
              )}
            </div>
            <ModelPicker provider={status.provider} disabled={status.busy} unsupported={status.reasoningUnsupported} />
          </form>
        </>
      )}
    </aside>
  )
}
