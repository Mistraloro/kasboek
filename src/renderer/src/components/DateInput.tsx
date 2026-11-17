import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { checkDateText, dateExample, datePlaceholder } from '@shared/format'
import { formatDate } from '../lib/format'
import { useSettings } from '../lib/settings'
import { Input } from './ui'

/**
 * A date field that shows and reads dates in the format chosen in Settings. `value` and `onChange`
 * use ISO "YYYY-MM-DD"; `onChange` gets '' while the text is empty or not a usable date; `usable` is false only when text was typed that cannot be used.
 */
export function DateInput({ id, value, onChange, max, required }: { id?: string; value: string; onChange: (iso: string, usable: boolean) => void; max?: string; required?: boolean }) {
  const { t } = useTranslation()
  const { fmt } = useSettings()
  const [text, setText] = useState(value ? formatDate(value, fmt) : '')
  const [left, setLeft] = useState(false)
  const check = checkDateText(text, fmt.formats, fmt.language, max)

  // Follow outside changes (a reset after saving, a new format) but not our own typing.
  useEffect(() => {
    if (value !== check.iso) setText(value ? formatDate(value, fmt) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, fmt.formats.date, fmt.language])

  const shown = left && check.problem
  return (
    <>
      <Input
        id={id}
        value={text}
        required={required}
        placeholder={datePlaceholder(fmt.formats)}
        aria-invalid={shown ? true : undefined}
        className={shown ? 'num border-negative!' : 'num'}
        onChange={(e) => {
          setText(e.target.value)
          setLeft(false)
          const next = checkDateText(e.target.value, fmt.formats, fmt.language, max)
          onChange(next.iso, next.problem === null)
        }}
        onBlur={() => setLeft(true)}
      />
      {shown && (
        <p className="text-xs text-negative">
          {check.problem === 'tooLate' ? t('dateInput.tooLate', { date: formatDate(max!, fmt) }) : t('dateInput.invalid', { format: datePlaceholder(fmt.formats), example: dateExample(fmt.formats, fmt.language) })}
        </p>
      )}
    </>
  )
}
