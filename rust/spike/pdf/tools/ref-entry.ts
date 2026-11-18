import { readFileSync, writeFileSync } from 'node:fs'
import { extractText } from '../../../../src/core/pdf/extract'
import { toLines } from '../../../../src/core/pdf/lines'
import { readStatement } from '../../../../src/core/pdf/statement'
export { extractText, toLines, readStatement }
const [file, out] = process.argv.slice(2)
if (file && process.argv[1]?.endsWith('ref.mjs')) {
  const t0 = performance.now()
  try {
    const r = await extractText(new Uint8Array(readFileSync(file)))
    const ms = performance.now() - t0
    writeFileSync(out!, JSON.stringify(r))
    console.log(JSON.stringify({ ok: true, ms, rssMb: process.resourceUsage().maxRSS / 1024 }))
  } catch (e) {
    writeFileSync(out!, JSON.stringify({ error: (e as { code?: string }).code ?? 'error' }))
    console.log(JSON.stringify({ ok: false, ms: performance.now() - t0, rssMb: process.resourceUsage().maxRSS / 1024, code: (e as { code?: string }).code }))
  }
  process.exit(0)
}
