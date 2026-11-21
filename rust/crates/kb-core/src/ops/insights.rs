//! `insights.get`, `insights.feedback`, `insights.restoreDismissed`, `insights.preview`: the local insights (src/core/insights.ts).
//! As in the desktop app (`ipc.ts`), `get` knows the interface language of `prefs.json` (a tip written in another language is
//! marked stale) and `preview` is the text a run would send. Running, status and cancel are not here: they need the assistant.
use super::{run, run_quiet};
use crate::core::{Core, Done};
use crate::error::AppResult;
use crate::finance::main_currency;
use crate::input::{Empty, Month, Trimmed};
use crate::insight_plan::{active_provider, facts_payload, insights_system, require_configured, shown_address, CHARS_PER_TOKEN};
use crate::insights::{build_facts, give_feedback, insights_view, restore_dismissed};
use crate::settings::get_settings;
use kb_db::Store;
use kb_rules::utf16_len;
use serde::{Deserialize, Serialize};
use serde_json::{json as obj, Value};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MonthIn {
    month: Month,
}

/// The interface language of the preferences file (`getPrefs().language`).
fn interface_language<S: Store>(core: &Core<S>) -> AppResult<String> {
    let prefs = core.prefs.borrow_mut().get()?;
    Ok(prefs.get("language").and_then(Value::as_str).unwrap_or("en").to_owned())
}

pub fn get<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: MonthIn| {
        let language = interface_language(core)?;
        insights_view(core, &i.month.0, Some(&language), &core.today())
    })
}

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum Verdict {
    Dismissed,
    NotUseful,
    Useful,
}

impl Verdict {
    fn as_str(self) -> &'static str {
        match self {
            Self::Dismissed => "dismissed",
            Self::NotUseful => "not_useful",
            Self::Useful => "useful",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FeedbackIn {
    key: Trimmed<1, 300>,
    verdict: Verdict,
}

pub fn feedback<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: FeedbackIn| {
        give_feedback(core.db()?, &i.key.0, i.verdict.as_str())?;
        Ok(obj!({ "ok": true }))
    })
}

pub fn restore<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| Ok(obj!({ "restored": restore_dismissed(core.db()?)? })))
}

/// What would be sent for this month: shown in the dialog where the person agrees, and in the card (`insightsPreview`).
pub fn preview<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run_quiet(raw, |i: MonthIn| {
        let db = core.db()?;
        let settings = get_settings(db)?;
        let provider = active_provider(db, &settings)?;
        require_configured(&provider)?;
        let today = core.today();
        let facts = build_facts(core, &i.month.0, &today)?;
        let (text, _) = facts_payload(&facts, &main_currency(db)?, &i.month.0, &today);
        let system = insights_system(&interface_language(core)?);
        let tokens = (utf16_len(&system) + utf16_len(&text)).div_ceil(CHARS_PER_TOKEN);
        let address = shown_address(&provider);
        Ok(obj!({
            "text": text, "approxTokens": tokens, "facts": facts.len(), "providerName": provider.preset.assistant_name,
            "company": provider.preset.company, "address": address, "model": provider.insights_model
        }))
    })
}

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &["insights.get", "insights.feedback", "insights.restoreDismissed", "insights.preview"];

pub(super) fn handler<S: Store>(name: &str) -> Option<super::Handler<S>> {
    Some(match name {
        "insights.get" => get::<S>,
        "insights.feedback" => feedback::<S>,
        "insights.restoreDismissed" => restore::<S>,
        "insights.preview" => preview::<S>,
        _ => return None,
    })
}
