//! The import operations: `import.analyze`, `.analyzeXml`, `.preview`, `.current`, `.raw`, `.remap`, `.updateRows`, `.commit`,
//! `.checkApply`, `.checkUndo`, `.discard`, `.batches`, `.undo`. PDF files and the assistant's check are not ported yet.
use super::{json, run, run_quiet};
use crate::core::{Actor, Core, Done};
use crate::error::{AppError, AppResult};
use crate::import::{
    analyze, analyze_xml, apply_check, commit, discard, latest_session, list_batches, preview, raw_window, remap, undo_batch, undo_check,
    update_rows, MappingIn, RowChange,
};
use crate::input::{is_none, nullable_optional, optional, Cents, Date, Empty, Id, Int, IntIn, LenVec, Plain, Text, Trimmed, Uuid};
use kb_db::Store;
use kb_import::rows::{CategorySource, Decision, RowOverride};
use serde::{Deserialize, Serialize};
use serde_json::{json as obj, Value};

/// `Buffer.from(text, 'base64')`: both alphabets, characters that are none of them are skipped, and the first `=` ends the data.
fn decode_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits) = (0_u32, 0_u32);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// `i.sessionId ?? openSession()`: the given session, else the one that is open.
fn session_of<S: Store>(core: &Core<S>, given: Option<&Uuid>) -> AppResult<String> {
    match given {
        Some(id) => Ok(id.0.clone()),
        None => latest_session(core)
            .ok_or_else(|| AppError::new("import.none", "No CSV import is open. Ask the person to choose a file on the Import page.")),
    }
}

/// An import preview as the caller may see it: the assistant gets nothing from above the header row found on opening.
fn shown<S: Store>(core: &Core<S>, p: crate::import::ImportPreview) -> AppResult<Value> {
    json(&if core.actor() == Actor::Assistant { p.assistant_view() } else { p })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnalyzeIn {
    file_name: Text<1, 260>,
    content_base64: Text<1, 14_000_000>,
    account_id: Id,
}

pub fn analyze_op<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run_quiet(raw, |i: AnalyzeIn| json(&analyze(core, &i.file_name.0, i.account_id.0, &decode_base64(&i.content_base64.0))?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnalyzeXmlIn {
    file_name: Text<1, 260>,
    content_base64: Text<1, 28_000_000>,
    account_id: Id,
}

pub fn analyze_xml_op<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run_quiet(raw, |i: AnalyzeXmlIn| json(&analyze_xml(core, &i.file_name.0, i.account_id.0, &decode_base64(&i.content_base64.0))?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SessionIn {
    session_id: Uuid,
}

pub fn preview_op<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run_quiet(raw, |i: SessionIn| json(&preview(core, &i.session_id.0)?))
}

pub fn current<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run_quiet(raw, |_: Empty| match latest_session(core) {
        Some(id) => shown(core, preview(core, &id)?),
        None => Ok(Value::Null),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawIn {
    #[serde(default)]
    from: IntIn<0, 9_007_199_254_740_991>,
    #[serde(default = "forty")]
    count: IntIn<1, 200>,
}

fn forty() -> IntIn<1, 200> {
    IntIn(40)
}

pub fn raw<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run_quiet(raw, |i: RawIn| {
        let id = session_of(core, None)?;
        json(&raw_window(core, &id, i.from.0 as usize, i.count.0 as usize, core.actor())?)
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RemapIn {
    #[serde(default, deserialize_with = "optional")]
    session_id: Option<Uuid>,
    mapping: MappingIn,
}

pub fn remap_op<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run_quiet(raw, |i: RemapIn| {
        let mapping = i.mapping.into_mapping()?;
        let id = session_of(core, i.session_id.as_ref())?;
        let source = if core.actor() == Actor::Assistant { "assistant" } else { "manual" };
        shown(core, remap(core, &id, mapping, source)?)
    })
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Decided {
    Include,
    Skip,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ChangeIn {
    index: IntIn<0, 9_007_199_254_740_991>,
    #[serde(default, deserialize_with = "nullable_optional")]
    decided: Option<Option<Decided>>,
    #[serde(default, deserialize_with = "nullable_optional")]
    category_id: Option<Option<Id>>,
    #[serde(default, deserialize_with = "optional")]
    booking_date: Option<Date>,
    #[serde(default, deserialize_with = "optional")]
    amount_cents: Option<Cents>,
    #[serde(default, deserialize_with = "optional")]
    description: Option<Trimmed<1, 300>>,
    #[serde(default, deserialize_with = "nullable_optional")]
    counterparty_name: Option<Option<Trimmed<0, 120>>>,
    #[serde(default, deserialize_with = "nullable_optional")]
    note: Option<Option<Plain<200>>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateRowsIn {
    #[serde(default, deserialize_with = "optional")]
    session_id: Option<Uuid>,
    changes: LenVec<ChangeIn, 1, 5000>,
}

pub fn update_rows_op<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run_quiet(raw, |i: UpdateRowsIn| {
        let id = session_of(core, i.session_id.as_ref())?;
        let source = if core.actor() == Actor::Assistant { CategorySource::Assistant } else { CategorySource::User };
        let changes = i
            .changes
            .0
            .into_iter()
            .map(|c| RowChange {
                index: c.index.0 as usize,
                change: RowOverride {
                    decided: c.decided.map(|d| {
                        d.map(|d| match d {
                            Decided::Include => Decision::Include,
                            Decided::Skip => Decision::Skip,
                        })
                    }),
                    category_source: c.category_id.is_some().then_some(source),
                    category_id: c.category_id.map(|c| c.map(|c| c.0)),
                    booking_date: c.booking_date.map(|d| d.0),
                    amount_cents: c.amount_cents.map(|a| a.0),
                    description: c.description.map(|d| d.0),
                    counterparty_name: c.counterparty_name.map(|n| n.map(|n| n.0)),
                    note: c.note.map(|n| n.map(|n| n.0)),
                },
            })
            .collect();
        shown(core, update_rows(core, &id, changes)?)
    })
}

fn yes() -> bool {
    true
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CommitIn {
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    session_id: Option<Uuid>,
    #[serde(default = "yes")]
    save_profile: bool,
}

pub fn commit_op<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: CommitIn| {
        let id = session_of(core, i.session_id.as_ref())?;
        json(&commit(core, &id, i.save_profile)?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CheckApplyIn {
    session_id: Uuid,
    rules: LenVec<Int, 0, 1000>,
    existing: LenVec<Int, 0, 1000>,
}

pub fn check_apply<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: CheckApplyIn| apply_check(core, &i.session_id.0))
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Part {
    Categories,
    Names,
    Fixes,
    All,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CheckUndoIn {
    session_id: Uuid,
    #[allow(dead_code)]
    part: Part,
}

pub fn check_undo<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run_quiet(raw, |i: CheckUndoIn| json(&undo_check(core, &i.session_id.0)?))
}

pub fn discard_op<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run_quiet(raw, |i: SessionIn| {
        discard(core, &i.session_id.0);
        Ok(obj!({ "ok": true }))
    })
}

pub fn batches<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run_quiet(raw, |_: Empty| json(&list_batches(core.db()?)?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UndoIn {
    batch_id: Id,
}

pub fn undo<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: UndoIn| Ok(obj!({ "deleted": undo_batch(core.db()?, i.batch_id.0)? })))
}

#[cfg(test)]
mod tests {
    use super::decode_base64;

    #[test]
    fn base64_is_as_lenient_as_the_buffer_of_node() {
        // Checked against `Buffer.from(text, 'base64')` in Node 22.
        assert_eq!(decode_base64("YQ=="), b"a");
        assert_eq!(decode_base64("YQ"), b"a");
        assert_eq!(decode_base64("Y Q=="), b"a");
        assert_eq!(decode_base64("YQ==YQ=="), b"a");
        assert_eq!(decode_base64("YQ=YQ"), b"a");
        assert_eq!(decode_base64("-_-_"), [0xfb, 0xff, 0xbf]);
        assert_eq!(decode_base64("a\nb=c"), [0x69]);
        assert_eq!(decode_base64("!!YQ"), b"a");
        assert_eq!(decode_base64("aGVsbG8gd29ybGQ="), b"hello world");
    }
}
