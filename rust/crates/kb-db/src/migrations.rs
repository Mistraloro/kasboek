//! Schema migrations, ported one to one from src/core/migrations.ts: the same SQL, in the same order, with the same
//! text (it is stored in `sqlite_master`, and the parity test compares it). Never edit a migration that has shipped:
//! add a new one. The index + 1 is stored in `PRAGMA user_version`.
//!
//! The static SQL lives in `migrations/*.sql`, copied from the TypeScript template strings with `${now}` expanded.
//! Dialect notes (sqlite3mc today): `strftime` defaults, `GLOB` checks, `COLLATE NOCASE` indexes, `ALTER TABLE ADD
//! COLUMN` with CHECK, partial indexes and a view; migration 9 rebuilds a table because SQLite cannot alter a CHECK.
use crate::legacy::{fingerprint, real_reference, FingerprintInput};
use crate::sync_schema::{create_sync_triggers, install_sync_schema, spec};
use rusqlite::Connection;

type Migration = fn(&Connection) -> rusqlite::Result<()>;

/// The 15 migrations. Their number is the schema version.
pub const SCHEMA_VERSION: u32 = 15;

pub(crate) static MIGRATIONS: [Migration; SCHEMA_VERSION as usize] = [
    m01_core,
    m02_rules_secrets,
    m03_bank_names,
    m04_fx_rates,
    m05_account_kind_valuations,
    m06_sync,
    m07_rule_match,
    m08_pending_references,
    m09_bank_text_iban_rules,
    m10_transfers_splits_goals,
    m11_memories,
    m12_fx_cost,
    m13_recurring_marks,
    m14_insight_feedback,
    m15_insights,
];

fn m01_core(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m01.sql"))?;
    let mut insert = conn.prepare("INSERT INTO categories (name, kind, sort_order) VALUES (?, ?, ?)")?;
    let defaults = [
        ("Salary", "income"),
        ("Other income", "income"),
        ("Groceries", "expense"),
        ("Housing", "expense"),
        ("Utilities", "expense"),
        ("Transport", "expense"),
        ("Eating out", "expense"),
        ("Shopping", "expense"),
        ("Health", "expense"),
        ("Insurance", "expense"),
        ("Subscriptions", "expense"),
        ("Leisure", "expense"),
        ("Gifts", "expense"),
        ("Fees & taxes", "expense"),
        ("Own transfers", "transfer"),
        ("Savings", "transfer"),
    ];
    for (i, (name, kind)) in defaults.into_iter().enumerate() {
        insert.execute((name, kind, i as i64))?;
    }
    Ok(())
}

fn m02_rules_secrets(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m02.sql"))
}

fn m03_bank_names(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m03.sql"))
}

fn m04_fx_rates(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m04.sql"))
}

fn m05_account_kind_valuations(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m05.sql"))
}

fn m06_sync(conn: &Connection) -> rusqlite::Result<()> {
    install_sync_schema(conn)
}

fn m07_rule_match(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m07.sql"))
}

/// Pending payments were stored with a placeholder reference ("2026-"): no reference after all, so they match once
/// the bank has booked them. Their fingerprint is made again without it.
fn m08_pending_references(conn: &Connection) -> rusqlite::Result<()> {
    type Row = (i64, i64, String, i64, Option<String>, String, String);
    let rows: Vec<Row> = conn
        .prepare("SELECT id, account_id, booking_date, amount_cents, counterparty_name, description, bank_reference FROM transactions WHERE bank_reference IS NOT NULL")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
        .collect::<Result<_, _>>()?;
    let mut fix = conn.prepare("UPDATE transactions SET bank_reference = NULL, fingerprint = ? WHERE id = ?")?;
    for (id, account_id, booking_date, amount_cents, counterparty_name, description, bank_reference) in &rows {
        if real_reference(Some(bank_reference)).is_some() {
            continue;
        }
        let fp = fingerprint(&FingerprintInput {
            account_id: *account_id,
            booking_date,
            amount_cents: *amount_cents,
            counterparty_name: counterparty_name.as_deref(),
            description: Some(description),
            bank_reference: None,
        });
        fix.execute((fp, id))?;
    }
    // Rules made before whole-word matching existed: short texts match only as a whole word too.
    conn.execute_batch(include_str!("migrations/m08_short_rules.sql"))
}

fn m09_bank_text_iban_rules(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m09_bank_columns.sql"))?;
    // Rules on the counterparty's account number (field "iban"): rebuilt, as SQLite can't change a CHECK constraint.
    // Ids and sync ids stay the same; the sync triggers are made again.
    conn.execute_batch(include_str!("migrations/m09_rules_rebuild.sql"))?;
    create_sync_triggers(conn, spec("rules"))
}

fn m10_transfers_splits_goals(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m10.sql"))?;
    create_sync_triggers(conn, spec("transaction_splits"))?;
    create_sync_triggers(conn, spec("goals"))
}

fn m11_memories(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m11.sql"))
}

fn m12_fx_cost(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m12.sql"))
}

fn m13_recurring_marks(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m13.sql"))?;
    create_sync_triggers(conn, spec("recurring_marks"))
}

fn m14_insight_feedback(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m14.sql"))
}

fn m15_insights(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("migrations/m15.sql"))
}
