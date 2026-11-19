
      ALTER TABLE transactions ADD COLUMN bank_counterparty TEXT;
      ALTER TABLE transactions ADD COLUMN bank_description TEXT;
      UPDATE transactions SET bank_counterparty = counterparty_name, bank_description = description;
    