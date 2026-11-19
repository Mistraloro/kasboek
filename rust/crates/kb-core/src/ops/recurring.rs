//! `recurring.list`, `recurring.hide`.
use super::{json, run};
use crate::core::{Core, Done};
use crate::error::AppResult;
use crate::input::Empty;
use crate::jsstr::{js_trim, zod_len};
use crate::recurring::{find_recurring, set_recurring_hidden};
use kb_db::Store;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn list<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| json(&find_recurring(core, &core.today())?))
}

/// `z.string().trim().regex(/^(in|out):/).max(200)`.
#[derive(Serialize)]
#[serde(transparent)]
struct Key(String);

impl<'de> Deserialize<'de> for Key {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let t = js_trim(&s);
        if (t.starts_with("in:") || t.starts_with("out:")) && zod_len(t) <= 200 {
            Ok(Self(t.to_owned()))
        } else {
            Err(de::Error::custom("expected a key that starts with in: or out:"))
        }
    }
}

fn yes() -> bool {
    true
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HideIn {
    key: Key,
    #[serde(default = "yes")]
    hidden: bool,
}

pub fn hide<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: HideIn| json(&set_recurring_hidden(core, &i.key.0, i.hidden, &core.today())?))
}
