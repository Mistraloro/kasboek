import { join } from 'node:path'
import { app } from 'electron'

const ud = (f: string): string => join(app.getPath('userData'), f)

export const paths = {
  get dataDir() {
    return app.getPath('userData')
  },
  get dbFile() {
    return ud('kasboek.db')
  },
  get accountFile() {
    return ud('account.json')
  },
  /** Phase 1 key file, migrated into the account at setup. */
  get legacyKeystoreFile() {
    return ud('keystore.json')
  },
  get prefsFile() {
    return ud('prefs.json')
  },
  /** This computer's sync identity and folder (paths differ per computer, so not in the database). */
  get syncFile() {
    return ud('sync.json')
  },
  get safetyDir() {
    return ud('safety-backups')
  },
  /** Built renderer files. Only pages under here may call operations. */
  rendererDir: ''
}
