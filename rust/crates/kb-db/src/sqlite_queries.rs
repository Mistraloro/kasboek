//! The SQL of the business operations: `Queries` on sqlite3mc. Statements follow src/core/{finance,balance,wealth,fx,
//! settings,ops}.ts one to one (same text where it matters for results: ordering, `fx()` placement, `LIKE ... ESCAPE`).
use crate::error::DbResult;
use crate::queries::Queries;
use crate::rows::*;
use crate::sqlite::SqliteStore;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, OptionalExtension, Row};

/// A transaction's amount in currency `to` (a SQL parameter by default), NULL when there is no rate.
fn fx_sql(to: &str) -> String {
    format!("fx(t.amount_cents, t.currency, t.booking_date, {to})")
}

fn account(r: &Row<'_>) -> rusqlite::Result<AccountRow> {
    Ok(AccountRow {
        id: r.get("id")?,
        name: r.get("name")?,
        bank: r.get("bank")?,
        iban: r.get("iban")?,
        currency: r.get("currency")?,
        kind: r.get("kind")?,
        opening_balance_cents: r.get("opening_balance_cents")?,
        archived: r.get::<_, i64>("archived")? == 1,
        created_at: r.get("created_at")?,
        fx_cost_pct: r.get("fx_cost_pct")?,
    })
}

fn tx(r: &Row<'_>) -> rusqlite::Result<TxRow> {
    Ok(TxRow {
        id: r.get("id")?,
        account_id: r.get("account_id")?,
        account_name: r.get("account_name")?,
        booking_date: r.get("booking_date")?,
        value_date: r.get("value_date")?,
        amount_cents: r.get("amount_cents")?,
        currency: r.get("currency")?,
        description: r.get("description")?,
        counterparty_name: r.get("counterparty_name")?,
        counterparty_iban: r.get("counterparty_iban")?,
        communication: r.get("communication")?,
        category_id: r.get("category_id")?,
        category_name: r.get("category_name")?,
        notes: r.get("notes")?,
        import_batch_id: r.get("import_batch_id")?,
        transfer_account: r.get("transfer_account")?,
        split_count: r.get("split_count")?,
    })
}

const TX_SELECT: &str = "SELECT t.*, a.name AS account_name, c.name AS category_name,
    (SELECT pa.name FROM transactions p JOIN accounts pa ON pa.id = p.account_id WHERE p.transfer_pair = t.transfer_pair AND p.id <> t.id) AS transfer_account,
    (SELECT count(*) FROM transaction_splits s WHERE s.tx_id = t.id) AS split_count
  FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id";

/// The WHERE part of a transactions filter and its arguments (`txWhere` in finance.ts).
fn tx_where(f: &TxFilterRow) -> (String, Vec<Value>) {
    let mut clauses: Vec<&str> = Vec::new();
    let mut args: Vec<Value> = Vec::new();
    // `if (f.accountId)`: an id of 0 cannot occur (ids are positive), so presence is enough.
    if let Some(id) = f.account_id {
        clauses.push("t.account_id = ?");
        args.push(Value::Integer(id));
    }
    match f.category {
        Some(CategoryFilter::None) => clauses.push("t.category_id IS NULL"),
        Some(CategoryFilter::Id(id)) => {
            clauses.push("t.category_id = ?");
            args.push(Value::Integer(id));
        }
        None => {}
    }
    if let Some((from, to)) = &f.month {
        clauses.push("t.booking_date >= ? AND t.booking_date < ?");
        args.push(Value::Text(from.clone()));
        args.push(Value::Text(to.clone()));
    }
    if let Some(from) = &f.from {
        clauses.push("t.booking_date >= ?");
        args.push(Value::Text(from.clone()));
    }
    if let Some(to) = &f.to {
        clauses.push("t.booking_date <= ?");
        args.push(Value::Text(to.clone()));
    }
    match f.direction {
        Some(Direction::In) => clauses.push("t.amount_cents > 0"),
        Some(Direction::Out) => clauses.push("t.amount_cents < 0"),
        None => {}
    }
    if let Some(search) = &f.search {
        let mut q = String::from("%");
        for c in search.chars() {
            if matches!(c, '%' | '_' | '\\') {
                q.push('\\');
            }
            q.push(c);
        }
        q.push('%');
        // The readable text and the bank's own.
        clauses.push(
            "(t.description LIKE ? ESCAPE '\\' OR t.counterparty_name LIKE ? ESCAPE '\\' OR t.communication LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\' OR t.bank_counterparty LIKE ? ESCAPE '\\' OR t.bank_description LIKE ? ESCAPE '\\')",
        );
        args.extend(std::iter::repeat_n(Value::Text(q), 6));
    }
    let w = if clauses.is_empty() { String::new() } else { format!("WHERE {}", clauses.join(" AND ")) };
    (w, args)
}

impl SqliteStore {
    fn has_table(&self, name: &str) -> DbResult<bool> {
        Ok(self.conn.query_row("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)", [name], |r| r.get(0))?)
    }

    fn has_setting(&self, key: &str) -> DbResult<bool> {
        Ok(self.conn.query_row("SELECT EXISTS (SELECT 1 FROM settings WHERE key = ?1)", [key], |r| r.get(0))?)
    }

    fn has_secret(&self, condition: &str) -> DbResult<bool> {
        Ok(self.conn.query_row(&format!("SELECT EXISTS (SELECT 1 FROM secrets WHERE {condition})"), [], |r| r.get(0))?)
    }
}

const AI_SECRETS: &str = "key = 'anthropicApiKey' OR key LIKE 'aiKey.%'";

fn sync_secrets(keep_sync_key: bool) -> &'static str {
    if keep_sync_key {
        "key = 'webdavPassword'"
    } else {
        "key IN ('syncKey', 'webdavPassword')"
    }
}

impl Queries for SqliteStore {
    fn settings_rows(&self) -> DbResult<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn setting_get(&self, key: &str) -> DbResult<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    fn setting_set(&self, key: &str, value: &str) -> DbResult<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    fn audit_insert(&self, actor: &str, action: &str, details: &str) -> DbResult<()> {
        self.conn.execute("INSERT INTO audit_log (actor, action, details) VALUES (?1, ?2, ?3)", [actor, action, details])?;
        Ok(())
    }

    fn accounts_all(&self) -> DbResult<Vec<AccountRow>> {
        let mut stmt = self.conn.prepare("SELECT * FROM accounts ORDER BY archived, name")?;
        let rows = stmt.query_map([], account)?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn account_get(&self, id: i64) -> DbResult<Option<AccountRow>> {
        Ok(self.conn.query_row("SELECT * FROM accounts WHERE id = ?1", [id], account).optional()?)
    }

    fn account_insert(&self, new: &NewAccount) -> DbResult<AccountRow> {
        Ok(self.conn.query_row(
            "INSERT INTO accounts (name, bank, iban, currency, kind, opening_balance_cents, fx_cost_pct)
               VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
            params![new.name, new.bank, new.iban, new.currency, new.kind, new.opening_balance_cents, new.fx_cost_pct],
            account,
        )?)
    }

    fn account_update(&self, row: &AccountRow) -> DbResult<()> {
        self.conn.execute(
            "UPDATE accounts SET name = ?, bank = ?, iban = ?, currency = ?, kind = ?, archived = ?, fx_cost_pct = ? WHERE id = ?",
            params![row.name, row.bank, row.iban, row.currency, row.kind, i64::from(row.archived), row.fx_cost_pct, row.id],
        )?;
        Ok(())
    }

    fn account_recurrency_transactions(&self, account_id: i64, from: &str, to: &str) -> DbResult<()> {
        self.conn.execute("UPDATE transactions SET currency = ? WHERE account_id = ? AND currency = ?", params![to, account_id, from])?;
        Ok(())
    }

    fn account_balance_rows(&self) -> DbResult<Vec<BalanceRow>> {
        let sql = format!(
            "SELECT a.id, a.currency, a.opening_balance_cents + coalesce(sum({}), 0) AS bal, count(t.id) AS n,
         EXISTS (SELECT 1 FROM valuations v WHERE v.account_id = a.id) AS checked
       FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id GROUP BY a.id",
            fx_sql("a.currency")
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(BalanceRow { id: r.get(0)?, currency: r.get(1)?, bal: r.get(2)?, count: r.get(3)?, checked: r.get::<_, i64>(4)? != 0 })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn accounts_with_valuations(&self) -> DbResult<Vec<i64>> {
        let mut stmt = self.conn.prepare("SELECT DISTINCT account_id AS id FROM valuations")?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn tx_sum(&self, account_id: i64, currency: &str, after: Option<&str>, up_to: Option<&str>) -> DbResult<f64> {
        Ok(self.conn.query_row(
            "SELECT coalesce(sum(coalesce(fx(amount_cents, currency, booking_date, ?), 0)), 0) AS s FROM transactions
       WHERE account_id = ? AND (? IS NULL OR booking_date > ?) AND (? IS NULL OR booking_date <= ?)",
            params![currency, account_id, after, after, up_to, up_to],
            |r| r.get(0),
        )?)
    }

    fn fx_convert(&self, cents: f64, from: &str, date: &str, to: &str) -> DbResult<Option<f64>> {
        Ok(self.conn.query_row("SELECT fx(?, ?, ?, ?) AS v", params![cents, from, date, to], |r| r.get(0))?)
    }

    fn checkpoints(&self, account_id: i64) -> DbResult<Vec<CheckpointRow>> {
        let mut stmt = self.conn.prepare("SELECT date, value_cents AS value, note FROM valuations WHERE account_id = ? ORDER BY date")?;
        let rows = stmt
            .query_map([account_id], |r| Ok(CheckpointRow { date: r.get(0)?, value: r.get(1)?, note: r.get(2)? }))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn valuations_list(&self, account_id: i64) -> DbResult<Vec<ValuationRow>> {
        let mut stmt =
            self.conn.prepare("SELECT account_id, date, value_cents, note FROM valuations WHERE account_id = ? ORDER BY date DESC")?;
        let rows = stmt
            .query_map([account_id], |r| {
                Ok(ValuationRow { account_id: r.get(0)?, date: r.get(1)?, value_cents: r.get(2)?, note: r.get(3)? })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn valuation_upsert(&self, account_id: i64, date: &str, value_cents: i64, note: Option<&str>) -> DbResult<()> {
        self.conn.execute(
            "INSERT INTO valuations (account_id, date, value_cents, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, date) DO UPDATE SET value_cents = excluded.value_cents, note = excluded.note",
            params![account_id, date, value_cents, note],
        )?;
        Ok(())
    }

    fn valuation_delete(&self, account_id: i64, date: &str) -> DbResult<()> {
        self.conn.execute("DELETE FROM valuations WHERE account_id = ? AND date = ?", params![account_id, date])?;
        Ok(())
    }

    fn categories_all(&self) -> DbResult<Vec<CategoryRow>> {
        let mut stmt = self.conn.prepare("SELECT * FROM categories ORDER BY kind, sort_order, name")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CategoryRow {
                    id: r.get("id")?,
                    name: r.get("name")?,
                    kind: r.get("kind")?,
                    parent_id: r.get("parent_id")?,
                    color: r.get("color")?,
                    sort_order: r.get("sort_order")?,
                    archived: r.get::<_, i64>("archived")? == 1,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn category_exists(&self, id: i64) -> DbResult<bool> {
        Ok(self.conn.query_row("SELECT EXISTS (SELECT 1 FROM categories WHERE id = ?)", [id], |r| r.get(0))?)
    }

    fn category_insert(&self, name: &str, kind: &str) -> DbResult<i64> {
        let max: i64 = self.conn.query_row("SELECT coalesce(max(sort_order), 0) AS m FROM categories", [], |r| r.get(0))?;
        self.conn.execute("INSERT INTO categories (name, kind, sort_order) VALUES (?, ?, ?)", params![name, kind, max + 1])?;
        Ok(self.conn.last_insert_rowid())
    }

    fn category_set_name(&self, id: i64, name: &str) -> DbResult<()> {
        self.conn.execute("UPDATE categories SET name = ? WHERE id = ?", params![name, id])?;
        Ok(())
    }

    fn category_set_archived(&self, id: i64, archived: bool) -> DbResult<()> {
        self.conn.execute("UPDATE categories SET archived = ? WHERE id = ?", params![i64::from(archived), id])?;
        Ok(())
    }

    fn tx_page(&self, filter: &TxFilterRow, limit: i64, offset: i64, main: &str) -> DbResult<(Vec<TxRow>, TxTotals)> {
        let (w, args) = tx_where(filter);
        let mut page_args = args.clone();
        page_args.push(Value::Integer(limit));
        page_args.push(Value::Integer(offset));
        let mut stmt = self.conn.prepare(&format!("{TX_SELECT} {w} ORDER BY t.booking_date DESC, t.id DESC LIMIT ? OFFSET ?"))?;
        let items = stmt.query_map(params_from_iter(page_args), tx)?.collect::<Result<Vec<_>, _>>()?;
        let fx = fx_sql("?");
        let mut agg_args = vec![Value::Text(main.to_owned()), Value::Text(main.to_owned())];
        agg_args.extend(args);
        let totals = self.conn.query_row(
            &format!(
                "SELECT count(*) AS n, coalesce(sum(CASE WHEN amount_cents > 0 THEN {fx} END), 0) AS inc,
              coalesce(sum(CASE WHEN amount_cents < 0 THEN {fx} END), 0) AS outc
       FROM transactions t {w}"
            ),
            params_from_iter(agg_args),
            |r| Ok(TxTotals { count: r.get(0)?, income: r.get(1)?, outgoing: r.get(2)? }),
        )?;
        Ok((items, totals))
    }

    fn tx_get(&self, id: i64) -> DbResult<Option<TxRow>> {
        Ok(self.conn.query_row(&format!("{TX_SELECT} WHERE t.id = ?"), [id], tx).optional()?)
    }

    fn tx_insert(&self, new: &NewTxRow) -> DbResult<i64> {
        self.conn.execute(
            "INSERT INTO transactions (account_id, booking_date, value_date, amount_cents, currency, description, counterparty_name,
         counterparty_iban, communication, category_id, notes, import_batch_id, bank_reference, fingerprint, bank_counterparty, bank_description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                new.account_id,
                new.booking_date,
                new.value_date,
                new.amount_cents,
                new.currency,
                new.description,
                new.counterparty_name,
                new.counterparty_iban,
                new.communication,
                new.category_id,
                new.notes,
                new.import_batch_id,
                new.bank_reference,
                new.fingerprint,
                new.bank_counterparty,
                new.bank_description
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    fn tx_update(&self, id: i64, edit: &TxEdit) -> DbResult<()> {
        self.conn.execute(
            "UPDATE transactions SET category_id = ?, notes = ?, description = ?, booking_date = ?,
       amount_cents = ?, counterparty_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
            params![edit.category_id, edit.notes, edit.description, edit.booking_date, edit.amount_cents, edit.counterparty_name, id],
        )?;
        Ok(())
    }

    fn tx_set_category(&self, id: i64, category_id: Option<i64>, only_uncategorised: bool) -> DbResult<u64> {
        let only = if only_uncategorised { " AND category_id IS NULL" } else { "" };
        let n = self.conn.execute(
            &format!("UPDATE transactions SET category_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?{only}"),
            params![category_id, id],
        )?;
        Ok(n as u64)
    }

    fn tx_set_counterparty(&self, id: i64, name: &str) -> DbResult<u64> {
        let n = self.conn.execute(
            "UPDATE transactions SET counterparty_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
            params![name, id],
        )?;
        Ok(n as u64)
    }

    fn tx_delete(&self, id: i64) -> DbResult<u64> {
        Ok(self.conn.execute("DELETE FROM transactions WHERE id = ?", [id])? as u64)
    }

    fn tx_amount(&self, id: i64) -> DbResult<Option<i64>> {
        Ok(self.conn.query_row("SELECT amount_cents FROM transactions WHERE id = ?", [id], |r| r.get(0)).optional()?)
    }

    fn splits_list(&self, tx_id: i64) -> DbResult<Vec<SplitRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.category_id, s.amount_cents, s.note, c.name AS category_name FROM transaction_splits s LEFT JOIN categories c ON c.id = s.category_id WHERE s.tx_id = ? ORDER BY s.id",
        )?;
        let rows = stmt
            .query_map([tx_id], |r| {
                Ok(SplitRow { category_id: r.get(0)?, amount_cents: r.get(1)?, note: r.get(2)?, category_name: r.get(3)? })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn splits_replace(&self, tx_id: i64, parts: &[NewSplit]) -> DbResult<()> {
        self.conn.execute("DELETE FROM transaction_splits WHERE tx_id = ?", [tx_id])?;
        let mut add = self.conn.prepare("INSERT INTO transaction_splits (tx_id, category_id, amount_cents, note) VALUES (?, ?, ?, ?)")?;
        for p in parts {
            add.execute(params![tx_id, p.category_id, p.amount_cents, p.note])?;
        }
        self.conn.execute("UPDATE transactions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [tx_id])?;
        Ok(())
    }

    fn rules_all(&self) -> DbResult<Vec<RuleRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT r.*, c.name AS category_name FROM rules r JOIN categories c ON c.id = r.category_id
         ORDER BY r.priority DESC, r.field = 'counterparty' DESC, length(r.pattern) DESC, r.id",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(RuleRow {
                    id: r.get("id")?,
                    field: r.get("field")?,
                    match_kind: r.get("match")?,
                    pattern: r.get("pattern")?,
                    category_id: r.get("category_id")?,
                    category_name: r.get("category_name")?,
                    priority: r.get("priority")?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn fx_manual_rates(&self, currency: Option<&str>) -> DbResult<Vec<FxRateRow>> {
        let sql = format!(
            "SELECT currency, date, per_eur FROM fx_rates WHERE source = 'manual' {} ORDER BY currency, date DESC",
            if currency.is_some() { "AND currency = ?" } else { "" }
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let args: Vec<Value> = currency.map(|c| Value::Text(c.to_owned())).into_iter().collect();
        let rows = stmt
            .query_map(params_from_iter(args), |r| {
                Ok(FxRateRow { currency: r.get(0)?, date: r.get(1)?, per_eur: r.get(2)?, source: "manual".into() })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn fx_set_manual_rate(&self, currency: &str, date: &str, per_eur: f64) -> DbResult<()> {
        self.conn.execute(
            "INSERT INTO fx_rates (currency, date, per_eur, source) VALUES (?, ?, ?, 'manual')
     ON CONFLICT(currency, date, source) DO UPDATE SET per_eur = excluded.per_eur",
            params![currency, date, per_eur],
        )?;
        Ok(())
    }

    fn fx_delete_manual_rate(&self, currency: &str, date: &str) -> DbResult<()> {
        self.conn.execute("DELETE FROM fx_rates WHERE source = 'manual' AND currency = ? AND date = ?", params![currency, date])?;
        Ok(())
    }

    fn fx_used_currencies(&self, main: &str) -> DbResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT currency FROM accounts UNION SELECT currency FROM transactions UNION SELECT ? UNION SELECT currency FROM fx_rates WHERE source = 'manual'")?;
        let rows = stmt.query_map([main], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn fx_currency_facts(&self, currency: &str) -> DbResult<FxCurrencyFacts> {
        let latest = self
            .conn
            .query_row(
                "SELECT date, per_eur, source FROM fx_rates WHERE currency = ? ORDER BY date DESC, CASE source WHEN 'manual' THEN 0 ELSE 1 END LIMIT 1",
                [currency],
                |r| Ok(FxRateRow { currency: currency.to_owned(), date: r.get(0)?, per_eur: r.get(1)?, source: r.get(2)? }),
            )
            .optional()?;
        let mut stmt = self.conn.prepare("SELECT source, count(*) AS n FROM fx_rates WHERE currency = ? GROUP BY source")?;
        let counts: Vec<(String, i64)> = stmt.query_map([currency], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        let count = |source: &str| counts.iter().find(|(s, _)| s == source).map_or(0, |(_, n)| *n);
        Ok(FxCurrencyFacts {
            currency: currency.to_owned(),
            latest,
            ecb_rates: count("ecb"),
            manual_rates: count("manual"),
            oldest_tx: self
                .conn
                .query_row("SELECT min(booking_date) AS d FROM transactions WHERE currency = ?", [currency], |r| r.get(0))?,
            first_rate: self.conn.query_row("SELECT min(date) AS d FROM fx_rates WHERE currency = ?", [currency], |r| r.get(0))?,
        })
    }

    fn import_reset_facts(&self, keep_sync_key: bool) -> DbResult<ImportResetFacts> {
        let has_secrets = self.has_table("secrets")?;
        let has_memories = self.has_table("memories")?;
        let secret = |condition: &str| -> DbResult<bool> {
            if has_secrets {
                self.has_secret(condition)
            } else {
                Ok(false)
            }
        };
        let sync_was_on = self.has_table("sync_flags")?
            && self.conn.query_row("SELECT enabled FROM sync_flags", [], |r| r.get::<_, i64>(0)).optional()? == Some(1);
        Ok(ImportResetFacts {
            ai_key: secret(AI_SECRETS)?,
            ai_endpoint: self.has_setting("aiBaseUrl")? || self.has_setting("aiProvider")? || self.has_setting("aiProviders")?,
            permissions: self.has_setting("permissions")?,
            mcp: self.has_setting("mcpEnabled")?,
            auto_backup: self.has_setting("autoBackupFolder")? || self.has_setting("autoBackupEnabled")?,
            memory: self.has_setting("memoryEnabled")?
                || (has_memories && self.conn.query_row("SELECT EXISTS (SELECT 1 FROM memories)", [], |r| r.get::<_, bool>(0))?),
            // The WebDAV password of a join is replaced by the caller: nothing to tell the user about.
            sync: !keep_sync_key && (secret(sync_secrets(keep_sync_key))? || sync_was_on),
        })
    }

    fn import_reset_apply(&self, keys: &[&str], keep_sync_key: bool) -> DbResult<()> {
        for key in keys {
            self.conn.execute("DELETE FROM settings WHERE key = ?", [key])?;
        }
        // The key names of keyName() in main/assistant/provider.ts: Claude's own and one per other provider.
        if self.has_table("secrets")? {
            self.conn.execute(&format!("DELETE FROM secrets WHERE {AI_SECRETS} OR {}", sync_secrets(keep_sync_key)), [])?;
        }
        // Without its key this database can't sync: switch sync off as stopSync does (main/sync/service.ts).
        if !keep_sync_key {
            if self.has_table("sync_flags")? {
                self.conn.execute("UPDATE sync_flags SET enabled = 0, applying = 0", [])?;
            }
            for table in ["sync_outbox", "sync_rows", "sync_pending", "sync_meta"] {
                if self.has_table(table)? {
                    self.conn.execute(&format!("DELETE FROM {table}"), [])?;
                }
            }
        }
        if self.has_table("memories")? {
            self.conn.execute("DELETE FROM memories", [])?;
        }
        // Tips written for another computer's data are not shown here.
        if self.has_table("insights")? {
            self.conn.execute("DELETE FROM insights", [])?;
        }
        Ok(())
    }
}
