import { Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, Segmented, Select, Switch } from '../../components/ui'
import { LANGUAGES } from '../../i18n'
import type { LanguageCode } from '@shared/languages'
import { call } from '../../lib/api'
import { useSettings } from '../../lib/settings'
import { GRAPHICS_CHOICES, type GraphicsChoice } from '@shared/graphics'
import { Row } from './Row'

export function AppearanceSection() {
  const { t } = useTranslation()
  const { prefs, updatePrefs } = useSettings()
  return (
    <Card>
      <CardHeader title={t('settings.appearance')} description={t('settings.appearanceHint')} />
      <Row label={t('settings.theme')}>
        <Segmented
          label={t('settings.theme')}
          value={prefs.theme}
          onChange={(theme) => void updatePrefs({ theme })}
          options={[
            { value: 'system', label: t('settings.themeSystem'), icon: <Monitor size={14} /> },
            { value: 'light', label: t('settings.themeLight'), icon: <Sun size={14} /> },
            { value: 'dark', label: t('settings.themeDark'), icon: <Moon size={14} /> }
          ]}
        />
      </Row>
      <Row label={t('settings.uiLanguage')} hint={t('settings.languageHint')}>
        <Select className="w-44" value={prefs.language} onChange={(e) => void updatePrefs({ language: e.target.value as LanguageCode })} aria-label={t('settings.uiLanguage')}>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </Select>
      </Row>
      <Row label={t('settings.keepInTray')} hint={t('settings.keepInTrayHint')}>
        <Switch label={t('settings.keepInTray')} checked={prefs.keepInTray} onChange={(v) => void updatePrefs({ keepInTray: v })} />
      </Row>
      <GraphicsRow />
    </Card>
  )
}

/** Drawing with or without the graphics card: some drivers (Windows on ARM) leave the window white. */
function GraphicsRow() {
  const { t } = useTranslation()
  const { prefs, updatePrefs, info } = useSettings()
  const [changed, setChanged] = useState(false)
  const now = info.graphics.hardware ? t('settings.graphics.nowOn') : t(`settings.graphics.nowOff.${info.graphics.reason ?? 'setting'}`)
  return (
    <Row label={t('settings.graphics.label')} hint={<>{now} {changed ? t('settings.graphics.restartHint') : t('settings.graphics.hint')}</>}>
      {changed && (
        <Button size="sm" onClick={() => void call('app.restart')}>
          {t('settings.graphics.restart')}
        </Button>
      )}
      <Select
        className="w-56"
        aria-label={t('settings.graphics.label')}
        value={prefs.graphics}
        onChange={(e) => {
          setChanged(true)
          void updatePrefs({ graphics: e.target.value as GraphicsChoice })
        }}
      >
        {GRAPHICS_CHOICES.map((c) => <option key={c} value={c}>{t(`settings.graphics.${c}`)}</option>)}
      </Select>
    </Row>
  )
}
