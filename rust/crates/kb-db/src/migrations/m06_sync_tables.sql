
    CREATE TABLE sync_flags (enabled INTEGER NOT NULL DEFAULT 0, applying INTEGER NOT NULL DEFAULT 0);
    INSERT INTO sync_flags (enabled, applying) VALUES (0, 0);
    -- Rows changed locally since the last sync (filled by triggers while sync is on).
    CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY, tbl TEXT NOT NULL, uid TEXT NOT NULL);
    -- The last synced state of each row: values and, per field, when it last changed.
    CREATE TABLE sync_rows (
      tbl TEXT NOT NULL, uid TEXT NOT NULL, data TEXT NOT NULL, ts TEXT NOT NULL, deleted TEXT,
      PRIMARY KEY (tbl, uid)
    );
    CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- Changes from another computer that clashed with a change here, for the person to see.
    CREATE TABLE sync_conflicts (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, summary TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0
    );
    -- Changes that refer to rows not here yet (arrive in a later file); retried every sync.
    CREATE TABLE sync_pending (id INTEGER PRIMARY KEY, device TEXT NOT NULL, change TEXT NOT NULL);
  