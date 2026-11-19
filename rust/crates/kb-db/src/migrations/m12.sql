
      -- What this bank charges on top of the reference rate when it converts currency, in percent
      -- (optional). Used to recognise transfers between accounts in different currencies, and as
      -- their exchange cost when there is no exchange rate for that day.
      ALTER TABLE accounts ADD COLUMN fx_cost_pct REAL CHECK (fx_cost_pct IS NULL OR (fx_cost_pct >= 0 AND fx_cost_pct <= 20));
    