/**
 * The tray (menu bar) icon: whether Claude apps can reach Kasboek, a way to stop that, and Quit.
 * The kasboek-mcp helper itself is started and ended by the Claude app; stopping the connection
 * here makes it answer "not available" until it is switched on again.
 */
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import icon from '../../resources/icon.png?asset'
import { getSettings, updateSettings } from '@core/settings'
import { mcpBridgeState } from './mcp/bridge'
import { getPrefs } from './prefs'
import { broadcast, db, isUnlocked } from './session'

type Text = 'open' | 'on' | 'off' | 'locked' | 'used' | 'stop' | 'start' | 'quit'
const TEXT: Record<string, Record<Text, string>> = {
  en: { open: 'Open Kasboek', on: 'Claude connection: on', off: 'Claude connection: off', locked: 'Claude connection: Kasboek is locked', used: 'Last used by Claude at {time}', stop: 'Stop Claude connection', start: 'Allow Claude connection', quit: 'Quit Kasboek' },
  nl: { open: 'Kasboek openen', on: 'Verbinding met Claude: aan', off: 'Verbinding met Claude: uit', locked: 'Verbinding met Claude: Kasboek is vergrendeld', used: 'Laatst gebruikt door Claude om {time}', stop: 'Verbinding met Claude stoppen', start: 'Verbinding met Claude toestaan', quit: 'Kasboek afsluiten' },
  fr: { open: 'Ouvrir Kasboek', on: 'Connexion à Claude : activée', off: 'Connexion à Claude : désactivée', locked: 'Connexion à Claude : Kasboek est verrouillé', used: 'Dernière utilisation par Claude à {time}', stop: 'Arrêter la connexion à Claude', start: 'Autoriser la connexion à Claude', quit: 'Quitter Kasboek' },
  de: { open: 'Kasboek öffnen', on: 'Verbindung zu Claude: an', off: 'Verbindung zu Claude: aus', locked: 'Verbindung zu Claude: Kasboek ist gesperrt', used: 'Zuletzt von Claude genutzt um {time}', stop: 'Verbindung zu Claude beenden', start: 'Verbindung zu Claude erlauben', quit: 'Kasboek beenden' },
  es: { open: 'Abrir Kasboek', on: 'Conexión con Claude: activada', off: 'Conexión con Claude: desactivada', locked: 'Conexión con Claude: Kasboek está bloqueado', used: 'Último uso por Claude a las {time}', stop: 'Detener la conexión con Claude', start: 'Permitir la conexión con Claude', quit: 'Salir de Kasboek' },
  'pt-PT': { open: 'Abrir o Kasboek', on: 'Ligação ao Claude: ativa', off: 'Ligação ao Claude: desativada', locked: 'Ligação ao Claude: o Kasboek está bloqueado', used: 'Último uso pelo Claude às {time}', stop: 'Parar a ligação ao Claude', start: 'Permitir a ligação ao Claude', quit: 'Sair do Kasboek' },
  'pt-BR': { open: 'Abrir o Kasboek', on: 'Conexão com o Claude: ativa', off: 'Conexão com o Claude: desativada', locked: 'Conexão com o Claude: o Kasboek está bloqueado', used: 'Último uso pelo Claude às {time}', stop: 'Parar a conexão com o Claude', start: 'Permitir a conexão com o Claude', quit: 'Sair do Kasboek' }
}

function text(key: Text): string {
  const lang = getPrefs().language
  return (TEXT[lang] ?? TEXT[lang.split('-')[0]!] ?? TEXT['en']!)[key]
}

let tray: Tray | null = null
let shownKey = ''
let menu: Menu | null = null

function showWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function setMcp(enabled: boolean): void {
  if (!isUnlocked()) return
  updateSettings(db(), { mcpEnabled: enabled })
  broadcast({ type: 'settings.changed' })
  refreshTray()
}

/** Rebuilds the menu when what it shows has changed. Cheap to call often. */
export function refreshTray(): void {
  if (!tray) return
  const unlocked = isUnlocked()
  const enabled = unlocked && getSettings(db()).mcpEnabled
  const { running, lastUsed } = mcpBridgeState()
  const time = lastUsed ? new Date(lastUsed).toLocaleTimeString(getPrefs().language, { hour: '2-digit', minute: '2-digit' }) : ''
  const key = JSON.stringify([unlocked, enabled, running, time, getPrefs().language])
  if (key === shownKey) return
  shownKey = key
  const status = !unlocked ? text('locked') : enabled ? text('on') : text('off')
  tray.setToolTip(`Kasboek · ${status}`)
  menu = Menu.buildFromTemplate([
      { label: text('open'), click: showWindow },
      { type: 'separator' },
      { label: status, enabled: false },
      ...(time && enabled ? [{ label: text('used').replace('{time}', time), enabled: false }] : []),
      ...(unlocked ? [enabled ? { label: text('stop'), click: () => setMcp(false) } : { label: text('start'), click: () => setMcp(true) }] : []),
      { type: 'separator' },
      { label: text('quit'), click: () => app.quit() }
    ])
  tray.setContextMenu(menu)
}

export function createTray(): void {
  if (tray) return
  const size = process.platform === 'darwin' ? 18 : 16
  try {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: size, height: size }))
  } catch (err) {
    // Some Linux desktops have no tray: the app works without it.
    console.warn('[tray] not available:', err instanceof Error ? err.message : err)
    return
  }
  // Windows and Linux: a click opens the window; the menu is on right-click (and on macOS on click).
  tray.on('click', () => {
    if (process.platform !== 'darwin') showWindow()
  })
  refreshTray()
  // Development builds: lets end-to-end tests read and click the menu.
  if (!app.isPackaged)
    (globalThis as Record<string, unknown>)['__kasboekTray'] = {
      labels: () => menu?.items.map((i) => i.label) ?? [],
      click: (label: string) => menu?.items.find((i) => i.label === label)?.click()
    }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
