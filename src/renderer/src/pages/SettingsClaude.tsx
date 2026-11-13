import { Copy, KeyRound, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ASSISTANT_MODELS, type AssistantModel, type Effort } from '@shared/types'
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from '@shared/ai-providers'
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
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const s = settings.data
  const preset = PROVIDERS[s?.aiProvider ?? 'anthropic']
  const native = preset.id === 'anthropic'
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
  const loadModels = (): void => {
    setLoadingModels(true)
    void call('assistant.models', {})
      .then((list) => {
        setModels(list)
        toast(t('ai.modelsLoaded', { count: list.length }))
      })
      .catch((e) => toast(errText(e), 'error'))
      .finally(() => setLoadingModels(false))
  }
  const suggestions = [...new Set([...models, ...preset.suggestedModels])]
  const modelInput = (value: string, field: 'aiChatModel' | 'aiCsvModel', label: string, placeholder?: string) => (
    <TextSetting key={`${preset.id}-${field}`} className="w-64!" label={label} value={value} placeholder={placeholder} list="ai-models" onSave={(v) => configure({ [field]: v })} />
  )

  return (
    <Card>
      <CardHeader title={t('ai.title')} description={t('ai.hint')} />
      {s && (
        <Row label={t('ai.provider')} hint={preset.company ? t('ai.providerCloud', { company: preset.company }) : t('ai.providerLocal')}>
          <Select className="w-64!" aria-label={t('ai.provider')} value={s.aiProvider} onChange={(e) => { setModels([]); configure({ aiProvider: e.target.value as ProviderId }) }}>
            {PROVIDER_IDS.map((id) => <option key={id} value={id}>{PROVIDERS[id].name}{PROVIDERS[id].company ? '' : ` · ${t('ai.local')}`}</option>)}
          </Select>
        </Row>
      )}
      {s && preset.editableUrl && (
        <Row label={t('ai.baseUrl')} hint={preset.id === 'custom' ? t('ai.baseUrlCustomHint') : t('ai.baseUrlLocalHint', { url: preset.baseUrl })}>
          <TextSetting key={`${preset.id}-url`} className="w-72!" label={t('ai.baseUrl')} value={s.aiBaseUrl ?? ''} placeholder={preset.baseUrl || 'https://…/v1'} onSave={(v) => configure({ aiBaseUrl: v || null })} />
        </Row>
      )}
      {(preset.needsKey || preset.id === 'custom') && (
        <Row label={t('claude.apiKey')} hint={native ? t('claude.apiKeyHint') : preset.needsKey ? t('ai.keyHint', { name: preset.name }) : t('ai.keyOptional')}>
          <Badge tone={status?.keyHint ? 'accent' : 'neutral'}>{status?.keyHint ? t('claude.keySet', { hint: status.keyHint }) : t('claude.keyNotSet')}</Badge>
          <Button size="sm" icon={<KeyRound size={14} />} onClick={() => setKeyOpen(true)}>{status?.keyHint ? t('claude.replaceKey') : t('claude.addKey')}</Button>
          {status?.keyHint && <Button size="sm" variant="ghost" aria-label={t('claude.removeKey')} icon={<Trash2 size={14} />} onClick={() => void call('assistant.clearKey')} />}
        </Row>
      )}
      {s && native && (
        <>
          <Row label={t('claude.chat')} hint={t('claude.chatHint')}>
            {modelSelect(s.chatModel, (chatModel) => configure({ chatModel }), t('claude.chat'))}
            {effortSelect(s.chatEffort, (chatEffort) => configure({ chatEffort }), t('claude.effortLabel'))}
          </Row>
          <Row label={t('claude.csv')} hint={t('claude.csvHint')}>
            {modelSelect(s.csvModel, (csvModel) => configure({ csvModel }), t('claude.csv'))}
            {effortSelect(s.csvEffort, (csvEffort) => configure({ csvEffort }), t('claude.effortLabel'))}
          </Row>
          <div className="border-b border-border px-5 py-4 text-xs text-muted">{t('claude.privacy')}</div>
        </>
      )}
      {s && !native && (
        <>
          <datalist id="ai-models">{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
          <Row label={t('claude.chat')} hint={t('ai.chatModelHint')}>
            {modelInput(s.aiChatModel, 'aiChatModel', t('claude.chat'), preset.suggestedModels[0])}
          </Row>
          <Row label={t('claude.csv')} hint={t('ai.csvModelHint')}>
            {modelInput(s.aiCsvModel, 'aiCsvModel', t('claude.csv'), s.aiChatModel || preset.suggestedModels[0])}
          </Row>
          <Row label={t('ai.models')} hint={t('ai.modelsHint', { name: preset.id === 'custom' ? t('ai.theServer') : preset.name })}>
            <Button size="sm" disabled={loadingModels} onClick={loadModels}>{loadingModels ? t('ai.loadingModels') : t('ai.loadModels')}</Button>
          </Row>
          <div className="border-b border-border px-5 py-4 text-xs text-muted">{t('ai.note')}</div>
        </>
      )}
      {s && <McpRows enabled={s.mcpEnabled} onChange={(mcpEnabled) => configure({ mcpEnabled })} />}

      <Modal open={keyOpen} title={t('ai.addKeyFor', { name: preset.name })} onClose={() => setKeyOpen(false)}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            setBusy(true)
            void call('assistant.setKey', { apiKey: key, provider: preset.id })
              .then(() => {
                toast(t('claude.keySaved'))
                setKey('')
                setKeyOpen(false)
              })
              .catch((err) => toast(errText(err), 'error'))
              .finally(() => setBusy(false))
          }}
        >
          <p className="text-[13px] text-muted">{native ? t('claude.keyHelp') : t('ai.keyHelp', { name: preset.name })}</p>
          <Field label={t('claude.apiKey')}>{(id) => <Input id={id} type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder={preset.keyPlaceholder ?? ''} />}</Field>
          <div className="flex justify-between gap-2">
            {preset.keyUrl ? <a className="self-center text-[13px] font-medium text-accent hover:underline" href={preset.keyUrl} target="_blank" rel="noreferrer">{t('ai.getKey', { name: preset.name })}</a> : <span />}
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

/** A text field that saves when it loses focus or on Enter. */
function TextSetting({ value, onSave, label, className, placeholder, list }: { value: string; onSave: (v: string) => void; label: string; className?: string; placeholder?: string; list?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const save = (): void => {
    if (text.trim() !== value) onSave(text.trim())
  }
  return (
    <Input
      className={className}
      aria-label={label}
      value={text}
      placeholder={placeholder}
      list={list}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), save())}
    />
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
