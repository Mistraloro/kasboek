//! The JavaScript string and number behaviour the ports share, in one place: `\s`, `String.length` and `Math.round`.

/// JavaScript's `\s` and `String.prototype.trim` white space: not the same set as `char::is_whitespace` (U+0085 is not in it,
/// U+FEFF is).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `\s` as the inside of a character class (`[...]`) for the `regex` crate; the same set as [`is_js_space`].
pub const JS_SPACE: &str = r"\t\n\x0B\x0C\r    -     　﻿";

/// UTF-16 length: what `String.length` counts.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `Math.round`: ties go towards positive infinity (Rust's `round` goes away from zero), and a negative value that rounds to
/// zero gives -0.
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_space_is_the_javascript_set() {
        assert!(is_js_space('\u{a0}') && is_js_space('\u{feff}') && !is_js_space('\u{85}') && !is_js_space('\u{200b}'));
    }

    #[test]
    fn counts_utf16_units() {
        assert_eq!(utf16_len("a\u{1F600}"), 3);
    }

    #[test]
    fn rounds_like_math_round() {
        assert_eq!((js_round(-2.5), js_round(2.5), js_round(0.49999999999999994)), (-2.0, 3.0, 0.0));
        assert!(js_round(-0.3).is_sign_negative() && js_round(-0.3) == 0.0);
    }
}
