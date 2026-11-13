/**
 * Parses a money amount as people and Belgian banks write it:
 * "12,50", "-1.234,56", "1 234,56", "+12.00", "12,50-", "€ 3,20", "(4,00)". Returns cents or null.
 * `decimal` forces the decimal separator; 'auto' guesses from the last separator.
 */
export function parseAmount(input: string, decimal: ',' | '.' | 'auto' = 'auto', prefer: ',' | '.' = ','): number | null {
  let s = input.trim().replace(/[€$£\s  ]|EUR/gi, '')
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  if (s.endsWith('-')) {
    negative = !negative
    s = s.slice(0, -1)
  }
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  } else if (s.startsWith('+')) s = s.slice(1)
  if (!/^[\d.,']+$/.test(s)) return null

  let dec = decimal
  if (dec === 'auto') {
    const lastComma = s.lastIndexOf(',')
    const lastDot = s.lastIndexOf('.')
    if (lastComma >= 0 && lastDot >= 0) dec = lastComma > lastDot ? ',' : '.'
    else if (lastComma >= 0) dec = s.length - lastComma - 1 === 3 && (s.split(',').length > 2 || prefer === '.') ? '.' : ','
    else if (lastDot >= 0) dec = s.length - lastDot - 1 === 3 && (s.split('.').length > 2 || prefer === ',') ? ',' : '.'
    else dec = prefer
  }
  const thousands = dec === ',' ? /[.']/g : /[,']/g
  const normalized = s.replace(thousands, '').replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null
  const [whole, frac = ''] = normalized.split('.')
  if (frac.length > 2 && !/^0+$/.test(frac.slice(2))) return null
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2))
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}
