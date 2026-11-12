import { join } from 'node:path'
import { app } from 'electron'
import type { Db } from '@core/database'
import { Keystore } from './security/keystore'

/** Paths and shared handles for the running app. */
export const paths = {
  get dataDir() {
    return app.getPath('userData')
  },
  get dbFile() {
    return join(app.getPath('userData'), 'kasboek.db')
  },
  get keystoreFile() {
    return join(app.getPath('userData'), 'keystore.json')
  },
  /** Built renderer files. Only pages under here may call operations. */
  rendererDir: '',
  get safetyDir() {
    return join(app.getPath('userData'), 'safety-backups')
  }
}

export const state: { db: Db | null; keystore: Keystore | null } = { db: null, keystore: null }

export function db(): Db {
  if (!state.db) throw new Error('Database is not open')
  return state.db
}

export function keystore(): Keystore {
  if (!state.keystore) throw new Error('Keystore is not ready')
  return state.keystore
}
