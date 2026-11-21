//! The service operations: the desktop operations of src/main/ipc.ts (dialogs, files, network, child processes, background
//! jobs). Each area file registers its operations in `register(&mut ServiceTable)`, the way `kb-session` registers the auth
//! operations; `table()` calls them all. A batch (docs/rust-port-plan.md section 11) fills in its own area file only.
use crate::jobs::ServiceTable;
use std::sync::LazyLock;

mod ai_jobs;
mod assistant;
mod assistant_chat;
mod backup;
mod ecb;
mod export;
mod mcp_bridge;
mod mcp_setup;
mod pdf;
mod report_pdf;
mod sync;
mod transfer;
mod update;

pub use backup::OsZone;
pub(crate) use backup::{run_auto_backup_if_due, run_auto_backup_sync};

/// Every service operation of the app.
pub fn table() -> ServiceTable {
    let mut table = ServiceTable::new();
    ai_jobs::register(&mut table);
    assistant::register(&mut table);
    assistant_chat::register(&mut table);
    backup::register(&mut table);
    ecb::register(&mut table);
    export::register(&mut table);
    mcp_bridge::register(&mut table);
    mcp_setup::register(&mut table);
    pdf::register(&mut table);
    report_pdf::register(&mut table);
    sync::register(&mut table);
    transfer::register(&mut table);
    update::register(&mut table);
    table
}

/// The operations the service answers itself, without kb-core: `app.*` (answered ahead of the session in `core_service.rs`)
/// and the registered ones. The contract test counts them together with the kb-core and `auth.*` operations.
pub static SERVICE_OPS: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| ["app.info", "app.ready", "app.milestone"].into_iter().chain(table().names()).collect());
