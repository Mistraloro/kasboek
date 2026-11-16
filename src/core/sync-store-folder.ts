/** Sync through a folder on this computer that a cloud app (OneDrive, Dropbox, iCloud Drive, …) keeps in step. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYNC_DIR, type StoreEntry, type SyncStore } from './sync-store'

export class FolderStore implements SyncStore {
  readonly label: string
  private readonly root: string

  /** `folder` is the folder the person chose; the files go into "Kasboek sync" inside it. */
  constructor(folder: string) {
    this.label = folder
    this.root = join(folder, SYNC_DIR)
  }

  private p(path: string): string {
    const parts = path.split('/').filter(Boolean)
    if (parts.some((x) => x === '..' || x === '.')) throw new Error('bad path')
    return join(this.root, ...parts)
  }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      return readFileSync(this.p(path))
    } catch {
      return null
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const file = this.p(path)
    mkdirSync(join(file, '..'), { recursive: true })
    const tmp = `${file}.${randomUUID().slice(0, 8)}.partial`
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, file)
  }

  async list(dir: string): Promise<StoreEntry[]> {
    try {
      return readdirSync(this.p(dir), { withFileTypes: true })
        .filter((d) => !d.name.endsWith('.partial'))
        .map((d) => {
          let mtime = 0
          try {
            mtime = statSync(join(this.p(dir), d.name)).mtimeMs
          } catch {
            // Removed meanwhile.
          }
          return { name: d.name, dir: d.isDirectory(), mtime }
        })
    } catch {
      return []
    }
  }

  async mkdir(dir: string): Promise<void> {
    mkdirSync(this.p(dir), { recursive: true })
  }

  async remove(path: string): Promise<void> {
    rmSync(this.p(path), { force: true })
  }
}
