//! Typed queries of the local insights (`insights.*`), batch B2: the SQL is copied verbatim from src/core/insights.ts (and
//! `getSecret` of src/core/secrets.ts); the trait and its `impl for SqliteStore` stay in this file.
use crate::error::DbResult;
use crate::sqlite::SqliteStore;
use rusqlite::{params, OptionalExtension};

/// A payment of the last days (`recentPayments`).
#[derive(Debug, Clone)]
pub struct PaymentRow {
    pub id: i64,
    pub booking_date: String,
    pub amount_cents: i64,
}

/// The tips the assistant wrote for a month, as stored.
#[derive(Debug, Clone)]
pub struct InsightsRow {
    pub created_at: String,
    pub provider: String,
    pub model: String,
    pub language: String,
    pub facts_hash: String,
    pub facts_json: String,
    pub suggestions_json: String,
}

/// The verdicts that hide a tip.
const DISMISSED: [&str; 2] = ["dismissed", "not_useful"];

pub trait InsightsQueries {
    /// Payments from `from` to `to` (both included), oldest first, then by id.
    fn insights_recent_payments(&self, from: &str, to: &str) -> DbResult<Vec<PaymentRow>>;
    /// `(id, currency)` of every account.
    fn insights_account_currencies(&self) -> DbResult<Vec<(i64, String)>>;
    /// The keys of the tips the person hid or called not useful.
    fn insights_dismissed_keys(&self) -> DbResult<Vec<String>>;
    fn insights_feedback_set(&self, key: &str, verdict: &str) -> DbResult<()>;
    /// Deletes the hidden and "not useful" verdicts; returns how many.
    fn insights_restore_dismissed(&self) -> DbResult<u64>;
    fn insights_row(&self, month: &str) -> DbResult<Option<InsightsRow>>;
    /// `getSecret`: the value of a secret, if there is one.
    fn insights_secret(&self, key: &str) -> DbResult<Option<String>>;
}

impl InsightsQueries for SqliteStore {
    fn insights_recent_payments(&self, from: &str, to: &str) -> DbResult<Vec<PaymentRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, booking_date, amount_cents FROM transactions WHERE booking_date >= ? AND booking_date <= ? ORDER BY booking_date, id",
        )?;
        let rows = stmt
            .query_map(params![from, to], |r| Ok(PaymentRow { id: r.get(0)?, booking_date: r.get(1)?, amount_cents: r.get(2)? }))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn insights_account_currencies(&self) -> DbResult<Vec<(i64, String)>> {
        let mut stmt = self.conn.prepare("SELECT id, currency FROM accounts")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn insights_dismissed_keys(&self) -> DbResult<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT key FROM insight_feedback WHERE verdict IN (?,?)")?;
        let rows = stmt.query_map(params![DISMISSED[0], DISMISSED[1]], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn insights_feedback_set(&self, key: &str, verdict: &str) -> DbResult<()> {
        self.conn.execute(
            "INSERT INTO insight_feedback (key, verdict) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET verdict = excluded.verdict, at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![key, verdict],
        )?;
        Ok(())
    }

    fn insights_restore_dismissed(&self) -> DbResult<u64> {
        let n = self.conn.execute("DELETE FROM insight_feedback WHERE verdict IN (?,?)", params![DISMISSED[0], DISMISSED[1]])?;
        Ok(n as u64)
    }

    fn insights_row(&self, month: &str) -> DbResult<Option<InsightsRow>> {
        Ok(self
            .conn
            .query_row(
                "SELECT created_at, provider, model, language, facts_hash, facts_json, suggestions_json FROM insights WHERE month = ?",
                [month],
                |r| {
                    Ok(InsightsRow {
                        created_at: r.get(0)?,
                        provider: r.get(1)?,
                        model: r.get(2)?,
                        language: r.get(3)?,
                        facts_hash: r.get(4)?,
                        facts_json: r.get(5)?,
                        suggestions_json: r.get(6)?,
                    })
                },
            )
            .optional()?)
    }

    fn insights_secret(&self, key: &str) -> DbResult<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM secrets WHERE key = ?", [key], |r| r.get(0)).optional()?)
    }
}
