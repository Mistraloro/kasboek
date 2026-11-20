//! What of a PDF statement goes to the assistant, and in what pieces (the text-selection half of src/core/pdf-plan.ts and
//! `prepare` / `pdfAssistPreview` of src/main/assistant/pdf.ts). Only the statement's text goes out: masked, as lines with
//! their positions, and without what stands above the table (name, address, account number). The preview the person agrees
//! to is built from the very same text that is sent.
//!
//! Not here: reading the assistant's answer and checking it against the lines (`parsePdfPlan`, `applyRowsPlan`); that is
//! the assistant crate's part and works on `MaskedLine` and `PdfLine`.
use crate::js::{self, re};
use crate::lines::PdfLine;
use crate::statement::{is_header_line, is_month_name};
use kb_rules::mask::mask_private;
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

/// A line of the statement as it is sent: numbers masked, with its position.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MaskedLine {
    pub id: usize,
    pub page: usize,
    /// `L12 p2 | x60 03/11 | x140 DESCRIPTION | x510 45,10-`
    pub text: String,
    /// The cells' text only (masked), the text a returned string must be found in.
    pub plain: String,
}

/// A line is cut after this many characters; nothing in a transaction needs more.
const MAX_LINE_CHARS: usize = 1000;

/// The first line of the table of transactions (its header row), or None when the text has none.
pub fn table_start(lines: &[PdfLine]) -> Option<usize> {
    lines.iter().find(|l| is_header_line(l)).map(|l| l.id)
}

fn cell_text(line: &PdfLine) -> String {
    line.cells.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" ")
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The first match of `DATE_LIKE` in a text (a date as statements write it: 2026-11-03, 03/11/2026, 03.11.26, 03/11, 03.11.),
/// as (start, end) in bytes. The expression of the TypeScript has look-ahead and a back-reference, which are done by hand here.
fn date_like(text: &str) -> Option<(usize, usize)> {
    static ISO: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{4}-\d{2}-\d{2}"));
    static FULL_SLASH: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{1,2}/\d{1,2}/\d{2,4}"));
    static FULL_DOT: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{1,2}\.\d{1,2}\.\d{2,4}"));
    static FULL_DASH: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{1,2}-\d{1,2}-\d{2,4}"));
    static SHORT_SLASH: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{1,2}/\d{1,2}"));
    static SHORT_DOT: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{1,2}\.\d{1,2}\."));
    let mut prev: Option<char> = None;
    for (i, c) in text.char_indices() {
        if c.is_ascii_digit() && !prev.is_some_and(is_word) {
            let rest = &text[i..];
            let next_after = |end: usize| rest[end..].chars().next();
            // \b at the end: the next character is not a word character
            let bounded = |end: usize| !next_after(end).is_some_and(is_word);
            for full in [&*ISO, &*FULL_SLASH, &*FULL_DOT, &*FULL_DASH] {
                if let Some(m) = full.find(rest) {
                    if bounded(m.end()) {
                        return Some((i, i + m.end()));
                    }
                }
            }
            if let Some(m) = SHORT_SLASH.find(rest) {
                if bounded(m.end()) && next_after(m.end()) != Some('/') {
                    return Some((i, i + m.end()));
                }
            }
            if let Some(m) = SHORT_DOT.find(rest) {
                if !next_after(m.end()).is_some_and(|n| n.is_ascii_digit()) {
                    return Some((i, i + m.end()));
                }
            }
        }
        prev = Some(c);
    }
    None
}

fn tokens(s: &str) -> Vec<String> {
    js::squash(s).split(' ').filter(|t| !t.is_empty()).map(String::from).collect()
}

/// Whether a line has a date and an amount, as a transaction does and a name or address does not.
fn looks_like_transaction(line: &PdfLine) -> bool {
    // Only a non-digit after the two decimals: the look-ahead `(?!\d)`.
    static AMOUNT_LIKE: LazyLock<Regex> = LazyLock::new(|| re(r"\d[\d.,' ]*[.,]\d{2}(?:[^0-9]|$)"));
    static DAY: LazyLock<Regex> = LazyLock::new(|| re(r"(?:^|\s)\d{1,2}(?:\s|$)"));
    let text = cell_text(line);
    let dateless = match date_like(&text) {
        Some((a, b)) => format!("{} {}", &text[..a], &text[b..]),
        None => text.clone(),
    };
    let has_date = dateless != text || (tokens(&text).iter().any(|t| is_month_name(t)) && DAY.is_match(&text));
    has_date && AMOUNT_LIKE.is_match(&dateless)
}

/// The first line to send: the table's header, or, when there is none, the first line with a date and an amount, so that the
/// holder's name, address and other free text above the transactions never go out. None when there is neither: then there is
/// nothing to read and nothing is sent.
pub fn first_line_sent(lines: &[PdfLine]) -> Option<usize> {
    table_start(lines).or_else(|| lines.iter().find(|l| looks_like_transaction(l)).map(|l| l.id))
}

/// The lines as they are sent: IBANs and runs of 13 or more digits masked, and, with `skip_before` (the table's first line),
/// everything above the table left out: the name and address blocks and the header of the first page.
pub fn masked_lines(lines: &[PdfLine], skip_before: Option<usize>) -> Vec<MaskedLine> {
    lines
        .iter()
        .filter(|l| skip_before.is_none_or(|s| l.id >= s))
        .map(|l| {
            let cells: Vec<(i64, String)> = l
                .cells
                .iter()
                .map(|c| {
                    // `Math.round`: halves go up
                    let f = c.x0.floor();
                    let x = if c.x0 - f >= 0.5 { f + 1.0 } else { f };
                    (x as i64, mask_private(&c.text, Some(MAX_LINE_CHARS)))
                })
                .collect();
            // An account number cut over two cells by wide spacing is only recognised as a whole: then the line is sent as one piece.
            let joined = cells.iter().map(|c| c.1.as_str()).collect::<Vec<_>>().join(" ");
            let whole = mask_private(&joined, Some(MAX_LINE_CHARS));
            let pieces = if whole == joined { cells } else { vec![(cells.first().map_or(0, |c| c.0), whole)] };
            MaskedLine {
                id: l.id,
                page: l.page,
                text: std::iter::once(format!("L{} p{}", l.id, l.page))
                    .chain(pieces.iter().map(|c| format!("x{} {}", c.0, c.1)))
                    .collect::<Vec<_>>()
                    .join(" | "),
                plain: pieces.iter().map(|c| c.1.as_str()).collect::<Vec<_>>().join(" "),
            }
        })
        .collect()
}

/// At most this many pages and characters go to the assistant in one call.
pub const MAX_PART_PAGES: usize = 4;
pub const MAX_PART_CHARS: usize = 40_000;
/// And this many lines: a transaction takes about 30 tokens of answer, and one answer must fit in about 6000.
pub const MAX_PART_LINES: usize = 180;
/// A part of this many lines or fewer (about 5 transactions) is not split further.
pub const MIN_SPLIT_LINES: usize = 10;
/// The last lines of the part before are repeated, marked as context, so a transaction cut by a part boundary can be understood.
pub const CONTEXT_LINES: usize = 3;
/// Longer statements are not read by the assistant.
pub const MAX_AI_PAGES: usize = 40;
/// `CHARS_PER_TOKEN` of src/main/assistant/provider.ts.
pub const CHARS_PER_TOKEN: usize = 3;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PdfPart {
    pub n: usize,
    pub of: usize,
    pub context: Vec<MaskedLine>,
    pub own: Vec<MaskedLine>,
}

pub fn pages_of(masked: &[MaskedLine]) -> usize {
    masked.iter().map(|m| m.page).collect::<std::collections::HashSet<_>>().len()
}

/// Splits the lines into parts of at most 4 pages and 40,000 characters.
pub fn split_parts(masked: &[MaskedLine]) -> Vec<PdfPart> {
    let mut groups: Vec<Vec<MaskedLine>> = Vec::new();
    let mut current: Vec<MaskedLine> = Vec::new();
    let mut pages = std::collections::HashSet::new();
    let mut chars = 0;
    for m in masked {
        let size = kb_rules::utf16_len(&m.text) + 1;
        if !current.is_empty()
            && (chars + size > MAX_PART_CHARS
                || current.len() >= MAX_PART_LINES
                || (!pages.contains(&m.page) && pages.len() >= MAX_PART_PAGES))
        {
            groups.push(std::mem::take(&mut current));
            pages.clear();
            chars = 0;
        }
        current.push(m.clone());
        pages.insert(m.page);
        chars += size;
    }
    if !current.is_empty() {
        groups.push(current);
    }
    let of = groups.len();
    (0..of)
        .map(|i| PdfPart {
            n: i + 1,
            of,
            context: if i > 0 { groups[i - 1][groups[i - 1].len().saturating_sub(CONTEXT_LINES)..].to_vec() } else { Vec::new() },
            own: groups[i].clone(),
        })
        .collect()
}

/// A part in two halves, for when its answer did not fit; None when it is small enough. The cut is made at the line nearest
/// the middle that starts with a date, so a transaction stays in one half; the second half gets the last lines of the first as context.
pub fn split_part(part: &PdfPart) -> Option<(PdfPart, PdfPart)> {
    static STARTS: LazyLock<Regex> = LazyLock::new(|| re(r"\|\s*x\d+ \d{1,2}[/.-]\d{1,2}"));
    let lines = &part.own;
    if lines.len() <= MIN_SPLIT_LINES {
        return None;
    }
    let mid = lines.len() / 2;
    let starts = |i: usize| STARTS.is_match(&lines[i].text);
    let mut cut = mid;
    // `d < mid - MIN_SPLIT_LINES / 2`
    for d in 0..(mid as i64 - (MIN_SPLIT_LINES / 2) as i64).max(0) as usize {
        if starts(mid + d) {
            cut = mid + d;
        } else if starts(mid - d) {
            cut = mid - d;
        } else {
            continue;
        }
        break;
    }
    let first = lines[..cut].to_vec();
    let context = first[first.len().saturating_sub(CONTEXT_LINES)..].to_vec();
    Some((PdfPart { own: first, ..part.clone() }, PdfPart { context, own: lines[cut..].to_vec(), ..part.clone() }))
}

/// The text a part is sent as.
pub fn part_text(part: &PdfPart) -> String {
    let head = format!(
        "Part {} of {}.{}",
        part.n,
        part.of,
        if part.context.is_empty() { "" } else { " Lines marked (context only) end the part before: do not use them in any row." }
    );
    let mut out = vec![head, String::new()];
    out.extend(part.context.iter().map(|m| format!("(context only) {}", m.text)));
    out.extend(part.own.iter().map(|m| m.text.clone()));
    out.join("\n")
}

/// The lines of the table on the pages after the first: from the first line with a date and an amount (else from the table's
/// header, else none). What is above it on a later page is a repeated page header: the holder's name and address, a logo line, the
/// account number again.
fn later_page_lines<'a>(page: &[&'a PdfLine]) -> Vec<&'a PdfLine> {
    let start = page.iter().find(|l| looks_like_transaction(l)).or_else(|| page.iter().find(|l| is_header_line(l)));
    match start {
        Some(s) => page.iter().copied().filter(|l| l.id >= s.id).collect(),
        None => Vec::new(),
    }
}

/// Everything that is sent for a statement, masked: only the table's rows. On the first page that is from the table's header (or
/// else the first transaction-like line) onward; on every later page from the first transaction-like line (see `later_page_lines`).
/// Empty when there is no such line. The preview and the calls to the assistant are both made from this one list (`linesToSend`).
pub fn lines_to_send(lines: &[PdfLine]) -> Vec<MaskedLine> {
    let Some(start) = first_line_sent(lines) else { return Vec::new() };
    let Some(from) = lines.iter().find(|l| l.id == start).map(|l| l.page) else { return Vec::new() };
    // pages in the order they first appear
    let mut pages: Vec<(usize, Vec<&PdfLine>)> = Vec::new();
    for l in lines.iter().filter(|l| l.id >= start) {
        match pages.iter_mut().find(|(p, _)| *p == l.page) {
            Some((_, own)) => own.push(l),
            None => pages.push((l.page, vec![l])),
        }
    }
    let kept: Vec<PdfLine> =
        pages.iter().flat_map(|(page, own)| if *page == from { own.clone() } else { later_page_lines(own) }).cloned().collect();
    masked_lines(&kept, None)
}

/// Why nothing can be sent: the error code and message of `prepare` in src/main/assistant/pdf.ts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanError {
    pub code: &'static str,
    pub message: String,
}

/// `prepare` of src/main/assistant/pdf.ts: the masked lines to send, or a clear error.
pub fn prepare(lines: &[PdfLine]) -> Result<Vec<MaskedLine>, PlanError> {
    if lines.is_empty() {
        return Err(PlanError { code: "assistant.pdf_empty", message: "This PDF has no text to read.".into() });
    }
    let masked = lines_to_send(lines);
    if masked.is_empty() {
        return Err(PlanError {
            code: "assistant.pdf_no_table",
            message: "No transaction rows were found in this PDF, so nothing was sent.".into(),
        });
    }
    let pages = pages_of(&masked);
    if pages > MAX_AI_PAGES {
        return Err(PlanError {
            code: "assistant.pdf_too_long",
            message: format!(
                "This statement has {pages} pages with text. The assistant reads at most {MAX_AI_PAGES} pages; try a shorter period."
            ),
        });
    }
    Ok(masked)
}

/// What would be sent: shown in the dialog where the person agrees (`PdfAssistPreview` of src/shared/types.ts).
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PdfAssistPreview {
    pub pages: usize,
    pub parts: usize,
    pub chars: usize,
    #[serde(rename = "approxTokens")]
    pub approx_tokens: usize,
    pub text: String,
}

/// `previewText`: the text of every part, as it is sent.
pub fn preview_text_of(masked: &[MaskedLine]) -> String {
    masked.iter().map(|m| m.text.as_str()).collect::<Vec<_>>().join("\n")
}

/// `pdfAssistPreview`: the text is the masked lines of `prepare`, which are also what `split_parts` sends.
pub fn preview_text(lines: &[PdfLine]) -> Result<PdfAssistPreview, PlanError> {
    let masked = prepare(lines)?;
    let text = preview_text_of(&masked);
    let chars = kb_rules::utf16_len(&text);
    Ok(PdfAssistPreview {
        pages: pages_of(&masked),
        parts: split_parts(&masked).len(),
        chars,
        approx_tokens: chars.div_ceil(CHARS_PER_TOKEN),
        text,
    })
}
