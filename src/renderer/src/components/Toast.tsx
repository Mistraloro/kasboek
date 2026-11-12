import { CheckCircle2, AlertCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

type Tone = 'success' | 'error'
interface Toast {
  id: number
  tone: Tone
  message: string
}

const Ctx = createContext<(message: string, tone?: Tone) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((message: string, tone: Tone = 'success') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, tone, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500)
  }, [])
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-lg border border-border bg-surface px-4 py-3 text-[13px] shadow-lg">
            {t.tone === 'success' ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent" />
            ) : (
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-negative" />
            )}
            <span className="selectable">{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
