//! JavaScript and zod string rules the TypeScript core relies on (`trim`, `\s`, the length zod checks), which differ from Rust's.

/// JavaScript's `WhiteSpace` and `LineTerminator`: Unicode space separators, tab, VT, FF, the byte order mark and the
/// line terminators. Rust's `char::is_whitespace` also counts U+0085 and misses U+FEFF.
pub fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_follows_javascript() {
        assert_eq!(js_trim("\u{FEFF} a b\u{A0}\n"), "a b");
        assert_eq!(js_trim("\u{85}x\u{85}"), "\u{85}x\u{85}", "NEL is not whitespace in JavaScript");
        assert_eq!(zod_len("a😀"), 2, "zod counts code points");
        assert_eq!(collapse_spaces("a \t\u{A0}b  c"), "a b c");
    }
}
