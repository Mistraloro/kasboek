//! The output of the reader: the same shape as `PdfText` in src/core/pdf/lines.ts, plus the limits of
//! src/core/pdf/limits.ts and the error codes and messages of src/core/pdf/extract.ts and src/main/pdf/protocol.ts.
use serde::{Deserialize, Serialize};

/// `PDF_LIMITS` in src/core/pdf/limits.ts.
pub const MAX_PAGES: usize = 150;
pub const MAX_ITEMS: usize = 100_000;
pub const MAX_CHARS: usize = 1_000_000;
/// `READ_TIMEOUT_MS` in src/main/pdf/run.ts.
pub const TIMEOUT_MS: u64 = 60_000;
/// A PDF larger than this is refused before parsing (the app reads the file into memory first).
pub const MAX_BYTES: usize = 256 * 1024 * 1024;
/// Fewer characters per page than this on average: a scan or a picture, not text (`MIN_CHARS_PER_PAGE` in extract.ts).
pub const MIN_CHARS_PER_PAGE: usize = 20;

/// One piece of text: x to the right, y upward from the page bottom as the page is shown.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub str: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub n: usize,
    pub width: f64,
    pub height: f64,
    pub items: Vec<Item>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PdfText {
    pub pages: Vec<Page>,
    #[serde(rename = "pageCount")]
    pub page_count: usize,
}

/// The error codes of `READER_ERROR_CODES` in src/main/pdf/protocol.ts.
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

    /// The English messages of extract.ts (the screen words each code in the person's language).
    pub fn message(self) -> &'static str {
        match self {
            ReadError::Password => "This PDF is protected with a password. Remove the protection and try again.",
            ReadError::Broken => "This PDF could not be read. The file may be damaged or not a PDF.",
            ReadError::TooLarge => "This PDF is too large or too complex to read. Try a PDF of one statement.",
            ReadError::Scanned => {
                "This PDF has no text to read (it looks like a scan or a picture). Download the statement as a PDF from your bank instead."
            }
        }
    }

    pub fn from_code(code: &str) -> Option<ReadError> {
        [ReadError::Password, ReadError::Broken, ReadError::TooLarge, ReadError::Scanned].into_iter().find(|e| e.code() == code)
    }
}

/// What the reader process answers, one JSON object per line (`ReaderMessage` in protocol.ts).
#[derive(Serialize, Deserialize, Debug)]
#[serde(untagged, deny_unknown_fields)]
pub enum ReaderMessage {
    Progress { progress: Progress },
    Ok { ok: True, result: PdfText },
    Failed { ok: False, code: String, message: String },
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(deny_unknown_fields)]
pub struct Progress {
    pub page: usize,
    pub pages: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(try_from = "bool", into = "bool")]
pub struct True;
#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(try_from = "bool", into = "bool")]
pub struct False;

impl TryFrom<bool> for True {
    type Error = &'static str;
    fn try_from(b: bool) -> Result<Self, Self::Error> {
        if b {
            Ok(True)
        } else {
            Err("expected true")
        }
    }
}
impl From<True> for bool {
    fn from(_: True) -> bool {
        true
    }
}
impl TryFrom<bool> for False {
    type Error = &'static str;
    fn try_from(b: bool) -> Result<Self, Self::Error> {
        if b {
            Err("expected false")
        } else {
            Ok(False)
        }
    }
}
impl From<False> for bool {
    fn from(_: False) -> bool {
        false
    }
}

/// UTF-16 length, as JavaScript counts the characters of a string.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The checks of `isPdfText` in protocol.ts: counts first, then every field; the answer of a separate process is not trusted.
pub fn is_valid_pdf_text(t: &PdfText) -> bool {
    if !(1..=MAX_PAGES).contains(&t.page_count) || t.pages.len() > MAX_PAGES {
        return false;
    }
    if t.pages.iter().map(|p| p.items.len()).sum::<usize>() > MAX_ITEMS {
        return false;
    }
    let ok = |v: f64, min: f64, max: f64| v.is_finite() && v >= min && v <= max;
    let mut chars = 0;
    for p in &t.pages {
        if !(1..=MAX_PAGES).contains(&p.n) || !ok(p.width, 0.0, 1e7) || !ok(p.height, 0.0, 1e7) {
            return false;
        }
        for i in &p.items {
            if !ok(i.x, -1e7, 1e7) || !ok(i.y, -1e7, 1e7) || !ok(i.w, -1e7, 1e7) || !ok(i.h, -1e7, 1e7) {
                return false;
            }
            chars += utf16_len(&i.str);
        }
        if chars > MAX_CHARS {
            return false;
        }
    }
    true
}
