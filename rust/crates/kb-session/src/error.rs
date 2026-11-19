//! Errors with the `AppError` codes of the TypeScript app (`code` + `message`). Messages never contain secrets.
use kb_crypto::CryptoError;
use kb_db::DbError;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionError {
    pub code: String,
    pub message: String,
}

impl SessionError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into() }
    }

    pub fn locked() -> Self {
        Self::new("auth.locked", "Kasboek is locked.")
    }

    pub fn corrupt(message: impl Into<String>) -> Self {
        Self::new("auth.corrupt", message)
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new("op.invalid_input", message)
    }

    /// What `runOp` answers for an error that is not an `AppError`.
    pub fn failed() -> Self {
        Self::new("op.failed", "Something went wrong. Details are in the log.")
    }

    /// `{"code","message"}`, the error half of an operation result.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "code": self.code, "message": self.message })
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SessionError {}

impl From<CryptoError> for SessionError {
    fn from(e: CryptoError) -> Self {
        Self::new(e.code(), e.to_string())
    }
}

impl From<DbError> for SessionError {
    fn from(e: DbError) -> Self {
        match e {
            DbError::BadKey | DbError::Locked | DbError::NewerSchema { .. } => Self::new(e.code(), e.to_string()),
            DbError::Unique(_) | DbError::Engine(_) => Self::failed(),
        }
    }
}

pub type SessionResult<T> = Result<T, SessionError>;
