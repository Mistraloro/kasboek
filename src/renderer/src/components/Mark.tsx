/** The Kasboek mark (see assets/brand/mark.svg). Uses the current text colour. */
export function Mark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={(size * 624) / 520} viewBox="240 200 520 624" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M492 512 L704 724" stroke="currentColor" strokeOpacity=".5" strokeWidth="120" strokeLinecap="round" />
      <path d="M492 512 L704 300" stroke="currentColor" strokeWidth="120" strokeLinecap="round" />
      <rect x="292" y="252" width="120" height="520" rx="60" />
    </svg>
  )
}
