
      CREATE TABLE rules_new (
        id INTEGER PRIMARY KEY,
        field TEXT NOT NULL CHECK (field IN ('counterparty', 'description', 'any', 'iban')),
        pattern TEXT NOT NULL,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
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
    