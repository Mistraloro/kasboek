//! What is synced between computers, and the triggers that record every change. Port of src/core/sync-schema.ts.
//!
//! The trigger text is written the way the TypeScript core writes it, down to the indentation, because SQLite stores
//! that text in `sqlite_master` and the parity test compares it.
use rusqlite::Connection;

const SYNC_TABLES_SQL: &str = include_str!("migrations/m06_sync_tables.sql");
const RANDOM: &str = "lower(hex(randomblob(16)))";

/// One synced table.
pub struct TableSpec {
    pub table: &'static str,
    /// SQL for a new row's uid (uses `NEW.`).
    pub uid: &'static str,
    pub cols: &'static [&'static str],
    /// Foreign keys, sent as the referenced row's uid: (column, referenced table).
    pub fks: &'static [(&'static str, &'static str)],
    /// Only rows matching this condition (on `NEW.` / `OLD.`) are synced; takes the row alias.
    pub when: Option<fn(&str) -> String>,
}

fn only_currency(row: &str) -> String {
    format!("{row}.key IN ('currency')")
}

fn only_manual(row: &str) -> String {
    format!("{row}.source = 'manual'")
}

/// In dependency order: a row only refers to tables before it.
pub static SYNC_TABLES: &[TableSpec] = &[
    TableSpec { table: "settings", uid: "NEW.key", cols: &["key", "value"], fks: &[], when: Some(only_currency) },
    TableSpec {
        table: "accounts",
        uid: RANDOM,
        cols: &["name", "bank", "iban", "currency", "kind", "opening_balance_cents", "archived", "created_at", "fx_cost_pct"],
        fks: &[],
        when: None,
    },
    TableSpec {
        table: "categories",
        uid: RANDOM,
        cols: &["name", "kind", "parent_id", "color", "sort_order", "archived"],
        fks: &[("parent_id", "categories")],
        when: None,
    },
    TableSpec {
        table: "rules",
        uid: RANDOM,
        cols: &["field", "pattern", "category_id", "created_at", "match", "priority"],
        fks: &[("category_id", "categories")],
        when: None,
    },
    TableSpec {
        table: "transactions",
        uid: RANDOM,
        cols: &[
            "account_id",
            "booking_date",
            "value_date",
            "amount_cents",
            "currency",
            "description",
            "counterparty_name",
            "counterparty_iban",
            "communication",
            "category_id",
            "notes",
            "bank_reference",
            "fingerprint",
            "created_at",
            "updated_at",
            "bank_counterparty",
            "bank_description",
            "transfer_pair",
        ],
        fks: &[("account_id", "accounts"), ("category_id", "categories")],
        when: None,
    },
    TableSpec {
        table: "transaction_splits",
        uid: RANDOM,
        cols: &["tx_id", "category_id", "amount_cents", "note"],
        fks: &[("tx_id", "transactions"), ("category_id", "categories")],
        when: None,
    },
    TableSpec {
        table: "budgets",
        uid: "(SELECT uid FROM categories WHERE id = NEW.category_id) || '/' || NEW.month",
        cols: &["category_id", "month", "amount_cents"],
        fks: &[("category_id", "categories")],
        when: None,
    },
    TableSpec {
        table: "valuations",
        uid: "(SELECT uid FROM accounts WHERE id = NEW.account_id) || '/' || NEW.date",
        cols: &["account_id", "date", "value_cents", "note"],
        fks: &[("account_id", "accounts")],
        when: None,
    },
    TableSpec {
        table: "fx_rates",
        uid: "NEW.currency || '/' || NEW.date || '/' || NEW.source",
        cols: &["currency", "date", "per_eur", "source"],
        fks: &[],
        when: Some(only_manual),
    },
    TableSpec {
        table: "goals",
        uid: RANDOM,
        cols: &["name", "target_cents", "target_date", "account_id", "saved_cents", "archived", "created_at"],
        fks: &[("account_id", "accounts")],
        when: None,
    },
    // The key is the natural id: the same item hidden on two computers is one row.
    TableSpec { table: "recurring_marks", uid: "NEW.key", cols: &["key", "hidden", "updated_at"], fks: &[], when: None },
    TableSpec {
        table: "csv_profiles",
        uid: "NEW.header_signature",
        cols: &["name", "bank", "header_signature", "mapping_json", "created_at", "updated_at"],
        fks: &[],
        when: None,
    },
];

pub fn spec(table: &str) -> &'static TableSpec {
    SYNC_TABLES.iter().find(|s| s.table == table).expect("a synced table")
}

/// Migration 6: sync bookkeeping tables, uids and triggers.
pub(crate) fn install_sync_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SYNC_TABLES_SQL)?;
    for s in SYNC_TABLES {
        let t = s.table;
        // Tables added in later migrations get their uid and triggers there.
        let exists: bool =
            conn.query_row("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)", [t], |r| r.get(0))?;
        if !exists {
            continue;
        }
        conn.execute_batch(&format!("ALTER TABLE {t} ADD COLUMN uid TEXT"))?;
        // Existing rows: fill in uid in order of dependencies (budgets need category uids first).
        conn.execute_batch(&format!("UPDATE {t} SET uid = {} WHERE uid IS NULL", s.uid.replace("NEW.", &format!("{t}."))))?;
        conn.execute_batch(&format!("CREATE UNIQUE INDEX idx_{t}_uid ON {t}(uid)"))?;
        create_sync_triggers(conn, s)?;
    }
    Ok(())
}

/// The triggers that record a synced table's changes (also used when a table is rebuilt).
pub(crate) fn create_sync_triggers(conn: &Connection, s: &TableSpec) -> rusqlite::Result<()> {
    let t = s.table;
    let on = "(SELECT enabled FROM sync_flags) = 1 AND (SELECT applying FROM sync_flags) = 0";
    let w = |row: &str| s.when.map_or(String::new(), |f| format!(" AND {}", f(row)));
    let (w_new, w_old) = (w("NEW"), w("OLD"));
    let sql = format!(
        "
    -- One trigger, so the uid is always set before the change is recorded.
    CREATE TRIGGER sync_{t}_ins AFTER INSERT ON {t} BEGIN
      UPDATE {t} SET uid = {uid} WHERE rowid = NEW.rowid AND uid IS NULL;
      INSERT INTO sync_outbox (tbl, uid) SELECT '{t}', uid FROM {t} WHERE rowid = NEW.rowid AND uid IS NOT NULL AND {on}{w_new};
    END;
    CREATE TRIGGER sync_{t}_upd AFTER UPDATE ON {t} WHEN {on}{w_new} AND NEW.uid IS NOT NULL BEGIN
      INSERT INTO sync_outbox (tbl, uid) VALUES ('{t}', NEW.uid);
    END;
    CREATE TRIGGER sync_{t}_del AFTER DELETE ON {t} WHEN {on}{w_old} AND OLD.uid IS NOT NULL BEGIN
      INSERT INTO sync_outbox (tbl, uid) VALUES ('{t}', OLD.uid);
    END;
  ",
        uid = s.uid
    );
    conn.execute_batch(&sql)
}
