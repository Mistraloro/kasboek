//! The core operations of insights.get/feedback/restoreDismissed/preview, batch B2 (docs/rust-port-plan.md section 11). Empty until that batch fills it in: add the handlers, list
//! their names in `PORTED` and in `handler`. `mod.rs` already chains this file.
use kb_db::Store;

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &[];

pub(super) fn handler<S: Store>(_name: &str) -> Option<super::Handler<S>> {
    None
}
