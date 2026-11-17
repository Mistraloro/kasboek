import { join } from 'node:path'
import { utilityProcess } from 'electron'
import type { PdfText } from '@core/pdf/lines'
import { runReader, type ReadOptions } from './run'

/** Next to this file in the build (out/main/pdf-reader.js, inside app.asar once packaged). */
const READER = join(__dirname, 'pdf-reader.js')

/** Reads the text of a PDF in a separate, memory-limited process with no environment and no output. */
export function readPdf(bytes: Uint8Array, opts: Omit<ReadOptions, 'timeoutMs'> = {}): Promise<PdfText> {
  return runReader(
    () => utilityProcess.fork(READER, [], { serviceName: 'Kasboek PDF reader', execArgv: ['--max-old-space-size=512'], env: {}, stdio: 'ignore' }),
    bytes,
    opts
  )
}
