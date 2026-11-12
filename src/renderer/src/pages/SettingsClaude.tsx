import { KeyRound, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ASSISTANT_MODELS, type AssistantModel, type Effort } from '@shared/types'
import { useAssistant } from '../components/AssistantPanel'
import { Badge, Button, Card, CardHeader, Field, Input, Modal, Select } from '../components/ui'
import { useToast } from '../components/Toast'
import { call, useOp } from '../lib/api'
import { errText } from './auth/parts'
import { Row } from './Settings'

const EFFORTS: Effort[] = ['low', 'medium', 'high']

export function ClaudeSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const status = useAssistant()
  const settings = useOp('settings.get')
  const [keyOpen, setKeyOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const s = settings.data
  const configure = (patch: Parameters<typeof call<'assistant.configure'>>[1]): void => void call('assistant.configure', patch).then(() => settings.reload(), (e) => toast(errText(e), 'error'))
  const modelSelect = (value: AssistantModel, onChange: (m: AssistantModel) => void, label: string) => (
    <Select className="w-52" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as AssistantModel)}>
      {ASSISTANT_MODELS.map((m) => <option key={m} value={m}>{t(`claude.model.${m}`)}</option>)}
    </Select>
  )
  const effortSelect = (value: Effort, onChange: (e: Effort) => void, label: string) => (
    <Select className="w-32" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Effort)}>
      {EFFORTS.map((x) => <option key={x} value={x}>{t(`claude.effort.${x}`)}</option>)}
    </Select>
  )

  return (
    <Card>
      <CardHeader title={t('claude.title')} description={t('claude.hint')} />
      <Row label={t('claude.apiKey')} hint={t('claude.apiKeyHint')}>
        <Badge tone={status?.configured ? 'accent' : 'neutral'}>{status?.configured ? t('claude.keySet', { hint: status.keyHint }) : t('claude.keyNotSet')}</Badge>
        <Button size="sm" icon={<KeyRound size={14} />} onClick={() => setKeyOpen(true)}>{status?.configured ? t('claude.replaceKey') : t('claude.addKey')}</Button>
        {status?.configured && <Button size="sm" variant="ghost" aria-label={t('claude.removeKey')} icon={<Trash2 size={14} />} onClick={() => void call('assistant.clearKey')} />}
      </Row>
      {s && (
        <>
          <Row label={t('claude.chat')} hint={t('claude.chatHint')}>
            {modelSelect(s.chatModel, (chatModel) => configure({ chatModel }), t('claude.chat'))}
            {effortSelect(s.chatEffort, (chatEffort) => configure({ chatEffort }), t('claude.effortLabel'))}
          </Row>
          <Row label={t('claude.csv')} hint={t('claude.csvHint')}>
            {modelSelect(s.csvModel, (csvModel) => configure({ csvModel }), t('claude.csv'))}
            {effortSelect(s.csvEffort, (csvEffort) => configure({ csvEffort }), t('claude.effortLabel'))}
          </Row>
        </>
      )}
      <div className="px-5 py-4 text-xs text-muted">{t('claude.privacy')}</div>

      <Modal open={keyOpen} title={t('claude.addKey')} onClose={() => setKeyOpen(false)}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            setBusy(true)
            void call('assistant.setKey', { apiKey: key })
              .then(() => {
                toast(t('claude.keySaved'))
                setKey('')
                setKeyOpen(false)
              })
              .catch((err) => toast(errText(err), 'error'))
              .finally(() => setBusy(false))
          }}
        >
          <p className="text-[13px] text-muted">{t('claude.keyHelp')}</p>
          <Field label={t('claude.apiKey')}>{(id) => <Input id={id} type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" />}</Field>
          <div className="flex justify-between gap-2">
            <a className="self-center text-[13px] font-medium text-accent hover:underline" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">{t('claude.getKey')}</a>
            <div className="flex gap-2">
              <Button onClick={() => setKeyOpen(false)}>{t('settings.cancel')}</Button>
              <Button type="submit" variant="primary" disabled={!key.trim() || busy}>{busy ? t('claude.checking') : t('settings.save')}</Button>
            </div>
          </div>
        </form>
      </Modal>
    </Card>
  )
}
