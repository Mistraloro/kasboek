import { AlertTriangle, CircleCheck, CircleDashed } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpClientsSeen } from '@shared/types'
import { call } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { useSettings } from '../lib/settings'
import { Button, cx } from './ui'

/** The helper checks the connection every few seconds while a Claude app runs. */
const CONNECTED_MS = 20_000

/** When each Claude app last reached Kasboek, refreshed while on screen. */
export function useClaudeClients(): McpClientsSeen | null {
  const [seen, setSeen] = useState<McpClientsSeen | null>(null)
  useEffect(() => {
    const load = (): void => void call('mcp.clients').then(setSeen, () => undefined)
    load()
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [])
  return seen
}

/** "Connected now", "Last used at …" or "Not connected yet". */
export function SeenLine({ at }: { at: number | null | undefined }) {
  const { t } = useTranslation()
  const { fmt } = useSettings()
  const now = Date.now()
  if (!at)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted">
        <CircleDashed size={12} /> {t('mcp.seen.never')}
      </span>
    )
  const live = now - at < CONNECTED_MS
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs', live ? 'text-accent' : 'text-muted')}>
      <CircleCheck size={12} /> {live ? t('mcp.seen.now') : t('mcp.seen.at', { time: formatDateTime(new Date(at).toISOString(), fmt) })}
    </span>
  )
}

/** Whether Claude Desktop is open, checked every few seconds while `active`. */
export function useDesktopRunning(active: boolean): boolean {
  const [running, setRunning] = useState(false)
  useEffect(() => {
    if (!active) return
    const load = (): void => void call('mcp.desktopRunning').then((r) => setRunning(r.running), () => setRunning(false))
    load()
    const timer = setInterval(load, 2500)
    return () => clearInterval(timer)
  }, [active])
  return active && running
}

/** Shown while Claude Desktop is open: it would undo the change when it quits. */
export function DesktopRunningWarning({ onAnyway, busy, text }: { onAnyway?: () => void; busy?: boolean; text?: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
      <div className="flex-1">
        <p>{text ?? t('mcp.desktopOpen')}</p>
        {onAnyway && (
          <Button size="sm" variant="ghost" className="mt-1 -ml-2" disabled={busy} onClick={onAnyway}>
            {t('mcp.addAnyway')}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Notices when Kasboek's entry in Claude Desktop disappears after it was added (Claude Desktop
 * rewrites its settings when it quits) and re-reads the state when the window comes back.
 */
export function useDesktopOverwritten(state: 'absent' | 'current' | 'outdated' | undefined, reload: () => void): boolean {
  const was = useRef(state)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    if (was.current === 'current' && state === 'absent') setGone(true)
    if (state === 'current') setGone(false)
    was.current = state
  }, [state])
  useEffect(() => {
    const onFocus = (): void => reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload])
  return gone
}
