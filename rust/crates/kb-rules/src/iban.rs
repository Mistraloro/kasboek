//! IBANs in free text: `src/shared/iban.ts`. Text is scanned as UTF-16 code units, as the regular expressions of the
//! original do, so indexes agree. `mask_account` and `shown_account` are new: the renderer has no such function (it
//! shows the account number as typed), they serve the hide-account-numbers display of the native app.

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

struct Hit {
    index: usize,
    cc: String,
    iban: String,
    used: usize,
}

fn is_alnum(u: u16) -> bool {
    u < 128 && (u as u8).is_ascii_alphanumeric()
}

/// A match of `([A-Z]{2})(\d{2})((?:[ ]?[A-Z0-9]){10,30})` (case-insensitive) starting exactly at `i`: its length.
fn match_at(t: &[u16], i: usize) -> Option<usize> {
    let letter = |u: u16| u < 128 && (u as u8).is_ascii_alphabetic();
    let digit = |u: u16| u < 128 && (u as u8).is_ascii_digit();
    if i + 4 > t.len() || !letter(t[i]) || !letter(t[i + 1]) || !digit(t[i + 2]) || !digit(t[i + 3]) {
        return None;
    }
    let mut j = i + 4;
    let mut reps = 0;
    while reps < 30 {
        if j + 1 < t.len() && t[j] == 0x20 && is_alnum(t[j + 1]) {
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

fn resolve(m: &[u16], cc: &str) -> Option<(String, usize)> {
    let compact: String = String::from_utf16_lossy(m).chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase();
    let n = compact.len();
    let lengths: Vec<usize> = match iban_length(cc) {
        Some(l) => vec![l],
        None => (0..n.saturating_sub(13)).map(|i| n - i).collect(),
    };
    for len in lengths {
        if len <= n && valid_iban(&compact[..len]) {
            let (mut used, mut count) = (0, 0);
            while count < len && used < m.len() {
                if m[used] != 0x20 {
                    count += 1;
                }
                used += 1;
            }
            return Some((compact[..len].to_string(), used));
        }
    }
    None
}

fn scan(t: &[u16]) -> Vec<Hit> {
    let mut hits = Vec::new();
    let mut at = 0;
    while at < t.len() {
        let Some(len) = (at..t.len()).find_map(|i| match_at(t, i).map(|l| (i, l))) else { break };
        let (index, len) = len;
        let cc = String::from_utf16_lossy(&t[index..index + 2]).to_uppercase();
        let prev_is_letter = index > 0 && t[index - 1] < 128 && (t[index - 1] as u8).is_ascii_alphabetic();
        let hit = if iban_length(&cc).is_some() || !prev_is_letter { resolve(&t[index..index + len], &cc) } else { None };
        match hit {
            None => at = index + 1,
            Some((iban, used)) => {
                hits.push(Hit { index, cc, iban, used });
                at = index + used;
            }
        }
    }
    hits
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// Every IBAN becomes its country and the last four characters: `BE…7034`.
pub fn mask_iban(text: &str) -> String {
    let t = units(text);
    let (mut out, mut at) = (String::new(), 0);
    for h in scan(&t) {
        out.push_str(&String::from_utf16_lossy(&t[at..h.index]));
        out.push_str(&format!("{}…{}", h.cc, &h.iban[h.iban.len() - 4..]));
        at = h.index + h.used;
    }
    out.push_str(&String::from_utf16_lossy(&t[at..]));
    out
}

/// The valid IBANs in a text, without spaces and in order of appearance, each once.
pub fn find_ibans(text: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for h in scan(&units(text)) {
        if !seen.contains(&h.iban) {
            seen.push(h.iban);
        }
    }
    seen
}

fn is_digit(u: u16) -> bool {
    (0x30..=0x39).contains(&u)
}

/// `^DATE(?:[ -]DATE)*$` with DATE = dd-mm-yyyy or yyyy-mm-dd (real day and month, year 19xx or 20xx).
fn dates_only(m: &[u16]) -> bool {
    let s: Vec<char> = String::from_utf16_lossy(m).chars().collect();
    if s.len() % 11 != 10 {
        return false;
    }
    let num = |a: &[char]| -> Option<u32> { a.iter().collect::<String>().parse().ok().filter(|_| a.iter().all(|c| c.is_ascii_digit())) };
    let date = |d: &[char]| -> bool {
        let dmy = d[2] == '-'
            && d[5] == '-'
            && num(&d[0..2]).is_some_and(|v| (1..=31).contains(&v))
            && num(&d[3..5]).is_some_and(|v| (1..=12).contains(&v))
            && num(&d[6..8]).is_some_and(|v| v == 19 || v == 20)
            && num(&d[8..10]).is_some();
        let ymd = d[4] == '-'
            && d[7] == '-'
            && num(&d[0..2]).is_some_and(|v| v == 19 || v == 20)
            && num(&d[2..4]).is_some()
            && num(&d[5..7]).is_some_and(|v| (1..=12).contains(&v))
            && num(&d[8..10]).is_some_and(|v| (1..=31).contains(&v));
        dmy || ymd
    };
    (0..s.len() / 11 + 1)
        .all(|k| date(&s[k * 11..k * 11 + 10]) && (k * 11 + 10 == s.len() || s[k * 11 + 10] == ' ' || s[k * 11 + 10] == '-'))
}

/// IBANs as `mask_iban` shows them, and runs of 13 or more digits (card or account numbers) by their last four. Dates side by side stay.
pub fn mask_numbers(text: &str) -> String {
    let t = units(&mask_iban(text));
    let (mut out, mut at, mut i) = (Vec::<u16>::new(), 0, 0);
    while i < t.len() {
        if !is_digit(t[i]) {
            i += 1;
            continue;
        }
        let (mut j, mut reps) = (i + 1, 0);
        loop {
            if j + 1 < t.len() && (t[j] == 0x20 || t[j] == 0x2d) && is_digit(t[j + 1]) {
                j += 2;
            } else if j < t.len() && is_digit(t[j]) {
                j += 1;
            } else {
                break;
            }
            reps += 1;
        }
        if reps < 12 {
            i += 1;
            continue;
        }
        out.extend_from_slice(&t[at..i]);
        if dates_only(&t[i..j]) {
            out.extend_from_slice(&t[i..j]);
        } else {
            let digits: Vec<u16> = t[i..j].iter().copied().filter(|&u| is_digit(u)).collect();
            out.push(0x2026);
            out.extend_from_slice(&digits[digits.len() - 4..]);
        }
        at = j;
        i = j;
    }
    out.extend_from_slice(&t[at..]);
    String::from_utf16_lossy(&out)
}

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
