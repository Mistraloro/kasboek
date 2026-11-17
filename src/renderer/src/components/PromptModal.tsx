import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Input, Modal } from './ui'

/**
 * Asks for one line of text in a dialog (Electron has no window.prompt). Enter sends, Escape cancels, and a
 * text `validate` refuses shows its message under the field. Shown by rendering it; `onSubmit` gets the
 * trimmed text and the dialog closes after it. Backdrop clicks do not close it, like every dialog.
 */
export function PromptModal({
  title,
  label,
  initialValue = '',
  submitLabel,
  hint,
  validate,
  onSubmit,
  onClose
}: {
  title: string
  label: string
  initialValue?: string
  submitLabel: string
  hint?: string
  /** The message to show for a text that cannot be used, or null when it is fine. */
  validate?: (text: string) => string | null
  onSubmit: (text: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const [text, setText] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const value = text.trim()
    if (!value) return
    const problem = validate?.(value) ?? null
    if (problem) return setError(problem)
    onSubmit(value)
    onClose()
  }
  return (
    <Modal open title={title} onClose={onClose}>
      <form className="flex flex-col gap-4 text-[13px]" onSubmit={submit}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="font-medium">
            {label}
          </label>
          <Input
            id={id}
            autoFocus
            value={text}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
            onChange={(e) => {
              setText(e.target.value)
              setError(null)
            }}
          />
          {error ? (
            <p id={`${id}-error`} role="alert" className="text-xs text-negative">
              {error}
            </p>
          ) : (
            hint && (
              <p id={`${id}-hint`} className="text-xs text-muted">
                {hint}
              </p>
            )
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {t('settings.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
