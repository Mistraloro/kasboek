import { Brain, Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Memory, MemoryState } from '@shared/types'
import { useAssistant } from '../components/AssistantPanel'
import { Badge, Button, Card, CardHeader, Input, Modal, Switch } from '../components/ui'
import { useToast } from '../components/Toast'
import { ApiError, call, useOp } from '../lib/api'
import { formatDate } from '../lib/format'
import { useSettings } from '../lib/settings'
import { errText } from './auth/parts'
import { Row } from './settings-sections/Row'

/** What the assistant remembers between conversations: see, change, add and forget. */
export function MemorySection() {
  const { t } = useTranslation()
  const toast = useToast()
  const { fmt } = useSettings()
  const name = useAssistant()?.providerName ?? 'Claude'
  const memory = useOp('memory.list')
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const s = memory.data
  if (!s) return null
  const act = (p: Promise<MemoryState>, after?: () => void): void =>
    void p.then(
      () => {
        after?.()
        void memory.reload()
      },
      (e) => toast(e instanceof ApiError && e.code === 'memory.sensitive' ? t('memory.refused') : errText(e), 'error')
    )
  const full = s.items.length >= s.limit
  return (
    <Card>
      <CardHeader title={t('memory.title')} description={t('memory.hint', { name: name })} />
      <Row label={t('memory.enabled')} hint={t('memory.enabledHint')}>
        <Switch label={t('memory.enabled')} checked={s.enabled} onChange={(v) => act(call('memory.setEnabled', { enabled: v }))} />
      </Row>
      {s.enabled && (
        <div className="px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">{t('memory.items', { count: s.items.length, limit: s.limit })}</p>
            {s.items.length > 0 && (
              <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirmAll(true)}>
                {t('memory.forgetAll')}
              </Button>
            )}
          </div>
          {s.items.length === 0 && (
            <p className="flex items-center gap-2 text-[13px] text-muted">
              <Brain size={14} /> {t('memory.empty')}
            </p>
          )}
          <ul className="flex flex-col">
            {s.items.map((m: Memory) => (
              <li key={m.id} className="flex items-center gap-2 border-b border-border py-2 text-[13px] last:border-b-0">
                {editing?.id === m.id ? (
                  <form
                    className="flex flex-1 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      act(call('memory.update', { id: m.id, text: editing.text }), () => setEditing(null))
                    }}
                  >
                    <Input className="flex-1" value={editing.text} maxLength={300} autoFocus aria-label={t('memory.edit')} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} />
                    <Button size="sm" type="submit" variant="primary" aria-label={t('memory.save')} icon={<Check size={14} />} disabled={!editing.text.trim()} />
                    <Button size="sm" variant="ghost" aria-label={t('settings.cancel')} icon={<X size={14} />} onClick={() => setEditing(null)} />
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 break-words">{m.text}</span>
                    <span className="shrink-0 text-xs text-muted" title={formatDate(m.updatedAt.slice(0, 10), fmt)}>
                      {m.source === 'assistant' ? (
                        <Badge>
                          {t('memory.byAssistant', {
                            name: name
                          })}
                        </Badge>
                      ) : (
                        <Badge>{t('memory.byYou')}</Badge>
                      )}
                    </span>
                    <Button size="sm" variant="ghost" aria-label={t('memory.edit')} icon={<Pencil size={14} />} onClick={() => setEditing({ id: m.id, text: m.text })} />
                    <Button size="sm" variant="ghost" aria-label={t('memory.forget')} icon={<Trash2 size={14} />} onClick={() => act(call('memory.forget', { ids: [m.id] }))} />
                  </>
                )}
              </li>
            ))}
          </ul>
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              act(call('memory.add', { text }), () => setText(''))
            }}
          >
            <Input
              className="flex-1"
              value={text}
              maxLength={300}
              disabled={full}
              placeholder={full ? t('memory.full') : t('memory.placeholder')}
              aria-label={t('memory.add')}
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" icon={<Plus size={14} />} disabled={full || !text.trim()}>
              {t('memory.add')}
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted">{t('memory.noNumbers')}</p>
        </div>
      )}
      <Modal open={confirmAll} title={t('memory.forgetAllTitle')} onClose={() => setConfirmAll(false)}>
        <p className="text-[13px] text-muted">{t('memory.forgetAllText', { count: s.items.length })}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setConfirmAll(false)}>{t('settings.cancel')}</Button>
          <Button variant="danger" onClick={() => act(call('memory.forgetAll'), () => setConfirmAll(false))}>
            {t('memory.forgetAll')}
          </Button>
        </div>
      </Modal>
    </Card>
  )
}
