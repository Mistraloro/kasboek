//! What opening a PDF statement as an import session needs (`openPdfSession` in src/main/pdf/open.ts, without the database
//! and the process): the lines, the table as a grid, the balances, the period and the notes. Turning the grid into
//! normalised rows (columns, dates, amounts) is the import's `analyzeGrid`, in `kb-import`; this is its input.
use crate::lines::{to_lines, PdfLine};
use crate::model::PdfText;
use crate::statement::{read_statement, StatementBalances, StatementNote, StatementPeriod};
use serde::{Deserialize, Serialize};

/// Remarks about a PDF import (`PdfNote` in src/shared/types.ts).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum PdfNote {
    OtherAccount { iban: String },
    DatesWithoutYear,
    PagesWithoutText { count: usize },
    NoTable { pages: usize, lines: usize },
}

/// Who read the rows (`PdfSessionData.readBy`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReadBy {
    Kasboek,
    Assistant,
}

/// What a PDF statement adds to its session (`PdfSessionData` in src/core/import.ts). Kept in memory only, like the session.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PdfSessionData {
    pub lines: Vec<PdfLine>,
    pub pages: usize,
    #[serde(rename = "readBy")]
    pub read_by: ReadBy,
    pub balances: StatementBalances,
    pub period: StatementPeriod,
    pub notes: Vec<PdfNote>,
}

/// The input of `analyzeGrid`: the grid (empty when no table was found) and the session data.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PdfAnalysis {
    pub grid: Vec<Vec<String>>,
    pub pdf: PdfSessionData,
}

/// A PDF file starts with "%PDF-" (`isPdf` in src/core/pdf/detect.ts).
pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
}

/// The text of a PDF read into the grid and the session data: lines, statement, and the notes `openPdfSession` adds (pages
/// without text; with no table only counts, never the text). `own_iban` is the account's number.
pub fn analyze_pdf(text: &PdfText, own_iban: Option<&str>) -> PdfAnalysis {
    let lines = to_lines(text);
    let read = read_statement(&lines, own_iban);
    let empty = text.pages.iter().filter(|p| p.items.is_empty()).count();
    let grid = if read.header_found { read.grid } else { Vec::new() };
    let mut notes: Vec<PdfNote> = read
        .notes
        .into_iter()
        .map(|n| match n {
            StatementNote::OtherAccount { iban } => PdfNote::OtherAccount { iban },
            StatementNote::DatesWithoutYear => PdfNote::DatesWithoutYear,
        })
        .collect();
    if empty > 0 {
        notes.push(PdfNote::PagesWithoutText { count: empty });
    }
    // Only counts, never the text: what the person can tell the developer when a bank's PDF is not read.
    if grid.is_empty() {
        notes.push(PdfNote::NoTable { pages: text.page_count, lines: lines.len() });
    }
    let pdf =
        PdfSessionData { pages: text.page_count, read_by: ReadBy::Kasboek, balances: read.balances, period: read.period, notes, lines };
    PdfAnalysis { grid, pdf }
}
