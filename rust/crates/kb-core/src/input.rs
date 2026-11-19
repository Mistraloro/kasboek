//! Input validation, the way zod does it in src/shared/contract.ts: strict objects (unknown fields refused), integers
//! that must be safe, strings trimmed before their length is checked, defaults applied when a field is missing, `null`
//! accepted only where the schema says `nullable`. Every failure is `op.invalid_input`.
//!
//! Types here deserialize *and* serialize: the audit log stores `JSON.stringify` of the parsed input, which has the
//! schema's key order, the trimmed strings, the defaults, and no key for an absent optional field.
use crate::error::AppError;
use crate::jsstr::{js_trim, zod_len};
use serde::de::{self, DeserializeOwned, Deserializer, Visitor};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use std::fmt;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `rawInput ?? {}`, then the typed parse. The message is serde's, not zod's: only the code is compared with TypeScript.
pub fn parse_input<I: DeserializeOwned>(raw: Value) -> Result<I, AppError> {
    let raw = if raw.is_null() { Value::Object(serde_json::Map::new()) } else { raw };
    // serde would also read a struct from an array; zod only takes an object.
    if !raw.is_object() {
        return Err(AppError::invalid_input("Invalid input: expected object"));
    }
    serde_json::from_value(raw).map_err(|e| AppError::invalid_input(e.to_string()))
}

/// `z.array(item).min(MIN).max(MAX)`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct LenVec<T, const MIN: usize, const MAX: usize>(pub Vec<T>);

impl<'de, T: Deserialize<'de>, const MIN: usize, const MAX: usize> Deserialize<'de> for LenVec<T, MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let items = Vec::<T>::deserialize(d)?;
        if (MIN..=MAX).contains(&items.len()) {
            Ok(Self(items))
        } else {
            Err(de::Error::custom(format!("expected {MIN} to {MAX} items")))
        }
    }
}

/// `z.object({}).strict()`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

/// A field that may be missing but not `null` (`.optional()`).
pub fn optional<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// A field that may be missing or `null` (`.nullable().optional()`): `None` = missing, `Some(None)` = null.
pub fn nullable_optional<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// A field that must be present but may be `null` (`.nullable()`).
pub fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

pub fn is_none<T>(v: &Option<T>) -> bool {
    v.is_none()
}

/// A JSON number that is a whole number in the safe range, as `z.number().int()` accepts (`1.0` and `1e2` count).
fn safe_int<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    struct V;
    impl Visitor<'_> for V {
        type Value = i64;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("an integer")
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<i64, E> {
            if (v as f64).abs() <= MAX_SAFE {
                Ok(v)
            } else {
                Err(E::custom("integer out of range"))
            }
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<i64, E> {
            i64::try_from(v).map_err(|_| E::custom("integer out of range")).and_then(|v| self.visit_i64(v))
        }
        fn visit_f64<E: de::Error>(self, v: f64) -> Result<i64, E> {
            if v.fract() == 0.0 && v.abs() <= MAX_SAFE {
                Ok(v as i64)
            } else {
                Err(E::custom("expected an integer"))
            }
        }
    }
    d.deserialize_any(V)
}

/// `z.number().int()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(transparent)]
pub struct Int(pub i64);

impl<'de> Deserialize<'de> for Int {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        safe_int(d).map(Int)
    }
}

/// A number between `MIN` and `MAX`, whole (`z.number().int().min(MIN).max(MAX)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct IntIn<const MIN: i64, const MAX: i64>(pub i64);

impl<'de, const MIN: i64, const MAX: i64> Deserialize<'de> for IntIn<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = safe_int(d)?;
        if (MIN..=MAX).contains(&v) {
            Ok(Self(v))
        } else {
            Err(de::Error::custom(format!("expected a value between {MIN} and {MAX}")))
        }
    }
}

impl<const MIN: i64, const MAX: i64> Default for IntIn<MIN, MAX> {
    fn default() -> Self {
        Self(0)
    }
}

/// `id`: a positive whole number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Id(pub i64);

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = safe_int(d)?;
        if v > 0 {
            Ok(Self(v))
        } else {
            Err(de::Error::custom("expected a positive integer"))
        }
    }
}

/// `cents`: a whole number between -1e12 and 1e12.
pub type Cents = IntIn<-1_000_000_000_000, 1_000_000_000_000>;

/// `z.number().min(MIN).max(MAX)` for a percentage: any number (not necessarily whole) inside the range.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Percent(pub f64);

impl<'de> Deserialize<'de> for Percent {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = f64::deserialize(d)?;
        if (0.0..=20.0).contains(&v) {
            Ok(Self(v))
        } else {
            Err(de::Error::custom("expected a percentage between 0 and 20"))
        }
    }
}

/// `z.number().positive().max(1e9)`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(transparent)]
pub struct PerEur(pub f64);

impl<'de> Deserialize<'de> for PerEur {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = f64::deserialize(d)?;
        if v > 0.0 && v <= 1e9 {
            Ok(Self(v))
        } else {
            Err(de::Error::custom("expected a positive number up to 1e9"))
        }
    }
}

/// `z.string().trim().min(MIN).max(MAX)`: trimmed first, then the length (code points, as zod 4 counts) is checked.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(transparent)]
pub struct Trimmed<const MIN: usize, const MAX: usize>(pub String);

impl<'de, const MIN: usize, const MAX: usize> Deserialize<'de> for Trimmed<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let t = js_trim(&s);
        let n = zod_len(t);
        if (MIN..=MAX).contains(&n) {
            Ok(Self(t.to_owned()))
        } else {
            Err(de::Error::custom(format!("expected {MIN} to {MAX} characters")))
        }
    }
}

/// `z.string().max(MAX)`: not trimmed.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(transparent)]
pub struct Plain<const MAX: usize>(pub String);

impl<'de, const MAX: usize> Deserialize<'de> for Plain<MAX> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        if zod_len(&s) <= MAX {
            Ok(Self(s))
        } else {
            Err(de::Error::custom(format!("expected at most {MAX} characters")))
        }
    }
}

/// `date`: `YYYY-MM-DD` (digits only; the calendar is not checked, as in zod).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Date(pub String);

pub fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

impl<'de> Deserialize<'de> for Date {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        if is_date(&s) {
            Ok(Self(s))
        } else {
            Err(de::Error::custom("Use YYYY-MM-DD."))
        }
    }
}

/// `month`: `YYYY-MM` with a month from 01 to 12.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Month(pub String);

impl<'de> Deserialize<'de> for Month {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let b = s.as_bytes();
        let ok = b.len() == 7
            && b[..4].iter().all(u8::is_ascii_digit)
            && b[4] == b'-'
            && matches!(&b[5..], [b'0', b'1'..=b'9'] | [b'1', b'0'..=b'2']);
        if ok {
            Ok(Self(s))
        } else {
            Err(de::Error::custom("Use YYYY-MM."))
        }
    }
}

/// `currency`: trimmed, upper-cased, and one of the currencies the runtime knows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Currency(pub String);

impl Default for Currency {
    fn default() -> Self {
        Self("EUR".into())
    }
}

impl<'de> Deserialize<'de> for Currency {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let code = js_trim(&s).to_uppercase();
        if crate::contract::currencies().contains(&code) {
            Ok(Self(code))
        } else {
            Err(de::Error::custom("Unknown currency code."))
        }
    }
}

/// `z.union([id, z.literal('none')])`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdOrNone {
    Id(Id),
    None,
}

impl Serialize for IdOrNone {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Id(id) => id.serialize(s),
            Self::None => s.serialize_str("none"),
        }
    }
}

impl<'de> Deserialize<'de> for IdOrNone {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match Value::deserialize(d)? {
            Value::String(s) if s == "none" => Ok(Self::None),
            other => Id::deserialize(other).map(Self::Id).map_err(de::Error::custom),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Sample {
        name: Trimmed<1, 5>,
        #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
        id: Option<Id>,
        #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
        note: Option<Option<Plain<3>>>,
        #[serde(default)]
        cents: Cents,
    }

    fn parse(v: Value) -> Result<Value, String> {
        parse_input::<Sample>(v).map(|s| serde_json::to_value(&s).unwrap()).map_err(|e| e.code)
    }

    #[test]
    fn strict_objects_trim_and_null_rules() {
        assert_eq!(parse(json!({"name": "  ab  "})).unwrap(), json!({"name": "ab", "cents": 0}));
        assert_eq!(parse(json!({"name": "a", "id": 3.0, "note": null})).unwrap(), json!({"name": "a", "id": 3, "note": null, "cents": 0}));
        for bad in [
            json!({"name": "a", "extra": 1}),
            json!({"name": "   "}),
            json!({"name": "toolong"}),
            json!({"name": "a", "id": null}),
            json!({"name": "a", "id": 0}),
            json!({"name": "a", "id": 1.5}),
            json!({"name": "a", "id": "1"}),
            json!({"name": "a", "note": "abcd"}),
            json!({"name": "a", "cents": 1e12 + 1.0}),
            json!({"name": "a", "cents": 9_007_199_254_740_993_i64}),
            json!([1]),
            json!("x"),
        ] {
            assert_eq!(parse(bad.clone()).unwrap_err(), "op.invalid_input", "{bad}");
        }
        assert_eq!(parse(Value::Null).unwrap_err(), "op.invalid_input", "null becomes {{}}, and the name is required");
    }

    #[test]
    fn dates_and_months() {
        assert!(is_date("2026-11-14") && !is_date("2026-1-14") && !is_date("2026-11-14\n") && !is_date("２０２６-11-14"));
        let m = |s: &str| serde_json::from_value::<Month>(json!(s)).is_ok();
        assert!(m("2026-01") && m("2026-12") && !m("2026-00") && !m("2026-13") && !m("2026-1"));
    }
}
