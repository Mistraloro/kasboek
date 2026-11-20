//! JavaScript string and regular-expression behaviour the TypeScript sources rely on, in the few places it differs from
//! Rust: `\s` (and `trim`) include the no-break space and the byte order mark but not U+0085, `\d` and `\w` are ASCII,
//! `.length` counts UTF-16 units.
use regex::Regex;

/// Characters that JavaScript's `\s` and `String.prototype.trim` treat as white space.
pub fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_ws)
}

/// `s.replace(/\s+/g, ' ').trim()`
pub fn squash(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut gap = false;
    for c in s.chars() {
        if is_ws(c) {
            gap = true;
        } else {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        }
    }
    out
}

const WS_CLASS: &str = r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

/// Compiles a pattern written for JavaScript (without look-around or back-references): `\s`, `\d`, `\w` and `\b` get their
/// JavaScript meaning. Panics on a bad pattern (they are constants of the program).
pub fn re(pattern: &str) -> Regex {
    let p = pattern.replace(r"\s", WS_CLASS).replace(r"\d", "[0-9]").replace(r"\w", "[A-Za-z0-9_]").replace(r"\b", r"(?-u:\b)");
    Regex::new(&p).unwrap_or_else(|e| panic!("bad pattern {pattern}: {e}"))
}

/// `new RegExp` for a case-insensitive pattern.
pub fn rei(pattern: &str) -> Regex {
    re(&format!("(?i){pattern}"))
}

/// UTF-16 length.
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()`
pub fn lower_plain(s: &str) -> String {
    use unicode_normalization::char::is_combining_mark;
    use unicode_normalization::UnicodeNormalization;
    s.nfd().filter(|c| !is_combining_mark(*c)).collect::<String>().to_lowercase()
}
