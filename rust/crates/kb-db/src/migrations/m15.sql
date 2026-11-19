
      -- The tips the assistant last wrote for a month, with the facts that were sent. On this computer only: not synced.
      CREATE TABLE insights (
        month TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        language TEXT NOT NULL,
        facts_hash TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        suggestions_json TEXT NOT NULL
      );
    