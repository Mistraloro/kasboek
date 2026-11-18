//! Same open sequence as src/core/database.ts (`unlock` + probe), without migrations.
use rusqlite::Connection;
use std::path::Path;

pub fn open(file: &Path, key_hex: &str) -> rusqlite::Result<Connection> {
    assert!(key_hex.len() == 64 && key_hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    let db = Connection::open(file)?;
    db.execute_batch(&format!("PRAGMA cipher='chacha20'; PRAGMA hexkey='{key_hex}';"))?;
    // First real access: fails with "file is not a database" on a wrong key.
    db.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))?;
    db.execute_batch("PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;")?;
    db.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get::<_, String>(0))?;
    Ok(db)
}
