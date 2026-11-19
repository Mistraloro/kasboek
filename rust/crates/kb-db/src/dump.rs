//! A stable text dump of a database for the conformance tests: schema, `user_version` and every row.
//! Random ids are masked, so two databases migrated by different engines compare equal when they hold the same data.
use crate::error::DbResult;
use crate::store::Cell;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use std::fmt::Write;

pub(crate) fn cell(value: ValueRef<'_>) -> Cell {
    match value {
        ValueRef::Null => Cell::Null,
        ValueRef::Integer(i) => Cell::Int(i),
        ValueRef::Real(r) => Cell::Real(r),
        ValueRef::Text(t) => Cell::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Cell::Blob(b.to_vec()),
    }
}

/// A run of exactly 32 lower-case hex characters in a `uid` column is a random id (`lower(hex(randomblob(16)))`).
fn mask_uid(text: &str) -> String {
    let is_hex = |c: char| c.is_ascii_digit() || ('a'..='f').contains(&c);
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    for c in text.chars().chain(std::iter::once('\0')) {
        if is_hex(c) {
            run.push(c);
            continue;
        }
        out.push_str(if run.len() == 32 { "<uid>" } else { &run });
        run.clear();
        out.push(c);
    }
    out.pop();
    out
}

fn render(cell: &Cell, mask: bool) -> String {
    match cell {
        Cell::Null => "NULL".into(),
        Cell::Int(i) => format!("i:{i}"),
        Cell::Real(r) => format!("r:{r:?}"),
        Cell::Text(t) => format!("t:{:?}", if mask { mask_uid(t) } else { t.clone() }),
        Cell::Blob(b) => format!("b:{}", hex::encode(b)),
    }
}

pub(crate) fn canonical_dump(conn: &Connection) -> DbResult<String> {
    let mut out = String::new();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    writeln!(out, "user_version={version}").expect("writing to a String");

    let mut schema = conn.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")?;
    let objects: Vec<(String, String, String, Option<String>)> =
        schema.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
    for (kind, name, table, sql) in &objects {
        writeln!(out, "-- {kind} {name} on {table}\n{}", sql.as_deref().unwrap_or("(no sql)")).expect("writing to a String");
    }

    for (_, name, _, _) in objects.iter().filter(|(kind, name, _, _)| kind == "table" && !name.starts_with("sqlite_")) {
        writeln!(out, "-- rows of {name}").expect("writing to a String");
        let mut stmt = conn.prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))?;
        let columns: Vec<String> = stmt.column_names().map(str::to_owned).collect();
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let cells: Vec<String> = columns
                .iter()
                .enumerate()
                .map(|(i, column)| Ok(render(&cell(row.get_ref(i)?), column == "uid")))
                .collect::<rusqlite::Result<_>>()?;
            writeln!(out, "{}", cells.join(" | ")).expect("writing to a String");
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_whole_32_character_hex_runs_are_masked() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(mask_uid(id), "<uid>");
        assert_eq!(mask_uid(&format!("{id}/2025-01")), "<uid>/2025-01");
        assert_eq!(mask_uid(&format!("{id}0")), format!("{id}0"));
        assert_eq!(mask_uid("shop-uid"), "shop-uid");
    }
}
