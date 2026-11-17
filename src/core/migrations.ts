import type { Db } from './database'
import { SPEC, createSyncTriggers, installSyncSchema } from './sync-schema'
import { realReference } from './csv/normalize'
import { fingerprint } from './fingerprint'

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
  },
  (db) => {
    db.exec(`
      -- Exchange rates as "units of this currency for 1 euro" (how the ECB publishes them).
      -- 'ecb' rows come from the ECB's public reference rates, 'manual' rows are typed in.
      CREATE TABLE fx_rates (
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        per_eur REAL NOT NULL CHECK (per_eur > 0),
        source TEXT NOT NULL CHECK (source IN ('ecb', 'manual')),
        PRIMARY KEY (currency, date, source)
      );
      -- Transactions follow their account's currency unless the bank file said otherwise.
      UPDATE transactions SET currency = (SELECT a.currency FROM accounts a WHERE a.id = transactions.account_id)
        WHERE currency = 'EUR' AND (SELECT a.currency FROM accounts a WHERE a.id = transactions.account_id) != 'EUR';
    `)
  },
  (db) => {
    db.exec(`
      -- What kind of account: decides how it counts in net worth and where it is listed.
      ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'current'
        CHECK (kind IN ('current', 'savings', 'investment', 'cash', 'credit_card', 'loan', 'other'));

      -- The value of an account on a day (e.g. a broker portfolio), in the account's currency.
      -- Payments after that day are added on top until the next value.
      CREATE TABLE valuations (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        value_cents INTEGER NOT NULL,
        note TEXT,
        UNIQUE (account_id, date)
      );
    `)
  },
  (db) => installSyncSchema(db),
  (db) => {
    db.exec(`
      -- How a rule's text matches (anywhere, as a whole word, or at the start) and its place in the
      -- order: higher priority first, then counterparty rules, then longer texts.
      ALTER TABLE rules ADD COLUMN match TEXT NOT NULL DEFAULT 'contains' CHECK (match IN ('contains', 'word', 'starts'));
      ALTER TABLE rules ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
      -- Duplicate checks on import: the bank's own reference, and the same amount a few days apart.
      CREATE INDEX idx_tx_bank_reference ON transactions(account_id, bank_reference) WHERE bank_reference IS NOT NULL;
      CREATE INDEX idx_tx_account_amount ON transactions(account_id, amount_cents, booking_date);
    `)
  },
  (db) => {
    // Pending payments were stored with a placeholder reference ("2026-"): no reference after all,
    // so they match once the bank has booked them. Their fingerprint is made again without it.
    const rows = db.prepare('SELECT id, account_id, booking_date, amount_cents, counterparty_name, description, bank_reference FROM transactions WHERE bank_reference IS NOT NULL').all() as {
      id: number
      account_id: number
      booking_date: string
      amount_cents: number
      counterparty_name: string | null
      description: string
      bank_reference: string
    }[]
    const fix = db.prepare('UPDATE transactions SET bank_reference = NULL, fingerprint = ? WHERE id = ?')
    for (const r of rows) {
      if (realReference(r.bank_reference) !== null) continue
      fix.run(fingerprint({ accountId: r.account_id, bookingDate: r.booking_date, amountCents: r.amount_cents, counterpartyName: r.counterparty_name, description: r.description, bankReference: null }), r.id)
    }
    // Rules made before whole-word matching existed: short texts match only as a whole word too.
    db.exec(`UPDATE rules SET match = 'word' WHERE match = 'contains' AND length(trim(pattern)) < 4`)
  },
  (db) => {
    // The bank's own text next to the readable one (which Check may tidy), so rules and duplicate
    // checks keep seeing what the next CSV will say. Existing rows: the text they have now.
    db.exec(`
      ALTER TABLE transactions ADD COLUMN bank_counterparty TEXT;
      ALTER TABLE transactions ADD COLUMN bank_description TEXT;
      UPDATE transactions SET bank_counterparty = counterparty_name, bank_description = description;
    `)
    // Rules on the counterparty's account number (field "iban"): rebuilt, as SQLite can't change a
    // CHECK constraint. Ids and sync ids stay the same; the sync triggers are made again.
    db.exec(`
      CREATE TABLE rules_new (
        id INTEGER PRIMARY KEY,
        field TEXT NOT NULL CHECK (field IN ('counterparty', 'description', 'any', 'iban')),
        pattern TEXT NOT NULL,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT ${now},
        match TEXT NOT NULL DEFAULT 'contains' CHECK (match IN ('contains', 'word', 'starts')),
        priority INTEGER NOT NULL DEFAULT 0,
        uid TEXT
      );
      INSERT INTO rules_new (id, field, pattern, category_id, created_at, match, priority, uid)
        SELECT id, field, pattern, category_id, created_at, match, priority, uid FROM rules;
      DROP TABLE rules;
      ALTER TABLE rules_new RENAME TO rules;
      CREATE UNIQUE INDEX idx_rules_unique ON rules(field, pattern COLLATE NOCASE);
      CREATE UNIQUE INDEX idx_rules_uid ON rules(uid);
    `)
    createSyncTriggers(db, SPEC.get('rules')!)
  },
  (db) => {
    db.exec(`
      -- Both halves of a transfer between the person's own accounts share this key.
      ALTER TABLE transactions ADD COLUMN transfer_pair TEXT;
      CREATE INDEX idx_tx_transfer_pair ON transactions(transfer_pair) WHERE transfer_pair IS NOT NULL;

      -- One payment over several categories (e.g. one receipt: groceries and household). The
      -- parts add up to the transaction's amount; summaries count the parts instead.
      CREATE TABLE transaction_splits (
        id INTEGER PRIMARY KEY,
        tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        amount_cents INTEGER NOT NULL,
        note TEXT,
        uid TEXT
      );
      CREATE INDEX idx_splits_tx ON transaction_splits(tx_id);
      CREATE UNIQUE INDEX idx_transaction_splits_uid ON transaction_splits(uid);

      -- Savings goals: an amount by a date, tracked by an account's balance or by hand.
      CREATE TABLE goals (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        target_cents INTEGER NOT NULL CHECK (target_cents > 0),
        target_date TEXT CHECK (target_date IS NULL OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        saved_cents INTEGER,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT ${now},
        uid TEXT
      );
      CREATE UNIQUE INDEX idx_goals_uid ON goals(uid);

      -- What summaries count: a transaction, or its parts when it is split.
      CREATE VIEW tx_lines AS
        SELECT t.id AS tx_id, t.account_id, t.booking_date, t.currency, t.category_id, t.amount_cents
        FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.tx_id = t.id)
        UNION ALL
        SELECT t.id, t.account_id, t.booking_date, t.currency, s.category_id, s.amount_cents
        FROM transaction_splits s JOIN transactions t ON t.id = s.tx_id;
    `)
    createSyncTriggers(db, SPEC.get('transaction_splits')!)
    createSyncTriggers(db, SPEC.get('goals')!)
  },
  (db) => {
    db.exec(`
      -- What the assistant remembers between conversations. On this computer only: not synced.
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 300),
        source TEXT NOT NULL CHECK (source IN ('person', 'assistant')),
        created_at TEXT NOT NULL DEFAULT ${now},
        updated_at TEXT NOT NULL DEFAULT ${now}
      );
    `)
  },
  (db) => {
    db.exec(`
      -- What this bank charges on top of the reference rate when it converts currency, in percent
      -- (optional). Used to recognise transfers between accounts in different currencies, and as
      -- their exchange cost when there is no exchange rate for that day.
      ALTER TABLE accounts ADD COLUMN fx_cost_pct REAL CHECK (fx_cost_pct IS NULL OR (fx_cost_pct >= 0 AND fx_cost_pct <= 20));
    `)
  },
  (db) => {
    db.exec(`
      -- Fixed costs are found from the transactions; this only remembers the ones the person said
      -- are not fixed (by the item's key). Rows are never deleted, see setRecurringHidden.
      CREATE TABLE recurring_marks (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 4 AND 200),
        hidden INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT ${now},
        uid TEXT
      );
      CREATE UNIQUE INDEX idx_recurring_marks_uid ON recurring_marks(uid);
    `)
    createSyncTriggers(db, SPEC.get('recurring_marks')!)
  },
  (db) => {
    db.exec(`
      -- What the person did with a tip on the Overview. On this computer only: not synced.
      CREATE TABLE insight_feedback (
        key TEXT PRIMARY KEY,
        verdict TEXT NOT NULL CHECK (verdict IN ('dismissed', 'not_useful', 'useful')),
        at TEXT NOT NULL DEFAULT ${now}
      );
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
