//! Kasboek design system: Slint components, tokens, fonts, icons and charts (`ui/`), and the Rust side they need
//! (`rules`, `charts`, `amount`, `table`, `paged`, `shot`). `Gallery` is the component gallery window (see README.md).
pub mod amount;
pub mod charts;
pub mod demo;
pub mod paged;
pub mod rules;
pub mod shot;
pub mod table;

slint::include_modules!();
