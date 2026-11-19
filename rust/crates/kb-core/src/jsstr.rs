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

/// `\p{L}`: Rust's alphabetic property without the marks, letter numbers and circled letters that it adds to the letters.
pub fn is_letter(c: char) -> bool {
    let cp = c as u32;
    let nl = matches!(cp, 0x16EE..=0x16F0 | 0x2160..=0x2182 | 0x2185..=0x2188 | 0x3007 | 0x3021..=0x3029 | 0x3038..=0x303A | 0xA6E6..=0xA6EF
        | 0x10140..=0x10174 | 0x10341 | 0x1034A | 0x103D1..=0x103D5 | 0x12400..=0x1246E);
    let circled = matches!(cp, 0x24B6..=0x24E9 | 0x1F130..=0x1F149 | 0x1F150..=0x1F169 | 0x1F170..=0x1F189);
    c.is_alphabetic() && !nl && !circled && !unicode_normalization::char::is_combining_mark(c)
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
}
