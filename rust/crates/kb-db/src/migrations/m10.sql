
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
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
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
    