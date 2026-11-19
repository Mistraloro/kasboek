
      -- Fixed costs are found from the transactions; this only remembers the ones the person said
      -- are not fixed (by the item's key). Rows are never deleted, see setRecurringHidden.
      CREATE TABLE recurring_marks (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 4 AND 200),
        hidden INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        uid TEXT
      );
      CREATE UNIQUE INDEX idx_recurring_marks_uid ON recurring_marks(uid);
    