//! Dev-only command line for the differential checks (`rust/parity`). Never shipped.
//!
//! Every command prints one JSON document (or, for `db-dump`, text) on stdout. On failure it prints
//! `{"error":{"code","message"}}` and exits with 1. Secrets are arguments or stdin: use invented ones only.
//! `kb-cli help` lists the commands.
mod commands;
mod scenario;

use serde_json::json;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match commands::run(&args) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("{}", json!({ "error": { "code": error.code, "message": error.message } }));
            ExitCode::FAILURE
        }
    }
}
