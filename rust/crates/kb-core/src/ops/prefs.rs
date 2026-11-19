//! `prefs.get`, `prefs.update`: the preferences file, which works while locked.
use super::{json, run};
use crate::core::{Core, Done};
use crate::error::{AppError, AppResult};
use crate::input::{is_none, optional, Empty, IntIn};
use kb_db::Store;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn get<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| json(&core.prefs.borrow_mut().get()?))
}

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Theme {
    System,
    Light,
    Dark,
}

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Graphics {
    Auto,
    On,
    Off,
}

#[derive(Deserialize, Serialize)]
enum Language {
    #[serde(rename = "en")]
    En,
    #[serde(rename = "nl")]
    Nl,
    #[serde(rename = "fr")]
    Fr,
    #[serde(rename = "de")]
    De,
    #[serde(rename = "es")]
    Es,
    #[serde(rename = "es-419")]
    Es419,
    #[serde(rename = "pt-PT")]
    PtPt,
    #[serde(rename = "pt-BR")]
    PtBr,
}

macro_rules! choice {
    ($name:ident { $($variant:ident = $text:literal),+ }) => {
        #[derive(Deserialize, Serialize, Clone, Copy)]
        enum $name { $(#[serde(rename = $text)] $variant),+ }
    };
}

choice!(Decimal { Comma = ",", Dot = "." });
choice!(Group { Dot = ".", Comma = ",", Space = " ", Apostrophe = "'", Nothing = "" });
choice!(Grouping { Thousands = "thousands", Indian = "indian" });
choice!(Position { AfterSpace = "after-space", After = "after", BeforeSpace = "before-space", Before = "before" });
choice!(Style { Symbol = "symbol", Code = "code" });
choice!(Negative { Minus = "minus", AfterSymbol = "minus-after-symbol", Parentheses = "parentheses" });
choice!(Clock { H24 = "24h", H12 = "12h" });
choice!(
    DatePattern {
        A = "DD/MM/YYYY", B = "DD-MM-YYYY", C = "DD.MM.YYYY", D = "D/M/YYYY", E = "D.M.YYYY", F = "D-M-YYYY", G = "DD/MM/YY",
        H = "DD.MM.YY", I = "MM/DD/YYYY", J = "M/D/YYYY", K = "MM-DD-YYYY", L = "MM/DD/YY", M = "YYYY-MM-DD", N = "YYYY/MM/DD",
        O = "YYYY.MM.DD", P = "YY-MM-DD", Q = "D MMM YYYY", R = "DD MMM YYYY", T = "D MMMM YYYY", U = "MMM D, YYYY",
        V = "MMMM D, YYYY", W = "YYYY MMM D"
    }
);

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FormatsIn {
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    decimal: Option<Decimal>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    group: Option<Group>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    grouping: Option<Grouping>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    currency_position: Option<Position>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    currency_style: Option<Style>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    negative: Option<Negative>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    date: Option<DatePattern>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    time: Option<Clock>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateIn {
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    theme: Option<Theme>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    language: Option<Language>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    formats: Option<FormatsIn>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    auto_lock_minutes: Option<IntIn<0, 240>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    update_check: Option<bool>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    welcome_done: Option<bool>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    graphics: Option<Graphics>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    keep_in_tray: Option<bool>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    insights: Option<bool>,
}

pub fn update<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: UpdateIn| {
        let Value::Object(mut patch) = serde_json::to_value(&input).map_err(|_| AppError::failed())? else {
            return Err(AppError::failed());
        };
        // A new graphics choice also forgets an earlier failure, so "automatic" tries the graphics card again.
        if patch.contains_key("graphics") {
            patch.insert("graphicsFailed".into(), Value::Bool(false));
        }
        json(&core.prefs.borrow_mut().update(&patch)?)
    })
}
