//! Rules the renderer and the main process share (`src/shared`), ported one to one. The tests compare every function with
//! the TypeScript one on the same inputs (`tests/fixtures/rules.json`, written by `tools/gen-fixtures.mjs`).
pub mod iban;
pub mod password;
