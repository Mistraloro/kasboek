import { ArrowUp, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from './ui'

export function AssistantPanel() {
  const { t } = useTranslation()
  const examples = [t('assistant.example1'), t('assistant.example2'), t('assistant.example3')]
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-border bg-bg" aria-label={t('assistant.title')}>
      <div className="flex items-center justify-between px-5 pt-3 pb-3">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-accent" />
          <h2 className="text-sm font-semibold">{t('assistant.title')}</h2>
        </div>
        <Badge>{t('assistant.comingSoon')}</Badge>
      </div>
      <div className="flex-1 overflow-y-auto px-5">
        <p className="text-[13px] text-muted">{t('assistant.intro')}</p>
        <p className="mt-5 mb-2 text-xs font-medium text-muted">{t('assistant.examplesTitle')}</p>
        <ul className="flex flex-col gap-2">
          {examples.map((e) => (
            <li key={e} className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">
              {e}
            </li>
          ))}
        </ul>
      </div>
      <div className="p-4">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 opacity-60">
          <input disabled placeholder={t('assistant.placeholder')} className="h-7 flex-1 bg-transparent text-sm outline-none" aria-label={t('assistant.placeholder')} />
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-fg">
            <ArrowUp size={15} />
          </span>
        </div>
      </div>
    </aside>
  )
}
