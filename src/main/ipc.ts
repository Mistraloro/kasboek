import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, shell, type WebFrameMain } from 'electron'
import { AppError } from '@core/errors'
import { coreOps, fxStatus, runOp, type OpContext, type OpTable } from '@core/ops'
import { getSettings, updateSettings } from '@core/settings'
import { TRANSFER_EXTENSION } from '@core/transfer-format'
import type { OpName } from '@shared/contract'
import { graphicsStatus, markPainted } from './graphics'
import { paths } from './paths'
import { getPrefs, updatePrefs } from './prefs'
import { syncTray } from './tray'
import { defaultCategoryNames } from './i18n-categories'
import { localizeDefaultCategories } from '@core/finance'
import { forgetFacts } from '@core/insights'
import * as session from './session'
import { applyTheme } from './theme'
import { lockedRefusal } from './lock-guard'
import { isTrustedFrameUrl } from './trusted-url'
import { backupList, backupStatus, describeTransfer, exportFileName, importTransfer, pickBackup, runAutoBackup, runAutoBackupIfDue } from './transfer/service'
import { dataChanged, unlocked as backupAfterUnlock } from './transfer/scheduler'
import { shouldAutoUpdate, updateEcbRates } from './fx/ecb'
import { afterImport as afterSyncImport, attach as attachSync, cancelJoin, changedLocally as syncChangedLocally, dismissConflicts as dismissSyncConflicts, isPendingJoin, onRemoteChanges, pickJoin, runSync, startSync, stopSync, syncStatus } from './sync/service'
import { writeTransfer } from './transfer/service'
import { setSecret } from '@core/secrets'
import { assistantStatus, confirm as confirmAssistant, initAssistant, publishStatus, resetChat, send, stopChat } from './assistant/chat'
import { checkKey } from './assistant/claude'
import { keyName } from './assistant/provider'
import { checkProviderKey, listProviderModels } from './assistant/models'
import { addCustomProvider, isKnownProvider, newCustomId, removeCustomProvider, renameCustomProvider, resolveProvider, switchProvider } from '@shared/ai-provider-store'
import { isCustomId } from '@shared/ai-providers'
import { claudeEffort } from '@shared/reasoning'
import { assistImport } from './assistant/csv'
import { assistPdf, pdfAssistPreview } from './assistant/pdf'
import { assistStatus, cancelAssist } from './assistant/jobs'
import { cancelInsights, insightsPreview, insightsStatus, runInsights } from './assistant/insights'
import { insightsView } from '@core/insights'
import { mcpClientsSeen, respondMcp } from './mcp/bridge'
import { exportCsv, exportPdf } from './export'
import { openPdfSession } from './pdf/open'
import { readPdf } from './pdf/read'
import { createReadSlot } from './pdf/handle'
import { helperPath } from './mcp/channel'
import { checkForUpdate, downloadUpdate, installUpdate, openReleasePage, updateStatus } from './update'
import * as mcpSetup from './mcp/setup'

let readyListener: (() => void) | null = null
/** Called once the page has drawn its first screen. */
export function onAppReady(fn: () => void): void {
  readyListener = fn
}
function appReady(): void {
  markPainted()
  readyListener?.()
  readyListener = null
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

async function openDialog(opts: Electron.OpenDialogOptions): Promise<string | null> {
  const win = focusedWindow()
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return res.canceled ? null : (res.filePaths[0] ?? null)
}

/** The PDF read in progress, so the page can stop it. */
const pdfRead = createReadSlot()

/** Stops the PDF read in progress, if any (the app locking). */
export function cancelPdfRead(): void {
  pdfRead.abort()
}

const kasboekFilter = [{ name: 'Kasboek export', extensions: [TRANSFER_EXTENSION] }]

function notifyBackup(p: Promise<string | null>): void {
  p.then((file) => file && session.broadcast({ type: 'backup.completed', file })).catch((err: unknown) =>
    session.broadcast({ type: 'backup.failed', message: err instanceof Error ? err.message : String(err) })
  )
}

/** Operations that need the desktop (dialogs, keychain, files). None are offered to an assistant. */
const desktopOps: OpTable = {
  'app.info': {
    mutates: false,
    assistant: false,
    handler: () => ({
      name: app.getName(),
      version: app.getVersion(),
      commit: __BUILD_COMMIT__,
      platform: process.platform,
      dataDir: paths.dataDir,
      graphics: graphicsStatus(),
      mcpCommand: { command: helperPath(), args: ['--data-dir', paths.dataDir] }
    })
  },
  'update.status': { mutates: false, assistant: false, handler: () => updateStatus() },
  'update.check': { mutates: false, assistant: false, handler: () => checkForUpdate() },
  'update.download': { mutates: false, assistant: false, handler: () => downloadUpdate() },
  'update.install': { mutates: false, assistant: false, handler: () => installUpdate() },
  'update.openPage': {
    mutates: false,
    assistant: false,
    handler: () => {
      openReleasePage()
      return { ok: true as const }
    }
  },
  'app.ready': {
    mutates: false,
    assistant: false,
    handler: () => {
      appReady()
      return { ok: true as const }
    }
  },
  'prefs.get': { mutates: false, assistant: false, handler: () => getPrefs() },
  'app.restart': {
    mutates: false,
    assistant: false,
    handler: () => {
      setTimeout(() => {
        app.relaunch()
        app.quit()
      }, 100)
      return { ok: true as const }
    }
  },
  'prefs.update': {
    mutates: false,
    assistant: false,
    handler: (_c, patch) => {
      // A new graphics choice also forgets an earlier failure, so "automatic" tries the graphics card again.
      const next = updatePrefs(patch.graphics ? { ...patch, graphicsFailed: false } : patch)
      if (patch.theme) applyTheme(next.theme)
      if (patch.keepInTray !== undefined) syncTray()
      return next
    }
  },

  'auth.status': { mutates: false, assistant: false, handler: () => session.status() },
  'auth.setup': {
    mutates: true,
    assistant: false,
    handler: async (_c, input) => {
      const result = await session.setup(input.mode, input.mode === 'password' ? input.password : undefined)
      // A new database starts with its categories in the interface language.
      if (session.isUnlocked()) localizeDefaultCategories(session.db(), defaultCategoryNames(getPrefs().language))
      return result
    }
  },
  'auth.unlock': {
    mutates: false,
    assistant: false,
    handler: async (_c, input) => {
      await session.unlock(input)
      afterUnlock()
      return session.status()
    }
  },
  'auth.unlockRecovery': {
    mutates: false,
    assistant: false,
    handler: async (_c, { recoveryKey }) => {
      await session.unlockRecovery(recoveryKey)
      afterUnlock()
      return session.status()
    }
  },
  'auth.lock': {
    mutates: false,
    assistant: false,
    handler: () => {
      session.lock('user')
      return session.status()
    }
  },
  'auth.erase': {
    mutates: false,
    assistant: false,
    handler: async () => {
      await session.erase()
      return session.status()
    }
  },
  'auth.restoreErased': {
    mutates: false,
    assistant: false,
    handler: async (_c, { name }) => {
      await session.restoreErasedData(name)
      return session.status()
    }
  },
  'auth.changePassword': {
    mutates: true,
    assistant: false,
    handler: async (_c, { current, next }) => {
      await session.changePassword(current, next)
      return session.status()
    }
  },
  'auth.usePasswordless': {
    mutates: true,
    assistant: false,
    handler: async (_c, { current }) => {
      await session.switchToPasswordless(current)
      return session.status()
    }
  },
  'auth.newRecoveryKey': {
    mutates: true,
    assistant: false,
    handler: async (_c, { current }) => ({ recoveryKey: await session.newRecoveryKey(current) })
  },
  'auth.forgetComputer': {
    mutates: true,
    assistant: false,
    handler: async () => {
      await session.forgetThisComputer()
      return session.status()
    }
  },
  'auth.totpBegin': { mutates: false, assistant: false, handler: () => session.totpBegin() },
  'auth.totpEnable': {
    mutates: true,
    assistant: false,
    handler: async (_c, { code }) => {
      await session.totpEnable(code)
      return session.status()
    }
  },
  'auth.totpDisable': {
    mutates: true,
    assistant: false,
    handler: async (_c, { code }) => {
      await session.totpDisable(code)
      return session.status()
    }
  },

  'transfer.export': {
    mutates: true,
    assistant: false,
    handler: async () => {
      session.secrets()
      const win = focusedWindow()
      const opts = { title: 'Export Kasboek', defaultPath: exportFileName(), filters: kasboekFilter }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { file: null }
      return { file: await writeTransfer(res.filePath, 'export') }
    }
  },
  'transfer.pick': {
    mutates: false,
    assistant: false,
    handler: async () => {
      // On the lock screen nobody may replace the data: only at first setup, or once logged in.
      if ((await session.status()).state === 'locked') throw new AppError('auth.locked', 'Unlock Kasboek first.')
      const file = await openDialog({ title: 'Import a Kasboek export', properties: ['openFile'], filters: kasboekFilter })
      return file ? describeTransfer(file) : null
    }
  },
  'transfer.import': {
    mutates: true,
    assistant: false,
    handler: async (_c, input) => {
      if ((await session.status()).state === 'locked') throw new AppError('auth.locked', 'Unlock Kasboek first.')
      const reset = await importTransfer(input, { joining: isPendingJoin(input.token) })
      // Joining a sync folder: from now on this computer syncs with it too.
      await afterSyncImport(input.token).catch((err: unknown) => console.warn('[sync] join failed:', err))
      return { status: await session.status(), reset }
    }
  },

  'assistant.status': { mutates: false, assistant: false, handler: () => assistantStatus() },
  'assistant.setKey': {
    mutates: true,
    assistant: false,
    handler: async ({ db }, { apiKey, provider }) => {
      const settings = getSettings(db)
      const id = provider ?? settings.aiProvider
      if (!isKnownProvider(settings, id)) throw new AppError('assistant.unknown_provider', 'That provider is no longer in your list.')
      // Dev/test only: skip the online check.
      if (app.isPackaged || process.env['KASBOEK_SKIP_KEY_CHECK'] !== '1') {
        if (id === 'anthropic') await checkKey(apiKey)
        else {
          // Check the key against this provider's own address, whether or not it is the one in use.
          await checkProviderKey({ ...resolveProvider(settings, id), key: apiKey })
        }
      }
      setSecret(db, keyName(id), apiKey)
      publishStatus()
      return assistantStatus()
    }
  },
  'assistant.clearKey': {
    mutates: true,
    assistant: false,
    handler: ({ db }) => {
      setSecret(db, keyName(getSettings(db).aiProvider), null)
      resetChat()
      return assistantStatus()
    }
  },
  'assistant.addProvider': {
    mutates: true,
    assistant: false,
    handler: ({ db }, { name, ...rest }) => {
      const next = updateSettings(db, addCustomProvider(getSettings(db), newCustomId(randomUUID()), { name, ...rest }))
      resetChat()
      return next
    }
  },
  'assistant.renameProvider': {
    mutates: true,
    assistant: false,
    handler: ({ db }, { id, name }) => {
      const settings = getSettings(db)
      if (!isCustomId(id) || !isKnownProvider(settings, id)) throw new AppError('assistant.unknown_provider', 'That provider is no longer in your list.')
      const next = updateSettings(db, renameCustomProvider(settings, id, name))
      publishStatus()
      return next
    }
  },
  'assistant.removeProvider': {
    mutates: true,
    assistant: false,
    handler: ({ db }, { id }) => {
      const settings = getSettings(db)
      if (!isCustomId(id) || !isKnownProvider(settings, id)) throw new AppError('assistant.unknown_provider', 'That provider is no longer in your list.')
      const next = updateSettings(db, removeCustomProvider(settings, id))
      setSecret(db, keyName(id), null)
      resetChat()
      return next
    }
  },
  'assistant.configure': {
    mutates: true,
    assistant: false,
    handler: ({ db }, patch) => {
      const before = getSettings(db)
      // Another provider brings back its own address and models (or its suggested model the first time).
      if (patch.aiProvider && patch.aiProvider !== before.aiProvider) {
        if (!isKnownProvider(before, patch.aiProvider)) throw new AppError('assistant.unknown_provider', 'That provider is no longer in your list.')
        patch = { ...switchProvider(before, patch.aiProvider), ...patch }
      }
      // A model that can't stop thinking gets the lowest level instead of "off".
      const model = patch.chatModel ?? before.chatModel
      const effort = patch.chatEffort ?? before.chatEffort
      if (claudeEffort(model, effort) !== effort) patch = { ...patch, chatEffort: claudeEffort(model, effort) }
      const csvModel = patch.csvModel ?? before.csvModel
      const csvEffort = patch.csvEffort ?? before.csvEffort
      if (claudeEffort(csvModel, csvEffort) !== csvEffort) patch = { ...patch, csvEffort: claudeEffort(csvModel, csvEffort) }
      const next = updateSettings(db, patch)
      // The conversation is tied to one provider's message format.
      if (next.aiProvider !== before.aiProvider) resetChat()
      else publishStatus()
      return next
    }
  },
  'assistant.models': { mutates: false, assistant: false, handler: ({ db }) => listProviderModels(db) },
  'assistant.send': { mutates: false, assistant: false, handler: (_c, { text }) => send(text) },
  'assistant.confirm': {
    mutates: false,
    assistant: false,
    handler: (_c, { id, approve }) => {
      confirmAssistant(id, approve)
      return assistantStatus()
    }
  },
  'assistant.stop': {
    mutates: false,
    assistant: false,
    handler: () => {
      stopChat()
      return assistantStatus()
    }
  },
  'assistant.reset': {
    mutates: false,
    assistant: false,
    handler: () => {
      resetChat()
      return assistantStatus()
    }
  },
  'import.assist': { mutates: false, assistant: false, handler: ({ db }, { sessionId }) => assistImport(db, sessionId) },
  'import.pdfAssistPreview': { mutates: false, assistant: false, handler: (_c, { sessionId }) => pdfAssistPreview(sessionId) },
  'import.pdfAssist': { mutates: false, assistant: false, handler: ({ db }, { sessionId }) => assistPdf(db, sessionId) },
  // Tips on the Overview: the cached ones need the interface language, and the assistant writes them only when asked.
  'insights.get': { mutates: false, assistant: false, handler: ({ db }, { month }) => insightsView(db, month, getPrefs().language) },
  'insights.preview': { mutates: false, assistant: false, handler: ({ db }, { month }) => insightsPreview(db, month) },
  'insights.run': { mutates: false, assistant: false, handler: ({ db }, { month, consent }) => runInsights(db, month, { consent }) },
  'insights.cancel': { mutates: false, assistant: false, handler: () => cancelInsights() },
  'insights.status': { mutates: false, assistant: false, handler: () => insightsStatus() },
  'export.csv': { mutates: false, assistant: false, handler: (_c, { filter, labels, defaultName }) => exportCsv(filter, labels, defaultName) },
  'export.pdf': { mutates: false, assistant: false, handler: (_c, { html, defaultName }) => exportPdf(html, defaultName) },
  'import.assistStatus': { mutates: false, assistant: false, handler: (_c, { sessionId }) => assistStatus(sessionId) },
  'import.assistCancel': {
    mutates: false,
    assistant: false,
    handler: (_c, { sessionId }) => {
      cancelAssist(sessionId)
      return { ok: true as const }
    }
  },
  'import.analyzePdf': {
    mutates: false,
    assistant: false,
    handler: async ({ db }, i) => {
      const controller = pdfRead.claim()
      if (!controller) throw new AppError('import.pdf_busy', 'Another PDF is still being read. Wait a moment and try again.')
      try {
        return await openPdfSession(db, {
          fileName: i.fileName,
          accountId: i.accountId,
          contentBase64: i.contentBase64,
          read: (bytes) => readPdf(bytes, { signal: controller.signal, onPage: (page, pages) => session.broadcast({ type: 'import.pdfProgress', page, pages }) })
        })
      } finally {
        pdfRead.release(controller)
      }
    }
  },
  'import.pdfCancel': {
    mutates: false,
    assistant: false,
    handler: () => {
      pdfRead.abort()
      return { ok: true as const }
    }
  },
  'mcp.setupStatus': { mutates: false, assistant: false, handler: () => mcpSetup.setupStatus() },
  'mcp.clients': { mutates: false, assistant: false, handler: () => mcpClientsSeen() },
  'mcp.desktopRunning': { mutates: false, assistant: false, handler: async () => ({ running: await mcpSetup.claudeDesktopRunning() }) },
  'mcp.desktopAdd': { mutates: false, assistant: false, handler: () => mcpSetup.addToDesktop() },
  'mcp.desktopRemove': { mutates: false, assistant: false, handler: () => mcpSetup.removeFromDesktop() },
  'mcp.codeAdd': {
    mutates: false,
    assistant: false,
    handler: async () => {
      await mcpSetup.addToCode()
      return { ok: true as const }
    }
  },
  'mcp.codeRemove': {
    mutates: false,
    assistant: false,
    handler: async () => {
      await mcpSetup.removeFromCode()
      return { ok: true as const }
    }
  },
  'mcp.respond': {
    mutates: false,
    assistant: false,
    handler: (_c, { id, approve }) => {
      respondMcp(id, approve)
      return { ok: true as const }
    }
  },

  'backup.status': { mutates: false, assistant: false, handler: () => backupStatus() },
  'backup.chooseFolder': {
    mutates: true,
    assistant: false,
    handler: async ({ db }) => {
      const folder = await openDialog({ title: 'Choose a backup folder', properties: ['openDirectory', 'createDirectory'] })
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
      if (enabled) notifyBackup(runAutoBackupIfDue())
      return backupStatus()
    }
  },
  'fx.updateEcb': {
    mutates: true,
    assistant: false,
    handler: async ({ db }) => {
      const { added } = await updateEcbRates(db)
      return { ...fxStatus(db), added }
    }
  },
  'sync.status': { mutates: false, assistant: false, handler: () => syncStatus() },
  'sync.start': { mutates: false, assistant: false, handler: (_c, input) => startSync(input) },
  'sync.pickJoin': {
    mutates: false,
    assistant: false,
    handler: async (_c, input) => {
      // Same rule as transfer.pick: not on the lock screen. At first setup (no account yet) and once logged in it works.
      if ((await session.status()).state === 'locked') throw new AppError('auth.locked', 'Unlock Kasboek first.')
      return pickJoin(input)
    }
  },
  'sync.cancelJoin': {
    mutates: false,
    assistant: false,
    handler: (_c, { token }) => {
      cancelJoin(token)
      return { ok: true as const }
    }
  },
  'sync.attach': { mutates: false, assistant: false, handler: (_c, input) => attachSync(input) },
  'sync.now': {
    mutates: false,
    assistant: false,
    handler: async () => {
      await runSync()
      return syncStatus()
    }
  },
  'sync.stop': { mutates: false, assistant: false, handler: () => stopSync() },
  'sync.dismissConflicts': { mutates: false, assistant: false, handler: () => dismissSyncConflicts() },
  'backup.runNow': { mutates: false, assistant: false, handler: async () => ({ file: await runAutoBackup() }) },
  'backup.list': { mutates: false, assistant: false, handler: () => backupList() },
  'backup.pick': { mutates: false, assistant: false, handler: (_c, { name }) => pickBackup(name) },
  'backup.revealFolder': {
    mutates: false,
    assistant: false,
    handler: async ({ db }) => {
      const folder = getSettings(db).autoBackupFolder
      return { ok: !!folder && (await shell.openPath(folder)) === '' }
    }
  }
}

export const allOps: OpTable = { ...coreOps, ...desktopOps }

/** Context whose database is only reachable while unlocked. */
export function opContext(actor: OpContext['actor']): OpContext {
  return {
    actor,
    get db() {
      return session.db()
    }
  }
}

/** Runs an operation, refusing everything but the login operations while locked. */
export async function dispatch(name: OpName, input: unknown, actor: OpContext['actor']) {
  const refusal = lockedRefusal(name, session.isUnlocked())
  if (refusal) return refusal
  const result = await runOp(allOps, opContext(actor), name, input)
  // Tell open pages to refresh, e.g. when Claude changed a budget.
  if (result.ok && allOps[name]?.mutates) {
    notifyChanged(actor)
    dataChanged(name, input)
    syncChangedLocally()
  }
  return result
}

/** Work that waits for the database: due backups and, when switched on, fresh exchange rates. */
function afterUnlock(): void {
  backupAfterUnlock()
  void runSync()
  if (!session.isUnlocked() || !shouldAutoUpdate(session.db())) return
  updateEcbRates(session.db())
    .then(({ added }) => added > 0 && notifyChanged('system'))
    .catch((err: unknown) => console.warn('[fx] automatic update failed:', err instanceof Error ? err.message : err))
}

// Changes from another computer: refresh open pages.
onRemoteChanges(() => notifyChanged('system'))

let changeTimer: NodeJS.Timeout | null = null
function notifyChanged(actor: OpContext['actor']): void {
  if (session.isUnlocked()) forgetFacts(session.db())
  if (changeTimer) clearTimeout(changeTimer)
  changeTimer = setTimeout(() => session.broadcast({ type: 'data.changed', actor }), 50)
}

/** Only our own page may call operations; never a page that got navigated to. */
function isTrusted(frame: WebFrameMain | null): boolean {
  if (!frame) return false
  return isTrustedFrameUrl(frame.url, paths.rendererDir, process.env['ELECTRON_RENDERER_URL'], app.isPackaged)
}

export function registerIpc(): void {
  initAssistant((op, input, actor) => dispatch(op, input, actor))
  session.onLock(resetChat)
  ipcMain.handle('kasboek:op', async (event, name: unknown, input: unknown) => {
    if (!isTrusted(event.senderFrame) || typeof name !== 'string') {
      return { ok: false, error: { code: 'ipc.denied', message: 'Not allowed.' } }
    }
    return dispatch(name as OpName, input, 'user')
  })
}
