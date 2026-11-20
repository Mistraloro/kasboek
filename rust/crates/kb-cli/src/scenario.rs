//! `kb-cli scenario file.json`: runs a scenario through `kb_core::dispatch` on a fresh encrypted database, and prints every
//! step's result plus a dump of all tables. The TypeScript runner (rust/parity/scenario-runner.ts) does the same through
//! the app's own `dispatch`, and the parity suite compares the two outputs.
//!
//! Scenario: `{"name", "clock": "2026-11-14T10:00:00Z", "languages": ["en"], "prefs": "<prefs.json text>" | null,
//! "steps": [{"op", "input", "actor"?}]}`. Steps whose op starts with `@` are harness steps: `@lock` and `@unlock` (the
//! session), `@sql` (`{"sql"}`: seed invented rows), `@fxReload` (after `@sql` changed `fx_rates`) and
//! `@resetImportedSettings` (`{"keepSyncKey"?, "assistantOff"?}`).
//!
//! Masked in the output, because they are random or depend on the wall clock: `uid` values (32 hex digits), every column
//! named `at` or ending in `_at`, and the keys `createdAt` / `updatedAt` / `committedAt` and `sessionId` of results. A string
//! `"$session"` in the input of a step stands for the `sessionId` the latest result had (the id of the open import). The random `transfer_pair` keys are
//! numbered in order of first appearance (`<pair 1>`), so which rows share a pair is still compared.
use crate::commands::CliError;
use kb_core::{Actor, Core, CoreConfig, FixedClock, SeededRng};
use kb_db::{Cell, DbKey, OpenOptions, SqliteStore, Store};
use serde_json::{json, Map, Value};
use std::path::Path;

/// An invented key that protects nothing.
const KEY_HEX: &str = "5a5a5a5a5a5a5a5a00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff";

fn fail<T>(message: impl ToString) -> Result<T, CliError> {
    Err(CliError { code: "scenario".into(), message: message.to_string() })
}

/// `2026-11-14T10:00:00Z` to milliseconds since the epoch.
fn parse_clock(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + num(11, 13)?) * 60 + num(14, 16)?) * 60_000 + num(17, 19)? * 1000)
}

fn actor(name: Option<&str>) -> Result<Actor, CliError> {
    match name {
        None | Some("user") => Ok(Actor::User),
        Some("assistant") => Ok(Actor::Assistant),
        Some("system") => Ok(Actor::System),
        Some(other) => fail(format!("unknown actor {other}")),
    }
}

/// Replaces every run of exactly 32 lower-case hex digits by `<uid>`.
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

fn is_time_column(name: &str) -> bool {
    name == "at" || name.ends_with("_at")
}

fn cell_json(cell: &Cell, column: &str) -> Value {
    match cell {
        Cell::Null => Value::Null,
        Cell::Int(_) | Cell::Real(_) | Cell::Blob(_) if is_time_column(column) => json!("<time>"),
        Cell::Int(i) => json!(i),
        Cell::Real(r) => kb_core::numbers::js_number(*r),
        Cell::Text(_) if is_time_column(column) => json!("<time>"),
        Cell::Text(t) => json!(mask_uid(t)),
        Cell::Blob(b) => json!(hex::encode(b)),
    }
}

/// `createdAt`, `updatedAt` and `committedAt` of a result are wall-clock times, and a `sessionId` is random.
fn mask_result(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                if (key == "createdAt" || key == "updatedAt" || key == "committedAt") && v.is_string() {
                    *v = json!("<time>");
                } else if key == "sessionId" && v.is_string() {
                    *v = json!("<session>");
                } else {
                    mask_result(v);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(mask_result),
        _ => {}
    }
}

/// Replaces the string `"$session"` anywhere in an input by the id of the import that is open.
fn with_session(value: &mut Value, id: &Option<String>) {
    match value {
        Value::String(s) if s == "$session" => *value = id.as_ref().map_or(Value::Null, |i| json!(i)),
        Value::Array(items) => items.iter_mut().for_each(|v| with_session(v, id)),
        Value::Object(map) => map.values_mut().for_each(|v| with_session(v, id)),
        _ => {}
    }
}

fn result_json(result: Result<Value, kb_core::AppError>) -> Value {
    match result {
        Ok(mut data) => {
            mask_result(&mut data);
            json!({ "ok": true, "data": data })
        }
        Err(e) => json!({ "ok": false, "error": e.to_json() }),
    }
}

fn dump(store: &SqliteStore) -> Result<Value, CliError> {
    let mut tables = Map::new();
    for t in store.dump_tables()? {
        let mut pairs: Vec<&str> = Vec::new();
        let rows: Vec<Value> = t
            .rows
            .iter()
            .map(|row| {
                Value::Array(
                    row.iter()
                        .zip(&t.columns)
                        .map(|(cell, column)| match cell {
                            Cell::Text(key) if t.name == "transactions" && column == "transfer_pair" => {
                                let at = pairs.iter().position(|k| k == key).unwrap_or_else(|| {
                                    pairs.push(key);
                                    pairs.len() - 1
                                });
                                json!(format!("<pair {}>", at + 1))
                            }
                            _ => cell_json(cell, column),
                        })
                        .collect(),
                )
            })
            .collect();
        tables.insert(t.name, json!({ "columns": t.columns, "rows": rows }));
    }
    Ok(Value::Object(tables))
}

pub fn run(file: &str) -> Result<String, CliError> {
    let scenario: Value = serde_json::from_str(&std::fs::read_to_string(file)?)?;
    let clock_ms = match scenario.get("clock").and_then(Value::as_str) {
        None => 1_794_650_400_000,
        Some(text) => parse_clock(text).ok_or_else(|| CliError { code: "scenario".into(), message: format!("bad clock {text}") })?,
    };
    let languages = scenario
        .get("languages")
        .and_then(Value::as_array)
        .map(|l| l.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
        .unwrap_or_else(|| vec!["en".to_owned()]);

    let dir = std::env::temp_dir().join(format!("kb-scenario-{}-{}", std::process::id(), clock_ms));
    std::fs::create_dir_all(&dir)?;
    let outcome = run_in(&dir, &scenario, clock_ms, languages);
    let _ = std::fs::remove_dir_all(&dir);
    outcome
}

fn run_in(dir: &Path, scenario: &Value, clock_ms: i64, languages: Vec<String>) -> Result<String, CliError> {
    let prefs_file = dir.join("prefs.json");
    if let Some(text) = scenario.get("prefs").and_then(Value::as_str) {
        std::fs::write(&prefs_file, text)?;
    }
    let store = SqliteStore::open(&dir.join("kasboek.db"), &DbKey::from_hex(KEY_HEX)?, OpenOptions::default())?;
    let mut core = Core::new(
        Some(store),
        Box::new(FixedClock { ms: clock_ms, utc_offset_minutes: 0 }),
        Box::new(SeededRng::new(1)),
        CoreConfig { prefs_file: Some(prefs_file.clone()), system_languages: languages },
    );

    let steps =
        scenario.get("steps").and_then(Value::as_array).ok_or_else(|| CliError { code: "scenario".into(), message: "no steps".into() })?;
    let mut results = Vec::with_capacity(steps.len());
    let mut session: Option<String> = None;
    for step in steps {
        let op = step
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| CliError { code: "scenario".into(), message: "step without op".into() })?;
        let mut input = step.get("input").cloned().unwrap_or(Value::Null);
        with_session(&mut input, &session);
        let result = match op {
            "@lock" => {
                core.set_unlocked(false);
                Ok(Value::Null)
            }
            "@unlock" => {
                core.set_unlocked(true);
                Ok(Value::Null)
            }
            "@sql" => {
                let sql = input.get("sql").and_then(Value::as_str).unwrap_or_default();
                core.db().and_then(|db| Ok(db.execute_script(sql)?)).map(|()| Value::Null)
            }
            "@fxReload" => core.db().and_then(|db| Ok(db.reload_fx_rates()?)).map(|()| Value::Null),
            "@resetImportedSettings" => {
                let keep = input.get("keepSyncKey").and_then(Value::as_bool).unwrap_or(false);
                let assistant_off = input.get("assistantOff").and_then(Value::as_bool).unwrap_or(false);
                core.db().and_then(|db| kb_core::settings::reset_imported_settings(db, keep, assistant_off)).map(|found| json!(found))
            }
            _ => core.dispatch(op, input, actor(step.get("actor").and_then(Value::as_str))?),
        };
        if let Some(id) = result.as_ref().ok().and_then(|d| d.get("sessionId")).and_then(Value::as_str) {
            session = Some(id.to_owned());
        }
        results.push(result_json(result));
    }
    let tables = dump(core.db().map_err(|e| CliError { code: e.code, message: e.message })?)?;
    let prefs_text = std::fs::read_to_string(&prefs_file).ok();
    Ok(json!({ "results": results, "dump": tables, "prefsFile": prefs_text }).to_string())
}
