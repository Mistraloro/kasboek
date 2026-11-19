//! Storage errors. `code()` gives the `AppError` code of the TypeScript core where it has one.
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    /// The key is not 32 bytes of lower-case hex.
    #[error("Database key must be 32 bytes of hex.")]
    BadKey,
    /// Wrong key, or the file is not a Kasboek database.
    #[error("The database could not be unlocked. The key does not match this file.")]
    Locked,
    #[error("This database was made by a newer version of Kasboek (schema {found}). Update the app to open it.")]
    NewerSchema { found: u32 },
    /// A UNIQUE or PRIMARY KEY constraint failed (the engine's message text holds `UNIQUE`, as TypeScript tests for).
    #[error("{0}")]
    Unique(String),
    /// Any other engine failure. The message is the engine's own.
    #[error("database error: {0}")]
    Engine(String),
}

impl DbError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::BadKey => "db.bad_key",
            Self::Locked => "db.locked",
            Self::NewerSchema { .. } => "db.newer_schema",
            Self::Unique(_) => "db.unique",
            Self::Engine(_) => "db.engine",
        }
    }
}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        match &e {
            rusqlite::Error::SqliteFailure(failure, _)
                if failure.code == rusqlite::ErrorCode::ConstraintViolation
                    && matches!(
                        failure.extended_code,
                        rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE | rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
                    ) =>
            {
                Self::Unique(e.to_string())
            }
            _ => Self::Engine(e.to_string()),
        }
    }
}

pub type DbResult<T> = Result<T, DbError>;
