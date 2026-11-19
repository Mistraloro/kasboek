
      -- How a rule's text matches (anywhere, as a whole word, or at the start) and its place in the
      -- order: higher priority first, then counterparty rules, then longer texts.
      ALTER TABLE rules ADD COLUMN match TEXT NOT NULL DEFAULT 'contains' CHECK (match IN ('contains', 'word', 'starts'));
      ALTER TABLE rules ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
      -- Duplicate checks on import: the bank's own reference, and the same amount a few days apart.
      CREATE INDEX idx_tx_bank_reference ON transactions(account_id, bank_reference) WHERE bank_reference IS NOT NULL;
      CREATE INDEX idx_tx_account_amount ON transactions(account_id, amount_cents, booking_date);
    