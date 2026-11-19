//! Builds the vendored sqlite3mc amalgamation (vendor/sqlite3.c) into a static library named `sqlite3`.
//! The compile-time defines are read from vendor/defines.gypi, the file better-sqlite3-multiple-ciphers uses, so the
//! engine is the one the Electron app runs. Nothing outside this crate is needed at build time.
use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("set by cargo")).join("vendor");
    let gypi = dir.join("defines.gypi");
    let source = dir.join("sqlite3.c");
    println!("cargo:rerun-if-changed={}", gypi.display());
    println!("cargo:rerun-if-changed={}", source.display());

    let mut build = cc::Build::new();
    // The Release flags of better-sqlite3's common.gypi (NDEBUG, -O3) and sqlite3.gyp (-std=c99, -w).
    build.file(&source).include(&dir).std("c99").warnings(false).opt_level(3).define("NDEBUG", None);
    let defines = defines(&std::fs::read_to_string(&gypi).expect("vendor/defines.gypi is readable"));
    assert_eq!(defines.len(), 37, "vendor/defines.gypi changed: update VENDOR.md and this check together");
    for define in &defines {
        match define.split_once('=') {
            Some((name, value)) => build.define(name, value),
            None => build.define(define, None),
        };
    }
    build.compile("sqlite3");
}

/// The single-quoted entries of the `defines` list in defines.gypi.
fn defines(gypi: &str) -> Vec<String> {
    gypi.lines().map(str::trim).filter_map(|line| line.strip_prefix('\'')?.strip_suffix("',")).map(str::to_owned).collect()
}
