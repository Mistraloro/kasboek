
      -- Exchange rates as "units of this currency for 1 euro" (how the ECB publishes them).
      -- 'ecb' rows come from the ECB's public reference rates, 'manual' rows are typed in.
      CREATE TABLE fx_rates (
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        per_eur REAL NOT NULL CHECK (per_eur > 0),
        source TEXT NOT NULL CHECK (source IN ('ecb', 'manual')),
        PRIMARY KEY (currency, date, source)
      );
      -- Transactions follow their account's currency unless the bank file said otherwise.
      UPDATE transactions SET currency = (SELECT a.currency FROM accounts a WHERE a.id = transactions.account_id)
        WHERE currency = 'EUR' AND (SELECT a.currency FROM accounts a WHERE a.id = transactions.account_id) != 'EUR';
    