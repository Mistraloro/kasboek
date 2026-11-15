/** Saving exports for an accountant or a spreadsheet: transactions as CSV, a report as PDF. */
import { writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog, session } from 'electron'
import { transactionsCsv, type TxFilter } from '@core/finance'
import { getPrefs } from './prefs'
import { db } from './session'

async function pickFile(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = { defaultPath: defaultName, filters }
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  return res.canceled || !res.filePath ? null : res.filePath
}

export async function exportCsv(filter: Omit<TxFilter, 'limit' | 'offset'>, labels: string[], defaultName: string): Promise<{ file: string | null; rows: number }> {
  const { csv, rows } = transactionsCsv(db(), filter, { decimal: getPrefs().formats.decimal, labels })
  const file = await pickFile(defaultName, [{ name: 'CSV', extensions: ['csv'] }])
  if (!file) return { file: null, rows }
  await writeFile(file, csv, 'utf8')
  return { file, rows }
}

/**
 * Prints a report page (made by the interface, in the person's language) to PDF in a hidden
 * window that runs no scripts and loads nothing from outside.
 */
export async function exportPdf(html: string, defaultName: string): Promise<{ file: string | null }> {
  const file = await pickFile(defaultName, [{ name: 'PDF', extensions: ['pdf'] }])
  if (!file) return { file: null }
  // Its own session: the request filter below applies to this window only.
  const pdfSession = session.fromPartition('kasboek-pdf')
  pdfSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('data:') }))
  const win = new BrowserWindow({ show: false, webPreferences: { session: pdfSession, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    // Only what is in the page itself: no network, no files.
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } })
    await writeFile(file, pdf)
    return { file }
  } finally {
    win.destroy()
  }
}
