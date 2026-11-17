import { Copy, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImportColumns, ImportMapping, ImportPreview } from '@shared/types'
import { Button, Field, Modal, Select, Switch } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { call } from '../../lib/api'
import { errText } from '../auth/parts'

const FIELDS: (keyof Omit<ImportColumns, 'description'>)[] = ['bookingDate', 'amount', 'debit', 'credit', 'direction', 'counterpartyName', 'counterpartyIban', 'communication', 'valueDate', 'currency', 'bankReference', 'status', 'balance']

export function MappingModal({ open, preview, onClose, onApplied }: { open: boolean; preview: ImportPreview; onClose: () => void; onApplied: (p: ImportPreview) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [m, setM] = useState<ImportMapping>(
    preview.mapping ?? { delimiter: ';', headerRow: 0, dateOrder: 'DMY', decimal: ',', invertSign: false, columns: { bookingDate: 0, amount: 1, description: [] } }
  )
  const header = preview.headers
  const col = (f: (typeof FIELDS)[number]): string => (m.columns[f] === undefined ? '' : String(m.columns[f]))
  const setCol = (f: (typeof FIELDS)[number], v: string): void => {
    const columns = { ...m.columns } as ImportColumns
    if (v === '') delete (columns as Partial<ImportColumns>)[f]
    else (columns as unknown as Record<string, number>)[f] = Number(v)
    setM({ ...m, columns })
  }
  const label = (i: number): string => `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''} · ${header[i] || t('import.column', { n: i + 1 })}${preview.sample[0]?.[i] ? `  (${preview.sample[0][i]!.slice(0, 24)})` : ''}`
  return (
    <Modal open={open} title={t('import.columns')} onClose={onClose}>
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
        <p className="text-[13px] text-muted">{t('import.columnsHint')}</p>
        {FIELDS.map((f) => (
          <Field key={f} label={t(`import.field.${f}`)}>
            {(id) => (
              <Select id={id} value={col(f)} onChange={(e) => setCol(f, e.target.value)}>
                <option value="">{f === 'bookingDate' ? t('import.pick') : t('import.none')}</option>
                {header.map((_, i) => <option key={i} value={i}>{label(i)}</option>)}
              </Select>
            )}
          </Field>
        ))}
        <div>
          <p className="mb-1.5 text-[13px] font-medium">{t('import.field.description')}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {header.map((h, i) => (
              <label key={i} className="flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" className="accent-[var(--accent)]" checked={m.columns.description.includes(i)} onChange={(e) => setM({ ...m, columns: { ...m.columns, description: e.target.checked ? [...m.columns.description, i] : m.columns.description.filter((x) => x !== i) } })} />
                {h || t('import.column', { n: i + 1 })}
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('import.dateOrder')}>{(id) => <Select id={id} value={m.dateOrder} onChange={(e) => setM({ ...m, dateOrder: e.target.value as ImportMapping['dateOrder'] })}><option value="DMY">31/12/2026</option><option value="YMD">2026-12-31</option><option value="MDY">12/31/2026</option></Select>}</Field>
          <Field label={t('import.decimal')}>{(id) => <Select id={id} value={m.decimal} onChange={(e) => setM({ ...m, decimal: e.target.value as ',' | '.' })}><option value=",">1.234,56</option><option value=".">1,234.56</option></Select>}</Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]"><Switch label={t('import.invert')} checked={m.invertSign} onChange={(v) => setM({ ...m, invertSign: v })} />{t('import.invert')}</label>
      </div>
      <div className="mt-4 flex justify-between gap-2 border-t border-border pt-4">
        <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => preview.mapping && setM(preview.mapping)}>{t('import.reset')}</Button>
        <div className="flex gap-2">
          <Button onClick={onClose}>{t('settings.cancel')}</Button>
          <Button variant="primary" icon={<Copy size={14} />} onClick={() => void call('import.remap', { sessionId: preview.sessionId, mapping: m }).then(onApplied, (e) => toast(errText(e), 'error'))}>{t('import.apply')}</Button>
        </div>
      </div>
    </Modal>
  )
}
