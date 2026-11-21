//! Amounts as typed in an `AmountInput`: text <-> cents, following the person's number format.

/// The separators of the Formats setting. `group` is `None` for "no grouping".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AmountFormat {
    pub decimal: char,
    pub group: Option<char>,
}

impl AmountFormat {
    pub const EN: AmountFormat = AmountFormat { decimal: '.', group: Some(',') };
    pub const DE: AmountFormat = AmountFormat { decimal: ',', group: Some('.') };

    /// From the strings the `Rules` global carries; a space as group separator is a narrow no-break space on screen.
    pub fn from_strs(decimal: &str, group: &str) -> Self {
        let group = group.chars().next().map(|c| if c == ' ' { '\u{202F}' } else { c });
        Self { decimal: decimal.chars().next().unwrap_or('.'), group }
    }
}

/// An amount as typed ("12", "-12.50", "12,5") in cents. No thousands separators, at most two decimals.
/// (Copied from `apps/kasboek/src/pages/settings/accounts.rs`; the app should call this one.)
pub fn parse_cents(text: &str) -> Option<i64> {
    let text = text.trim();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let (whole, fraction) = digits.split_once(['.', ',']).unwrap_or((digits, ""));
    let plain = |t: &str| t.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() && fraction.is_empty() || !plain(whole) || !plain(fraction) || fraction.len() > 2 || whole.len() > 12 {
        return None;
    }
    let cents = whole.parse::<i64>().unwrap_or(0) * 100 + format!("{fraction:0<2}").parse::<i64>().ok()?;
    Some(if negative { -cents } else { cents })
}

/// Group separators removed when they are used as grouping: one to three digits, then groups of exactly three. A
/// separator that does not fit ("12.5" in German) is left for `parse_cents`, which reads `.` and `,` as a decimal mark.
fn strip_grouping(text: &str, format: &AmountFormat) -> String {
    let Some(group) = format.group.filter(|g| *g != format.decimal) else { return text.to_string() };
    let (sign, rest) = match text.chars().next() {
        Some(c @ ('-' | '+')) => (&text[..c.len_utf8()], &text[c.len_utf8()..]),
        _ => ("", text),
    };
    let (whole, tail) = match rest.find(format.decimal) {
        Some(at) => rest.split_at(at),
        None => (rest, ""),
    };
    let mut groups = whole.split(group);
    let first = groups.next().unwrap_or("");
    let fits = (1..=3).contains(&first.len()) && groups.all(|g| g.len() == 3);
    if whole.contains(group) && fits {
        format!("{sign}{}{tail}", whole.replace(group, ""))
    } else {
        text.to_string()
    }
}

/// `parse_cents` for text in the person's format: "1.234,50" (German) and "1,234.50" (English) are 123450.
pub fn parse_amount(text: &str, format: &AmountFormat) -> Option<i64> {
    let text: String =
        text.trim().chars().map(|c| if c == '\u{2212}' { '-' } else { c }).filter(|c| !c.is_whitespace() && *c != '\u{202F}').collect();
    parse_cents(&strip_grouping(&text, format).replace(format.decimal, "."))
}

/// Cents as the format writes them, without a currency: "-1.234,50". Always two decimals.
pub fn format_amount(cents: i64, format: &AmountFormat) -> String {
    let digits = cents.unsigned_abs().to_string();
    let (whole, fraction) = {
        let padded = format!("{digits:0>3}");
        let (w, f) = padded.split_at(padded.len() - 2);
        (w.to_string(), f.to_string())
    };
    let mut grouped = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.extend(format.group);
        }
        grouped.push(c);
    }
    format!("{}{grouped}{}{fraction}", if cents < 0 { "-" } else { "" }, format.decimal)
}

/// What the input shows after it lost focus: the typed amount written in the format; "" for an empty or unreadable text.
pub fn normalize(text: &str, format: &AmountFormat) -> String {
    parse_amount(text, format).map(|c| format_amount(c, format)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_as_typed() {
        assert_eq!(parse_cents("12"), Some(1200));
        assert_eq!(parse_cents("-12.50"), Some(-1250));
        assert_eq!(parse_cents("12,5"), Some(1250));
        assert_eq!(parse_cents(" +0.07 "), Some(7));
        assert_eq!(parse_cents(".5"), Some(50));
        assert_eq!(parse_cents("1.234"), None);
        assert_eq!(parse_cents("1,000.00"), None);
        assert_eq!(parse_cents("-"), None);
        assert_eq!(parse_cents(""), None);
        assert_eq!(parse_cents("abc"), None);
    }

    #[test]
    fn german_format() {
        let f = AmountFormat::DE;
        assert_eq!(parse_amount("1.234,50", &f), Some(123_450));
        assert_eq!(parse_amount("1.234", &f), Some(123_400));
        assert_eq!(parse_amount("12.5", &f), Some(1250), "a point that is no grouping stays a decimal mark");
        assert_eq!(parse_amount("-1.000.000,01", &f), Some(-100_000_001));
        assert_eq!(parse_amount("12,50", &f), Some(1250));
        assert_eq!(parse_amount("1.23.456", &f), None);
        assert_eq!(parse_amount("\u{2212}3,5", &f), Some(-350));
    }

    #[test]
    fn english_and_spaced_formats() {
        assert_eq!(parse_amount("1,234.50", &AmountFormat::EN), Some(123_450));
        assert_eq!(parse_amount("1,23", &AmountFormat::EN), Some(123), "a comma that is no grouping stays a decimal mark");
        let spaced = AmountFormat::from_strs(",", " ");
        assert_eq!(parse_amount("1 234,5", &spaced), Some(123_450));
        assert_eq!(parse_amount("1\u{202F}234,5", &spaced), Some(123_450));
        let plain = AmountFormat::from_strs(".", "");
        assert_eq!(parse_amount("1234.5", &plain), Some(123_450));
    }

    #[test]
    fn writes_in_the_format() {
        assert_eq!(format_amount(123_450, &AmountFormat::DE), "1.234,50");
        assert_eq!(format_amount(-7, &AmountFormat::EN), "-0.07");
        assert_eq!(format_amount(100_000_000, &AmountFormat::EN), "1,000,000.00");
        assert_eq!(format_amount(0, &AmountFormat::from_strs(",", "")), "0,00");
        assert_eq!(format_amount(123_456, &AmountFormat::from_strs(",", " ")), "1\u{202F}234,56");
    }

    #[test]
    fn normalizes_what_was_typed() {
        assert_eq!(normalize("1234,5", &AmountFormat::DE), "1.234,50");
        assert_eq!(normalize("", &AmountFormat::DE), "");
        assert_eq!(normalize("abc", &AmountFormat::DE), "");
    }
}
