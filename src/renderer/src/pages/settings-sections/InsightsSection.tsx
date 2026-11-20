import { useTranslation } from 'react-i18next'
import { Button, Card, Switch } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { call } from '../../lib/api'
import { useAssistantEnabled, useSettings } from '../../lib/settings'
import { errText } from '../auth/parts'
import { Row } from './Row'

export function InsightsSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const { prefs, updatePrefs } = useSettings()
  const assistantEnabled = useAssistantEnabled()
  return (
    <Card>
      <Row label={t('settings.insights')} hint={t(assistantEnabled ? 'settings.insightsHint' : 'settings.insightsHintLocal')}>
        <Button size="sm" onClick={() => void call('insights.restoreDismissed').then(() => toast(t('settings.insightsRestored')), (e) => toast(errText(e), 'error'))}>
          {t('settings.insightsRestore')}
        </Button>
        <Switch label={t('settings.insights')} checked={prefs.insights} onChange={(v) => void updatePrefs({ insights: v })} />
      </Row>
    </Card>
  )
}
