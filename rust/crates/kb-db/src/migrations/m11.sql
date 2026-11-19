
      -- What the assistant remembers between conversations. On this computer only: not synced.
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 300),
        source TEXT NOT NULL CHECK (source IN ('person', 'assistant')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    