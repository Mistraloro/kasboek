//! Kasboek import engine without storage: ports of `src/core/csv`, `src/core/camt`, `src/core/fingerprint.ts` and the pure
//! parts of `src/core/import.ts` and `src/core/pdf/statement.ts` (reconciliation). The session, the SQL and the operations
//! are in `kb-core`, which depends on this crate.
//!
//! - [`csv`]: decoding, delimiter and header detection, the column mapping, normalising rows.
//! - [`camt`]: the safe XML reader and the CAMT.052/053/054 reader, and the grid an XML statement is turned into.
//! - [`rows`]: the import rows (status, duplicates, possible duplicates) and the bank balance of a file.
//! - [`statement`]: the printed balances against the rows.
//! - [`jsstr`], [`amount`], [`fingerprint`], [`group`]: JavaScript string rules, money amounts, the transaction fingerprint, the payee key.
pub mod amount;
pub mod camt;
pub mod csv;
pub mod error;
pub mod fingerprint;
pub mod group;
pub mod jsstr;
pub mod rows;
pub mod statement;

pub use error::ImportError;
