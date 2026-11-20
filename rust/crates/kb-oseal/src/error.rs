//! Typed errors. Messages never contain secrets, paths or item contents.
use kb_session::oscrypt::SealError;
use std::io::ErrorKind;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OsealError {
    /// No usable operating system store (no Secret Service, unsupported platform).
    #[error("the operating system key store is not available")]
    Unavailable,
    /// The store exists but is locked or the user dismissed the prompt.
    #[error("the operating system key store is locked or the prompt was dismissed")]
    Locked,
    /// The item that should hold a key does not exist.
    #[error("the key item was not found")]
    NotFound,
    /// A format or prefix this version does not read.
    #[error("the value uses a format that is not supported")]
    Unsupported,
    /// Wrong key, damaged data or a refused call.
    #[error("the value could not be opened")]
    Failed,
    /// account.json changed between planning and applying a migration.
    #[error("the account file changed during the migration")]
    Changed,
    #[error("file error: {0:?}")]
    Io(ErrorKind),
}

impl From<SealError> for OsealError {
    fn from(e: SealError) -> Self {
        match e {
            SealError::Unavailable => Self::Unavailable,
            SealError::Unsupported => Self::Unsupported,
            SealError::Failed => Self::Failed,
        }
    }
}

impl From<OsealError> for SealError {
    fn from(e: OsealError) -> Self {
        match e {
            OsealError::Unavailable | OsealError::Locked => Self::Unavailable,
            OsealError::Unsupported => Self::Unsupported,
            OsealError::NotFound | OsealError::Failed | OsealError::Changed | OsealError::Io(_) => Self::Failed,
        }
    }
}

impl From<std::io::Error> for OsealError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.kind())
    }
}
