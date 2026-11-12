import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, shell, type WebFrameMain } from 'electron'
import { BACKUP_EXTENSION, backupFileName } from '@core/backup-format'
import { coreOps, runOp, type OpTable } from '@core/ops'
import { getSettings, updateSettings } from '@core/settings'
import type { AppEvent, OpName } from '@shared/contract'
import { backupStatus, describeBackup, restoreBackup, runAutoBackup, runAutoBackupIfDue, writeBackup } from './backup/service'
import { db, keystore, paths, state } from './state'
import { applyTheme } from './theme'

export function broadcast(event: AppEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('kasboek:event', event)
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

/** Operations that need the desktop (dialogs, OS keychain, files). Never exposed to the assistant. */
const desktopOps: OpTable = {
  'app.info': {
    mutates: false,
    assistant: false,
    handler: () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      dataDir: paths.dataDir,
      keyProtection: keystore().protection()
    })
  },
  'settings.update': {
    mutates: true,
    assistant: false,
    handler: ({ db }, patch) => {
      const next = updateSettings(db, patch)
      if (patch.theme) applyTheme(next.theme)
      return next
    }
  },
  'backup.status': { mutates: false, assistant: false, handler: () => backupStatus() },
  'backup.setPassword': {
    mutates: true,
    assistant: false,
    handler: async (_ctx, { password }) => {
      await keystore().setBackupPassword(password)
      return backupStatus()
    }
  },
  'backup.chooseFolder': {
    mutates: true,
    assistant: false,
    handler: async ({ db }) => {
      const win = focusedWindow()
      const opts: Electron.OpenDialogOptions = {
        title: 'Choose a backup folder',
        properties: ['openDirectory', 'createDirectory']
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const folder = res.canceled ? null : (res.filePaths[0] ?? null)
      if (folder) updateSettings(db, { autoBackupFolder: folder })
      return { folder }
    }
  },
  'backup.configureAuto': {
    mutates: true,
    assistant: false,
    handler: ({ db }, { enabled, keep }) => {
      updateSettings(db, { autoBackupEnabled: enabled, ...(keep ? { autoBackupKeep: keep } : {}) })
      // Make the first automatic backup straight away instead of waiting for the next check.
      if (enabled) {
        runAutoBackupIfDue()
          .then((file) => file && broadcast({ type: 'backup.completed', file }))
          .catch((err: unknown) => broadcast({ type: 'backup.failed', message: err instanceof Error ? err.message : String(err) }))
      }
      return backupStatus()
    }
  },
  'backup.createNow': {
    mutates: false,
    assistant: false,
    handler: async (_ctx, { target }) => {
      if (target === 'auto') return { file: await runAutoBackup() }
      const win = focusedWindow()
      const opts = {
        title: 'Save backup',
        defaultPath: backupFileName(),
        filters: [{ name: 'Kasboek backup', extensions: [BACKUP_EXTENSION] }]
      }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { file: null }
      return { file: await writeBackup(res.filePath) }
    }
  },
  'backup.pick': {
    mutates: false,
    assistant: false,
    handler: async () => {
      const win = focusedWindow()
      const opts: Electron.OpenDialogOptions = {
        title: 'Restore from backup',
        properties: ['openFile'],
        filters: [{ name: 'Kasboek backup', extensions: [BACKUP_EXTENSION] }]
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const file = res.canceled ? undefined : res.filePaths[0]
      return file ? describeBackup(file) : null
    }
  },
  'backup.restore': {
    mutates: false,
    assistant: false,
    handler: async (_ctx, { token, password }) => {
      await restoreBackup(token, password, () => {
        state.db?.close()
        state.db = null
      })
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 400)
      return { restored: true as const }
    }
  },
  'backup.revealFolder': {
    mutates: false,
    assistant: false,
    handler: async ({ db }) => {
      const folder = getSettings(db).autoBackupFolder
      if (!folder) return { ok: false }
      return { ok: (await shell.openPath(folder)) === '' }
    }
  }
}

export const allOps: OpTable = { ...coreOps, ...desktopOps }

/** Only our own page may call operations; never a page that got navigated to. */
function isTrusted(frame: WebFrameMain | null): boolean {
  if (!frame) return false
  const url = frame.url
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev && url.startsWith(dev)) return true
  return url.startsWith(pathToFileURL(paths.rendererDir).href)
}

export function registerIpc(): void {
  ipcMain.handle('kasboek:op', async (event, name: unknown, input: unknown) => {
    if (!isTrusted(event.senderFrame) || typeof name !== 'string') {
      return { ok: false, error: { code: 'ipc.denied', message: 'Not allowed.' } }
    }
    if (!state.db) return { ok: false, error: { code: 'db.closed', message: 'Kasboek is restarting.' } }
    return runOp(allOps, { db: db(), actor: 'user' }, name as OpName, input)
  })
}
