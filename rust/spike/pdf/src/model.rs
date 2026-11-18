//! The output: the same shape as `PdfText` in src/core/pdf/lines.ts, plus the reader's limits and error codes.
use serde::Serialize;

/// Same limits as `PDF_LIMITS` in src/core/pdf/limits.ts and READ_TIMEOUT_MS in src/main/pdf/run.ts.
pub const MAX_PAGES: usize = 150;
pub const MAX_ITEMS: usize = 100_000;
pub const MAX_CHARS: usize = 1_000_000;
pub const TIMEOUT_MS: u64 = 60_000;
/// A PDF larger than this is refused before parsing (the app reads the file into memory first).
pub const MAX_BYTES: usize = 256 * 1024 * 1024;
/// Fewer characters per page than this on average: a scan or a picture, not text (MIN_CHARS_PER_PAGE in extract.ts).
pub const MIN_CHARS_PER_PAGE: usize = 20;

#[derive(Serialize, Clone, Debug)]
pub struct Item {
    pub str: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Debug)]
pub struct Page {
    pub n: usize,
    pub width: f64,
    pub height: f64,
    pub items: Vec<Item>,
}

#[derive(Serialize, Debug)]
pub struct PdfText {
    pub pages: Vec<Page>,
    #[serde(rename = "pageCount")]
    pub page_count: usize,
}

/// The error codes of READER_ERROR_CODES in src/main/pdf/protocol.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError {
    Password,
    Broken,
    TooLarge,
    Scanned,
}

impl ReadError {
    pub fn code(self) -> &'static str {
        match self {
            ReadError::Password => "import.pdf_password",
            ReadError::Broken => "import.pdf_broken",
            ReadError::TooLarge => "import.pdf_too_large",
            ReadError::Scanned => "import.pdf_scanned",
        }
    }
}
