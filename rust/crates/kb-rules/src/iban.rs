//! IBANs in free text: `src/shared/iban.ts`. Text is scanned as UTF-16 code units, as the regular expressions of the
//! original do, so indexes agree. `mask_account` and `shown_account` are new: the renderer has no such function (it
//! shows the account number as typed), they serve the hide-account-numbers display of the native app.

use unicode_normalization::UnicodeNormalization;

// Length of an IBAN per country (the IBAN registry).
const IBAN_LENGTH: &[(&str, usize)] = &[
    ("AD", 24),
    ("AE", 23),
    ("AL", 28),
    ("AT", 20),
    ("AZ", 28),
    ("BA", 20),
    ("BE", 16),
    ("BG", 22),
    ("BH", 22),
    ("BR", 29),
    ("BY", 28),
    ("CH", 21),
    ("CR", 22),
    ("CY", 28),
    ("CZ", 24),
    ("DE", 22),
    ("DK", 18),
    ("DO", 28),
    ("EE", 20),
    ("EG", 29),
    ("ES", 24),
    ("FI", 18),
    ("FO", 18),
    ("FR", 27),
    ("GB", 22),
    ("GE", 22),
    ("GI", 23),
    ("GL", 18),
    ("GR", 27),
    ("GT", 28),
    ("HR", 21),
    ("HU", 28),
    ("IE", 22),
    ("IL", 23),
    ("IQ", 23),
    ("IS", 26),
    ("IT", 27),
    ("JO", 30),
    ("KW", 30),
    ("KZ", 20),
    ("LB", 28),
    ("LC", 32),
    ("LI", 21),
    ("LT", 20),
    ("LU", 20),
    ("LV", 21),
    ("MC", 27),
    ("MD", 24),
    ("ME", 22),
    ("MK", 19),
    ("MR", 27),
    ("MT", 31),
    ("MU", 30),
    ("NL", 18),
    ("NO", 15),
    ("PK", 24),
    ("PL", 28),
    ("PS", 29),
    ("PT", 25),
    ("QA", 29),
    ("RO", 24),
    ("RS", 22),
    ("SA", 24),
    ("SC", 31),
    ("SE", 24),
    ("SI", 19),
    ("SK", 24),
    ("SM", 27),
    ("ST", 25),
    ("SV", 28),
    ("TL", 23),
    ("TN", 24),
    ("TR", 26),
    ("UA", 29),
    ("VA", 22),
    ("VG", 24),
    ("XK", 20),
];

fn iban_length(cc: &str) -> Option<usize> {
    IBAN_LENGTH.iter().find(|(c, _)| *c == cc).map(|(_, l)| *l)
}

pub fn valid_iban(iban: &str) -> bool {
    let chars: Vec<char> = iban.chars().collect();
    if chars.len() < 4 {
        return false;
    }
    let mut rem: u64 = 0;
    for &ch in chars[4..].iter().chain(&chars[..4]) {
        if let Some(d) = ch.to_digit(10) {
            rem = (rem * 10 + d as u64) % 97;
        } else if ch.is_ascii_uppercase() {
            // A letter becomes two digits (A = 10 ... Z = 35).
            rem = (rem * 100 + (ch as u64 - 55)) % 97;
        } else {
            return false;
        }
    }
    rem == 1
}

/// The characters that may separate the groups of an account or card number.
pub(crate) fn is_sep(u: u16) -> bool {
    matches!(u, 0x20 | 0x2e | 0x2d | 0x2f)
}

/// JavaScript's `\s`: not the same set as `char::is_whitespace` (U+0085 is not in it, U+FEFF is).
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Compatibility forms (full-width digits, ...) as plain ones; all white space as one space; zero-width characters gone; every
/// dash as a hyphen. NFKC would turn the `…` of a masked number into three dots, so it is applied between the `…`s only.
pub fn fold(text: &str) -> String {
    let normalized = text.split('\u{2026}').map(|part| part.nfkc().collect::<String>()).collect::<Vec<_>>().join("\u{2026}");
    let mut out = String::with_capacity(normalized.len());
    let mut in_space = false;
    for c in normalized.chars() {
        if matches!(c, '\u{ad}' | '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}') {
            continue;
        }
        let c = if matches!(c, '\u{2010}'..='\u{2015}' | '\u{2212}') { '-' } else { c };
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

/// Runs a masking step on the folded text; a text that the step left alone is returned as it came.
pub(crate) fn masking(text: &str, step: impl Fn(&[u16]) -> Vec<u16>) -> String {
    let folded: Vec<u16> = fold(text).encode_utf16().collect();
    let out = step(&folded);
    if out == folded {
        text.to_string()
    } else {
        String::from_utf16_lossy(&out)
    }
}

pub(crate) struct Hit {
    pub(crate) index: usize,
    pub(crate) cc: String,
    pub(crate) iban: String,
    /// How many code units of the text the account number takes, separators included.
    pub(crate) used: usize,
}

fn is_alnum(u: u16) -> bool {
    u < 128 && (u as u8).is_ascii_alphanumeric()
}

/// A match of `([A-Z]{2})(\d{2})((?:[ .\-/]?[A-Z0-9]){10,30})` (case-insensitive) starting exactly at `i`: its length.
fn match_at(t: &[u16], i: usize) -> Option<usize> {
    let letter = |u: u16| u < 128 && (u as u8).is_ascii_alphabetic();
    let digit = |u: u16| u < 128 && (u as u8).is_ascii_digit();
    if i + 4 > t.len() || !letter(t[i]) || !letter(t[i + 1]) || !digit(t[i + 2]) || !digit(t[i + 3]) {
        return None;
    }
    let mut j = i + 4;
    let mut reps = 0;
    while reps < 30 {
        if j + 1 < t.len() && is_sep(t[j]) && is_alnum(t[j + 1]) {
            j += 2;
        } else if j < t.len() && is_alnum(t[j]) {
            j += 1;
        } else {
            break;
        }
        reps += 1;
    }
    (reps >= 10).then_some(j - i)
}

/// For a country that is not in the table: the lengths (longest first, at least 15) at which the start of the text passes the
/// checksum, all found in one pass over the text.
fn lengths_with_valid_checksum(compact: &[u8]) -> Vec<usize> {
    let digits = |c: u8| if c >= b'A' { (c - 55).to_string() } else { (c as char).to_string() };
    let head: String = compact[..4].iter().map(|&c| digits(c)).collect();
    let head_value: u64 = head.parse().unwrap_or(0);
    let scale = 10u64.pow(head.len() as u32);
    let mut found = Vec::new();
    let mut rem: u64 = 0;
    for len in 5..=compact.len() {
        for d in digits(compact[len - 1]).bytes() {
            rem = (rem * 10 + (d - b'0') as u64) % 97;
        }
        if len >= 15 && (rem * scale + head_value) % 97 == 1 {
            found.push(len);
        }
    }
    found.reverse();
    found
}

/// The valid IBAN at the start of a candidate match, and how many code units of the match it used.
fn resolve(m: &[u16], cc: &str) -> Option<(String, usize)> {
    let compact: Vec<u8> = m.iter().filter(|&&u| !is_sep(u)).map(|&u| (u as u8).to_ascii_uppercase()).collect();
    // Try the country's length first (the match may run on into other text), then shorter ones.
    let lengths = match iban_length(cc) {
        Some(l) => vec![l],
        None => lengths_with_valid_checksum(&compact),
    };
    for len in lengths {
        if len <= compact.len() {
            let candidate = std::str::from_utf8(&compact[..len]).expect("ASCII");
            if valid_iban(candidate) {
                let (mut used, mut count) = (0, 0);
                while count < len && used < m.len() {
                    if !is_sep(m[used]) {
                        count += 1;
                    }
                    used += 1;
                }
                return Some((candidate.to_string(), used));
            }
        }
    }
    None
}

/// The valid IBANs in a (folded) text, in order of appearance. A failed candidate is tried again one character further, so a real
/// one inside it is still found.
pub(crate) fn scan(t: &[u16]) -> Vec<Hit> {
    let mut hits = Vec::new();
    let mut at = 0;
    while at < t.len() {
        let Some((index, len)) = (at..t.len()).find_map(|i| match_at(t, i).map(|l| (i, l))) else { break };
        let cc = String::from_utf16_lossy(&t[index..index + 2]).to_uppercase();
        let prev_is_letter = index > 0 && t[index - 1] < 128 && (t[index - 1] as u8).is_ascii_alphabetic();
        let hit = if iban_length(&cc).is_some() || !prev_is_letter { resolve(&t[index..index + len], &cc) } else { None };
        match hit {
            None => at = index + 1,
            Some((iban, used)) => {
                hits.push(Hit { index, cc, iban, used });
                // Carry on after the account number: another one may follow right behind it.
                at = index + used;
            }
        }
    }
    hits
}

pub(crate) fn ibans_hidden(t: &[u16]) -> Vec<u16> {
    let (mut out, mut at) = (Vec::new(), 0);
    for h in scan(t) {
        out.extend_from_slice(&t[at..h.index]);
        out.extend(format!("{}\u{2026}{}", h.cc, &h.iban[h.iban.len() - 4..]).encode_utf16());
        at = h.index + h.used;
    }
    out.extend_from_slice(&t[at..]);
    out
}

/// Every IBAN becomes its country and the last four characters: `BE…7034`. Text is folded first (see `fold`); a text with
/// nothing to hide is returned exactly as it came.
pub fn mask_iban(text: &str) -> String {
    masking(text, ibans_hidden)
}

/// The valid IBANs in a text, without spaces and in order of appearance, each once.
pub fn find_ibans(text: &str) -> Vec<String> {
    let folded: Vec<u16> = fold(text).encode_utf16().collect();
    let mut seen: Vec<String> = Vec::new();
    for h in scan(&folded) {
        if !seen.contains(&h.iban) {
            seen.push(h.iban);
        }
    }
    seen
}

pub use crate::mask::mask_numbers;

/// An account number in groups of four, as the Accounts settings show it.
fn grouped(iban: &str) -> String {
    let compact: Vec<char> = iban.chars().filter(|c| !c.is_whitespace()).collect();
    compact.chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join(" ")
}

/// The account number with everything but the last four characters replaced by dots: `•••• •••• •••• 7034`.
pub fn mask_account(iban: &str) -> String {
    let compact: Vec<char> = iban.chars().filter(|c| !c.is_whitespace()).collect();
    let keep = compact.len().saturating_sub(4);
    let hidden: String = compact.iter().enumerate().map(|(i, &c)| if i < keep { '•' } else { c }).collect();
    grouped(&hidden)
}

/// What to put on screen: the number in groups of four when `reveal` is set (the eye is held), else `mask_account`.
pub fn shown_account(iban: &str, reveal: bool) -> String {
    if reveal {
        grouped(iban)
    } else {
        mask_account(iban)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_display() {
        assert_eq!(mask_account("BE68 5390 0754 7034"), "•••• •••• •••• 7034");
        assert_eq!(shown_account("BE68539007547034", true), "BE68 5390 0754 7034");
        assert_eq!(shown_account("BE68539007547034", false), "•••• •••• •••• 7034");
        assert_eq!(mask_account(""), "");
    }
}
