import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, Switch } from '../../components/ui'
import { call } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useSettings } from '../../lib/settings'
import { useUpdate } from '../../components/Update'
import { startTour } from '../../components/Tour'
import { Row } from './Row'

/** Version, data folder, updates and the tour. */
export function AboutSection() {
  const { t } = useTranslation()
  const { info } = useSettings()
  return (
    <Card>
      <CardHeader title={t('settings.about')} />
      <Row label={t('settings.dataFolder')} hint={<span className="selectable break-all">{info.dataDir}</span>}>
        <span className="text-[13px] text-muted">{t('settings.version', { version: info.commit ? `${info.version} (${info.commit})` : info.version })}</span>
      </Row>
      <UpdateRow />
      <Row label={t('tour.settingsLabel')} hint={t('tour.settingsHint')}>
        <Button size="sm" onClick={startTour}>{t('tour.show')}</Button>
      </Row>
    </Card>
  )
}

/** Whether Kasboek looks for new releases, and a manual check. */
function UpdateRow() {
  const { t } = useTranslation()
  const { prefs, updatePrefs, fmt } = useSettings()
  const u = useUpdate()
  const when = u?.lastCheckedAt ? formatDateTime(u.lastCheckedAt, fmt) : null
  const hint = !u?.supported
    ? t('update.devOnly')
    : u.state === 'checking'
      ? t('update.checking')
      : u.state === 'error'
        ? u.error
        : u.state === 'none'
          ? t('update.upToDate', { when })
          : u.latest && u.state !== 'idle'
            ? t('update.availableHint', { version: u.latest })
            : t('update.autoHint')
  return (
    <Row label={t('update.auto')} hint={hint}>
      <Button size="sm" disabled={!u?.supported || u.state === 'checking' || u.state === 'downloading'} onClick={() => void call('update.check')}>
        {t('update.checkNow')}
      </Button>
      <Switch label={t('update.auto')} checked={prefs.updateCheck} onChange={(v) => void updatePrefs({ updateCheck: v })} />
    </Row>
  )
}
