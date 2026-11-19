//! JSON numbers as JavaScript prints them: `100.0` is `100`, `-0` is `0`. SQLite sums that went through `fx()` are REAL,
//! and the TypeScript core hands them to JSON as plain numbers, so the Rust side normalises every result the same way.
use serde_json::{Number, Value};

/// Largest magnitude below which a whole `f64` becomes an integer (JavaScript switches to exponents at 1e21; no money
/// amount comes near the 2^63 an `i64` holds).
const WHOLE_LIMIT: f64 = 9.2e18;

/// A number as JSON.parse(JSON.stringify(x)) would give it.
pub fn js_number(x: f64) -> Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < WHOLE_LIMIT {
        // `as i64` turns -0.0 into 0.
        Value::from(x as i64)
    } else {
        Number::from_f64(x).map_or(Value::Null, Value::Number)
    }
}

/// Rewrites every whole floating-point number inside `value` as an integer.
pub fn normalize(value: &mut Value) {
    match value {
        Value::Number(n) if n.is_f64() => *value = js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => items.iter_mut().for_each(normalize),
        Value::Object(map) => map.values_mut().for_each(normalize),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn whole_floats_become_integers_like_in_javascript() {
        let mut v = json!({"a": 100.0, "b": -0.0, "c": 2.5, "d": [1.0, {"e": -3.0}], "f": 7});
        normalize(&mut v);
        assert_eq!(v.to_string(), r#"{"a":100,"b":0,"c":2.5,"d":[1,{"e":-3}],"f":7}"#);
    }
}
