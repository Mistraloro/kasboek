//! Text rules the Slint components call (see `ui/rules.slint`): date typing and formatting as in `src/shared/format.ts`
//! (`formatDate`, `parseTypedDate`, `checkDateText`) and type-ahead search. Pure functions, unit-tested.

/// Month names of a language, short and long. English only until the i18n crate exists.
pub struct MonthNames {
    pub short: [&'static str; 12],
    pub long: [&'static str; 12],
}

pub const EN: MonthNames = MonthNames {
    short: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    long: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok<'a> {
    Year4,
    Year2,
    MonthLong,
    MonthShort,
    Month2,
    Month1,
    Day2,
    Day1,
    Lit(&'a str),
}

/// Splits a pattern such as "DD/MM/YYYY" the way the renderer's regex does: tokens are the longest of
/// YYYY|YY|MMMM|MMM|MM|M|DD|D at each position, everything else up to the next token is a literal.
fn tokens(pattern: &str) -> Vec<Tok<'_>> {
    const TABLE: [(&str, Tok<'static>); 8] = [
        ("YYYY", Tok::Year4),
        ("YY", Tok::Year2),
        ("MMMM", Tok::MonthLong),
        ("MMM", Tok::MonthShort),
        ("MM", Tok::Month2),
        ("M", Tok::Month1),
        ("DD", Tok::Day2),
        ("D", Tok::Day1),
    ];
    let mut out = Vec::new();
    let mut i = 0;
    let mut lit_start = 0;
    while i < pattern.len() {
        if let Some((text, tok)) = TABLE.iter().find(|(t, _)| pattern[i..].starts_with(t)) {
            if lit_start < i {
                out.push(Tok::Lit(&pattern[lit_start..i]));
            }
            out.push(*tok);
            i += text.len();
            lit_start = i;
        } else {
            i += pattern[i..].chars().next().map_or(1, char::len_utf8);
        }
    }
    if lit_start < pattern.len() {
        out.push(Tok::Lit(&pattern[lit_start..]));
    }
    out
}

fn pad(n: u32) -> String {
    format!("{n:02}")
}

/// `formatDate` for an ISO "YYYY-MM-DD" date. Anything else is returned unchanged.
pub fn format_date(iso: &str, pattern: &str, names: &MonthNames) -> String {
    let Some((y, m, d)) = split_iso(iso) else { return iso.to_string() };
    tokens(pattern)
        .into_iter()
        .map(|t| match t {
            Tok::Year4 => y.to_string(),
            Tok::Year2 => pad(y % 100),
            Tok::MonthLong => names.long[(m - 1) as usize].to_string(),
            Tok::MonthShort => names.short[(m - 1) as usize].to_string(),
            Tok::Month2 => pad(m),
            Tok::Month1 => m.to_string(),
            Tok::Day2 => pad(d),
            Tok::Day1 => d.to_string(),
            Tok::Lit(s) => s.to_string(),
        })
        .collect()
}

fn split_iso(iso: &str) -> Option<(u32, u32, u32)> {
    let b = iso.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| iso.get(r).filter(|s| s.bytes().all(|c| c.is_ascii_digit())).and_then(|s| s.parse().ok());
    let (y, m, d): (u32, u32, u32) = (num(0..4)?, num(5..7)?, num(8..10)?);
    ((1..=12).contains(&m) && d >= 1).then_some((y, m, d))
}

fn month_from_name(name: &str, names: &MonthNames) -> Option<u32> {
    let wanted = name.trim_end_matches('.').to_lowercase();
    (0..12).find(|&i| names.short[i].to_lowercase() == wanted || names.long[i].to_lowercase() == wanted).map(|i| i as u32 + 1)
}

#[derive(Default, Clone)]
struct Parts {
    y: Option<u32>,
    m: Option<u32>,
    d: Option<u32>,
}

/// Backtracking match of the tokens against the input, as the regex of `parseTypedDate` does.
fn matches(toks: &[Tok], input: &[char], names: &MonthNames, parts: Parts) -> Option<Parts> {
    let Some((tok, rest)) = toks.split_first() else {
        return input.is_empty().then_some(parts);
    };
    let digits = |lo: usize, hi: usize| -> Vec<usize> {
        let n = input.iter().take(hi).take_while(|c| c.is_ascii_digit()).count();
        (lo..=n).rev().collect()
    };
    let num = |n: usize| input[..n].iter().collect::<String>().parse::<u32>().unwrap_or(0);
    match tok {
        Tok::Year4 | Tok::Year2 => {
            let n = if *tok == Tok::Year4 { 4 } else { 2 };
            if input.len() >= n && input[..n].iter().all(|c| c.is_ascii_digit()) {
                let v = num(n);
                let y = if n == 2 { 2000 + v } else { v };
                return matches(rest, &input[n..], names, Parts { y: Some(y), ..parts });
            }
            None
        }
        Tok::Month1 | Tok::Month2 | Tok::Day1 | Tok::Day2 => digits(1, 2).into_iter().find_map(|n| {
            let v = Some(num(n));
            let p =
                if matches!(tok, Tok::Month1 | Tok::Month2) { Parts { m: v, ..parts.clone() } } else { Parts { d: v, ..parts.clone() } };
            matches(rest, &input[n..], names, p)
        }),
        Tok::MonthShort | Tok::MonthLong => {
            let letters = input.iter().take_while(|c| c.is_alphabetic()).count();
            (1..=letters).rev().find_map(|n| {
                // The name, with or without one trailing dot ("mar", "mar.").
                [1usize, 0].into_iter().find_map(|dot| {
                    if dot == 1 && input.get(n) != Some(&'.') {
                        return None;
                    }
                    let take = n + dot;
                    let month = month_from_name(&input[..take].iter().collect::<String>(), names)?;
                    matches(rest, &input[take..], names, Parts { m: Some(month), ..parts.clone() })
                })
            })
        }
        Tok::Lit(s) => {
            if s.trim().is_empty() {
                let n = input.iter().take_while(|c| c.is_whitespace()).count();
                return (1..=n).rev().find_map(|k| matches(rest, &input[k..], names, parts.clone()));
            }
            // Literal text: whitespace inside it matches any amount of whitespace, the rest must be equal.
            let lit: Vec<char> = s.chars().collect();
            let (mut i, mut j) = (0, 0);
            while j < lit.len() {
                if lit[j].is_whitespace() {
                    while i < input.len() && input[i].is_whitespace() {
                        i += 1;
                    }
                    j += 1;
                } else if i < input.len() && input[i] == lit[j] {
                    i += 1;
                    j += 1;
                } else {
                    return None;
                }
            }
            matches(rest, &input[i..], names, parts)
        }
    }
}

fn days_in(y: u32, m: u32) -> u32 {
    match m {
        2 if (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// `parseTypedDate`: the ISO date a text stands for, or `None`. A plain ISO date is always accepted; day and month may
/// have no leading zero; two-digit years count as 20YY.
pub fn parse_typed(text: &str, pattern: &str, names: &MonthNames) -> Option<String> {
    let input = text.trim();
    if input.is_empty() {
        return None;
    }
    let parts = if let Some((y, m, d)) = split_iso(input) {
        Parts { y: Some(y), m: Some(m), d: Some(d) }
    } else {
        let chars: Vec<char> = input.chars().collect();
        matches(&tokens(pattern), &chars, names, Parts::default())?
    };
    let (y, m, d) = (parts.y?, parts.m?, parts.d?);
    (y >= 1 && (1..=12).contains(&m) && d >= 1 && d <= days_in(y, m)).then(|| format!("{y:04}-{m:02}-{d:02}"))
}

/// Outcome of `checkDateText`: the ISO date ("" when empty or unusable) and the problem ("", "invalid", "too-late").
pub fn check_date(text: &str, pattern: &str, max: &str, names: &MonthNames) -> (String, &'static str) {
    if text.trim().is_empty() {
        return (String::new(), "");
    }
    match parse_typed(text, pattern, names) {
        None => (String::new(), "invalid"),
        Some(iso) if !max.is_empty() && iso.as_str() > max => (String::new(), "too-late"),
        Some(iso) => (iso, ""),
    }
}

/// Index of the first item at or after `from` (wrapping round) that starts with `prefix`, ignoring case; -1 if none.
pub fn find_prefix<S: AsRef<str>>(items: &[S], prefix: &str, from: i32) -> i32 {
    if items.is_empty() || prefix.is_empty() {
        return -1;
    }
    let prefix = prefix.to_lowercase();
    let n = items.len() as i32;
    let start = from.rem_euclid(n);
    (0..n).map(|k| (start + k) % n).find(|&i| items[i as usize].as_ref().to_lowercase().starts_with(&prefix)).unwrap_or(-1)
}

/// Connects the `Rules` global of a window to the Rust implementations above. Call once per window, after
/// `slint::include_modules!()` made `Rules` and `DateCheck` available in the calling module:
/// `kb_ui::wire_rules!(&window);`
#[macro_export]
macro_rules! wire_rules {
    ($ui:expr) => {{
        use ::slint::{ComponentHandle as _, Model as _};
        let rules = $ui.global::<Rules>();
        rules.on_check_date(|text, max, pattern| {
            let (iso, problem) = $crate::rules::check_date(&text, &pattern, &max, &$crate::rules::EN);
            DateCheck { iso: iso.into(), problem: problem.into() }
        });
        rules.on_format_date(|iso, pattern| $crate::rules::format_date(&iso, &pattern, &$crate::rules::EN).into());
        rules.on_find_prefix(|items, prefix, from| {
            let items: ::std::vec::Vec<::slint::SharedString> = items.iter().collect();
            $crate::rules::find_prefix(&items, &prefix, from)
        });
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str, pattern: &str) -> Option<String> {
        parse_typed(text, pattern, &EN)
    }

    #[test]
    fn formats_like_the_renderer() {
        assert_eq!(format_date("2026-03-05", "DD/MM/YYYY", &EN), "05/03/2026");
        assert_eq!(format_date("2026-03-05", "D MMM YY", &EN), "5 Mar 26");
        assert_eq!(format_date("2026-03-05", "MMMM D, YYYY", &EN), "March 5, 2026");
        assert_eq!(format_date("2026-03-05", "M/D/YYYY", &EN), "3/5/2026");
    }

    #[test]
    fn parses_typed_dates() {
        assert_eq!(p("05/03/2026", "DD/MM/YYYY").as_deref(), Some("2026-03-05"));
        assert_eq!(p("5/3/2026", "DD/MM/YYYY").as_deref(), Some("2026-03-05"));
        assert_eq!(p("2026-03-05", "DD/MM/YYYY").as_deref(), Some("2026-03-05"));
        assert_eq!(p("5 mar 26", "D MMM YY").as_deref(), Some("2026-03-05"));
        assert_eq!(p("March 5, 2026", "MMMM D, YYYY").as_deref(), Some("2026-03-05"));
        assert_eq!(p("5.3.2026", "D.M.YYYY").as_deref(), Some("2026-03-05"));
        assert_eq!(p("29/02/2024", "DD/MM/YYYY").as_deref(), Some("2024-02-29"));
    }

    #[test]
    fn refuses_what_is_not_a_date() {
        assert_eq!(p("31/02/2026", "DD/MM/YYYY"), None);
        assert_eq!(p("29/02/2026", "DD/MM/YYYY"), None);
        assert_eq!(p("13/13/2026", "DD/MM/YYYY"), None);
        assert_eq!(p("5 foo 26", "D MMM YY"), None);
        assert_eq!(p("05-03-2026", "DD/MM/YYYY"), None);
        assert_eq!(p("", "DD/MM/YYYY"), None);
    }

    #[test]
    fn check_reports_the_problem() {
        assert_eq!(check_date("", "DD/MM/YYYY", "", &EN), (String::new(), ""));
        assert_eq!(check_date("x", "DD/MM/YYYY", "", &EN), (String::new(), "invalid"));
        assert_eq!(check_date("05/03/2026", "DD/MM/YYYY", "2026-03-01", &EN), (String::new(), "too-late"));
        assert_eq!(check_date("05/03/2026", "DD/MM/YYYY", "2026-03-05", &EN), ("2026-03-05".into(), ""));
    }

    #[test]
    fn type_ahead_wraps_and_ignores_case() {
        let items = ["Euro", "Dollar", "Danish krone", "Yen"];
        assert_eq!(find_prefix(&items, "d", 0), 1);
        assert_eq!(find_prefix(&items, "d", 2), 2);
        assert_eq!(find_prefix(&items, "d", 3), 1);
        assert_eq!(find_prefix(&items, "da", 0), 2);
        assert_eq!(find_prefix(&items, "x", 0), -1);
        assert_eq!(find_prefix::<&str>(&[], "x", 0), -1);
    }
}
