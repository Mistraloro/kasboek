//! PDF statements.
pub mod cap;
mod csvrules;
mod js;
pub mod lines;
pub mod model;
pub mod plan;
pub mod process;
pub mod reader;
mod recover;
pub mod session;
pub mod statement;
mod synonyms;

pub use lines::{to_lines, PdfCell, PdfLine};
pub use model::*;
pub use plan::{
    first_line_sent, lines_to_send, masked_lines, part_text, prepare, preview_text, preview_text_of, split_part, split_parts, table_start,
    MaskedLine, PdfAssistPreview, PdfPart, PlanError,
};
pub use process::{read_pdf_in_child, run_reader_process, ChildOptions, PdfError};
pub use reader::{read_guarded, ReadStats};
pub use session::{analyze_pdf, is_pdf, PdfAnalysis, PdfNote, PdfSessionData, ReadBy};
pub use statement::{complete_year, read_statement, reconcile, reconciliation_banner, Reconciliation, ReconciliationBanner, StatementRead};
