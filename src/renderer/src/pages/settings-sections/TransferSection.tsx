import { Download, Upload } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { call } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { ImportFlow } from '../auth/ImportFlow'
import { errText } from '../auth/parts'
import { Row } from './Row'

export function TransferSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const { set } = useAuth()
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState(false)
  return (
    <Card>
      <CardHeader title={t('transfer.title')} description={t('transfer.hint')} />
      <Row label={t('transfer.export')} hint={t('transfer.exportHint')}>
        <Button
          size="sm"
          variant="primary"
          icon={<Download size={14} />}
          onClick={() => void call('transfer.export').then((r) => r.file && toast(t('transfer.exported', { file: r.file })), (e) => toast(errText(e), 'error'))}
        >
          {t('transfer.exportButton')}
        </Button>
      </Row>
      <Row label={t('transfer.import')} hint={t('transfer.importHint')}>
        <Button size="sm" icon={<Upload size={14} />} onClick={() => setImporting(true)}>{t('transfer.importButton')}</Button>
      </Row>
      <Modal open={importing} title={t('transfer.import')} onClose={() => setImporting(false)} dismissible={!notice}>
        {importing && <ImportFlow replacing onNotice={setNotice} onCancel={() => setImporting(false)} onDone={(s) => { setImporting(false); set(s); window.location.reload() }} />}
      </Modal>
    </Card>
  )
}
