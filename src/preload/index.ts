import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, KasboekBridge } from '../shared/contract'

// One IPC listener for the whole page; components subscribe to it.
const listeners = new Set<(event: AppEvent) => void>()
ipcRenderer.on('kasboek:event', (_e, event: AppEvent) => {
  for (const l of listeners) l(event)
})

/** The only thing the page can reach: run a named operation, and listen for app events. */
const bridge: KasboekBridge = {
  invoke: (op, input) => ipcRenderer.invoke('kasboek:op', op, input),
  onEvent: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}

contextBridge.exposeInMainWorld('kasboek', bridge)
