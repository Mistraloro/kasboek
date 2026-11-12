import { Check, PlugZap, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { call } from '../lib/api'
import { Button, Modal } from './ui'

/** Changes requested through MCP (Claude Desktop / Claude Code) wait here for approval. */
export function McpRequests() {
  const { t } = useTranslation()
  const [queue, setQueue] = useState<{ id: string; summary: string }[]>([])
  useEffect(
    () =>
      window.kasboek.onEvent((e) => {
        if (e.type === 'mcp.request') setQueue((q) => [...q, { id: e.id, summary: e.summary }])
      }),
    []
  )
  const current = queue[0]
  const answer = (approve: boolean): void => {
    if (!current) return
    void call('mcp.respond', { id: current.id, approve })
    setQueue((q) => q.slice(1))
  }
  return (
    <Modal open={!!current} title={t('mcp.requestTitle')} onClose={() => answer(false)}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><PlugZap size={17} /></span>
        <div>
          <p className="text-[13px] text-muted">{t('mcp.requestBody')}</p>
          <p className="mt-2 font-medium">{current?.summary}</p>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button icon={<X size={14} />} onClick={() => answer(false)}>{t('assistant.decline')}</Button>
        <Button variant="primary" icon={<Check size={14} />} onClick={() => answer(true)}>{t('assistant.approve')}</Button>
      </div>
    </Modal>
  )
}
