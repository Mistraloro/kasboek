import { useTranslation } from 'react-i18next'
import { Card, CardHeader, Select } from '../../components/ui'
import { formatDate, formatDateTime, formatMoney, formatNumber, type Fmt } from '../../lib/format'
import { CURRENCY_POSITIONS, CURRENCY_STYLES, DATE_PATTERNS, DECIMAL_SEPARATORS, GROUP_SEPARATORS, GROUPINGS, NEGATIVE_STYLES, TIME_FORMATS, formatTime, type CurrencyPosition, type CurrencyStyle, type DatePattern, type DecimalSeparator, type FormatPrefs, type GroupSeparator, type Grouping, type NegativeStyle, type TimeFormat } from '@shared/format'
import { useSettings } from '../../lib/settings'
import { Row } from './Row'

export function FormatsSection() {
  const { t } = useTranslation()
  const { prefs, updatePrefs, settings, fmt } = useSettings()
  const f = prefs.formats
  const set = (patch: Partial<FormatPrefs>): void => void updatePrefs({ formats: patch })
  const with_ = (patch: Partial<FormatPrefs>): Fmt => ({ ...fmt, formats: { ...f, ...patch } })
  const sample = new Date(2026, 0, 31, 14, 30)
  const cur = settings.currency
  const row = (label: string, value: string, options: { value: string; label: string; disabled?: boolean }[], onChange: (v: string) => void) => (
    <Row label={label}>
      <Select className="w-64!" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </Select>
    </Row>
  )
  return (
    <Card>
      <CardHeader
        title={t('settings.formats')}
        description={t('settings.formatsHint', { value: `${formatMoney(-123456789, cur, fmt)} · ${formatDateTime(sample, fmt)}` })}
      />
      {row(t('settings.decimalSeparator'), f.decimal, DECIMAL_SEPARATORS.map((d) => ({ value: d, label: `${t(`settings.sep.${sepKey(d)}`)}  (${formatNumber(1234.5, with_({ decimal: d, group: d === f.group ? (d === ',' ? '.' : ',') : f.group }))})` })), (v) => {
        const decimal = v as DecimalSeparator
        set(decimal === f.group ? { decimal, group: decimal === ',' ? '.' : ',' } : { decimal })
      })}
      {row(t('settings.groupSeparator'), f.group, GROUP_SEPARATORS.map((g) => ({ value: g, disabled: g === f.decimal, label: `${t(`settings.sep.${sepKey(g)}`)}  (${formatNumber(1234567, with_({ group: g }), 0)})` })), (v) => set({ group: v as GroupSeparator }))}
      {row(t('settings.grouping'), f.grouping, GROUPINGS.map((g) => ({ value: g, label: `${t(`settings.groupingOption.${g}`)}  (${formatNumber(12345678, with_({ grouping: g }), 0)})` })), (v) => set({ grouping: v as Grouping }))}
      {row(t('settings.currencyPosition'), f.currencyPosition, CURRENCY_POSITIONS.map((p) => ({ value: p, label: formatMoney(123450, cur, with_({ currencyPosition: p })) })), (v) => set({ currencyPosition: v as CurrencyPosition }))}
      {row(t('settings.currencyStyle'), f.currencyStyle, CURRENCY_STYLES.map((s) => ({ value: s, label: `${t(`settings.currencyStyleOption.${s}`)}  (${formatMoney(123450, cur, with_({ currencyStyle: s }))})` })), (v) => set({ currencyStyle: v as CurrencyStyle }))}
      {row(t('settings.negative'), f.negative, NEGATIVE_STYLES.map((n) => ({ value: n, label: formatMoney(-123450, cur, with_({ negative: n })) })), (v) => set({ negative: v as NegativeStyle }))}
      {row(t('settings.dateFormat'), f.date, DATE_PATTERNS.map((p) => ({ value: p, label: `${formatDate(sample, with_({ date: p }))}  (${p})` })), (v) => set({ date: v as DatePattern }))}
      {row(t('settings.timeFormat'), f.time, TIME_FORMATS.map((tf) => ({ value: tf, label: `${t(`settings.timeOption.${tf}`)}  (${formatTime(sample, { ...f, time: tf })})` })), (v) => set({ time: v as TimeFormat }))}
    </Card>
  )
}

function sepKey(s: string): string {
  return { '.': 'dot', ',': 'comma', ' ': 'space', "'": 'apostrophe', '': 'none' }[s] ?? 'none'
}
