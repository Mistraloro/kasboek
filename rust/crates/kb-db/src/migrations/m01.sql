
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        bank TEXT NOT NULL DEFAULT 'other',
        iban TEXT UNIQUE,
        currency TEXT NOT NULL DEFAULT 'EUR',
        opening_balance_cents INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
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
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Every change, and who made it (you, the assistant, or the app itself).
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        actor TEXT NOT NULL CHECK (actor IN ('user', 'assistant', 'system')),
        action TEXT NOT NULL,
        details TEXT
      );
    