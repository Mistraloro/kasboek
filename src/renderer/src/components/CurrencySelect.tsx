import { useMemo, type SelectHTMLAttributes } from 'react'
import { CURRENCIES } from '@shared/currency'
import { usePrefs } from '../lib/settings'
import { Select } from './ui'

/** All ISO currencies, named in the interface language ("USD — US Dollar"). */
export function CurrencySelect(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'>) {
  const { prefs } = usePrefs()
  const options = useMemo(() => {
    let names: Intl.DisplayNames | null = null
    try {
      names = new Intl.DisplayNames([prefs.language], { type: 'currency' })
    } catch {
      names = null
    }
    return CURRENCIES.map((c) => ({ code: c, label: `${c} — ${names?.of(c) ?? c}` }))
  }, [prefs.language])
  return (
    <Select {...props}>
      {options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
    </Select>
  )
}
