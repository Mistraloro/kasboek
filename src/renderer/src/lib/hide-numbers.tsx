import { Eye, EyeOff } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { shownAccount, shownText } from '@shared/hide-numbers'
import { revealedAfter, type RevealEvent } from '@shared/password-reveal'
import { Input, cx } from '../components/ui'
import { useSettings } from './settings'

/**
 * Account numbers (IBANs, card-like numbers) are hidden on screen by default, in case someone is
 * watching. Every place in the renderer that shows one goes through <Iban>, <Masked> or <IbanInput>
 * (tests/hide-numbers.test.ts checks this). A reveal lasts while the eye is held down, never longer.
 * Nothing in the renderer copies an account number; the text on screen is what gets selected.
 */
export const useHideNumbers = (): boolean => useSettings().settings.hideAccountNumbers

/** Hold-to-reveal state: `shown` is true only while the eye is held (same rules as the password field). */
function useHoldReveal() {
  const { t } = useTranslation()
  const [shown, setShown] = useState(false)
  const apply = (event: RevealEvent): void => setShown((s) => revealedAfter(s, event))
  useEffect(() => {
    if (!shown) return
    const onBlur = (): void => setShown((s) => revealedAfter(s, { kind: 'window-blur' }))
    const onVisibility = (): void => setShown((s) => revealedAfter(s, { kind: 'visibility', hidden: document.hidden }))
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [shown])
  const label = t('settings.holdToShowNumber')
  const button = (className?: string): ReactNode => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={shown}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        apply({ kind: 'pointerdown' })
      }}
      onPointerUp={() => apply({ kind: 'pointerup' })}
      onPointerCancel={() => apply({ kind: 'pointercancel' })}
      onPointerLeave={() => apply({ kind: 'pointerleave' })}
      onBlur={() => apply({ kind: 'blur' })}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') e.preventDefault()
        apply({ kind: 'keydown', key: e.key })
      }}
      onKeyUp={(e) => apply({ kind: 'keyup', key: e.key })}
      className={cx('inline-flex h-5 w-5 shrink-0 touch-none items-center justify-center rounded align-middle text-muted select-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none', className)}
    >
      {shown ? <EyeOff size={12} aria-hidden /> : <Eye size={12} aria-hidden />}
    </button>
  )
  return { shown, button }
}

/** One account number (an IBAN): BE…1234 until the eye is held. */
export function Iban({ value, className }: { value: string; className?: string }) {
  const hidden = useHideNumbers()
  const { shown, button } = useHoldReveal()
  const text = shownAccount(value, hidden && !shown)
  return (
    <span className={cx('num', className)}>
      {text}
      {hidden && <span className="ml-1">{button()}</span>}
    </span>
  )
}

/** A free text that may hold account or card numbers: they show as BE…1234 / …1234 until the eye is held. The eye only appears when something is hidden. */
export function Masked({ text, className }: { text: string; className?: string }) {
  const hidden = useHideNumbers()
  const { shown, button } = useHoldReveal()
  const masked = shownText(text, hidden)
  const changed = masked !== text
  return (
    <span className={className}>
      {changed && !shown ? masked : text}
      {changed && <span className="ml-1">{button()}</span>}
    </span>
  )
}

/** Text the person did not choose to see revealed (chat bubbles, summaries): masked, without an eye. */
export function useMasked(text: string): string {
  return shownText(text, useHideNumbers())
}

/** The account number field: masked until it is focused or the eye is held, so editing always works on the real value. */
export function IbanInput({ value, onChange, id, placeholder, className }: { value: string; onChange: (v: string) => void; id?: string; placeholder?: string; className?: string }) {
  const hidden = useHideNumbers()
  const { shown, button } = useHoldReveal()
  const [focused, setFocused] = useState(false)
  const masked = hidden && !focused && !shown && value !== ''
  return (
    <div className="relative">
      <Input
        id={id}
        value={masked ? shownAccount(value, true) : value}
        readOnly={masked}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        autoComplete="off"
        className={cx(hidden && 'pr-10', className)}
      />
      {hidden && <span className="absolute top-1/2 right-1.5 -translate-y-1/2">{button('h-7 w-7')}</span>}
    </div>
  )
}
