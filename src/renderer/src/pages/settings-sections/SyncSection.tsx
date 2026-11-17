import { FolderInput, FolderOpen, FolderSync, Server } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type PickedTransfer, type SyncStatus } from '@shared/types'
import { Badge, Button, Card, CardHeader, Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { ApiError, call } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { formatDateTime } from '../../lib/format'
import { useSettings } from '../../lib/settings'
import { ImportFlow } from '../auth/ImportFlow'
import { WebDavModal } from '../../components/WebDav'
import { errText } from '../auth/parts'
import { Row } from './Row'

export function SyncSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const { fmt } = useSettings()
  const { set } = useAuth()
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [joining, setJoining] = useState<PickedTransfer | null>(null)
  const [joinNotice, setJoinNotice] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [showConflicts, setShowConflicts] = useState(false)
  const [dav, setDav] = useState<'start' | 'join' | 'attach' | null>(null)
  useEffect(() => {
    void call('sync.status').then(setStatus)
    return window.kasboek.onEvent((e) => e.type === 'sync.updated' && setStatus(e.status))
  }, [])
  const run = (p: Promise<SyncStatus>): void => void p.then(setStatus, (e) => (e instanceof ApiError && e.code === 'sync.cancelled' ? undefined : toast(errText(e), 'error')))
  if (!status) return null
  const others = status.devices.filter((d) => !d.thisComputer)
  return (
    <Card>
      <CardHeader title={t('sync.title')} description={t('sync.hint')} />
      {status.state === 'off' && (
        <>
          <Row label={t('sync.start')} hint={t('sync.startHint')}>
            <Button size="sm" variant="primary" icon={<FolderSync size={14} />} onClick={() => run(call('sync.start'))}>{t('sync.startButton')}</Button>
          </Row>
          <Row label={t('webdav.start')} hint={t('webdav.startHint')}>
            <Button size="sm" icon={<Server size={14} />} onClick={() => setDav('start')}>{t('webdav.choose')}</Button>
          </Row>
          <Row label={t('sync.join')} hint={t('sync.joinHint')}>
            <Button size="sm" icon={<Server size={14} />} onClick={() => setDav('join')}>{t('webdav.join')}</Button>
            <Button size="sm" icon={<FolderInput size={14} />} onClick={() => void call('sync.pickJoin').then(setJoining, (e) => (e instanceof ApiError && e.code === 'sync.cancelled' ? undefined : toast(errText(e), 'error')))}>{t('sync.joinFolder')}</Button>
          </Row>
          <div className="px-5 py-4 text-xs text-muted">{t('sync.risk')}</div>
        </>
      )}
      {status.state === 'detached' && (
        <Row label={t('sync.detached')} hint={t('sync.detachedHint')}>
          <Button size="sm" icon={<Server size={14} />} onClick={() => setDav('attach')}>{t('webdav.choose')}</Button>
          <Button size="sm" variant="primary" icon={<FolderOpen size={14} />} onClick={() => run(call('sync.attach'))}>{t('sync.chooseFolder')}</Button>
        </Row>
      )}
      {status.state === 'on' && (
        <>
          <Row label={status.kind === 'webdav' ? t('webdav.server') : t('sync.folder')} hint={<span className="selectable break-all">{status.folder}</span>}>
            <Badge tone={status.error ? 'warning' : 'accent'}>{status.busy ? t('sync.syncing') : status.error ? t('sync.problem') : t('sync.on')}</Badge>
            <Button size="sm" disabled={status.busy} onClick={() => run(call('sync.now'))}>{t('sync.now')}</Button>
          </Row>
          {status.error && <p className="border-b border-border px-5 py-3 text-[13px] text-warning">{status.error}</p>}
          <Row label={t('sync.computers')} hint={status.lastSyncAt ? t('sync.last', { date: formatDateTime(status.lastSyncAt, fmt) }) : undefined}>
            <div className="flex flex-col items-end gap-0.5 text-[13px]">
              {status.devices.map((d) => (
                <span key={d.id}>
                  <span className="font-medium">{d.label}</span>
                  <span className="text-muted"> · {d.thisComputer ? t('sync.thisComputer') : d.lastSeen ? formatDateTime(d.lastSeen, fmt) : '—'}</span>
                </span>
              ))}
              {!others.length && <span className="text-muted">{t('sync.noOthers')}</span>}
            </div>
          </Row>
          {status.conflicts.length > 0 && (
            <Row label={t('sync.conflicts', { count: status.conflicts.length })} hint={t('sync.conflictsHint')}>
              <Button size="sm" onClick={() => setShowConflicts(true)}>{t('sync.show')}</Button>
            </Row>
          )}
          <Row label={t('sync.stop')} hint={t('sync.stopHint')}>
            <Button size="sm" variant="ghost" onClick={() => setConfirmStop(true)}>{t('sync.stopButton')}</Button>
          </Row>
        </>
      )}
      <WebDavModal
        open={!!dav}
        title={dav === 'join' ? t('sync.join') : dav === 'attach' ? t('sync.detached') : t('webdav.start')}
        submit={dav === 'join' ? t('webdav.joinSubmit') : t('webdav.startSubmit')}
        onClose={() => setDav(null)}
        onSubmit={(webdav) =>
          dav === 'join'
            ? call('sync.pickJoin', { webdav }).then(setJoining)
            : call(dav === 'attach' ? 'sync.attach' : 'sync.start', { webdav }).then(setStatus)
        }
      />
      <Modal open={!!joining} title={t('sync.join')} onClose={() => setJoining(null)} dismissible={!joinNotice}>
        {joining && <ImportFlow replacing preset={joining} onNotice={setJoinNotice} onCancel={() => setJoining(null)} onDone={(s) => { setJoining(null); set(s); window.location.reload() }} />}
      </Modal>
      <Modal open={confirmStop} title={t('sync.stop')} onClose={() => setConfirmStop(false)}>
        <p className="text-[13px] text-muted">{t('sync.stopConfirm')}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setConfirmStop(false)}>{t('settings.cancel')}</Button>
          <Button variant="danger" onClick={() => { setConfirmStop(false); run(call('sync.stop')) }}>{t('sync.stopButton')}</Button>
        </div>
      </Modal>
      <Modal open={showConflicts} title={t('sync.conflictsTitle')} onClose={() => setShowConflicts(false)} closeOnBackdrop>
        <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto text-[13px]">
          {status.conflicts.map((c) => (
            <li key={c.id} className="rounded-lg bg-surface-2 px-3 py-2">
              <p>{c.summary}</p>
              <p className="text-xs text-muted">{formatDateTime(c.at, fmt)}</p>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setShowConflicts(false)}>{t('settings.cancel')}</Button>
          <Button variant="primary" onClick={() => { setShowConflicts(false); run(call('sync.dismissConflicts')) }}>{t('sync.dismiss')}</Button>
        </div>
      </Modal>
    </Card>
  )
}
