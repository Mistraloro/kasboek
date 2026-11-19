// Reference renderings of the design system's components with the REAL React components of the renderer
// (ui.tsx, charts.tsx, Toast.tsx, DateInput.tsx), laid out at the same absolute positions as the Slint cases in
// ui/cases.slint. Opened as harness.html?case=NAME&theme=light|dark by reference.mjs.
//
// `data-force="hover|focus"` marks elements whose :hover / :focus(-visible) state reference.mjs forces through the
// DevTools protocol, so every state of every component can be in one still.
import { StrictMode, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowLeftRight, Copy, Monitor, Moon, Plus, Sun } from 'lucide-react'
import '@renderer/styles.css'
import '@renderer/i18n'
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Modal, MonthNav, PageHeader, PasswordInput, Segmented, Select, Switch } from '@renderer/components/ui'
import { CategoryBars, Meter, MonthBars, TrendLine } from '@renderer/components/charts'
import { ToastProvider, useToast } from '@renderer/components/Toast'
import { DateInput } from '@renderer/components/DateInput'
import { PrefsProvider, SettingsProvider, applyThemeToDocument } from '@renderer/lib/settings'

const params = new URLSearchParams(location.search)
const name = params.get('case') ?? 'button'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
applyThemeToDocument(theme)

const at = (x: number, y: number, w?: number): CSSProperties => ({ position: 'absolute', left: x, top: y, width: w })
const A = ({ x, y, w, children }: { x: number; y: number; w?: number; children: ReactNode }) => <div style={at(x, y, w)}>{children}</div>
const eur = new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' })
const money = (c: number): string => eur.format(c / 100)
const compact = (c: number): string => (c === 0 ? '0' : `${c / 100000}k`)

function ButtonCase() {
  const variants = ['primary', 'secondary', 'ghost', 'danger'] as const
  return (
    <>
      {variants.map((v, r) => (
        <div key={v}>
          <A x={24} y={24 + r * 48}><Button variant={v}>Save</Button></A>
          <A x={184} y={24 + r * 48}><Button variant={v} data-force="hover">Save</Button></A>
          <A x={344} y={24 + r * 48}><Button variant={v} data-force="focus">Save</Button></A>
          <A x={504} y={24 + r * 48}><Button variant={v} disabled>Save</Button></A>
        </div>
      ))}
      <A x={24} y={216}><Button size="sm">Edit</Button></A>
      <A x={184} y={216}><Button icon={<Copy size={14} />}>Copy</Button></A>
      <A x={344} y={216}><Button variant="primary" icon={<Plus size={14} />}>Add account</Button></A>
    </>
  )
}

function InputCase() {
  return (
    <>
      <A x={24} y={24} w={432}><Input defaultValue="Groceries" aria-label="Description" /></A>
      <A x={24} y={72} w={432}><Input placeholder="Search transactions" aria-label="Search" /></A>
      <A x={24} y={120} w={432}><Input defaultValue="Groceries" aria-label="Description" data-force="focus" /></A>
      <A x={24} y={168} w={432}><Input defaultValue="Groceries" aria-label="Description" disabled /></A>
      <A x={24} y={216} w={432}><Input defaultValue="-1234,50" aria-label="Amount" className="num border-negative!" /></A>
    </>
  )
}

function PasswordCase() {
  return (
    <>
      <A x={24} y={24} w={432}><PasswordInput placeholder="Password" aria-label="Password" /></A>
      <A x={24} y={72} w={432}><PasswordInput defaultValue="correct horse" aria-label="Password" /></A>
      {/* The eye of this one is held down by reference.mjs. */}
      <A x={24} y={120} w={432}><PasswordInput defaultValue="correct horse" aria-label="Password" id="held" /></A>
      <A x={24} y={168} w={432}><PasswordInput defaultValue="correct horse" aria-label="Password" data-force="focus" /></A>
    </>
  )
}

function SelectCase() {
  const options = (
    <>
      <option value="eur">Euro</option>
      <option value="usd">US dollar</option>
      <option value="gbp">Pound sterling</option>
    </>
  )
  return (
    <>
      <A x={24} y={24} w={432}><Select defaultValue="eur" aria-label="Currency">{options}</Select></A>
      <A x={24} y={72} w={432}><Select defaultValue="usd" aria-label="Currency" data-force="focus">{options}</Select></A>
      <A x={24} y={120} w={432}><Select defaultValue="eur" aria-label="Currency" disabled>{options}</Select></A>
    </>
  )
}

function Seg({ options, initial, label, force }: { options: { value: string; label: string; icon?: ReactNode; disabled?: boolean }[]; initial: string; label: string; force?: boolean }) {
  const [v, setV] = useState(initial)
  return (
    <div data-force={force ? 'focus-selected' : undefined}>
      <Segmented value={v} onChange={setV} options={options} label={label} />
    </div>
  )
}

function SegmentedCase() {
  return (
    <>
      <A x={24} y={24}><Seg label="Period" initial="month" options={[{ value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }]} /></A>
      <A x={24} y={72}>
        <Seg label="Theme" initial="light" options={[{ value: 'system', label: 'System', icon: <Monitor size={14} /> }, { value: 'light', label: 'Light', icon: <Sun size={14} /> }, { value: 'dark', label: 'Dark', icon: <Moon size={14} /> }]} />
      </A>
      <A x={24} y={120}><Seg force label="Mode" initial="spending" options={[{ value: 'income', label: 'Income' }, { value: 'spending', label: 'Spending' }, { value: 'both', label: 'Both', disabled: true }]} /></A>
    </>
  )
}

function SwitchCase() {
  const noop = (): void => {}
  return (
    <>
      <A x={24} y={24}><Switch checked={false} onChange={noop} label="Insights" /></A>
      <A x={84} y={24}><Switch checked onChange={noop} label="Insights" /></A>
      <A x={144} y={24}><span data-force="focus-child"><Switch checked onChange={noop} label="Insights" /></span></A>
      <A x={204} y={24}><span style={{ opacity: 0.5 }}><Switch checked={false} onChange={noop} label="Insights" /></span></A>
      <A x={264} y={24}><span style={{ opacity: 0.5 }}><Switch checked onChange={noop} label="Insights" /></span></A>
    </>
  )
}

function BadgeCase() {
  return (
    <>
      <A x={24} y={24}><Badge>Neutral</Badge></A>
      <A x={120} y={24}><Badge tone="accent">Accent</Badge></A>
      <A x={208} y={24}><Badge tone="warning">Warning</Badge></A>
      <A x={304} y={24}><Badge tone="negative">Negative</Badge></A>
    </>
  )
}

function CardCase() {
  return (
    <A x={24} y={24} w={592}>
      <Card>
        <CardHeader title="Budget progress" description="Spent this month against your limits" action={<Button size="sm">Edit</Button>} />
        <div className="p-5 text-[13px]">Groceries are at 84% of the budget.</div>
      </Card>
    </A>
  )
}

function PageHeaderCase() {
  return (
    <A x={24} y={24} w={752}>
      <PageHeader title="Overview" subtitle="March 2026" action={<Button variant="primary">Import</Button>} />
    </A>
  )
}

function EmptyStateCase() {
  return (
    <A x={24} y={24} w={592}>
      <Card className="h-[248px]">
        <EmptyState icon={<ArrowLeftRight size={20} />} title="No transactions yet" body="Import a bank file or add a transaction by hand to see it here." action={<Button variant="primary">Go to import</Button>} />
      </Card>
    </A>
  )
}

function ModalCase({ ask }: { ask: boolean }) {
  return (
    <>
      <div style={{ ...at(40, 40), color: 'var(--text-muted)' }}>Page behind the dialog</div>
      <Modal open title="Add a note" onClose={() => {}} dirty={ask}>
        {ask ? (
          <div style={{ height: 40 }} />
        ) : (
          <>
            <Field label="Note" hint="Only you can see it.">{(id) => <Input id={id} defaultValue="Rent for March" />}</Field>
            <div className="mt-4 flex justify-end gap-2">
              <Button>Cancel</Button>
              <Button variant="primary">Save</Button>
            </div>
          </>
        )}
      </Modal>
    </>
  )
}

function MonthNavCase() {
  const [m, setM] = useState('2026-03')
  return <A x={24} y={24}><MonthNav month={m} label="March 2026" onChange={setM} /></A>
}

function Pusher() {
  const toast = useToast()
  useEffect(() => {
    toast('Copied to the clipboard.')
    toast('The backup could not be written: the folder is read-only.', 'error')
  }, [toast])
  return null
}

function DateCase() {
  return <A x={24} y={24} w={432}><DateInput value="" onChange={() => {}} /></A>
}

function TabsCase() {
  const tabs = ['General', 'Accounts', 'Security', 'Data', 'About']
  return (
    <A x={24} y={24} w={592}>
      <div role="tablist" aria-label="Settings" className="flex gap-1 border-b border-border">
        {tabs.map((t, i) => (
          <button key={t} type="button" role="tab" aria-selected={i === 1} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${i === 1 ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}`}>
            {t}
          </button>
        ))}
      </div>
    </A>
  )
}

function TableCase() {
  const rows: [string, string, string, string][] = [['05/03/2026', 'Supermarket', '-42.10', ''], ['04/03/2026', 'Salary', '2,450.00', 'bg-accent-soft/50'], ['02/03/2026', 'Water bill', '-18.40', '']]
  return (
    <A x={24} y={24} w={592}>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[12px] text-muted">
              <th className="w-28 py-3 pr-3 pl-5 font-medium" style={{ width: 116 }}>Date</th>
              <th className="px-3 py-3 font-medium">Description</th>
              <th className="w-32 py-3 pr-5 pl-3 text-right font-medium" style={{ width: 128 }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([d, desc, a, bg], i) => (
              <tr key={d} className={`border-b border-border last:border-b-0 hover:bg-surface-2/60 ${bg}`}>
                <td className="num py-2.5 pr-3 pl-5">{d}</td>
                <td className="px-3 py-2.5">{desc}</td>
                <td className="num py-2.5 pr-5 pl-3 text-right">{a}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </A>
  )
}

function MeterCase() {
  return (
    <>
      <A x={24} y={24} w={432}><Meter value={30} max={100} /></A>
      <A x={24} y={48} w={432}><Meter value={90} max={100} /></A>
      <A x={24} y={72} w={432}><Meter value={120} max={100} /></A>
      <A x={24} y={96} w={432}><Meter value={0} max={null} /></A>
      <A x={24} y={120} w={432}><Meter value={1} max={1000} /></A>
    </>
  )
}

function CategoryCase() {
  const rows = [['Groceries', 54200], ['Rent', 50000], ['Dining out', 18950], ['Transport', 9400], ['Subscriptions', 4599], ['Other', 300]] as [string, number][]
  return (
    <A x={24} y={24} w={592}>
      <Card className="p-5">
        <CategoryBars rows={rows.map(([n, c]) => ({ name: n, cents: c }))} format={money} />
      </Card>
    </A>
  )
}

function MonthBarsCase() {
  const d = [['Oct', 245000, 189000], ['Nov', 245000, 210500], ['Dec', 310000, 267300], ['Jan', 245000, 176000], ['Feb', 245000, 0], ['Mar', 0, 54200]] as [string, number, number][]
  return (
    <A x={24} y={24} w={592}>
      <Card className="p-5">
        <MonthBars data={d.map(([l, i, s]) => ({ month: l, label: l, income: i, spending: s }))} format={money} label="Income and spending per month" legend={{ income: 'Income', spending: 'Spending' }} />
      </Card>
    </A>
  )
}

function TrendCase() {
  const d = [['Jan', 0], ['Feb', 250000], ['Mar', 410000, 'Bonus'], ['Apr', 380000], ['May', 720000], ['Jun', 900000], ['Jul', 1200000]] as [string, number, string?][]
  return (
    <A x={24} y={24} w={592}>
      <Card className="p-5">
        <TrendLine data={d.map(([l, c, n]) => ({ key: l, label: l, cents: c, note: n }))} format={money} compact={compact} label="Net worth over time" />
      </Card>
    </A>
  )
}

const CASES: Record<string, () => ReactNode> = {
  button: () => <ButtonCase />,
  input: () => <InputCase />,
  password: () => <PasswordCase />,
  select: () => <SelectCase />,
  segmented: () => <SegmentedCase />,
  switch: () => <SwitchCase />,
  badge: () => <BadgeCase />,
  card: () => <CardCase />,
  pageheader: () => <PageHeaderCase />,
  emptystate: () => <EmptyStateCase />,
  modal: () => <ModalCase ask={false} />,
  'modal-ask': () => <ModalCase ask />,
  monthnav: () => <MonthNavCase />,
  toast: () => <Pusher />,
  date: () => <DateCase />,
  tabs: () => <TabsCase />,
  table: () => <TableCase />,
  meter: () => <MeterCase />,
  categorybars: () => <CategoryCase />,
  monthbars: () => <MonthBarsCase />,
  trendline: () => <TrendCase />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrefsProvider>
      <SettingsProvider>
        <ToastProvider>
          <div id="stage" style={{ position: 'fixed', inset: 0, background: 'var(--bg)' }}>{(CASES[name] ?? (() => null))()}</div>
        </ToastProvider>
      </SettingsProvider>
    </PrefsProvider>
  </StrictMode>
)
