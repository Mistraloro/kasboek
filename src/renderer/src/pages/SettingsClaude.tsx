import { Copy, KeyRound, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ASSISTANT_MODELS, type AssistantModel, type Effort } from '@shared/types'
import { useAssistant } from '../components/AssistantPanel'
import { Badge, Button, Card, CardHeader, Field, Input, Modal, Select, Switch } from '../components/ui'
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
      <div className="border-b border-border px-5 py-4 text-xs text-muted">{t('claude.privacy')}</div>
      {s && <McpRows enabled={s.mcpEnabled} onChange={(mcpEnabled) => configure({ mcpEnabled })} />}

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

function McpRows({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const status = useOp('mcp.setupStatus')
  const [confirm, setConfirm] = useState<null | 'desktopAdd' | 'desktopRemove'>(null)
  const [manual, setManual] = useState(false)
  const [busy, setBusy] = useState(false)
  const st = status.data
  const entryJson = st ? JSON.stringify({ mcpServers: { kasboek: st.entry } }, null, 2) : ''
  const quote = (p: string): string => (/\s/.test(p) ? `"${p}"` : p)
  const command = st ? `claude mcp add --scope user kasboek -- ${[st.entry.command, ...st.entry.args].map(quote).join(' ')}` : ''
  const copy = (v: string): void => void navigator.clipboard.writeText(v).then(() => toast(t('mcp.copied')), () => toast(t('auth.copyFailed'), 'error'))
  const act = (p: Promise<unknown>, done: string): void => {
    setBusy(true)
    p.then(() => toast(done), (e) => toast(errText(e), 'error')).finally(() => {
      setBusy(false)
      setConfirm(null)
      void status.reload()
    })
  }
  const desktopTone = st?.desktop?.state === 'current' ? 'accent' : st?.desktop?.state === 'outdated' ? 'warning' : 'neutral'
  return (
    <>
      <Row label={t('mcp.title')} hint={t('mcp.hint')}>
        <Switch label={t('mcp.title')} checked={enabled} onChange={onChange} />
      </Row>
      {enabled && st && (
        <>
          {!st.helperFound && <p className="px-5 pt-3 text-xs text-warning">{t('mcp.helperMissing')}</p>}
          <Row label={t('mcp.desktopLabel')} hint={st.desktop ? <span className="selectable break-all">{st.desktop.configPath}</span> : t('mcp.desktopUnavailable')}>
            {st.desktop && (
              <>
                <Badge tone={desktopTone}>{t(`mcp.state.${st.desktop.state}`)}</Badge>
                {st.desktop.state !== 'current' && <Button size="sm" variant="primary" disabled={busy} onClick={() => setConfirm('desktopAdd')}>{st.desktop.state === 'outdated' ? t('mcp.update') : t('mcp.addDesktop')}</Button>}
                {st.desktop.state !== 'absent' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm('desktopRemove')}>{t('mcp.remove')}</Button>}
              </>
            )}
          </Row>
          <Row label={t('mcp.codeLabel')} hint={st.code ? <span className="selectable break-all">{st.code.path}</span> : t('mcp.codeNotFound')}>
            {st.code && (
              <>
                <Badge tone={st.code.installed ? 'accent' : 'neutral'}>{st.code.installed ? t('mcp.state.current') : t('mcp.state.absent')}</Badge>
                <Button size="sm" variant={st.code.installed ? 'secondary' : 'primary'} disabled={busy} onClick={() => act(call('mcp.codeAdd'), t('mcp.codeAdded'))}>{st.code.installed ? t('mcp.update') : t('mcp.addCode')}</Button>
                {st.code.installed && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(call('mcp.codeRemove'), t('mcp.removedCode'))}>{t('mcp.remove')}</Button>}
              </>
            )}
          </Row>
          <div className="px-5 py-3 text-[13px]">
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => setManual((v) => !v)}>{manual ? t('mcp.hideManual') : t('mcp.manual')}</button>
            {manual && (
              <div className="mt-3 flex flex-col gap-3">
                <div>
                  <div className="mb-1 flex items-center justify-between"><span className="font-medium">{t('mcp.desktop')}</span><Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => copy(entryJson)}>{t('auth.copy')}</Button></div>
                  <pre className="selectable overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[12px]">{entryJson}</pre>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between"><span className="font-medium">{t('mcp.code')}</span><Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => copy(command)}>{t('auth.copy')}</Button></div>
                  <pre className="selectable overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[12px]">{command}</pre>
                </div>
              </div>
            )}
            <p className="mt-3 text-xs text-muted">{t('mcp.note')}</p>
          </div>
          <Modal open={!!confirm} title={confirm === 'desktopRemove' ? t('mcp.removeTitle') : t('mcp.addTitle')} onClose={() => setConfirm(null)}>
            <div className="flex flex-col gap-3 text-[13px]">
              <p className="text-muted">{confirm === 'desktopRemove' ? t('mcp.removeBody') : t('mcp.addBody')}</p>
              <p className="selectable rounded-lg bg-surface-2 px-3 py-2 font-mono text-[12px] break-all">{st.desktop?.configPath}</p>
              {confirm === 'desktopAdd' && <pre className="selectable overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[12px]">{JSON.stringify({ kasboek: st.entry }, null, 2)}</pre>}
              <p className="text-xs text-muted">{t('mcp.backupNote')}</p>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setConfirm(null)}>{t('settings.cancel')}</Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => act(call(confirm === 'desktopRemove' ? 'mcp.desktopRemove' : 'mcp.desktopAdd'), confirm === 'desktopRemove' ? t('mcp.removedDesktop') : t('mcp.addedDesktop'))}
                >
                  {confirm === 'desktopRemove' ? t('mcp.remove') : t('mcp.confirmAdd')}
                </Button>
              </div>
            </div>
          </Modal>
        </>
      )}
    </>
  )
}
