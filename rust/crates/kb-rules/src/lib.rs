//! Rules the renderer and the main process share (`src/shared`), ported one to one. The tests compare every function with
//! the TypeScript one on the same inputs (`tests/fixtures/rules.json`, written by `tools/gen-fixtures.mjs`).
pub mod iban;
pub mod jsstr;
pub mod mask;
pub mod password;

pub use jsstr::{is_js_space, js_round, utf16_len, JS_SPACE};
