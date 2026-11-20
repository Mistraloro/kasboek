//! JavaScript string and regular-expression behaviour the TypeScript sources rely on, in the few places it differs from
//! Rust: `\s` (and `trim`) include the no-break space and the byte order mark but not U+0085, `\d` and `\w` are ASCII.
//! White space itself, `.length` and `Math.round` are the single copies of `kb-rules`.
use kb_rules::{is_js_space, JS_SPACE};
use regex::Regex;

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.replace(/\s+/g, ' ').trim()`
pub fn squash(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut gap = false;
    for c in s.chars() {
        if is_js_space(c) {
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

/// Compiles a pattern written for JavaScript (without look-around or back-references): `\s`, `\d`, `\w` and `\b` get their
/// JavaScript meaning. Panics on a bad pattern (they are constants of the program).
pub fn re(pattern: &str) -> Regex {
    let space = format!("[{JS_SPACE}]");
    let p = pattern.replace(r"\s", &space).replace(r"\d", "[0-9]").replace(r"\w", "[A-Za-z0-9_]").replace(r"\b", r"(?-u:\b)");
    Regex::new(&p).unwrap_or_else(|e| panic!("bad pattern {pattern}: {e}"))
}

/// `new RegExp` for a case-insensitive pattern.
pub fn rei(pattern: &str) -> Regex {
    re(&format!("(?i){pattern}"))
}

/// `s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()`
pub fn lower_plain(s: &str) -> String {
    use unicode_normalization::char::is_combining_mark;
    use unicode_normalization::UnicodeNormalization;
    s.nfd().filter(|c| !is_combining_mark(*c)).collect::<String>().to_lowercase()
}
