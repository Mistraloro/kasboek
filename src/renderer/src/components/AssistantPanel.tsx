import { ArrowUp, Check, RotateCcw, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssistantStatus, ChatMessage } from '@shared/types'
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

/** Minimal formatting: **bold**, `code`, line breaks and "- " bullets. No HTML is ever injected. */
function Rich({ text }: { text: string }) {
  const inline = (s: string, key: number): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong> : part.startsWith('`') && part.endsWith('`') ? <code key={`${key}-${i}`} className="rounded bg-surface-2 px-1 text-[12px]">{part.slice(1, -1)}</code> : part
    )
  return (
    <div className="selectable space-y-1.5">
      {text.split(/\n{2,}/).map((para, i) => {
        const lines = para.split('\n')
        if (lines.every((l) => /^\s*[-•*] /.test(l)))
          return <ul key={i} className="list-disc space-y-0.5 pl-4">{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-•*] /, ''), j)}</li>)}</ul>
        return <p key={i}>{lines.flatMap((l, j) => (j ? [<br key={`br${j}`} />, ...inline(l, j)] : inline(l, j)))}</p>
      })}
    </div>
  )
}

function Bubble({ m }: { m: ChatMessage }) {
  const { t } = useTranslation()
  const toast = useToast()
  if (m.role === 'user') return <div className="selectable ml-8 self-end rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2 text-[13px] whitespace-pre-wrap">{m.text}</div>
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
  return (
    <div className="text-[13px] leading-relaxed">
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
          </form>
        </>
      )}
    </aside>
  )
}
