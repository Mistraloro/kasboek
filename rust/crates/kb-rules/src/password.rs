//! Password rules and a strength estimate: `src/shared/password.ts`. Strings are handled as UTF-16 code units where the
//! regular expressions of the original do (they run without the `u` flag).
use std::collections::HashSet;

pub const MIN_PASSWORD_LENGTH: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordIssue {
    Length,
    Variety,
    Common,
    AppName,
    Pattern,
}

impl PasswordIssue {
    /// The name the TypeScript type uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Length => "length",
            Self::Variety => "variety",
            Self::Common => "common",
            Self::AppName => "appName",
            Self::Pattern => "pattern",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PasswordCheck {
    pub ok: bool,
    pub issues: Vec<PasswordIssue>,
    /// 0 very weak ... 4 strong.
    pub strength: u8,
    /// Rough guessing difficulty in bits, after penalties.
    pub bits: u32,
    pub classes: u32,
}

const COMMON: &str =
    "password passwort wachtwoord motdepasse paswoord welkom welcome bienvenue azerty qwerty qwertz azertyuiop qwertyuiop \
letmein iloveyou admin administrator root monkey dragon football voetbal soccer baseball master shadow sunshine \
princess superman batman trustno1 starwars whatever freedom secret geheim bonjour soleil chocolat amour liebe \
hallo hello login changeme default test testing abc abcdef abcdefgh asdfgh zxcvbn \
belgie belgique belgium brussel bruxelles antwerpen gent liege leuven bank budget money geld argent euro \
summer winter autumn spring zomer lente herfst";

const KEYBOARD_ROWS: [&str; 7] = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "azertyuiop", "qsdfghjklm", "wxcvbn", "1234567890"];

fn leet(c: char) -> char {
    match c {
        '@' | '4' => 'a',
        '3' => 'e',
        '1' | '!' => 'i',
        '0' => 'o',
        '$' | '5' => 's',
        '7' | '+' => 't',
        other => other,
    }
}

fn classes_of(pw: &str) -> u32 {
    [
        pw.chars().any(|c| c.is_ascii_lowercase()),
        pw.chars().any(|c| c.is_ascii_uppercase()),
        pw.chars().any(|c| c.is_ascii_digit()),
        pw.chars().any(|c| !c.is_ascii_alphanumeric()),
    ]
    .into_iter()
    .filter(|&b| b)
    .count() as u32
}

/// JavaScript's `.` does not match line terminators.
fn dot(u: u16) -> bool {
    !matches!(u, 0x0a | 0x0d | 0x2028 | 0x2029)
}

fn has_pattern(pw: &str) -> bool {
    let s = pw.to_lowercase();
    let units: Vec<u16> = s.encode_utf16().collect();
    // (.)\1{3,}: one character four times in a row.
    if units.windows(4).any(|w| dot(w[0]) && w.iter().all(|&u| u == w[0])) {
        return true;
    }
    // (.{2,4})\1{2,}: a group of 2 to 4 characters three times in a row.
    for len in 2..=4 {
        if units.windows(3 * len).any(|w| w[..len].iter().all(|&u| dot(u)) && w[..len] == w[len..2 * len] && w[..len] == w[2 * len..]) {
            return true;
        }
    }
    // Four consecutive characters going up or down (code points, as `[...slice]` splits them).
    for i in 0..units.len().saturating_sub(3) {
        let c: Vec<u32> = char::decode_utf16(units[i..i + 4].iter().copied())
            .map(|r| r.map_or_else(|e| e.unpaired_surrogate() as u32, first_unit))
            .collect();
        let up = c.iter().enumerate().all(|(j, &v)| j == 0 || v == c[j - 1] + 1);
        let down = c.iter().enumerate().all(|(j, &v)| j == 0 || v + 1 == c[j - 1]);
        if up || down {
            return true;
        }
    }
    KEYBOARD_ROWS.iter().any(|row| (0..=row.len().saturating_sub(4)).any(|i| row.len() >= 4 && s.contains(&row[i..i + 4])))
}

/// `charCodeAt(0)` of a character: its first UTF-16 unit.
fn first_unit(ch: char) -> u32 {
    let mut buf = [0u16; 2];
    ch.encode_utf16(&mut buf)[0] as u32
}

fn only_letters(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_lowercase()).collect()
}

fn is_common(pw: &str) -> bool {
    let words: HashSet<&str> = COMMON.split(' ').collect();
    let lower = pw.to_lowercase();
    if words.contains(lower.as_str()) {
        return true;
    }
    let unleet: String = lower.chars().map(leet).collect();
    let mut cores = vec![only_letters(&lower)];
    let second = only_letters(&unleet);
    if second != cores[0] {
        cores.push(second);
    }
    for core in &cores {
        if core.len() >= 3 && words.contains(core.as_str()) {
            return true;
        }
        for w in COMMON.split(' ') {
            if w.len() < 4 || !core.contains(w) {
                continue;
            }
            if core.replace(w, "").is_empty() || w.len() * 2 >= core.len() {
                return true;
            }
        }
    }
    false
}

pub fn check_password(pw: &str) -> PasswordCheck {
    let mut issues = Vec::new();
    let classes = classes_of(pw);
    let length = pw.chars().count();
    if length < MIN_PASSWORD_LENGTH {
        issues.push(PasswordIssue::Length);
    }
    if classes < 3 {
        issues.push(PasswordIssue::Variety);
    }
    if !pw.is_empty() && is_common(pw) {
        issues.push(PasswordIssue::Common);
    }
    let lower = pw.to_lowercase();
    if ["kasboek", "k@sb0ek", "kasb0ek"].iter().any(|n| lower.contains(n)) {
        issues.push(PasswordIssue::AppName);
    }
    if !pw.is_empty() && has_pattern(pw) {
        issues.push(PasswordIssue::Pattern);
    }

    let pool = (if pw.chars().any(|c| c.is_ascii_lowercase()) { 26 } else { 0 })
        + (if pw.chars().any(|c| c.is_ascii_uppercase()) { 26 } else { 0 })
        + (if pw.chars().any(|c| c.is_ascii_digit()) { 10 } else { 0 })
        + (if pw.chars().any(|c| !c.is_ascii_alphanumeric()) { 33 } else { 0 });
    let unique = pw.chars().collect::<HashSet<_>>().len();
    let mut bits = if pool > 0 { length.min(unique * 2) as f64 * (pool as f64).log2() } else { 0.0 };
    if issues.contains(&PasswordIssue::Pattern) {
        bits *= 0.6;
    }
    if issues.contains(&PasswordIssue::Common) || issues.contains(&PasswordIssue::AppName) {
        bits *= 0.3;
    }
    let bits = bits.round() as u32;
    let strength = if bits >= 70 {
        4
    } else if bits >= 55 {
        3
    } else if bits >= 40 {
        2
    } else if bits >= 30 {
        1
    } else {
        0
    };
    PasswordCheck { ok: issues.is_empty() && strength == 4, issues, strength, bits, classes }
}
