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

/** About three round gridline values (1, 2 or 5 times a power of ten) inside lo..hi. */
function niceTicks(lo: number, hi: number): number[] {
  const raw = (hi - lo) / 3
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v)
  return out
}

/**
 * One value over time (net worth): a 2px line over a faint area, three recessive gridlines with
 * labels, and a crosshair with a tooltip on hover. One series, so no legend: the title names it.
 */
export function TrendLine({ data, format, compact, label }: { data: { key: string; label: string; cents: number; note?: string }[]; format: (c: number) => string; compact: (c: number) => string; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 560
  const H = 200
  const pad = { top: 12, bottom: 24, left: 56, right: 8 }
  if (!data.length) return null
  const values = data.map((d) => d.cents)
  let lo = Math.min(0, ...values)
  let hi = Math.max(0, ...values)
  if (lo === hi) hi = lo + 100
  const span = hi - lo
  lo -= span * 0.04
  hi += span * 0.06
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const x = (i: number): number => pad.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW)
  const y = (v: number): number => pad.top + plotH - ((v - lo) / (hi - lo)) * plotH
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.cents).toFixed(1)}`).join(' ')
  const zero = y(0)
  const area = `${line} L${x(data.length - 1).toFixed(1)},${zero.toFixed(1)} L${x(0).toFixed(1)},${zero.toFixed(1)} Z`
  const ticks = niceTicks(lo, hi)
  const every = Math.max(1, Math.ceil(data.length / 8))
  const h = hover !== null ? data[hover] : null
  const onMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * plotW
    setHover(Math.max(0, Math.min(data.length - 1, Math.round((px / plotW) * (data.length - 1)))))
  }
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" role="img" aria-label={label}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray="2 4" />
            <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" className="num fill-[var(--text-muted)] text-[11px]">{compact(v)}</text>
          </g>
        ))}
        {lo < 0 && <line x1={pad.left} x2={W - pad.right} y1={zero} y2={zero} stroke="var(--border-strong)" />}
        <path d={area} fill="var(--chart-spending)" opacity={0.1} />
        <path d={line} fill="none" stroke="var(--chart-spending)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) =>
          (i % every === 0 && data.length - 1 - i >= every) || i === data.length - 1 ? (
            <text key={d.key} x={x(i)} y={H - 6} textAnchor="middle" className="fill-[var(--text-muted)] text-[11px]">{d.label}</text>
          ) : null
        )}
        {h && hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + plotH} stroke="var(--border-strong)" />
            <circle cx={x(hover)} cy={y(h.cents)} r={4.5} fill="var(--chart-spending)" stroke="var(--surface)" strokeWidth={2} />
          </>
        )}
        <rect x={pad.left} y={0} width={plotW} height={H} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {h && hover !== null && (
        <Tip x={`${(x(hover) / W) * 100}%`} y={64}>
          <p className="mb-0.5 font-medium">{h.label}</p>
          <p className="num font-medium">{format(h.cents)}</p>
          {h.note && <p className="text-muted">{h.note}</p>}
        </Tip>
      )}
    </div>
  )
}
