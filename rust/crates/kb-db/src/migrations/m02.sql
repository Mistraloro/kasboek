
      -- "Always put X in category Y".
      CREATE TABLE rules (
        id INTEGER PRIMARY KEY,
        field TEXT NOT NULL CHECK (field IN ('counterparty', 'description', 'any')),
        pattern TEXT NOT NULL,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX idx_rules_unique ON rules(field, pattern COLLATE NOCASE);

      -- API keys and similar, inside the encrypted database. Never returned to the UI.
      CREATE TABLE secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    