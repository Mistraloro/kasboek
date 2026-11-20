//! JavaScript and zod string rules the TypeScript core relies on (`trim`, `\s`, the length zod checks), which differ from
//! Rust's. They live in `kb-import`, which the import code needs too; this module keeps the path the other modules use.
pub use kb_import::jsstr::*;
