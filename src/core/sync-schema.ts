/**
 * What is synced between computers, and the triggers that record every change.
 *
 * Every synced row gets a global id (`uid`): random for things people create (accounts,
 * categories, transactions, rules), derived from the natural key where one exists (a budget is
 * category + month), so the same budget made on two computers is the same row. Local-only data
 * (import batches, audit log, secrets, backups settings) is not synced.
 */
import type { Db } from './database'

export interface TableSpec {
  table: string
  /** SQL for a new row's uid (uses NEW.). */
  uid: string
  cols: string[]
  /** Foreign keys, sent as the referenced row's uid. */
  fks: Record<string, string>
  /** Only rows matching this condition (on NEW./OLD.) are synced. */
  when?: (row: 'NEW' | 'OLD') => string
}

const RANDOM = `lower(hex(randomblob(16)))`

/** In dependency order: a row only refers to tables before it. */
export const SYNC_TABLES: TableSpec[] = [
  { table: 'settings', uid: `NEW.key`, cols: ['key', 'value'], fks: {}, when: (r) => `${r}.key IN ('currency')` },
  { table: 'accounts', uid: RANDOM, cols: ['name', 'bank', 'iban', 'currency', 'kind', 'opening_balance_cents', 'archived', 'created_at'], fks: {} },
  { table: 'categories', uid: RANDOM, cols: ['name', 'kind', 'parent_id', 'color', 'sort_order', 'archived'], fks: { parent_id: 'categories' } },
  { table: 'rules', uid: RANDOM, cols: ['field', 'pattern', 'category_id', 'created_at', 'match', 'priority'], fks: { category_id: 'categories' } },
  {
    table: 'transactions',
    uid: RANDOM,
    cols: ['account_id', 'booking_date', 'value_date', 'amount_cents', 'currency', 'description', 'counterparty_name', 'counterparty_iban', 'communication', 'category_id', 'notes', 'bank_reference', 'fingerprint', 'created_at', 'updated_at', 'bank_counterparty', 'bank_description', 'transfer_pair'],
    fks: { account_id: 'accounts', category_id: 'categories' }
  },
  { table: 'transaction_splits', uid: RANDOM, cols: ['tx_id', 'category_id', 'amount_cents', 'note'], fks: { tx_id: 'transactions', category_id: 'categories' } },
  { table: 'budgets', uid: `(SELECT uid FROM categories WHERE id = NEW.category_id) || '/' || NEW.month`, cols: ['category_id', 'month', 'amount_cents'], fks: { category_id: 'categories' } },
  { table: 'valuations', uid: `(SELECT uid FROM accounts WHERE id = NEW.account_id) || '/' || NEW.date`, cols: ['account_id', 'date', 'value_cents', 'note'], fks: { account_id: 'accounts' } },
  { table: 'fx_rates', uid: `NEW.currency || '/' || NEW.date || '/' || NEW.source`, cols: ['currency', 'date', 'per_eur', 'source'], fks: {}, when: (r) => `${r}.source = 'manual'` },
  { table: 'goals', uid: RANDOM, cols: ['name', 'target_cents', 'target_date', 'account_id', 'saved_cents', 'archived', 'created_at'], fks: { account_id: 'accounts' } },
  { table: 'csv_profiles', uid: `NEW.header_signature`, cols: ['name', 'bank', 'header_signature', 'mapping_json', 'created_at', 'updated_at'], fks: {} }
]

export const SPEC = new Map(SYNC_TABLES.map((s) => [s.table, s]))

/** Migration: uids, sync bookkeeping tables and triggers. */
export function installSyncSchema(db: Db): void {
  db.exec(`
    CREATE TABLE sync_flags (enabled INTEGER NOT NULL DEFAULT 0, applying INTEGER NOT NULL DEFAULT 0);
    INSERT INTO sync_flags (enabled, applying) VALUES (0, 0);
    -- Rows changed locally since the last sync (filled by triggers while sync is on).
    CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY, tbl TEXT NOT NULL, uid TEXT NOT NULL);
    -- The last synced state of each row: values and, per field, when it last changed.
    CREATE TABLE sync_rows (
      tbl TEXT NOT NULL, uid TEXT NOT NULL, data TEXT NOT NULL, ts TEXT NOT NULL, deleted TEXT,
      PRIMARY KEY (tbl, uid)
    );
    CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- Changes from another computer that clashed with a change here, for the person to see.
    CREATE TABLE sync_conflicts (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, summary TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0
    );
    -- Changes that refer to rows not here yet (arrive in a later file); retried every sync.
    CREATE TABLE sync_pending (id INTEGER PRIMARY KEY, device TEXT NOT NULL, change TEXT NOT NULL);
  `)
  for (const s of SYNC_TABLES) {
    const t = s.table
    // Tables added in later migrations get their uid and triggers there.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) continue
    db.exec(`ALTER TABLE ${t} ADD COLUMN uid TEXT`)
    // Existing rows: fill in uid order of dependencies (budgets need category uids first).
    db.exec(`UPDATE ${t} SET uid = ${s.uid.replaceAll('NEW.', `${t}.`)} WHERE uid IS NULL`)
    db.exec(`CREATE UNIQUE INDEX idx_${t}_uid ON ${t}(uid)`)
    createSyncTriggers(db, s)
  }
}

/** The triggers that record a synced table's changes (also used when a table is rebuilt). */
export function createSyncTriggers(db: Db, s: TableSpec): void {
  const t = s.table
  const on = `(SELECT enabled FROM sync_flags) = 1 AND (SELECT applying FROM sync_flags) = 0`
  const w = (r: 'NEW' | 'OLD'): string => (s.when ? ` AND ${s.when(r)}` : '')
  db.exec(`
    -- One trigger, so the uid is always set before the change is recorded.
    CREATE TRIGGER sync_${t}_ins AFTER INSERT ON ${t} BEGIN
      UPDATE ${t} SET uid = ${s.uid} WHERE rowid = NEW.rowid AND uid IS NULL;
      INSERT INTO sync_outbox (tbl, uid) SELECT '${t}', uid FROM ${t} WHERE rowid = NEW.rowid AND uid IS NOT NULL AND ${on}${w('NEW')};
    END;
    CREATE TRIGGER sync_${t}_upd AFTER UPDATE ON ${t} WHEN ${on}${w('NEW')} AND NEW.uid IS NOT NULL BEGIN
      INSERT INTO sync_outbox (tbl, uid) VALUES ('${t}', NEW.uid);
    END;
    CREATE TRIGGER sync_${t}_del AFTER DELETE ON ${t} WHEN ${on}${w('OLD')} AND OLD.uid IS NOT NULL BEGIN
      INSERT INTO sync_outbox (tbl, uid) VALUES ('${t}', OLD.uid);
    END;
  `)
}
