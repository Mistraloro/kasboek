import type { Db } from './database'

const now = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

/**
 * Schema migrations, applied in order. Never edit a migration that has shipped:
 * add a new one. The index + 1 is stored in `PRAGMA user_version`.
 */
export const MIGRATIONS: ((db: Db) => void)[] = [
  (db) => {
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        bank TEXT NOT NULL DEFAULT 'other',
        iban TEXT UNIQUE,
        currency TEXT NOT NULL DEFAULT 'EUR',
        opening_balance_cents INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT ${now}
      );

      CREATE TABLE categories (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
        parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX idx_categories_name ON categories(name COLLATE NOCASE, ifnull(parent_id, 0));

      CREATE TABLE import_batches (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        csv_profile TEXT,
        row_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('staged', 'committed', 'discarded')),
        created_at TEXT NOT NULL DEFAULT ${now},
        committed_at TEXT
      );

      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        booking_date TEXT NOT NULL CHECK (booking_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        value_date TEXT,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'EUR',
        description TEXT NOT NULL DEFAULT '',
        counterparty_name TEXT,
        counterparty_iban TEXT,
        communication TEXT,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        notes TEXT,
        import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
        bank_reference TEXT,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT ${now},
        updated_at TEXT NOT NULL DEFAULT ${now}
      );
      CREATE INDEX idx_tx_account_date ON transactions(account_id, booking_date);
      CREATE INDEX idx_tx_category ON transactions(category_id);
      CREATE INDEX idx_tx_fingerprint ON transactions(account_id, fingerprint);

      CREATE TABLE budgets (
        id INTEGER PRIMARY KEY,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        UNIQUE (category_id, month)
      );

      -- Remembered CSV column mappings, keyed by the file's header row.
      CREATE TABLE csv_profiles (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        bank TEXT,
        header_signature TEXT NOT NULL UNIQUE,
        mapping_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT ${now},
        updated_at TEXT NOT NULL DEFAULT ${now}
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Every change, and who made it (you, the assistant, or the app itself).
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL DEFAULT ${now},
        actor TEXT NOT NULL CHECK (actor IN ('user', 'assistant', 'system')),
        action TEXT NOT NULL,
        details TEXT
      );
    `)

    const insert = db.prepare('INSERT INTO categories (name, kind, sort_order) VALUES (?, ?, ?)')
    const defaults: [string, 'income' | 'expense' | 'transfer'][] = [
      ['Salary', 'income'],
      ['Other income', 'income'],
      ['Groceries', 'expense'],
      ['Housing', 'expense'],
      ['Utilities', 'expense'],
      ['Transport', 'expense'],
      ['Eating out', 'expense'],
      ['Shopping', 'expense'],
      ['Health', 'expense'],
      ['Insurance', 'expense'],
      ['Subscriptions', 'expense'],
      ['Leisure', 'expense'],
      ['Gifts', 'expense'],
      ['Fees & taxes', 'expense'],
      ['Own transfers', 'transfer'],
      ['Savings', 'transfer']
    ]
    defaults.forEach(([name, kind], i) => insert.run(name, kind, i))
  },
  (db) => {
    db.exec(`
      -- "Always put X in category Y".
      CREATE TABLE rules (
        id INTEGER PRIMARY KEY,
        field TEXT NOT NULL CHECK (field IN ('counterparty', 'description', 'any')),
        pattern TEXT NOT NULL,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT ${now}
      );
      CREATE UNIQUE INDEX idx_rules_unique ON rules(field, pattern COLLATE NOCASE);

      -- API keys and similar, inside the encrypted database. Never returned to the UI.
      CREATE TABLE secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  },
  (db) => {
    // Accounts used to pick from a fixed list of banks; the bank is now a free-text name.
    db.exec(`
      UPDATE accounts SET bank = CASE bank
        WHEN 'argenta' THEN 'Argenta'
        WHEN 'hellobank' THEN 'Hello bank!'
        WHEN 'keytrade' THEN 'Keytrade Bank'
        WHEN 'other' THEN ''
        ELSE bank END;
    `)
  }
]

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number
}

export function migrate(db: Db): void {
  const current = schemaVersion(db)
  if (current > MIGRATIONS.length) {
    throw new Error(
      `This database was made by a newer version of Kasboek (schema ${current}). Update the app to open it.`
    )
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v]!(db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
