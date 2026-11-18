import { it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { makePdf, type PdfPageSpec } from '../../../../tests/helpers/make-pdf'
import { STATEMENT_PAGES } from '../../../../tests/helpers/statement-pdf'
import { blockPages, turnedPages, TXS } from './layouts'

const OUT = process.env.CORPUS_DIR!
const w = (n: string, b: Uint8Array) => writeFileSync(`${OUT}/${n}.pdf`, b)
it('corpus', () => {
  w('ts_statement', makePdf(STATEMENT_PAGES))
  w('ts_statement_flate', makePdf(STATEMENT_PAGES, { flate: true }))
  w('ts_encrypted', makePdf(STATEMENT_PAGES, { encrypted: true }))
  w('ts_filler_bomb', makePdf([{}], { flate: true, filler: 4 * 1024 * 1024 }))
  w('ts_blocks', makePdf(blockPages(TXS), { flate: true }))
  w('ts_turned3', makePdf(turnedPages(3).pages))
  w('ts_turned71', makePdf(turnedPages(71).pages, { flate: true }))
  // 71 pages x 60 rows like the "thousands of lines" test, as real text pieces
  const pages: PdfPageSpec[] = []
  let n = 0
  for (let p = 0; p < 71; p++) {
    const texts: NonNullable<PdfPageSpec['texts']> = [{ x: 40, y: 800, text: 'Rekeningafschrift van Voorbeeld' }, { x: 40, y: 788, text: 'Datum' }, { x: 110, y: 788, text: 'Omschrijving' }, { x: 400, y: 788, text: 'Bedrag' }]
    for (let r = 0; r < 60; r++) {
      n++
      const y = 776 - r * 12
      texts.push({ x: 40, y, text: `${String(1 + (n % 28)).padStart(2, '0')}/11/2026` }, { x: 110, y, text: `Betaling ${n}` }, { x: 400, y, text: `-${n},00` })
    }
    texts.push({ x: 110, y: 30, text: `Pagina ${p + 1} van 71` })
    pages.push({ texts })
  }
  w('ts_table_4260rows', makePdf(pages, { flate: true }))
})
