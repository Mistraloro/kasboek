
      -- What the person did with a tip on the Overview. On this computer only: not synced.
      CREATE TABLE insight_feedback (
        key TEXT PRIMARY KEY,
        verdict TEXT NOT NULL CHECK (verdict IN ('dismissed', 'not_useful', 'useful')),
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    