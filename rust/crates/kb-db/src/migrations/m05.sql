
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
    