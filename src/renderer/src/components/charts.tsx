import { useState, type ReactNode } from 'react'

/** Small hover card. Text uses text colours; the swatch carries identity. */
function Tip({ x, y, children }: { x: number | string; y: number; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg" style={{ left: x, top: y - 8 }}>
      {children}
    </div>
  )
}

const Swatch = ({ color }: { color: string }) => <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />

/** Spending per category: one series, so one hue and no legend. Values labelled at the bar end. */
export function CategoryBars({ rows, format, max = 8 }: { rows: { name: string; cents: number }[]; format: (c: number) => string; max?: number }) {
  const shown = rows.slice(0, max)
  const rest = rows.slice(max).reduce((s, r) => s + r.cents, 0)
  if (rest > 0) shown.push({ name: 'Other', cents: rest })
  const top = Math.max(...shown.map((r) => r.cents), 1)
  return (
    <ul className="flex flex-col gap-2.5" aria-label="Spending by category">
      {shown.map((r) => (
        <li key={r.name} className="grid grid-cols-[120px_1fr_auto] items-center gap-3 text-[13px]" title={`${r.name}: ${format(r.cents)}`}>
          <span className="truncate text-muted">{r.name}</span>
          <span className="h-3 rounded-r-[4px] bg-chart-spending" style={{ width: `${Math.max(1.5, (r.cents / top) * 100)}%` }} />
          <span className="num text-right font-medium">{format(r.cents)}</span>
        </li>
      ))}
    </ul>
  )
}

/** Income vs spending per month: two series side by side on one axis, with a legend and hover details. */
export function MonthBars({
  data,
  format,
  label,
  legend
}: {
  data: { month: string; label: string; income: number; spending: number }[]
  format: (c: number) => string
  label: string
  legend: { income: string; spending: string }
}) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 560
  const H = 180
  const pad = { top: 10, bottom: 24, left: 0, right: 0 }
  const top = Math.max(...data.flatMap((d) => [d.income, d.spending]), 1)
  const plotH = H - pad.top - pad.bottom
  const slot = W / data.length
  const barW = Math.min(22, slot / 3.2)
  const y = (v: number): number => pad.top + plotH - (v / top) * plotH
  const bar = (x: number, v: number, cls: string) => {
    const h = Math.max(v > 0 ? 2 : 0, (v / top) * plotH)
    const r = Math.min(4, h / 2, barW / 2)
    const y0 = pad.top + plotH
    // Rounded top, square base anchored to the baseline.
    return <path className={cls} d={`M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + barW - r} Q${x + barW},${y0 - h} ${x + barW},${y0 - h + r} V${y0} Z`} />
  }
  const h = hover !== null ? data[hover] : null
  return (
    <div>
      <div className="mb-3 flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><Swatch color="var(--chart-income)" />{legend.income}</span>
        <span className="flex items-center gap-1.5"><Swatch color="var(--chart-spending)" />{legend.spending}</span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" role="img" aria-label={label}>
          {[0.5, 1].map((f) => (
            <line key={f} x1={0} x2={W} y1={y(top * f)} y2={y(top * f)} stroke="var(--border)" strokeDasharray="2 4" />
          ))}
          <line x1={0} x2={W} y1={pad.top + plotH} y2={pad.top + plotH} stroke="var(--border-strong)" />
          {data.map((d, i) => {
            const cx = slot * i + slot / 2
            return (
              <g key={d.month} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={slot * i} y={0} width={slot} height={H} fill={hover === i ? 'var(--surface-2)' : 'transparent'} rx={6} />
                {bar(cx - barW - 1, d.income, 'fill-chart-income')}
                {bar(cx + 1, d.spending, 'fill-chart-spending')}
                <text x={cx} y={H - 6} textAnchor="middle" className="fill-[var(--text-muted)] text-[11px]">{d.label}</text>
              </g>
            )
          })}
        </svg>
        {h && hover !== null && (
          <Tip x={`${((hover + 0.5) / data.length) * 100}%`} y={0}>
            <p className="mb-1 font-medium">{h.label}</p>
            <p className="flex items-center gap-1.5"><Swatch color="var(--chart-income)" />{legend.income}: <span className="num font-medium">{format(h.income)}</span></p>
            <p className="flex items-center gap-1.5"><Swatch color="var(--chart-spending)" />{legend.spending}: <span className="num font-medium">{format(h.spending)}</span></p>
          </Tip>
        )}
      </div>
    </div>
  )
}

/** Budget meter: spent against budget. Over budget switches to the negative colour and says so in text. */
export function Meter({ value, max }: { value: number; max: number | null }) {
  if (!max) return <div className="h-1.5 w-full rounded-full bg-surface-2" />
  const pct = Math.min(100, (value / max) * 100)
  const over = value > max
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuenow={value} aria-valuemax={max} aria-valuemin={0}>
      <div className={over ? 'h-full rounded-full bg-negative' : pct > 85 ? 'h-full rounded-full bg-warning' : 'h-full rounded-full bg-accent'} style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%` }} />
    </div>
  )
}
