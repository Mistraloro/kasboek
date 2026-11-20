//! The error of the import code: the code and the plain text of the `AppError` it becomes in `kb-core`.
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportError {
    pub code: &'static str,
    pub message: String,
}

impl ImportError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    /// What the TypeScript `runOp` answers for an exception that is not an `AppError` (a failed schema parse, a bad date).
    pub fn failed() -> Self {
        Self::new("op.failed", "Something went wrong. Details are in the log.")
    }
}

impl fmt::Display for ImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ImportError {}
