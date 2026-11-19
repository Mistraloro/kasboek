//! `SqliteStore`: the [`Store`] on sqlite3mc (through rusqlite). All SQL of the crate that touches a live connection
//! is here or in the modules it calls.
use crate::dump;
use crate::error::{DbError, DbResult};
use crate::fx::{self, FxRates};
use crate::key::DbKey;
use crate::migrations::{MIGRATIONS, SCHEMA_VERSION};
use crate::store::{Cell, OpenOptions, Store};
use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags};
use std::cell::Cell as Counter;
use std::path::Path;
use zeroize::Zeroizing;

pub struct SqliteStore {
    conn: Connection,
    rates: FxRates,
    depth: Counter<u32>,
}

impl SqliteStore {
    /// The raw connection, for tests that insert invented rows. Production code goes through [`Store`].
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

fn to_value(cell: Cell) -> Value {
    match cell {
        Cell::Null => Value::Null,
        Cell::Int(i) => Value::Integer(i),
        Cell::Real(r) => Value::Real(r),
        Cell::Text(t) => Value::Text(t),
        Cell::Blob(b) => Value::Blob(b),
    }
}

impl Store for SqliteStore {
    fn open(file: &Path, key: &DbKey, options: OpenOptions) -> DbResult<Self> {
        // Like better-sqlite3: read-write, create, no URI names.
        let conn = Connection::open_with_flags(
            file,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // Cipher settings and key come before any other statement. ChaCha20-Poly1305 detects tampering.
        let unlock = Zeroizing::new(format!("PRAGMA cipher='chacha20'; PRAGMA hexkey='{}';", key.as_hex()));
        // Reading the schema is the first real access; it fails if the key is wrong.
        conn.execute_batch(&unlock)
            .and_then(|()| conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)).map(drop))
            .map_err(|_| DbError::Locked)?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;")?;
        conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get::<_, String>(0))?;
        let store = Self { conn, rates: FxRates::default(), depth: Counter::new(0) };
        if options.migrate {
            store.migrate()?;
        }
        fx::install(&store.conn, &store.rates)?;
        Ok(store)
    }

    fn schema_version(&self) -> DbResult<u32> {
        Ok(self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    fn migrate_to(&self, target: u32) -> DbResult<()> {
        let current = self.schema_version()?;
        if current > SCHEMA_VERSION {
            return Err(DbError::NewerSchema { found: current });
        }
        for (index, migration) in MIGRATIONS.iter().enumerate().take(target.min(SCHEMA_VERSION) as usize).skip(current as usize) {
            self.transaction(|store| {
                migration(&store.conn)?;
                store.conn.execute_batch(&format!("PRAGMA user_version = {}", index + 1))?;
                Ok(())
            })?;
        }
        Ok(())
    }

    fn transaction<T, F: FnOnce(&Self) -> DbResult<T>>(&self, work: F) -> DbResult<T> {
        let depth = self.depth.get();
        let (begin, commit, rollback) = if depth == 0 {
            ("BEGIN".to_string(), "COMMIT".to_string(), "ROLLBACK".to_string())
        } else {
            (format!("SAVEPOINT sp{depth}"), format!("RELEASE sp{depth}"), format!("ROLLBACK TO sp{depth}; RELEASE sp{depth}"))
        };
        self.conn.execute_batch(&begin)?;
        self.depth.set(depth + 1);
        let result = work(self);
        self.depth.set(depth);
        match result {
            Ok(value) => {
                self.conn.execute_batch(&commit)?;
                Ok(value)
            }
            Err(error) => {
                // The original error matters more than a failed rollback.
                let _ = self.conn.execute_batch(&rollback);
                Err(error)
            }
        }
    }

    fn reload_fx_rates(&self) -> DbResult<()> {
        Ok(self.rates.reload(&self.conn)?)
    }

    fn probe_fx(&self, args: [Cell; 4]) -> DbResult<Cell> {
        let params: Vec<Value> = args.into_iter().map(to_value).collect();
        Ok(self.conn.query_row("SELECT fx(?1, ?2, ?3, ?4)", rusqlite::params_from_iter(params), |r| Ok(dump::cell(r.get_ref(0)?)))?)
    }

    fn integrity_ok(&self) -> DbResult<bool> {
        let rows: Vec<String> = self.conn.prepare("PRAGMA quick_check")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(rows == ["ok"])
    }

    fn snapshot_encrypted(&self, target: &Path) -> DbResult<()> {
        self.conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
        Ok(())
    }

    fn table_counts(&self) -> DbResult<Vec<(String, i64)>> {
        let names: Vec<String> = self
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let mut counts = Vec::with_capacity(names.len());
        for name in names {
            let n: i64 = self.conn.query_row(&format!("SELECT count(*) FROM \"{name}\""), [], |r| r.get(0))?;
            counts.push((name, n));
        }
        Ok(counts)
    }

    fn canonical_dump(&self) -> DbResult<String> {
        dump::canonical_dump(&self.conn)
    }
}
