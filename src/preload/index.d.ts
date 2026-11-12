import type { KasboekBridge } from '../shared/contract'

declare global {
  interface Window {
    kasboek: KasboekBridge
  }
}
