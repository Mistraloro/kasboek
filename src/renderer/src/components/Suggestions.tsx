import { AlertTriangle, ChevronDown, ChevronUp, Info, Lightbulb } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { actionOf, bodyKey, severityOf, textVars, titleKey, type InsightSeverity } from '@shared/insights'
import type { InsightFact } from '@shared/types'
import type { Page } from '../App'
import { call } from '../lib/api'
import { formatDate } from '../lib/format'
import { useSettings } from '../lib/settings'
import { Button, Card, CardHeader } from './ui'

const SHOWN = 3
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

/** Tips found locally from the month's data; loaded only while the card is open. */
export function Suggestions({ month, monthText, go }: { month: string; monthText: string; go: (p: Page, params?: Record<string, unknown>) => void }) {
  const { t } = useTranslation()
  const { fmt, money } = useSettings()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [facts, setFacts] = useState<InsightFact[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [all, setAll] = useState(false)
  const latest = useRef(0)

  const load = useCallback(() => {
    const run = ++latest.current
    setFailed(false)
    call('insights.get', { month })
      .then((view) => run === latest.current && setFacts(view.facts))
      .catch(() => run === latest.current && setFailed(true))
  }, [month])

  // After the first paint, and only while open: the facts take a moment to work out.
  useEffect(() => {
    if (collapsed) return
    setFacts(null)
    load()
  }, [collapsed, load])
  useEffect(
    () =>
      window.kasboek.onEvent((e) => {
        if (e.type === 'data.changed' && !collapsed) load()
      }),
    [collapsed, load]
  )

  const toggle = (): void => {
    writeCollapsed(!collapsed)
    setCollapsed(!collapsed)
  }
  // The tip goes at once; the server leaves it out of the next answer too.
  const give = (f: InsightFact, verdict: 'dismissed' | 'not_useful'): void => {
    setFacts((list) => list && list.filter((x) => x.key !== f.key))
    void call('insights.feedback', { key: f.key, verdict }).catch(load)
  }

  const list = facts ?? []
  const visible = all ? list : list.slice(0, SHOWN)
  return (
    <Card className="mt-4">
      <CardHeader
        title={t('insights.title')}
        action={
          <div className="flex items-center gap-2">
            {/* Reserved: the button for tips written by the assistant (a later step) goes here. Nothing is shown for now. */}
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
          ) : facts === null ? (
            <p className="px-5 py-4 text-[13px] text-muted">{t('insights.loading')}</p>
          ) : list.length === 0 ? (
            <p className="px-5 py-4 text-[13px] text-muted">{t('insights.empty', { month: monthText })}</p>
          ) : (
            <>
              <ul>
                {visible.map((f) => {
                  const severity = severityOf(f.kind)
                  const action = actionOf(f)
                  const vars = textVars(f.values, { money, date: (iso) => formatDate(iso, fmt) })
                  return (
                    <li key={f.key} className="flex items-start gap-3 border-b border-border px-5 py-3.5 last:border-b-0">
                      <span className="mt-0.5 shrink-0" role="img" aria-label={t(`insights.severity.${severity}`)}>{ICONS[severity]}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium">{t(titleKey(f), vars)}</p>
                        <p className="text-xs text-muted">{t(bodyKey(f), vars)}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          <Button size="sm" onClick={() => go(action.page, action.params)}>{t(`insights.action.${action.label}`)}</Button>
                          <Button size="sm" variant="ghost" onClick={() => give(f, 'not_useful')}>{t('insights.notUseful')}</Button>
                          <Button size="sm" variant="ghost" onClick={() => give(f, 'dismissed')}>{t('insights.hide')}</Button>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
              {list.length > SHOWN && (
                <div className="border-t border-border px-5 py-2.5">
                  <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? t('insights.showLess') : t('insights.showAll', { n: list.length })}</Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  )
}
