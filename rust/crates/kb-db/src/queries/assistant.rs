//! Typed queries of the assistant's providers and secrets (`assistant.*`). Empty until its batch adds the methods (docs/rust-port-plan.md section 11): the trait and its
//! `impl for SqliteStore` stay in this file, so that batch edits no shared file. The SQL is copied verbatim from the TypeScript.
use crate::sqlite::SqliteStore;

pub trait AssistantQueries {}

impl AssistantQueries for SqliteStore {}
