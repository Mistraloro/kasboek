//! Password rules (src/shared/password.ts): at least 12 characters, three of four character classes, not a common
//! password or built from one, no "kasboek", no runs like "aaaa" or "1234". The main process refuses anything that fails.

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordCheck {
    pub ok: bool,
    pub issues: Vec<PasswordIssue>,
    /// 0 (very weak) to 4 (strong).
    pub strength: u8,
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

fn common() -> impl Iterator<Item = &'static str> {
    COMMON.split(' ')
}

fn unleet(c: char) -> char {
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
    .iter()
    .filter(|b| **b)
    .count() as u32
}

/// What `.` matches in a JavaScript regular expression.
fn dot(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn has_pattern(pw: &str) -> bool {
    let s: Vec<char> = pw.to_lowercase().chars().collect();
    // (.)\1{3,}: aaaa
    if s.windows(4).any(|w| dot(w[0]) && w.iter().all(|c| *c == w[0])) {
        return true;
    }
    // (.{2,4})\1{2,}: ababab, 123123123
    for len in 2..=4 {
        if s.len() >= len * 3
            && (0..=s.len() - len * 3).any(|i| {
                s[i..i + len].iter().all(|c| dot(*c))
                    && s[i..i + len] == s[i + len..i + 2 * len]
                    && s[i..i + len] == s[i + 2 * len..i + 3 * len]
            })
        {
            return true;
        }
    }
    // abcd, 4321
    if s.windows(4).any(|w| {
        let c: Vec<i64> = w.iter().map(|ch| i64::from(u32::from(*ch))).collect();
        (1..4).all(|j| c[j] == c[j - 1] + 1) || (1..4).all(|j| c[j] == c[j - 1] - 1)
    }) {
        return true;
    }
    let text: String = s.iter().collect();
    KEYBOARD_ROWS.iter().any(|row| row.as_bytes().windows(4).any(|w| text.contains(std::str::from_utf8(w).expect("ASCII"))))
}

fn is_common(pw: &str) -> bool {
    let lower = pw.to_lowercase();
    if common().any(|w| w == lower) {
        return true;
    }
    let unleeted: String = lower.chars().map(unleet).collect();
    let letters = |t: &str| t.chars().filter(|c| c.is_ascii_lowercase()).collect::<String>();
    let mut cores = vec![letters(&lower)];
    let second = letters(&unleeted);
    if second != cores[0] {
        cores.push(second);
    }
    for core in cores {
        if core.len() >= 3 && common().any(|w| w == core) {
            return true;
        }
        for w in common() {
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
    let unique = pw.chars().collect::<std::collections::HashSet<_>>().len();
    let mut bits = if pool > 0 { length.min(unique * 2) as f64 * f64::from(pool).log2() } else { 0.0 };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_passphrase_and_refuses_weak_ones() {
        assert!(check_password("violet-Harbor-83-lantern").ok);
        for weak in ["short1A!", "alllowercaseletters", "Welkom2026!xx", "aaaaBBBB1111!!", "Kasboek-Secret-77x", "abcd-Efgh-Qwerty-1", ""] {
            assert!(!check_password(weak).ok, "{weak}");
        }
    }
}
