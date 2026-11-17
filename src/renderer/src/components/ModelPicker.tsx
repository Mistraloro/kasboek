import { Check, ChevronDown, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { fieldText, initialHighlight, modelCounts, modelOptions, modelRows, moveHighlight } from '@shared/model-options'
import { Button, Input } from './ui'

/**
 * A combobox for a model: the field shows the current model and opens the full list. Typing filters the list
 * (the list says so) without changing anything until a row is picked; a name the provider does not list is
 * taken through the last row. `emptyLabel` adds a first row for "no model of its own".
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
  const id = useId()
  const listId = `${id}-list`
  const optionId = (i: number): string => `${id}-option-${i}`
  const [open, setOpen] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  // Some providers have no model list: then the name is simply typed.
  const noList = loaded.length === 0 && suggested.length === 0
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])

  const all = modelOptions(loaded, suggested, value)
  const rows = modelRows(all, filtering ? query : '', !!emptyLabel)
  const counts = modelCounts(all, filtering ? query : '')
  const fieldPlaceholder = filtering ? t('ai.filterModels') : (emptyLabel ?? placeholder ?? t('ai.typeModel'))

  useEffect(() => {
    if (open && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const close = (): void => {
    setOpen(false)
    setFiltering(false)
    setQuery('')
    setActive(-1)
  }
  const show = (): void => {
    if (open) return
    setOpen(true)
    setActive(initialHighlight(modelRows(all, '', !!emptyLabel), value))
  }
  const pick = (row: (typeof rows)[number] | undefined): void => {
    if (!row) return
    const model = row.kind === 'empty' ? '' : row.model
    close()
    if (model !== value) onChange(model)
  }

  if (noList) {
    const commit = (): void => {
      const v = text.trim()
      if (v !== value && (v || emptyLabel)) onChange(v)
      else setText(value)
    }
    return (
      <div className="flex items-start gap-2">
        <div className="flex w-64 flex-col gap-1.5">
          <Input
            aria-label={label}
            value={text}
            spellCheck={false}
            placeholder={emptyLabel ?? placeholder ?? t('ai.typeModel')}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.preventDefault(), commit())
              else if (e.key === 'Escape') setText(value)
            }}
          />
          {status && <div className="text-xs text-muted">{status}</div>}
        </div>
        <Button size="sm" variant="ghost" disabled={loading} aria-label={t('ai.reloadModels')} title={t('ai.reloadModels')} icon={<RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />} onClick={onReload} />
      </div>
    )
  }

  const rowText = (row: (typeof rows)[number]): string => (row.kind === 'empty' ? (emptyLabel ?? '') : row.kind === 'custom' ? t('ai.useTyped', { name: row.model }) : row.model)
  const hasModelRows = rows.some((r) => r.kind === 'model')

  return (
    <div className="flex items-start gap-2">
      <div className="flex w-64 flex-col gap-1.5">
        <div className="relative">
          <Input
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
            autoComplete="off"
            spellCheck={false}
            className={filtering ? 'border-accent pr-8' : 'pr-8'}
            value={fieldText(value, query, filtering)}
            placeholder={fieldPlaceholder}
            onFocus={(e) => {
              e.currentTarget.select()
              show()
            }}
            onClick={show}
            onBlur={close}
            onChange={(e) => {
              if (!open) setOpen(true)
              setFiltering(true)
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (!open) show()
                else setActive(moveHighlight(active, e.key === 'ArrowDown' ? 1 : -1, rows.length))
              } else if (e.key === 'Enter') {
                if (open) {
                  e.preventDefault()
                  pick(rows[active])
                }
              } else if (e.key === 'Escape' && open) {
                e.preventDefault()
                e.stopPropagation()
                close()
              }
            }}
          />
          <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted" aria-hidden>
            {filtering ? <Search size={14} /> : <ChevronDown size={14} />}
          </span>
          {open && (
            <div
              className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-surface text-sm shadow-lg"
              // Keep the focus in the field while the list is used.
              onMouseDown={(e) => e.preventDefault()}
            >
              {counts && (
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs text-muted">
                  <span aria-live="polite">{t('ai.modelsShowing', { shown: counts.shown, count: counts.total })}</span>
                  <button
                    type="button"
                    aria-label={t('ai.clearFilter')}
                    title={t('ai.clearFilter')}
                    onClick={() => {
                      setQuery('')
                      setActive(0)
                    }}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                  >
                    <X size={12} aria-hidden />
                  </button>
                </div>
              )}
              {filtering && !hasModelRows && <div className="px-3 py-2 text-xs text-muted">{t('ai.noModelMatch')}</div>}
              <ul id={listId} role="listbox" aria-label={label} className="max-h-60 overflow-y-auto py-1">
                {rows.map((row, i) => {
                  const selected = row.kind === 'empty' ? !value : row.kind === 'model' && row.model === value
                  return (
                    <li
                      key={`${row.kind}-${row.kind === 'empty' ? '' : row.model}`}
                      id={optionId(i)}
                      role="option"
                      aria-selected={selected}
                      onMouseMove={() => active !== i && setActive(i)}
                      onClick={() => pick(row)}
                      className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 ${i === active ? 'bg-surface-2 text-text' : 'text-text'} ${row.kind === 'custom' ? 'border-t border-border' : ''}`}
                    >
                      <span className="truncate">{rowText(row)}</span>
                      {selected && <Check size={14} className="shrink-0 text-accent" aria-hidden />}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
        {status && <div className="text-xs text-muted">{status}</div>}
      </div>
      <Button size="sm" variant="ghost" disabled={loading} aria-label={t('ai.reloadModels')} title={t('ai.reloadModels')} icon={<RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />} onClick={onReload} />
    </div>
  )
}
