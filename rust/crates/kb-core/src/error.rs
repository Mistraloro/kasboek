//! `AppError`: the error of every operation, with the codes and texts of `AppError` in src/core/errors.ts.
use kb_db::DbError;
use serde_json::Value;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub struct AppError {
    pub code: String,
    pub message: String,
    /// Structured facts about the failure, for a text in the person's language (`ErrorDetails` in TypeScript).
    pub details: Option<Value>,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into(), details: None }
    }

    /// What the TypeScript `runOp` answers for an error that is not an `AppError` (the details go to the log there).
    pub fn failed() -> Self {
        Self::new("op.failed", "Something went wrong. Details are in the log.")
    }

    pub fn locked() -> Self {
        Self::new("auth.locked", "Kasboek is locked.")
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new("op.invalid_input", message)
    }

    /// `{"code", "message", "details"?}`, the error half of `OpResult`.
    pub fn to_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("code".into(), Value::String(self.code.clone()));
        map.insert("message".into(), Value::String(self.message.clone()));
        if let Some(details) = &self.details {
            map.insert("details".into(), details.clone());
        }
        Value::Object(map)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

/// A storage error nobody handled specifically: the TypeScript core logs it and answers `op.failed`. A locked or
/// newer-schema database keeps its own code (the same `AppError` codes as in src/core/database.ts).
impl From<DbError> for AppError {
    fn from(e: DbError) -> Self {
        match e {
            DbError::BadKey | DbError::Locked | DbError::NewerSchema { .. } => Self::new(e.code(), e.to_string()),
            DbError::Unique(_) | DbError::Engine(_) => Self::failed(),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
