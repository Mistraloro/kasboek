import { CheckCircle2, ListChecks, RotateCcw, Sparkles, Undo2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { CheckPart, ImportPreview } from '@shared/types'
import { Button, Card } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { call } from '../../lib/api'
import { Iban, Masked } from '../../lib/hide-numbers'
import { useSettings } from '../../lib/settings'
import { errText } from '../auth/parts'

/** What Check did (each part can be undone) and what it proposes for later imports and older transactions. */
export function CheckSummaryCard({ preview, onChange }: { preview: ImportPreview; onChange: (p: ImportPreview) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { money } = useSettings()
  const c = preview.check!
  const [rules, setRules] = useState<Set<number>>(() => new Set(c.rules.map((r) => r.id)))
  const [existing, setExisting] = useState<Set<number>>(() => new Set(c.existing.map((e) => e.id)))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setRules(new Set(c.rules.map((r) => r.id)))
    setExisting(new Set(c.existing.map((e) => e.id)))
  }, [c.rules, c.existing])
  const undo = (part: CheckPart): void => void call('import.checkUndo', { sessionId: preview.sessionId, part }).then(onChange, (e) => toast(errText(e), 'error'))
  const toggle = (set: Set<number>, id: number, on: boolean): Set<number> => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }
  const line = (text: string, part: CheckPart | null): ReactNode => (
    <li className="flex items-center gap-2">
      <CheckCircle2 size={14} className="shrink-0 text-accent" />
      <span className="flex-1">{text}</span>
      {part && <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} onClick={() => undo(part)}>{t('import.undoPart')}</Button>}
    </li>
  )
  const done = [
    c.categorised > 0 && line(t('import.check.categorised', { count: c.categorised }), 'categories'),
    c.renamed > 0 && line(t('import.check.renamed', { count: c.renamed }), 'names'),
    c.fixed > 0 && line(t('import.check.fixed', { count: c.fixed }), 'fixes'),
    c.mappingChanged && line(t('import.check.mapping'), null),
    c.applied && line(t('import.check.saved', { rules: c.applied.rules, count: c.applied.categorised }), null)
  ].filter(Boolean)
  const picked = rules.size + existing.size
  const apply = (): void => {
    setBusy(true)
    void call('import.checkApply', { sessionId: preview.sessionId, rules: [...rules], existing: [...existing] })
      .then((r) => {
        onChange(r.preview)
        toast(t('import.check.applied', { rules: r.rules, count: r.categorised }) + (r.skipped ? ` ${t('import.check.skippedSince', { count: r.skipped })}` : ''))
      }, (e) => toast(errText(e), 'error'))
      .finally(() => setBusy(false))
  }
  return (
    <Card className="mb-4 px-5 py-4 text-[13px]">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={15} className="text-accent" />
        <h3 className="flex-1 font-semibold">{t('import.check.title', { name: c.by })}</h3>
        <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => undo('all')}>{t('import.check.undoAll')}</Button>
      </div>
      {c.alreadyImported > 0 && <p className="mb-2 text-muted">{t('import.check.already', { count: c.alreadyImported, total: c.total })}</p>}
      {done.length > 0 ? <ul className="space-y-1">{done}</ul> : <p className="text-muted">{t('import.check.nothingChanged')}</p>}
      {(c.rules.length > 0 || c.existing.length > 0) && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 flex items-center gap-2 font-medium"><ListChecks size={14} /> {t('import.check.proposals')}</p>
          {c.existing.length > 0 && (
            <>
              <p className="mb-1 text-xs text-muted">{t('import.check.existingTitle')}</p>
              <ul className="mb-3 max-h-48 space-y-1 overflow-y-auto">
                {c.existing.map((e) => (
                  <li key={e.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="accent-[var(--accent)]" checked={existing.has(e.id)} onChange={(ev) => setExisting((s) => toggle(s, e.id, ev.target.checked))} />
                      <span className="min-w-0 flex-1 truncate"><span className="font-medium">{e.label}</span> → {e.categoryName}</span>
                      <span className="num text-muted">{t('import.check.count', { count: e.count })} · {money(e.totalCents, preview.currency)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          {c.rules.length > 0 && (
            <>
              <p className="mb-1 text-xs text-muted">{t('import.check.rulesTitle')}</p>
              <ul className="mb-3 max-h-48 space-y-1 overflow-y-auto">
                {c.rules.map((r) => (
                  <li key={r.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="accent-[var(--accent)]" checked={rules.has(r.id)} onChange={(ev) => setRules((s) => toggle(s, r.id, ev.target.checked))} />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-muted">{t(`budgets.field.${r.field}`)} {t(`budgets.match.${r.match}`)}</span> “{r.field === 'iban' ? <Iban value={r.pattern} /> : <Masked text={r.pattern} />}” → <span className="font-medium">{r.categoryName}</span>
                      </span>
                      <span className="num text-muted">{t('import.check.ruleReach', { here: r.rowsHere, existing: r.existing })}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex justify-end">
            <Button size="sm" variant="primary" disabled={!picked || busy} onClick={apply}>{t('import.check.apply', { rules: rules.size, groups: existing.size })}</Button>
          </div>
        </div>
      )}
      {c.dropped.length > 0 && (
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer">{t('import.check.dropped', { count: c.dropped.length })}</summary>
          <ul className="mt-1 list-disc pl-5">{c.dropped.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </details>
      )}
    </Card>
  )
}
