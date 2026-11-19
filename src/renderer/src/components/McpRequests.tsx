import { Check, CheckCheck, PlugZap, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { call } from '../lib/api'
import { Masked } from '../lib/hide-numbers'
import { Button, Modal } from './ui'

interface Request {
  id: string
  op: string
  summary: string
  expired?: boolean
}

/** Changes requested through MCP (Claude Desktop / Claude Code) wait here for approval. */
export function McpRequests() {
  const { t } = useTranslation()
  const [queue, setQueue] = useState<Request[]>([])
  useEffect(
    () =>
      window.kasboek.onEvent((e) => {
        if (e.type === 'mcp.request') setQueue((q) => [...q, { id: e.id, op: e.op, summary: e.summary }])
        // A request nobody answered in time: the card says so instead of disappearing.
        if (e.type === 'mcp.expired') setQueue((q) => q.map((r) => (r.id === e.id ? { ...r, expired: true } : r)))
      }),
    []
  )
  const current = queue[0]
  const similar = current && !current.expired ? queue.filter((r) => !r.expired && r.op === current.op) : []
  const answer = (approve: boolean, all = false): void => {
    if (!current) return
    const ids = all ? similar.map((r) => r.id) : [current.id]
    if (!current.expired) for (const id of ids) void call('mcp.respond', { id, approve })
    setQueue((q) => q.filter((r) => !ids.includes(r.id)))
  }
  return (
    <Modal open={!!current} title={t('mcp.requestTitle')} onClose={() => answer(false)}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><PlugZap size={17} /></span>
        <div>
          <p className="text-[13px] text-muted">{current?.expired ? t('mcp.requestExpired') : t('mcp.requestBody')}</p>
          <p className={`mt-2 font-medium ${current?.expired ? 'text-muted line-through' : ''}`}>{current && <Masked text={current.summary} />}</p>
          {queue.length > 1 && <p className="mt-2 text-xs text-muted">{t('mcp.waiting', { count: queue.length - 1 })}</p>}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {current?.expired ? (
          <Button onClick={() => answer(false)}>{t('mcp.close')}</Button>
        ) : (
          <>
            <Button icon={<X size={14} />} onClick={() => answer(false)}>{t('assistant.decline')}</Button>
            {similar.length > 1 && <Button icon={<CheckCheck size={14} />} onClick={() => answer(true, true)}>{t('mcp.approveAll', { count: similar.length })}</Button>}
            <Button variant="primary" icon={<Check size={14} />} onClick={() => answer(true)}>{t('assistant.approve')}</Button>
          </>
        )}
      </div>
    </Modal>
  )
}
