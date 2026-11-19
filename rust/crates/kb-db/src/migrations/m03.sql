
      UPDATE accounts SET bank = CASE bank
        WHEN 'argenta' THEN 'Argenta'
        WHEN 'hellobank' THEN 'Hello bank!'
        WHEN 'keytrade' THEN 'Keytrade Bank'
        WHEN 'other' THEN ''
        ELSE bank END;
    