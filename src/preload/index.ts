import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, KasboekBridge } from '../shared/contract'

/** The only thing the page can reach: run a named operation, and listen for app events. */
const bridge: KasboekBridge = {
  invoke: (op, input) => ipcRenderer.invoke('kasboek:op', op, input),
  onEvent: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, event: AppEvent): void => listener(event)
    ipcRenderer.on('kasboek:event', handler)
    return () => ipcRenderer.removeListener('kasboek:event', handler)
  }
}

contextBridge.exposeInMainWorld('kasboek', bridge)
