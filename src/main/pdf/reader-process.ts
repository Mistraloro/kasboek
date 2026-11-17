/**
 * Entry of the PDF reader: runs in an Electron utility process (see read.ts), reads one file and
 * ends. Nothing here may touch the database or the network.
 */
import { AppError } from '@core/errors'
import { extractText } from '@core/pdf/extract'
import { READER_ERROR_CODES, type ReaderMessage, type ReaderRequest } from './protocol'

const port = process.parentPort

function send(message: ReaderMessage): void {
  port.postMessage(message)
}

port.once('message', (event: { data: ReaderRequest }) => {
  extractText(event.data.bytes, (page, pages) => send({ progress: { page, pages } })).then(
    (result) => send({ ok: true, result }),
    (err: unknown) => {
      const known = err instanceof AppError && (READER_ERROR_CODES as readonly string[]).includes(err.code)
      send({
        ok: false,
        code: known ? (err.code as (typeof READER_ERROR_CODES)[number]) : 'import.pdf_broken',
        message: known ? err.message : 'This PDF could not be read. The file may be damaged or not a PDF.'
      })
    }
  )
})
