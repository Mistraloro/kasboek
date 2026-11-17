import { RefreshCw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MODEL_SEARCH_THRESHOLD, filterModels, modelOptions } from '@shared/model-options'
import { Button, Input, Select } from './ui'

const OTHER = '__other__'

/**
 * Picks a model from the full list (loaded and suggested), with a search box when the list is long and a way to
 * type a name the provider does not list. `emptyLabel` adds an option for "no model of its own".
 */
export function ModelPicker({
  value,
  loaded,
  suggested,
  label,
  placeholder,
  emptyLabel,
  loading,
  status,
  onChange,
  onReload
}: {
  value: string
  loaded: readonly string[]
  suggested: readonly string[]
  label: string
  placeholder?: string
  emptyLabel?: string
  loading: boolean
  /** A line under the field: what was found, what went wrong or what is missing. */
  status?: ReactNode
  onChange: (model: string) => void
  onReload: () => void
}) {
  const { t } = useTranslation()
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => setText(value), [value])
  const all = modelOptions(loaded, suggested, value)
  const shown = filterModels(all, query, value)
  // Some providers have no model list: then the name is simply typed.
  const noList = loaded.length === 0 && suggested.length === 0
  const typed = typing || noList
  const commit = (): void => {
    const v = text.trim()
    setTyping(false)
    if (v !== value && (v || emptyLabel)) onChange(v)
    else setText(value)
  }
  return (
    <div className="flex items-start gap-2">
      <div className="flex w-64 flex-col gap-1.5">
        {all.length > MODEL_SEARCH_THRESHOLD && <Input aria-label={t('ai.searchModels')} placeholder={t('ai.searchModels')} value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />}
        {typed ? (
          <Input
            aria-label={label}
            autoFocus={typing}
            value={text}
            spellCheck={false}
            placeholder={emptyLabel ?? placeholder ?? t('ai.typeModel')}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.preventDefault(), commit())
              else if (e.key === 'Escape') (setText(value), setTyping(false))
            }}
          />
        ) : (
          <Select
            aria-label={label}
            value={value}
            onChange={(e) => {
              if (e.target.value === OTHER) {
                setText('')
                setTyping(true)
              } else if (e.target.value !== value) onChange(e.target.value)
            }}
          >
            {(emptyLabel || !value) && <option value="">{emptyLabel ?? placeholder ?? ''}</option>}
            {shown.map((m) => <option key={m} value={m}>{m}</option>)}
            <option value={OTHER}>{t('ai.otherModel')}</option>
          </Select>
        )}
        {status && <div className="text-xs text-muted">{status}</div>}
      </div>
      <Button size="sm" variant="ghost" disabled={loading} aria-label={t('ai.reloadModels')} title={t('ai.reloadModels')} icon={<RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />} onClick={onReload} />
    </div>
  )
}
