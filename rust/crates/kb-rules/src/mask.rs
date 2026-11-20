//! Privacy masking of free text: `maskNumbers`, `maskContacts`, `maskPrivate` and `cutText` of `src/shared/iban.ts` as the release
//! branch has them (the rust-native branch's own copy of that file is older and has no `maskPrivate`; the parity specs take the
//! reference from `KB_TS_ROOT`). `mask_private` masks the whole text and then cuts it. Text is
//! scanned as UTF-16 code units, as the regular expressions of the original do, so lengths and cuts agree. Without lookbehind
//! in the `regex` crate every pattern is matched by hand; each function says which pattern it is.
use crate::iban::{fold, ibans_hidden, is_sep, masking, scan};
use crate::jsstr::is_js_space;

const MAIL_LOCAL: usize = 100;
const MAIL_DOMAIN: usize = 255;
const ELLIPSIS: u16 = 0x2026;

fn at(t: &[u16], i: usize) -> Option<u8> {
    t.get(i).and_then(|&u| u8::try_from(u).ok())
}

fn digit_at(t: &[u16], i: usize) -> bool {
    at(t, i).is_some_and(|c| c.is_ascii_digit())
}

/// `\d{n}` at `i` and its value.
fn number_at(t: &[u16], i: usize, n: usize) -> Option<u32> {
    (0..n).try_fold(0u32, |v, k| if digit_at(t, i + k) { Some(v * 10 + (t[i + k] - 0x30) as u32) } else { None })
}

fn digits_in(t: &[u16]) -> usize {
    t.iter().filter(|&&u| (0x30..=0x39).contains(&u)).count()
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// A plausible date (a real day and month) of exactly 10 characters at `i`: dd-mm-yyyy or yyyy-mm-dd, also with / or . between the parts.
fn date_at(t: &[u16], i: usize) -> bool {
    let day = |j: usize| number_at(t, j, 2).is_some_and(|v| (1..=31).contains(&v));
    let month = |j: usize| number_at(t, j, 2).is_some_and(|v| (1..=12).contains(&v));
    let year = |j: usize| number_at(t, j, 4).is_some_and(|v| (1900..=2099).contains(&v));
    [0x2d, 0x2f, 0x2e].into_iter().any(|s| {
        let sep = |j: usize| t.get(j) == Some(&s);
        (day(i) && sep(i + 2) && month(i + 3) && sep(i + 5) && year(i + 6))
            || (year(i) && sep(i + 4) && month(i + 5) && sep(i + 7) && day(i + 8))
    })
}

/// `(?<![\d.,])\d{1,3}(?:[.,]\d{3}){1,2}(?:[.,]\d{1,2})?(?!\d)` at `i`, with the backtracking of the regex: its length.
fn amount_at(t: &[u16], i: usize) -> Option<usize> {
    let sep = |j: usize| matches!(at(t, j), Some(b'.' | b','));
    if i > 0 && (digit_at(t, i - 1) || sep(i - 1)) {
        return None;
    }
    let lead = (0..).take_while(|&k| digit_at(t, i + k)).count();
    if !(1..=3).contains(&lead) {
        return None;
    }
    let group = |j: usize| sep(j) && number_at(t, j + 1, 3).is_some();
    let mut ends = Vec::new();
    let mut j = i + lead;
    while ends.len() < 2 && group(j) {
        j += 4;
        ends.push(j);
    }
    // Greedy: two groups before one; decimals of two digits, then one, then none.
    for &end in ends.iter().rev() {
        let decimals = [2, 1].into_iter().filter(|&n| sep(end) && number_at(t, end + 1, n).is_some()).map(|n| end + 1 + n);
        if let Some(stop) = decimals.chain([end]).find(|&stop| !digit_at(t, stop)) {
            return Some(stop - i);
        }
    }
    None
}

/// `\d(?:[ .\-/]?\d){12,}` at `i`: its length.
fn digit_run_at(t: &[u16], i: usize) -> Option<usize> {
    if !digit_at(t, i) {
        return None;
    }
    let (mut j, mut reps) = (i + 1, 0);
    loop {
        if j + 1 < t.len() && is_sep(t[j]) && digit_at(t, j + 1) {
            j += 2;
        } else if digit_at(t, j) {
            j += 1;
        } else {
            break;
        }
        reps += 1;
    }
    (reps >= 12).then_some(j - i)
}

/// One match of NUMBERS at `i`: its length and whether it is a date or amount (kept) rather than a run of digits (hidden).
fn numbers_at(t: &[u16], i: usize) -> Option<(usize, bool)> {
    if date_at(t, i) && !(i > 0 && digit_at(t, i - 1)) && !digit_at(t, i + 10) {
        return Some((10, true));
    }
    if let Some(len) = amount_at(t, i) {
        return Some((len, true));
    }
    digit_run_at(t, i).map(|len| (len, false))
}

/// The matches of NUMBERS in a text: start, length, kept.
fn numbers_in(t: &[u16]) -> Vec<(usize, usize, bool)> {
    let (mut found, mut i) = (Vec::new(), 0);
    while i < t.len() {
        match numbers_at(t, i) {
            Some((len, keep)) => {
                found.push((i, len, keep));
                i += len;
            }
            None => i += 1,
        }
    }
    found
}

/// Dates at the end of a text: the text without them, and them.
fn split_trailing_dates(t: &[u16], min_digits: usize) -> (&[u16], &[u16]) {
    let mut head = t;
    let mut tail_from = t.len();
    while head.len() >= 11 && is_sep(head[head.len() - 11]) && date_at(head, head.len() - 10) {
        let next = &head[..head.len() - 11];
        if digits_in(next) < min_digits {
            break;
        }
        tail_from = next.len();
        head = next;
    }
    (head, &t[tail_from..])
}

fn numbers_hidden(t: &[u16]) -> Vec<u16> {
    let t = ibans_hidden(t);
    let (mut out, mut from) = (Vec::new(), 0);
    for (start, len, keep) in numbers_in(&t) {
        if keep {
            continue;
        }
        out.extend_from_slice(&t[from..start]);
        let (head, tail) = split_trailing_dates(&t[start..start + len], 13);
        out.push(ELLIPSIS);
        let digits: Vec<u16> = head.iter().copied().filter(|&u| (0x30..=0x39).contains(&u)).collect();
        out.extend_from_slice(&digits[digits.len() - 4..]);
        out.extend_from_slice(tail);
        from = start + len;
    }
    out.extend_from_slice(&t[from..]);
    out
}

/// IBANs as `mask_iban` shows them, and runs of 13 or more digits (card or account numbers) by their last four. Dates and
/// amounts stay, also right next to such a run or after it.
pub fn mask_numbers(text: &str) -> String {
    masking(text, numbers_hidden)
}

fn mail_part(u: u16) -> bool {
    !(matches!(u, 0x40 | 0x3c | 0x3e | 0x28 | 0x29 | 0x7c) || char::from_u32(u as u32).is_some_and(is_js_space))
}

/// The e-mail addresses in a text hidden. Scans from each @ outwards, with a limit on both sides, so a long text can't make it slow.
fn mails_hidden(t: &[u16]) -> Vec<u16> {
    let (mut out, mut from_at) = (Vec::new(), 0);
    let mut i = 0;
    while i < t.len() {
        if t[i] != 0x40 {
            i += 1;
            continue;
        }
        let mut from = i;
        while from > from_at && i - from < MAIL_LOCAL && mail_part(t[from - 1]) {
            from -= 1;
        }
        let mut to = i + 1;
        while to < t.len() && to - i <= MAIL_DOMAIN && mail_part(t[to]) {
            to += 1;
        }
        let domain = &t[i + 1..to];
        let dot = domain.iter().skip(1).position(|&u| u == 0x2e).map(|p| p + 1);
        if from == i || dot.is_none_or(|d| d >= domain.len() - 1) {
            i += 1;
            continue;
        }
        out.extend_from_slice(&t[from_at..from]);
        out.extend([ELLIPSIS, 0x40, ELLIPSIS]);
        from_at = to;
        i = to;
    }
    out.extend_from_slice(&t[from_at..]);
    out
}

/// `(?:\+|\b00)\d[\d ./()-]{6,30}\d` at `i`: its length.
fn phone_at(t: &[u16], i: usize) -> Option<usize> {
    let prefix = if at(t, i) == Some(b'+') {
        1
    } else if at(t, i) == Some(b'0')
        && at(t, i + 1) == Some(b'0')
        && !(i > 0 && t[i - 1] < 128 && ((t[i - 1] as u8).is_ascii_alphanumeric() || t[i - 1] == 0x5f))
    {
        2
    } else {
        return None;
    };
    if !digit_at(t, i + prefix) {
        return None;
    }
    let from = i + prefix + 1;
    let class = |j: usize| at(t, j).is_some_and(|c| c.is_ascii_digit() || matches!(c, b' ' | b'.' | b'/' | b'(' | b')' | b'-'));
    let run = (0..30).take_while(|&k| class(from + k)).count();
    (6..=run).rev().find(|&k| digit_at(t, from + k)).map(|k| from + k + 1 - i)
}

/// `^\+\d{1,3}(?:[.,]\d{3}){1,2}$`: +1.234.567, an amount with a plus sign.
fn signed_amount(m: &[u16]) -> bool {
    if m.first() != Some(&0x2b) {
        return false;
    }
    let lead = m[1..].iter().take_while(|&&u| (0x30..=0x39).contains(&u)).count();
    let rest = &m[1 + lead..];
    (1..=3).contains(&lead)
        && matches!(rest.len(), 4 | 8)
        && rest.chunks(4).all(|g| matches!(g[0], 0x2e | 0x2c) && g[1..].iter().all(|&u| (0x30..=0x39).contains(&u)))
}

fn contacts_hidden(t: &[u16]) -> Vec<u16> {
    let t = mails_hidden(t);
    let (mut out, mut from, mut i) = (Vec::new(), 0, 0);
    while i < t.len() {
        let Some(len) = phone_at(&t, i) else {
            i += 1;
            continue;
        };
        let m = &t[i..i + len];
        out.extend_from_slice(&t[from..i]);
        if signed_amount(m) && digits_in(m) <= 7 {
            out.extend_from_slice(m);
        } else {
            out.extend(units("\u{2026}phone\u{2026}"));
            out.extend_from_slice(split_trailing_dates(m, 7).1);
        }
        i += len;
        from = i;
    }
    out.extend_from_slice(&t[from..]);
    out
}

/// An e-mail address, or a phone number written with a + or 00 prefix (an international number). Cheap and not exhaustive.
pub fn mask_contacts(text: &str) -> String {
    masking(text, contacts_hidden)
}

/// What a number, address or phone number cut off at the end of a masked prefix can leave unmasked: well under this many units.
const EDGE: usize = 400;

/// Everything that must not leave the device or show on a screen that is being watched: account and card numbers first, then
/// e-mail addresses and phone numbers (the other way round, the phone rule would eat the groups of a spaced IBAN). `max` (in
/// UTF-16 code units, as `String.length`) cuts the text to that many characters, after masking: masks shrink a text, so cutting
/// first would let unmasked text slide under the cut. A long text is masked as a prefix only; the prefix grows until its masked
/// form is `EDGE` longer than `max`, so whatever the prefix edge left half-masked lies beyond the cut.
pub fn mask_private(text: &str, max: Option<usize>) -> String {
    let t = units(text);
    let Some(max) = max.filter(|&m| t.len() > m) else { return mask_contacts(&mask_numbers(text)) };
    let mut length = max.saturating_mul(4).saturating_add(EDGE);
    loop {
        let prefix = String::from_utf16_lossy(&t[..t.len().min(length)]);
        let masked = units(&mask_contacts(&mask_numbers(&prefix)));
        if length >= t.len() || masked.len() >= max.saturating_add(EDGE) {
            return format!("{}\u{2026}", String::from_utf16_lossy(&masked[..masked.len().min(max)]));
        }
        length = length.saturating_mul(4);
    }
}

/// The first `max` characters of a text, but never through the middle of an account or card number: one that would be cut in two
/// is left out whole, so no part of it is shown.
pub fn cut_text(text: &str, max: usize) -> String {
    let t = units(text);
    if t.len() <= max {
        return text.to_string();
    }
    let window: Vec<u16> = fold(&String::from_utf16_lossy(&t[..t.len().min(max + 64)])).encode_utf16().collect();
    let mut cut = max;
    let straddles = |index: usize, length: usize, cut: usize| index < cut && index + length > cut;
    for h in scan(&window) {
        if straddles(h.index, h.used, cut) {
            cut = h.index;
        }
    }
    for (index, len, keep) in numbers_in(&window) {
        if !keep && straddles(index, len, cut) {
            cut = index;
        }
    }
    String::from_utf16_lossy(&t[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::iban::mask_iban;
    use crate::jsstr::utf16_len;

    // All data here is invented. The IBANs are the published example numbers of the IBAN standard.
    const OTHER: &str = "NL91ABNA0417164300";
    const OTHER_SPACED: &str = "NL91 ABNA 0417 1643 00";
    const CARD: &str = "5412 7512 3412 3456";
    const MAIL: &str = "ilse.vermeulen@example.test";
    const PHONE: &str = "+32 475 12 34 56";

    #[test]
    fn hides_contacts() {
        assert_eq!(mask_contacts(&format!("{MAIL} {PHONE}")), "…@… …phone…");
        assert_eq!(mask_contacts("call 0032 475 12 34 56 now"), "call …phone… now");
        assert_eq!(mask_contacts("a@b and x@y.z. and @c.d"), "a@b and …@… and @c.d");
    }

    #[test]
    fn private_masks_numbers_before_contacts() {
        let out = mask_private(&format!("pay {OTHER_SPACED} or call {PHONE}, mail {MAIL}"), None);
        assert_eq!(out, "pay NL…4300 or call …phone…, mail …@…");
        assert_eq!(mask_private(&format!("card {CARD}"), None), "card …3456");
    }

    #[test]
    fn dates_and_amounts_stay() {
        assert_eq!(mask_numbers("on 2026-10-01 paid 1.234,50 and 12.345.678,9"), "on 2026-10-01 paid 1.234,50 and 12.345.678,9");
        assert_eq!(mask_numbers("ref 1234 5678 9012 3456 2026-10-01"), "ref …3456 2026-10-01");
        assert_eq!(mask_contacts("raise of +1.234.567 now"), "raise of +1.234.567 now");
    }

    #[test]
    fn folds_compatibility_forms_and_separators() {
        assert_eq!(fold("ＮＬ９１\u{a0}ABNA\u{200b}\n0417\u{2013}1643"), "NL91 ABNA 0417-1643");
        assert_eq!(mask_iban("NL91\u{a0}ABNA\u{a0}0417\u{a0}1643\u{a0}00"), "NL…4300");
        assert_eq!(mask_iban("NL91.ABNA.0417.1643.00 and NL91/ABNA/0417/1643/00"), "NL…4300 and NL…4300");
        assert_eq!(mask_iban("keep …1234 as it is"), "keep …1234 as it is");
    }

    #[test]
    fn digit_groups_across_separators() {
        assert_eq!(mask_numbers("4111.1111.1111.1111"), "…1111");
        assert_eq!(mask_numbers("4111/1111/1111/1111 and 4111-1111-1111-1111"), "…1111 and …1111");
        assert_eq!(mask_numbers("12 34 56"), "12 34 56");
    }

    #[test]
    fn leaves_a_clean_text_exactly_as_it_came() {
        let text = "two  spaces\u{a0}and a tab\t, nothing private";
        assert_eq!(mask_private(text, None), text);
    }

    #[test]
    fn cuts_to_max_and_never_through_a_number() {
        let long = format!("{} {OTHER} tail", "a".repeat(20));
        assert_eq!(mask_private(&long, Some(30)), format!("{} NL…4300 t…", "a".repeat(20)));
        assert_eq!(mask_private("short", Some(30)), "short");
        let text = format!("{} {OTHER} tail", "a".repeat(10));
        assert_eq!(cut_text(&text, 20), format!("{} ", "a".repeat(10)));
        assert_eq!(cut_text(&text, 40), text);
        assert_eq!(cut_text(&format!("{} {CARD} x", "a".repeat(10)), 20), format!("{} ", "a".repeat(10)));
    }

    #[test]
    fn masks_before_it_cuts() {
        let spaced = [OTHER_SPACED; 5].join(" ");
        assert_eq!(mask_private(&format!("{spaced} {CARD} tail"), Some(60)), "NL…4300 NL…4300 NL…4300 NL…4300 NL……3456 tail…");
        assert_eq!(mask_private(&format!("{} {CARD}", "1".repeat(80)), Some(30)), "…3456…");
        assert_eq!(mask_private("call +32 475 12 34 56 now", Some(10)), "call …phon…");
    }

    #[test]
    fn a_hostile_million_character_text_is_masked_fast() {
        let started = std::time::Instant::now();
        for unit in ["ab12", "NL91 ", "1 ", "NL91 ABNA 0417 1643 00 "] {
            let text = unit.repeat(1_000_000 / unit.len() + 1);
            let out = mask_private(&text, Some(2000));
            assert!(utf16_len(&out) <= 2001);
            assert!(!out.contains("ABNA") && !out.contains("0417"));
        }
        assert!(started.elapsed().as_secs() < 20, "too slow: {:?}", started.elapsed());
    }
}
