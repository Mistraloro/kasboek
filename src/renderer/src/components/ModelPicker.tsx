import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
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
  onChange: (model: string) => void
  onReload: () => void
}) {
  const { t } = useTranslation()
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const all = modelOptions(loaded, suggested, value)
  const shown = filterModels(all, query, value)
  const commit = (): void => {
    const v = text.trim()
    setTyping(false)
    if (v && v !== value) onChange(v)
  }
  return (
    <div className="flex items-center gap-2">
      <div className="flex w-64 flex-col gap-1.5">
        {all.length > MODEL_SEARCH_THRESHOLD && <Input aria-label={t('ai.searchModels')} placeholder={t('ai.searchModels')} value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />}
        {typing ? (
          <Input
            aria-label={label}
            autoFocus
            value={text}
            spellCheck={false}
            placeholder={t('ai.typeModel')}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.preventDefault(), commit())
              else if (e.key === 'Escape') setTyping(false)
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
      </div>
      <Button size="sm" variant="ghost" disabled={loading} aria-label={t('ai.reloadModels')} title={t('ai.reloadModels')} icon={<RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />} onClick={onReload} />
    </div>
  )
}
