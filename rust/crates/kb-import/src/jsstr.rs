//! JavaScript and zod string rules the TypeScript core relies on (`trim`, `\s`, `Number(text)`, the length zod checks), which
//! differ from Rust's. `kb-core` re-exports this module. `is_js_space`, `JS_SPACE`, `utf16_len` and `js_round` are the single
//! copies of `kb-rules`, re-exported here.
use regex::Regex;
use std::sync::LazyLock;

pub use kb_rules::{is_js_space, js_round, utf16_len, JS_SPACE};

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// The length zod 4 checks in `.min()` and `.max()` of a string: code points (a surrogate pair counts once), not the UTF-16
/// units of `String.prototype.length`.
pub fn zod_len(s: &str) -> usize {
    s.chars().count()
}

/// `s.replace(/\s+/g, ' ')`.
pub fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `\p{L}`, by the `regex` crate's own Unicode table (Rust's `char::is_alphabetic` is a wider set).
pub fn is_letter(c: char) -> bool {
    static LETTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{L}$").expect("letter regex"));
    LETTER.is_match(c.encode_utf8(&mut [0; 4]))
}

/// `s.slice(0, n)` for `n` UTF-16 units. A surrogate pair that the cut would split is left out whole (JavaScript would keep
/// a lone half, which a Rust string cannot hold).
pub fn slice_units(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (at, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..at];
        }
    }
    s
}

/// `Number(text)`: the whole text is a number (JavaScript's `StringToNumber`), else NaN. Empty or blank text is 0, `0x`, `0o`
/// and `0b` read integers, `Infinity` is infinite, and Rust's `inf` and `nan` words are not numbers.
pub fn js_number(text: &str) -> f64 {
    let t = js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let radix = match t.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &t[2..];
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut value = 0.0_f64;
        for c in digits.chars() {
            match c.to_digit(radix) {
                Some(d) => value = value * f64::from(radix) + f64::from(d),
                None => return f64::NAN,
            }
        }
        return value;
    }
    let (negative, body) = match t.as_bytes()[0] {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    let magnitude = if body == "Infinity" {
        f64::INFINITY
    } else {
        // StrDecimalLiteral: digits with an optional fraction and exponent, at least one digit in the mantissa.
        let b = body.as_bytes();
        let mut i = 0;
        let int_digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
        i += int_digits;
        let mut frac_digits = 0;
        if b.get(i) == Some(&b'.') {
            frac_digits = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
            i += 1 + frac_digits;
        }
        if int_digits + frac_digits == 0 {
            return f64::NAN;
        }
        if matches!(b.get(i), Some(b'e' | b'E')) {
            let mut j = i + 1;
            if matches!(b.get(j), Some(b'+' | b'-')) {
                j += 1;
            }
            let exp_digits = b[j..].iter().take_while(|c| c.is_ascii_digit()).count();
            if exp_digits == 0 {
                return f64::NAN;
            }
            i = j + exp_digits;
        }
        if i != b.len() {
            return f64::NAN;
        }
        body.parse::<f64>().unwrap_or(f64::NAN)
    };
    if negative {
        -magnitude
    } else {
        magnitude
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_follows_javascript() {
        assert_eq!(js_trim("\u{FEFF} a b\u{A0}\n"), "a b");
        assert_eq!(js_trim("\u{85}x\u{85}"), "\u{85}x\u{85}", "NEL is not whitespace in JavaScript");
        assert_eq!(zod_len("a😀"), 2, "zod counts code points");
        assert_eq!(collapse_spaces("a \t\u{A0}b  c"), "a b c");
        assert!(is_letter('é') && is_letter('漢') && !is_letter('Ⅻ') && !is_letter('Ⓐ') && !is_letter('\u{301}') && !is_letter('7'));
        assert_eq!(slice_units("ab😀cd", 3), "ab");
        assert_eq!(slice_units("ab😀cd", 4), "ab😀");
        assert_eq!(slice_units("abc", 9), "abc");
    }

    #[test]
    fn number_follows_javascript() {
        for (text, want) in [
            ("12", 12.0),
            (" 1e1 ", 10.0),
            ("", 0.0),
            ("  ", 0.0),
            ("0x1F", 31.0),
            ("0b101", 5.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("-3", -3.0),
            ("+3", 3.0),
        ] {
            assert_eq!(js_number(text), want, "{text:?}");
        }
        for bad in ["abc", "1_0", "inf", "nan", "infinity", "-0x10", "0x", "1e", ".", "1 2", "--1", "1.2.3"] {
            assert!(js_number(bad).is_nan(), "{bad:?}");
        }
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        assert!(js_number(&"9".repeat(400)).is_infinite());
    }
}
